#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { auditConfig, createAuditRun, redactAuditText, withAuditTrace } from "../audit.js";
import { materializeChangeEvidence, openChangeEvidence, type ChangeManifest } from "../change-evidence.js";
import { createEvidencePack, writeEvidencePack, type EvidencePack } from "../evidence-pack.js";
import { createGuidanceResult, writeGuidanceResult, SEMANTIC_DATA_SHA256, SEMANTIC_RULE_SET_SHA256, type GuidanceResult } from "../semantic-checks.js";
import { CAVEAT_CARD_SET_SHA256 } from "../caveat-cards.js";
import { loadProfile } from "../profile.js";
import { scan } from "../scan.js";
import type { Finding, ScanResult } from "../findings.js";
import { ENGINES } from "../engines/registry.js";
import { projectFacts, type ProjectFacts } from "../project-facts.js";
import { ensureGraph } from "./graph.js";
import { ensureGraphify } from "./graphify.js";
import { appAccess, fetchReviewThreads, makeApp, postComment, postReview, replyInThread, resolveThread, tokenAccess, updateComment, type GitHubAccess } from "./github.js";
import { parsePriorThreads, resolvedReply, type PriorFinding } from "./incremental.js";
import {
  convertManifestCode,
  loadCredentials,
  page,
  renderCallbackPage,
  renderConfiguredPage,
  renderSetupPage,
  restartCommand,
  saveCredentials,
  type AppCredentials,
} from "./manifest.js";
import { ackMessage, doneMessage, failMessage, renderInline, renderWalkthrough, skipMessage, type Tier, type VerifyOutput } from "./render.js";
import { markPostWalkLeadPublication } from "../runner/post-walk-leads.js";
import { formatLine, makeLogger } from "./log.js";
import { materializeTrustedReviewState, type TrustedReviewState } from "../trusted-state.js";
import { preBodyReject, readCappedBody, routeEvent, verifySignature, type Job } from "./webhook.js";
import { relayChallengeAllowed, relayConfigFromEnv, verifyRelayDelivery } from "./relay.js";
import { executableIdentity, run, runStreaming, safeChildEnvironment, type RunOpts } from "../exec.js";
import { writeWorkItem } from "../work-item.js";
import {
  ReviewCache,
  findingSnapshot,
  incrementalDependencyBoundary,
  publicationDecisions,
  reconcileFindings,
  projectFactsCacheSchema,
  scanResultCacheSchema,
  stableJson,
  type FindingLifecycle,
  type LastCompleted,
} from "../review-cache.js";

// The App layer: GitHub plumbing only. It holds the App key and webhook secret —
// never a model credential. The BYOAI seam is LEVERET_RUNNER: a user-supplied
// command (their agent, their provider, their hardware) that turns the bounded
// evidence pack into a verified report. Without one, reviews run deterministic-only.
//
// Unconfigured servers boot into SETUP MODE: /setup drives GitHub's App Manifest
// flow, creating an App the USER owns (webhook pre-pointed here) and storing the
// returned credentials on this machine only.

const DATA_DIR = process.env.LEVERET_DATA ?? join(homedir(), ".leveret-app");
const APP_CHILD_TIMEOUT_MS = 15 * 60_000;

async function mustRun(cmd: string, args: string[], cwd: string, options?: RunOpts): Promise<void> {
  const result = await run(cmd, args, cwd, options);
  if (result.code !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed with exit ${result.code}${result.signal ? ` (${result.signal})` : ""}`);
}

/** deterministic-only fallback: engine findings become the report directly */
function reportFromScan(result: ScanResult): VerifyOutput {
  const tier = (f: Finding): Tier =>
    f.severity === "error" ? "major" : f.severity === "warning" ? "minor" : "nit";
  return {
    report: result.findings.map((f, i) => ({
      id: `D${i + 1}`,
      file: f.file,
      line: f.line,
      title: `${f.engine}/${f.rule}: ${f.message}`,
      tier: tier(f),
      severity: f.severity,
      scope: "in-diff",
      evidence: `reported by ${f.engine} (deterministic pass; no runner configured)`,
    })),
    verdicts: result.findings.map((_, i) => ({ id: `D${i + 1}`, grade: "actionable" })),
    coverage: {
      lenses: [
        {
          lens: "deterministic-engines",
          outcome: `${result.findings.length} finding(s); agent lenses NOT run (no LEVERET_RUNNER)`,
        },
      ],
      files: [],
    },
  };
}

async function reviewJob(job: Extract<Job, { kind: "review" }>, access?: GitHubAccess): Promise<void> {
  const wallStartedAt = performance.now();
  const runId = randomUUID();
  const bound = { runId, prUrl: `https://github.com/${job.repo}/pull/${job.pr}` };
  let audit;
  try {
    audit = await createAuditRun(auditConfig(DATA_DIR), runId);
  } catch (error) {
    process.stdout.write(`${formatLine("error", "audit initialization failed", bound, { err: error, completeness: "lost" })}\n`);
    if (access) await postComment(access, job.repo, job.pr, failMessage(error, runId)).catch(() => {});
    throw error;
  }
  const log = makeLogger(bound, undefined, (record) => { void audit?.record("operational", "log", record).catch(() => {}); });
  log.info("review job started", { headSha: job.headSha, action: job.action });
  await audit?.record("app", "review_job_received", job);
  await audit?.record("app", "work_item_captured", job.workItem);
  await audit?.writeCapabilities({ graph: "not-run", scanner: "not-run", node: process.version });
  let ackId: number | undefined;
  const work = await mkdtemp(join(tmpdir(), "leveret-app-"));
  const runnerWork = await mkdtemp(join(tmpdir(), "leveret-runner-"));
  let trusted: TrustedReviewState | undefined;
  let cache: ReviewCache | undefined;
  let cacheCompletion: Omit<LastCompleted, "schema" | "version" | "repository_sha256" | "pull_request" | "completed_at"> | undefined;
  let failure: unknown;
  try {
    await withAuditTrace(audit, async () => {
      const token = await access?.token();
      const gitEnv = {
        ...safeChildEnvironment(process.env),
        ...(token ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        } : {}),
      };
      await mustRun("git", ["clone", "--quiet", job.cloneUrl, work], "/", { env: gitEnv, timeoutMs: APP_CHILD_TIMEOUT_MS });
      await mustRun("git", ["fetch", "--quiet", "origin", `pull/${job.pr}/head`], work, { env: gitEnv, timeoutMs: APP_CHILD_TIMEOUT_MS });
      await mustRun("git", ["checkout", "--quiet", job.headSha], work, { timeoutMs: APP_CHILD_TIMEOUT_MS });
      const baseRef = `${job.baseRef}@${job.baseSha}`;
      const resolvedBase = await run("git", ["rev-parse", "--verify", `${job.baseSha}^{commit}`], work, { timeoutMs: APP_CHILD_TIMEOUT_MS });
      if (resolvedBase.code !== 0 || resolvedBase.stdout.trim() !== job.baseSha) throw new Error("failed to resolve exact webhook base SHA");
      const base = job.baseSha;
      trusted = await materializeTrustedReviewState(work, base);

      // the repo's config may ask Leveret to stand down — say so once, then leave
      const profile = await loadProfile(trusted.profilePath);
      await audit?.record("repository", "effective_configuration", {
        host: {
          source: "process environment",
          runner: process.env.LEVERET_RUNNER ?? null,
          model: process.env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol",
          provider: process.env.LEVERET_RUNNER_PROVIDER ?? "openai",
          thinking: process.env.LEVERET_RUNNER_EFFORT ?? "high",
          discovery: {
            mode: process.env.LEVERET_DISCOVERY_MODE ?? "single",
            scheduler: process.env.LEVERET_DISCOVERY_SCHEDULER ?? "serial/v1",
            concurrency_bound: Number(process.env.LEVERET_DISCOVERY_CONCURRENCY ?? 1),
          },
          model_routing: process.env.LEVERET_MODEL_ROUTING
            ? { source: "host-file-outside-checkout", sha256: process.env.LEVERET_MODEL_ROUTING_SHA256 ?? null }
            : { source: "runner-default-fixed", sha256: null },
          cache: { enabled: process.env.LEVERET_CACHE !== "0", root: join(DATA_DIR, "cache", "review-v1"), owner: "host" },
          trace: audit?.config,
        },
        trusted_base: { source: baseRef, sha: base, profile },
      });
      let skipReason: string | null = null;
      if (!profile.review.enabled) skipReason = "`review.enabled` is false in `.leveret.yml`";
      else if (profile.review.skipTitle && new RegExp(profile.review.skipTitle).test(job.title)) {
        skipReason = `the PR title matches \`review.skipTitle\` (\`${profile.review.skipTitle}\`)`;
      }
      if (skipReason) {
        if (access && job.action === "opened") {
          try {
            const commentId = await postComment(access, job.repo, job.pr, skipMessage(skipReason));
            await audit?.record("app", "publication_completed", { action: "skip-comment", comment_id: commentId });
          } catch (error) {
            await audit?.record("app", "publication_failed", { action: "skip-comment", error });
          }
        }
        return;
      }

      // the friendly heads-up, EDITED to the outcome when the job ends — a PR should
      // never show a silent bot or an eternal "working on it"
      if (access) {
        const model = process.env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol";
        try {
          ackId = await postComment(access, job.repo, job.pr, ackMessage(job.headSha, model));
          await audit?.record("app", "publication_completed", { action: "ack-comment", comment_id: ackId });
        } catch (error) {
          await audit?.record("app", "publication_failed", { action: "ack-comment", error });
          log.warn("acknowledgement publication failed", { err: error });
        }
      }
      // the checkout gets its code graph before any agent looks at it (owner ruling:
      // the graph is derived and always buildable — structure is queried, not grepped)
      const preparationStartedAt = performance.now();
      cache = await ReviewCache.open({
        dataRoot: DATA_DIR,
        repoRoot: work,
        repository: job.repo,
        pullRequest: job.pr,
        enabled: process.env.LEVERET_CACHE !== "0",
      });
      const lastCompleted = await cache.readLastCompleted();
      await audit?.record("repository", "cache_metadata", cache.lastCompletedDecision);
      const boundary = await incrementalDependencyBoundary(work, lastCompleted?.head ?? null, job.headSha);
      await audit?.record("repository", "incremental_range", boundary);

      // The checkout-local graph index is intentionally rebuilt. A cached status
      // cannot stand in for files that tools must query in this exact checkout.
      const codegraphBin = process.env.LEVERET_CODEGRAPH_BIN ?? "codegraph";
      const graphifyBin = process.env.LEVERET_GRAPHIFY_BIN ?? "graphify";
      const graphKey = cache.key("graph-toolchain", base, job.headSha, {
        node: process.version,
        codegraph_binary: codegraphBin,
        graphify_binary: graphifyBin,
        sandbox: "disabled",
      }, boundary);
      await audit?.record("repository", "cache_decision", cache.fallback(graphKey, "checkout-local indexes must be rebuilt; dependency/tool sandbox is disabled"));
      const [graph, graphify] = await Promise.all([
        ensureGraph(work, codegraphBin),
        ensureGraphify(work, runnerWork, graphifyBin),
      ]);
      if (!graph.ok) log.warn("codegraph unavailable", { detail: graph.detail });
      if (!graphify.ok) log.warn("graphify unavailable", { detail: graphify.detail });
      await audit?.record("repository", "startup_indexes", { codegraph: graph, graphify });
      const evidencePath = join(runnerWork, "change-evidence.v1.json");
      const manifestKey = cache.key("change-manifest", base, job.headSha, {
        schema_version: 1,
        range: `${base}..${job.headSha}`,
      }, boundary);
      const cachedManifest = await cache.get<ChangeManifest>(manifestKey);
      await audit?.record("repository", "cache_decision", cachedManifest.decision);
      let evidence;
      if (cachedManifest.value) {
        try {
          await writeFile(evidencePath, `${JSON.stringify(cachedManifest.value)}\n`);
          evidence = await openChangeEvidence(work, evidencePath);
        } catch (error) {
          await audit?.record("repository", "cache_decision", cache.invalidate(manifestKey, `cached manifest failed checkout validation: ${String(error)}`));
          evidence = await materializeChangeEvidence(work, base, evidencePath, job.headSha);
          cache.stage(manifestKey, evidence.manifest);
        }
      } else {
        evidence = await materializeChangeEvidence(work, base, evidencePath, job.headSha);
        cache.stage(manifestKey, evidence.manifest);
      }
      const auditPatch = await evidence.auditPatch();
      await audit?.record("repository", "review_diff", {
        base_ref: baseRef,
        base_sha: evidence.manifest.base,
        head_sha: evidence.manifest.head,
        changed_files: evidence.manifest.files.map((file) => file.path),
        change_manifest: evidence.manifest,
        unified_diff: auditPatch.patch,
        sha256: auditPatch.sha256,
        bytes: auditPatch.bytes,
      });
      const profileSha256 = createHash("sha256").update(stableJson(profile)).digest("hex");
      const manifestSha256 = createHash("sha256").update(stableJson(evidence.manifest)).digest("hex");
      const engineIdentity = JSON.parse(stableJson(await Promise.all(ENGINES.map(async (engine) => ({
        id: engine.id,
        bin: engine.bin,
        executable: await executableIdentity(engine.bin, work),
      })))));
      const scanKey = cache.key("scan-result", base, job.headSha, {
        manifest_sha256: manifestSha256,
        profile_sha256: profileSha256,
        trusted_base: base,
        engines: engineIdentity,
        allow_custom_engines: false,
      }, boundary);
      const cachedScan = await cache.get<unknown>(scanKey);
      await audit?.record("repository", "cache_decision", cachedScan.decision);
      const parsedScan = cachedScan.value === undefined ? undefined : scanResultCacheSchema.safeParse(cachedScan.value);
      if (parsedScan && !parsedScan.success) await audit?.record("repository", "cache_decision", cache.invalidate(scanKey, `cached scan result failed strict schema validation: ${parsedScan.error.message}`));
      const cachedScanResult: ScanResult | undefined = parsedScan?.success ? parsedScan.data : undefined;
      const result = cachedScanResult ?? await scan({
        repo: work,
        base: evidence.manifest.base,
        manifest: evidence.manifest,
        profilePath: trusted.profilePath,
        rulesRoot: trusted.root,
        memoryRepo: trusted.root,
        allowCustomEngines: false,
      });
      if (!cachedScanResult) cache.stage(scanKey, result);
      await audit?.record("repository", "scan_completed", { base_ref: baseRef, base_sha: base, head_sha: job.headSha, graph, scan: result });

      const factsKey = cache.key("project-facts", base, job.headSha, {
        manifest_sha256: manifestSha256,
        project_facts_version: 1,
      }, boundary);
      const cachedFacts = await cache.get<unknown>(factsKey);
      await audit?.record("repository", "cache_decision", cachedFacts.decision);
      const parsedFacts = cachedFacts.value === undefined ? undefined : projectFactsCacheSchema.safeParse(cachedFacts.value);
      if (parsedFacts && !parsedFacts.success) await audit?.record("repository", "cache_decision", cache.invalidate(factsKey, `cached project facts failed strict schema validation: ${parsedFacts.error.message}`));
      const cachedProjectFacts: ProjectFacts | undefined = parsedFacts?.success ? parsedFacts.data : undefined;
      if (lastCompleted?.head !== job.headSha && boundary.reusable_artifacts.includes("project-facts")) {
        await audit?.record("repository", "cache_decision", cache.fallback(factsKey, "cross-head project-facts reuse not proven against exact checkout; recomputing owning artifact"));
      }
      const facts = cachedProjectFacts ?? await projectFacts(work);
      if (!cachedProjectFacts) cache.stage(factsKey, facts);
      const evidencePackPath = join(runnerWork, "evidence-pack.v1.json");
      const evidenceKey = cache.key("evidence-pack", base, job.headSha, {
        manifest_sha256: manifestSha256,
        scan_key: cache.keyDigest(scanKey),
        project_key: cache.keyDigest(factsKey),
        profile_sha256: profileSha256,
        trusted_base: base,
        engines: engineIdentity,
      }, boundary);
      const cachedPack = await cache.get<EvidencePack>(evidenceKey);
      await audit?.record("repository", "cache_decision", cachedPack.decision);
      const evidencePack = cachedPack.value ?? await createEvidencePack({
        repo: work,
        manifest: evidence.manifest,
        profile,
        profilePath: trusted.profilePath,
        rulesRoot: trusted.root,
        project: facts,
        scan: result,
        engines: ENGINES,
      });
      if (!cachedPack.value) cache.stage(evidenceKey, evidencePack);
      const evidencePackFile = await writeEvidencePack(work, evidencePackPath, evidencePack);
      const guidancePath = join(runnerWork, "guidance-result.v1.json");
      const guidanceKey = cache.key("guidance-selection", base, job.headSha, {
        evidence_pack_sha256: evidencePackFile.sha256,
        trusted_base: base,
        guidance_schema: "leveret.guidance-result/v1",
        card_set_sha256: CAVEAT_CARD_SET_SHA256,
        rule_set_sha256: SEMANTIC_RULE_SET_SHA256,
        data_sha256: SEMANTIC_DATA_SHA256,
      }, boundary);
      const cachedGuidance = await cache.get<GuidanceResult>(guidanceKey);
      await audit?.record("repository", "cache_decision", cachedGuidance.decision);
      const guidance = cachedGuidance.value ?? await createGuidanceResult(work, evidencePackFile);
      if (!cachedGuidance.value) cache.stage(guidanceKey, guidance);
      const guidanceFile = await writeGuidanceResult(work, guidancePath, guidance);
      await audit?.record("repository", "evidence_pack", {
        pack: evidencePack,
        schema: evidencePack.schema,
        sha256: evidencePackFile.sha256,
        bytes: evidencePackFile.bytes,
      });
      await audit?.record("repository", "guidance_result", {
        guidance: guidanceFile.guidance,
        schema: guidanceFile.guidance.schema,
        sha256: guidanceFile.sha256,
        bytes: guidanceFile.bytes,
        selected_card_ids: guidanceFile.guidance.selectedCards.map((card) => card.id),
        selected_rule_ids: guidanceFile.guidance.selectedCards.flatMap((card) => card.ruleId ? [card.ruleId] : []),
        emitted_rule_lead_ids: guidanceFile.guidance.ruleLeads.map((lead) => lead.id),
        selected_mutation_ids: [...new Set(guidanceFile.guidance.mutationLeads.map((lead) => lead.mutationId))].sort(),
        hashes: guidanceFile.guidance.provenance,
      });
      const engineCapabilities = Object.fromEntries(evidencePack.analyzers.map((analyzer) => [
        analyzer.id,
        { status: analyzer.staticResult, lifecycle: analyzer.lifecycle, ...(analyzer.executable ?? { available: false }) },
      ]));
      await audit?.writeCapabilities({
        graph,
        graphify,
        scanner: { engines: engineCapabilities },
        evidence_pack: { schema: evidencePack.schema, sha256: evidencePackFile.sha256, bytes: evidencePackFile.bytes },
        guidance: { schema: guidanceFile.guidance.schema, sha256: guidanceFile.sha256, bytes: guidanceFile.bytes },
        node: process.version,
      });

      // incremental re-review: hand the runner the bot's own unresolved threads
      let prior: PriorFinding[] = [];
      if (access && job.action !== "opened") {
        try {
          const threads = await fetchReviewThreads(access, job.repo, job.pr);
          prior = parsePriorThreads(threads as Parameters<typeof parsePriorThreads>[0], await access.botLogin());
          if (prior.length > 0) {
            await writeFile(join(runnerWork, "prior.json"), JSON.stringify(prior, null, 1));
          }
        } catch (err) {
          log.warn("prior-thread fetch failed; reviewing without incremental context", { err });
        }
      }

      await audit?.record("repository", "prior_findings", prior);
      const modelStartedAt = performance.now();
      let verify: VerifyOutput;
      if (process.env.LEVERET_RUNNER) {
        const workItemFile = await writeWorkItem(runnerWork, job.workItem);
        await audit?.record("app", "work_item_materialized", {
          schema: job.workItem.schema,
          path_role: "outside-checkout runner input",
          sha256: workItemFile.sha256,
          bytes: workItemFile.bytes,
        });
        const [cmd, ...args] = process.env.LEVERET_RUNNER.split(" ") as [string, ...string[]];
        // Default Pi budget: review + verify + one schema-correction phase, each 30m,
        // plus startup/cleanup slack. Custom runners can override explicitly.
        const runnerTimeout = Number(process.env.LEVERET_RUNNER_TIMEOUT_MS ?? 100 * 60_000);
        if (!Number.isFinite(runnerTimeout) || runnerTimeout <= 0) {
          throw new Error("LEVERET_RUNNER_TIMEOUT_MS must be a positive number");
        }
        const cacheRunPath = join(runnerWork, "cache-run.v1.json");
        await writeFile(cacheRunPath, `${stableJson({
          schema: "leveret.review-cache-run/v1",
          enabled: cache.enabled,
          incremental: boundary,
          artifacts: cache.decisions,
          optional_dependency_sandbox: "disabled",
        })}\n`);
        const runnerEnv = {
          ...process.env,
          LEVERET_REPO: work,
          LEVERET_BASE: base,
          LEVERET_WORK_ITEM: workItemFile.path,
          LEVERET_CHANGE_MANIFEST: evidencePath,
          LEVERET_EVIDENCE_PACK: evidencePackFile.path,
          LEVERET_EVIDENCE_PACK_SHA256: evidencePackFile.sha256,
          LEVERET_GUIDANCE: guidanceFile.path,
          LEVERET_CACHE_RUN: cacheRunPath,
          LEVERET_GUIDANCE_SHA256: guidanceFile.sha256,
          LEVERET_CODEGRAPH_BIN: codegraphBin,
          LEVERET_REQUIRE_INDEXES: process.env.LEVERET_REQUIRE_INDEXES ?? "1",
          LEVERET_GRAPH: graph.ok ? "1" : "0",
          ...(graphify.ok && graphify.graphPath ? {
            LEVERET_GRAPHIFY_GRAPH: graphify.graphPath,
            LEVERET_GRAPHIFY_BIN: graphifyBin,
            LEVERET_GRAPHIFY_NODES: String(graphify.indexedNodes ?? 0),
            LEVERET_GRAPHIFY_EDGES: String(graphify.indexedEdges ?? 0),
          } : {}),
          ...(prior.length > 0 ? { LEVERET_PRIOR: join(runnerWork, "prior.json") } : {}),
          ...(audit ? { LEVERET_TRACE_DIR: audit.partialDir, LEVERET_RUN_ID: runId, LEVERET_DATA: DATA_DIR } : {}),
        };
        await audit?.record("lifecycle", "runner_started", { argv: [cmd, ...args], cwd: runnerWork, environment_names: Object.keys(runnerEnv).sort() });
        let diagnosticBuffer = "";
        const emitDiagnostic = (line: string): void => {
          const detail = redactAuditText(line);
          log.info("runner diagnostic", {
            ...(audit?.config.policies.operational === "full" ? { detail: detail.slice(0, 2000) } : {}),
            bytes: Buffer.byteLength(line),
            sha256: createHash("sha256").update(line).digest("hex"),
            truncated: detail.length > 2000,
          });
        };
        const r = await runStreaming(cmd, args, runnerWork, {
          maxBuffer: 64 * 1024 * 1024,
          timeoutMs: runnerTimeout,
          env: runnerEnv,
          onStderr: (chunk) => {
            diagnosticBuffer += chunk.toString("utf8");
            const lines = diagnosticBuffer.split("\n");
            diagnosticBuffer = lines.pop() ?? "";
            for (const line of lines) emitDiagnostic(line);
          },
        });
        if (diagnosticBuffer) emitDiagnostic(diagnosticBuffer);
        log.info("runner exited", { code: r.code, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated });
        if (r.code !== 0) throw new Error(`runner failed with exit ${r.code}${r.signal ? ` (${r.signal})` : ""}`);
        await audit?.record("result", "runner_output_received", { raw: r.stdout });
        await audit?.validateCapturedEvents();
        verify = JSON.parse(r.stdout) as VerifyOutput;
        await audit?.record("result", "runner_output_parsed", { raw: r.stdout, parsed: verify });
      } else {
        verify = reportFromScan(result);
      }
      const modelDurationMs = Math.max(0, performance.now() - modelStartedAt);
      const snapshots = verify.report.map((item) => {
        const grade = verify.verdicts.find((verdict) => verdict.id === item.id)?.grade ?? "unverifiable";
        return findingSnapshot({
          id: item.id,
          concernSource: item.id,
          rule: item.title.split(":")[0] ?? item.title,
          file: item.file,
          start: item.line,
          context: `${item.title}\n${item.evidence}`,
          evidenceHashes: [createHash("sha256").update(item.evidence).digest("hex")],
          grade,
        });
      });
      const lifecycle: FindingLifecycle[] = reconcileFindings(snapshots, lastCompleted?.findings);
      const findingPublications = publicationDecisions(lifecycle);
      for (const publication of findingPublications) await audit?.record("app", "finding_publication_decision", publication);
      const publishedIds = new Set(findingPublications.filter((item) => item.publish).map((item) => item.id));
      const publicationVerify: VerifyOutput = { ...verify, report: verify.report.filter((item) => publishedIds.has(item.id)) };
      const runConfiguration = (verify.run_configuration ??= {}) as Record<string, unknown>;
      const cacheConfiguration = {
        schema: "leveret.review-cache-run/v1",
        enabled: cache.enabled,
        root: "host LEVERET_DATA/cache/review-v1 (outside reviewed checkout)",
        incremental: boundary,
        artifacts: cache.decisions,
        optional_dependency_sandbox: "disabled",
      };
      runConfiguration.cache = cacheConfiguration;
      const suppliedTimings: Record<string, unknown> = runConfiguration.timings && typeof runConfiguration.timings === "object" && !Array.isArray(runConfiguration.timings)
        ? runConfiguration.timings as Record<string, unknown>
        : {};
      runConfiguration.timings = {
        preparation_ms: Math.max(0, modelStartedAt - preparationStartedAt),
        model_ms: typeof suppliedTimings.model_ms === "number" ? suppliedTimings.model_ms : modelDurationMs,
        verification_ms: typeof suppliedTimings.verification_ms === "number" ? suppliedTimings.verification_ms : null,
        publication_ms: null,
        wall_ms: null,
        summed_worker_compute_ms: typeof suppliedTimings.summed_worker_compute_ms === "number" ? suppliedTimings.summed_worker_compute_ms : null,
      };
      const resultKey = cache.key("final-result", base, job.headSha, {
        evidence_pack_sha256: evidencePackFile.sha256,
        guidance_sha256: guidanceFile.sha256,
        trusted_base: base,
        runner: process.env.LEVERET_RUNNER ?? "deterministic-only",
        provider: process.env.LEVERET_RUNNER_PROVIDER ?? "openai",
        model: process.env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol",
        effort: process.env.LEVERET_RUNNER_EFFORT ?? "high",
        system_prompt: JSON.parse(stableJson(runConfiguration.system_prompt ?? null)),
      }, boundary);
      const priorResult = await cache.get(resultKey);
      await audit?.record("repository", "cache_decision", priorResult.decision);
      if (priorResult.value) {
        await audit?.record("repository", "cache_decision", cache.fallback(resultKey, "prior result retained as data; prompts, policy, knowledge, and verdicts are reevaluated"));
      }
      cacheConfiguration.artifacts = cache.decisions;
      cache.stage(resultKey, verify);
      cacheCompletion = {
        base,
        head: job.headSha,
        range: boundary.range ?? `${base}..${job.headSha}`,
        artifact_keys: {},
        findings: lifecycle.map((item) => ({ finding: item.finding, state: item.state })),
      };
      await audit?.writeResult(verify);
      const recordLeadPublication = async (published: boolean): Promise<void> => {
        const postWalk = verify.post_walk_leads;
        if (!postWalk) return;
        postWalk.accounting = markPostWalkLeadPublication(
          postWalk.accounting,
          publicationVerify.report.map((report) => report.id),
          published,
        );
        await audit?.record("result", "post_walk_publication_accounting", postWalk.accounting);
        await audit?.writeResult(verify);
      };

      const publicationStartedAt = performance.now();
      if (access) {
        await audit?.record("app", "publication_started", { repository: job.repo, pr: job.pr, head_sha: job.headSha, findings: publicationVerify.report.length, decisions: findingPublications });
        let reviewPublication: Awaited<ReturnType<typeof postReview>>;
        try {
          reviewPublication = await postReview(
            access,
            job.repo,
            job.pr,
            job.headSha,
            renderWalkthrough(publicationVerify, result, graph, graphify),
            renderInline(publicationVerify),
          );
        } catch (error) {
          await audit?.record("app", "publication_failed", { action: "review", error });
          await recordLeadPublication(false);
          throw error;
        }
        if (ackId) {
          try {
            await updateComment(access, job.repo, ackId, doneMessage(publicationVerify));
          } catch (error) {
            await audit?.record("app", "publication_failed", { action: "ack-completion-edit", comment_id: ackId, error });
          }
        }
        // act on the verifier's resolutions: short reply + resolve the thread
        for (const res of verify.resolutions ?? []) {
          if (res.status !== "resolved") continue;
          const pf = prior.find((p) => p.threadId === res.threadId);
          try {
            if (pf?.commentId) {
              await replyInThread(access, job.repo, job.pr, pf.commentId, resolvedReply(res.note, job.headSha));
            }
            await resolveThread(access, res.threadId);
            await audit?.record("app", "review_thread_resolved", { thread_id: res.threadId, comment_id: pf?.commentId, note: res.note });
          } catch (err) {
            await audit?.record("app", "publication_failed", { action: "thread-resolution", thread_id: res.threadId, error: err });
            log.warn("thread resolution failed", { threadId: res.threadId, err });
          }
        }
        log.info("review posted", {
          findings: publicationVerify.report.length,
          resolved: (verify.resolutions ?? []).filter((r) => r.status === "resolved").length,
        });
        if (reviewPublication.inlineFailure) {
          await audit?.record("app", "publication_failed", { action: "inline-review", retried_without_inline: true, error: reviewPublication.inlineFailure });
        }
        await audit?.record("app", "publication_completed", {
          repository: job.repo,
          pr: job.pr,
          review_id: reviewPublication.id,
          inline: reviewPublication.inline,
          inline_failure: reviewPublication.inlineFailure,
          ack_comment_id: ackId,
          findings: publicationVerify.report.length,
        });
      } else {
        const walkthrough = renderWalkthrough(publicationVerify, result, graph, graphify);
        log.info("review completed without GitHub publication", {
          findings: publicationVerify.report.length,
          walkthroughBytes: Buffer.byteLength(walkthrough),
          walkthroughSha256: createHash("sha256").update(walkthrough).digest("hex"),
        });
        await recordLeadPublication(false);
      }
      const timings = (runConfiguration.timings ?? {}) as Record<string, unknown>;
      timings.publication_ms = Math.max(0, performance.now() - publicationStartedAt);
      timings.wall_ms = Math.max(0, performance.now() - wallStartedAt);
      await audit?.record("result", "run_metrics", { timings, cache: runConfiguration.cache });
      await audit?.writeResult(verify);
    });
  } catch (err) {
    failure = err;
    log.error("review job failed", { err });
    // the crash report reaches the PR with the run id even when the ack never posted
    if (access) {
      const body = failMessage(err, runId);
      try {
        if (ackId) await updateComment(access, job.repo, ackId, body);
        else await postComment(access, job.repo, job.pr, body);
      } catch (publicationError) {
        await audit?.record("app", "publication_failed", { action: "failure-notice", error: publicationError }).catch(() => {});
      }
    }
    throw err;
  } finally {
    const cleanup: Record<string, unknown> = {};
    try {
      await trusted?.close();
      cleanup.trusted_state = trusted ? "closed" : "not-opened";
    } catch (error) {
      cleanup.trusted_state = "failed";
      cleanup.trusted_state_error = error;
    }
    for (const [name, path] of [["checkout", work], ["runner_work", runnerWork]] as const) {
      try {
        await rm(path, { recursive: true, force: true });
        cleanup[name] = "removed";
      } catch (error) {
        cleanup[name] = "failed";
        cleanup[`${name}_error`] = error;
      }
    }
    await audit?.record("lifecycle", "app_cleanup", cleanup);
    let finalized;
    try {
      finalized = await audit?.finalize(failure ? "failed" : "complete", failure);
    } catch (auditError) {
      if (audit?.config.failurePolicy === "fail") throw auditError;
      process.stdout.write(`${formatLine("error", "audit finalization failed; continuing by owner policy", bound, { err: auditError, completeness: "lost" })}\n`);
    }
    if (finalized) {
      process.stdout.write(`${formatLine("info", "audit finalized", bound, {
        status: finalized.status,
        runDir: finalized.runDir,
        archivePath: finalized.archive?.path,
        archiveSha256: finalized.archive?.sha256,
        archiveBytes: finalized.archive?.bytes,
        archiveMediaType: finalized.archive?.mediaType,
        degradation: finalized.degradation,
        completeness: finalized.completeness,
      })}\n`);
    }
    if (finalized?.status === "complete" && finalized.completeness === "complete" && cache?.enabled && cacheCompletion) {
      await cache.commitCompleted(cacheCompletion);
    } else {
      cache?.discard();
    }
  }
}

/** Human replies on findings persist raw for the agent-side learn ingestion;
 * extraction of the ruling stays with the agent — this layer never interprets. */
async function learnFeedJob(job: Extract<Job, { kind: "learn-feed" }>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(
    join(DATA_DIR, "learn-feed.jsonl"),
    `${JSON.stringify({ ...job, receivedAt: new Date().toISOString() })}\n`,
  );
}

/** where GitHub delivers webhooks: tunnel/smee channel, or the request host */
function hookUrl(req: IncomingMessage, port: number): string {
  return process.env.LEVERET_PUBLIC_URL ?? `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
}

/** where the browser returns after App creation: the host it is already on */
function redirectBase(req: IncomingMessage, port: number): string {
  return `http://${req.headers.host ?? `127.0.0.1:${port}`}`;
}

/** The brand assets, served so the setup pages have a logo and the user has an
 * avatar file to upload. Whitelisted by name: this server sits on a public tunnel. */
const ASSETS: Record<string, string> = {
  "/assets/logo.svg": "image/svg+xml",
  "/assets/logo.png": "image/png",
};

function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" }).end(body);
}

export async function main(): Promise<void> {
  let creds = await loadCredentials(DATA_DIR, process.env);
  const relayConfig = relayConfigFromEnv(process.env);
  const port = Number(process.env.PORT ?? 8090);
  // state token -> the org the setup page was opened for (undefined = personal
  // account); the callback needs it to link at the right App settings page
  const setupStates = new Map<string, string | undefined>();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");

    if (req.method === "GET" && ASSETS[url.pathname]) {
      readFile(new URL(`../..${url.pathname}`, import.meta.url))
        .then((buf) => res.writeHead(200, { "content-type": ASSETS[url.pathname]! }).end(buf))
        .catch(() => res.writeHead(404).end());
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/leveret") {
      const repository = url.searchParams.get("repo") ?? "";
      const installationId = url.searchParams.get("iid") ?? "";
      res.writeHead(relayConfig && relayChallengeAllowed(repository, installationId, relayConfig) ? 204 : 404).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      if (creds) {
        html(res, 200, renderConfiguredPage(DATA_DIR));
        return;
      }
      const state = randomBytes(16).toString("hex");
      const org = url.searchParams.get("org") ?? undefined;
      setupStates.set(state, org);
      html(res, 200, renderSetupPage(hookUrl(req, port), redirectBase(req, port), state, org, {
        publicUrlConfigured: Boolean(process.env.LEVERET_PUBLIC_URL),
        restartCommand: restartCommand(process.env, process.argv),
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/setup/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || !setupStates.has(state)) {
        html(res, 400, page("Leveret setup", '<p class="card err">Invalid or expired setup state — start again at <a href="/setup">/setup</a>.</p>'));
        return;
      }
      const org = setupStates.get(state);
      setupStates.delete(state);
      convertManifestCode(code)
        .then(async (c) => {
          await saveCredentials(DATA_DIR, c);
          creds = await loadCredentials(DATA_DIR, process.env);
          html(res, 200, renderCallbackPage(c.htmlUrl, org));
        })
        .catch((err) =>
          html(res, 500, page("Leveret setup", `<p class="card err">Setup failed: ${String(err)}</p>`)),
        );
      return;
    }

    if (req.method !== "POST") {
      html(
        res,
        creds || relayConfig ? 200 : 503,
        page(
          "Leveret",
          creds || relayConfig
            ? '<p class="card">Running — waiting on pull request webhooks.</p>'
            : '<p class="card">Unconfigured. <a href="/setup">Create your GitHub App</a> to get started.</p>',
        ),
      );
      return;
    }

    if (req.headers["x-leveret-signature"]) {
      if (!relayConfig) {
        res.writeHead(503).end();
        return;
      }
      void readCappedBody(req).then((body) => {
        if (body === null) {
          res.writeHead(413).end();
          return;
        }
        const verified = verifyRelayDelivery(req.headers, Buffer.from(body), relayConfig);
        if (!verified) {
          res.writeHead(401).end();
          return;
        }
        let job: Job | null = null;
        try {
          const payload = JSON.parse(body) as { repository?: { full_name?: string }; installation?: { id?: number } };
          if (payload.repository?.full_name !== verified.repository || payload.installation?.id !== verified.installationId) {
            throw new Error("signed relay fields do not match payload");
          }
          job = routeEvent(verified.event, payload as never, verified.delivery);
        } catch {
          res.writeHead(400).end();
          return;
        }
        res.writeHead(202).end();
        if (!job) return;
        const access = tokenAccess(verified.token, process.env.LEVERET_RELAY_BOT_LOGIN ?? "leveret[bot]");
        const run = job.kind === "review" ? reviewJob(job, access) : learnFeedJob(job);
        run.catch(() => {});
      });
      return;
    }

    // this endpoint is public: refuse on headers alone before buffering anything
    const reject = preBodyReject(req.headers);
    if (reject) {
      res.writeHead(reject).end();
      return;
    }
    if (!creds) {
      res.writeHead(503).end();
      return;
    }
    const activeCreds = creds;
    void readCappedBody(req).then((body) => {
      if (body === null) {
        res.writeHead(413).end();
        return;
      }
      if (!verifySignature(activeCreds.webhookSecret, body, req.headers["x-hub-signature-256"] as string | undefined)) {
        res.writeHead(401).end();
        return;
      }
      const event = req.headers["x-github-event"] as string;
      let job: Job | null = null;
      try {
        const delivery = req.headers["x-github-delivery"];
        job = routeEvent(event, JSON.parse(body), Array.isArray(delivery) ? delivery[0] : delivery);
      } catch {
        /* unparseable payload: acknowledge and ignore */
      }
      res.writeHead(202).end(); // ack fast; work happens after
      if (!job) return;
      const access = job.installationId
        ? appAccess(makeApp({ appId: activeCreds.appId, privateKey: activeCreds.privateKey }), job.installationId)
        : undefined;
      const run = job.kind === "review" ? reviewJob(job, access) : learnFeedJob(job);
      run.catch(() => {}); // job-level loggers already reported with the run id
    });
  });
  server.listen(port, () => process.stdout.write(`${formatLine("info", "server listening", {
    component: "app",
    port,
    configured: Boolean(creds || relayConfig),
    mode: creds ? "github-app" : relayConfig ? "relay" : "setup",
  })}\n`));
}

main().catch((err) => {
  process.stderr.write(`${formatLine("error", "server failed", { component: "app" }, { err })}\n`);
  process.exit(1);
});
