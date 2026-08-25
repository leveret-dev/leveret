import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { auditConfig, createAuditRun, withAuditTrace } from "../src/audit.js";
import { materializeChangeEvidence, openChangeEvidence, type ChangeEvidence, type ChangeManifest } from "../src/change-evidence.js";
import { createEvidencePack, writeEvidencePack, type EvidencePack } from "../src/evidence-pack.js";
import { createGuidanceResult, writeGuidanceResult, SEMANTIC_DATA_SHA256, SEMANTIC_RULE_SET_SHA256, type GuidanceResult } from "../src/semantic-checks.js";
import { CAVEAT_CARD_SET_SHA256 } from "../src/caveat-cards.js";
import { executableIdentity, runStreaming } from "../src/exec.js";
import { ensureGraph } from "../src/app/graph.js";
import { scan } from "../src/scan.js";
import type { ScanResult } from "../src/findings.js";
import { ENGINES } from "../src/engines/registry.js";
import { loadProfile } from "../src/profile.js";
import { projectFacts, type ProjectFacts } from "../src/project-facts.js";
import { materializeTrustedReviewState, type TrustedReviewState } from "../src/trusted-state.js";
import { parseWorkItem, type WorkItem } from "../src/work-item.js";
import {
  ReviewCache,
  incrementalDependencyBoundary,
  projectFactsCacheSchema,
  scanResultCacheSchema,
  stableJson,
  type LastCompleted,
} from "../src/review-cache.js";
import { experimentManifestSchema, type ExperimentConfiguration, type ExperimentManifest } from "../src/runner/experiment.js";

export const CORPUS_SCHEMA = "leveret.replay-corpus/v1" as const;
export const REPLAY_RESULT_SCHEMA = "leveret.replay-result/v1" as const;
export type ContextMode = "diff-only" | "review-context";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const lineRange = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().refine((value) => value.end >= value.start, "line range end precedes start");
const textPrecondition = z.object({ kind: z.enum(["contains", "not_contains"]), path: z.string().min(1).max(500), text: z.string().min(1).max(16 * 1024), lines: lineRange.optional() }).strict();
const hashPrecondition = z.object({ kind: z.literal("sha256"), path: z.string().min(1).max(500), sha256 }).strict();
export const preconditionSchema = z.union([textPrecondition, hashPrecondition]);

export const corpusRowSchema = z.object({
  id: z.string().regex(/^pfblockerng-(2444|2521)-r\d+$/),
  repository: z.literal("pfBlockerNG/pfBlockerNG"),
  pull_request: z.number().int().positive(),
  pull_request_url: z.url(),
  external_id: z.string().regex(/^discussion_r\d+$/),
  external_url: z.url(),
  disposition: z.enum(["accepted", "rejected"]),
  disposition_provenance: z.object({ kind: z.enum(["maintainer-reply", "executed-control"]), url: z.url(), note: z.string().min(1) }).strict(),
  original_commit_id: sha,
  frozen: z.object({ range_id: z.string().min(1), base: sha, head: sha, range: z.string().min(82) }).strict(),
  source: z.object({ file: z.string().min(1), lines: lineRange, mechanism: z.string().min(1) }).strict(),
  scorer_notes: z.string().min(1),
  preconditions: z.array(preconditionSchema).min(1).max(8),
  work_item: z.object({ path: z.string().min(1), schema: z.literal("leveret.work-item/v1"), sha256 }).strict(),
}).strict();

export const corpusSchema = z.object({ schema: z.literal(CORPUS_SCHEMA), version: z.literal(1), identity: z.object({ name: z.literal("pfblockerng-coderabbit-original-commit"), sha256 }).strict(), rows: z.array(corpusRowSchema).length(13) }).strict();

export type CorpusRow = z.infer<typeof corpusRowSchema>;
export type Precondition = z.infer<typeof preconditionSchema>;
export type ReplayCorpus = z.infer<typeof corpusSchema>;
export interface LoadedCorpus { corpus: ReplayCorpus; path: string; workItems: Record<string, { path: string; workItem: WorkItem; sha256: string }> }

const EXPECTED_RANGES: Record<number, { base: string; head: string }> = {
  2444: { base: "8f08d6e4d7145a89fc4e15133d595e7a9825d673", head: "ed359c691e8002acaeb0a296bc69bf9ab1bbc97a" },
  2521: { base: "03d1e963f0e8fb4c4673b0fef6b12134ff7a037f", head: "b312a6def6d5b2c440431314081e4d9095d3dd6c" },
};
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function corpusIdentity(corpus: ReplayCorpus): string { return digest(JSON.stringify({ ...corpus, identity: { ...corpus.identity, sha256: "" } })); }
function assertUnique(values: string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`duplicate corpus ${label}`); }
function requireInside(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes its root`);
}

export async function loadCorpus(path: string): Promise<LoadedCorpus> {
  const corpusPath = resolve(path);
  const corpus = corpusSchema.parse(JSON.parse(await readFile(corpusPath, "utf8")));
  if (corpusIdentity(corpus) !== corpus.identity.sha256) throw new Error("corpus identity hash mismatch");
  assertUnique(corpus.rows.map((row) => row.id), "row id");
  assertUnique(corpus.rows.map((row) => row.external_id), "external id");
  assertUnique(corpus.rows.map((row) => row.external_url), "external URL");
  assertUnique(corpus.rows.map((row) => row.disposition_provenance.url), "disposition provenance URL");
  const accepted = corpus.rows.filter((row) => row.disposition === "accepted").length;
  const rejected = corpus.rows.filter((row) => row.disposition === "rejected").length;
  if (accepted !== 12 || rejected !== 1) throw new Error(`corpus must contain 12 accepted and 1 rejected row; got ${accepted} and ${rejected}`);
  const corpusDir = dirname(corpusPath);
  const workItems: LoadedCorpus["workItems"] = {};
  for (const row of corpus.rows) {
    const expected = EXPECTED_RANGES[row.pull_request];
    if (!expected || row.frozen.base !== expected.base || row.frozen.head !== expected.head || row.original_commit_id !== expected.head) throw new Error(`${row.id} does not use the frozen original-commit range`);
    if (row.pull_request_url !== `https://github.com/pfBlockerNG/pfBlockerNG/pull/${row.pull_request}` || !row.external_url.startsWith(`${row.pull_request_url}#${row.external_id}`) || !row.disposition_provenance.url.startsWith(`${row.pull_request_url}#discussion_r`)) throw new Error(`${row.id} has inconsistent external identity`);
    const itemPath = resolve(corpusDir, row.work_item.path);
    requireInside(corpusDir, itemPath, `${row.id} work-item path`);
    const content = await readFile(itemPath, "utf8");
    const itemHash = digest(content);
    if (itemHash !== row.work_item.sha256) throw new Error(`${row.id} work-item hash mismatch`);
    const workItem = parseWorkItem(content);
    if (workItem.fields.repository.value !== row.repository || workItem.fields.number.value !== row.pull_request || workItem.fields.base_sha.value !== row.frozen.base || workItem.fields.head_sha.value !== row.frozen.head) throw new Error(`${row.id} work-item identity mismatch`);
    if (workItem.fields.title.availability !== "present" || workItem.fields.body.availability !== "present" || Object.values(workItem.fields).some((field) => field.provenance.source !== "historical-replay")) throw new Error(`${row.id} work-item is not a complete historical snapshot`);
    const previous = workItems[row.frozen.range_id];
    if (previous && (previous.path !== itemPath || previous.sha256 !== itemHash)) throw new Error(`${row.id} range uses a different work-item snapshot`);
    workItems[row.frozen.range_id] = { path: itemPath, workItem, sha256: itemHash };
  }
  if (Object.keys(workItems).length !== 2) throw new Error("corpus must group into exactly two frozen ranges");
  return { corpus, path: corpusPath, workItems };
}

export interface PreconditionResult { precondition: Precondition; ok: boolean; detail: string }
export async function executePreconditions(repo: string, preconditions: Precondition[]): Promise<PreconditionResult[]> {
  const root = await realpath(repo);
  const results: PreconditionResult[] = [];
  for (const precondition of preconditions) {
    try {
      const candidate = resolve(root, precondition.path);
      requireInside(root, candidate, "precondition path");
      const actual = await realpath(candidate);
      requireInside(root, actual, "precondition target");
      const content = await readFile(actual);
      if (precondition.kind === "sha256") {
        const actualHash = digest(content);
        results.push({ precondition, ok: actualHash === precondition.sha256, detail: actualHash });
        continue;
      }
      const whole = content.toString("utf8");
      const selected = precondition.lines ? whole.split("\n").slice(precondition.lines.start - 1, precondition.lines.end).join("\n") : whole;
      const found = selected.includes(precondition.text);
      results.push({ precondition, ok: precondition.kind === "contains" ? found : !found, detail: found ? "text present" : "text absent" });
    } catch (error) { results.push({ precondition, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export interface TrialPlan {
  schema: typeof REPLAY_RESULT_SCHEMA; id: string; corpus_sha256: string; range_id: string; repository: string; pull_request: number; base: string; head: string; range: string; mode: ContextMode; trial: number; target_ids: string[]; work_item_path: string | null; work_item_sha256: string | null;
  experiment?: { configuration: ExperimentConfiguration; trial_id: string; cache_state: "cold" | "warm" };
}
export function planTrials(loaded: LoadedCorpus, modes: ContextMode[], trials: number): TrialPlan[] {
  if (!Number.isSafeInteger(trials) || trials <= 0) throw new Error("trials must be a positive integer");
  if (new Set(modes).size !== modes.length || modes.length === 0) throw new Error("modes must be non-empty and unique");
  const grouped = new Map<string, CorpusRow[]>();
  for (const row of loaded.corpus.rows) grouped.set(row.frozen.range_id, [...(grouped.get(row.frozen.range_id) ?? []), row]);
  const groups = [...grouped.values()].sort((a, b) => a[0]!.frozen.range_id.localeCompare(b[0]!.frozen.range_id));
  const plans: TrialPlan[] = [];
  for (const rows of groups) {
    const row = rows[0]!;
    const item = loaded.workItems[row.frozen.range_id];
    for (const mode of modes) for (let trial = 1; trial <= trials; trial++) {
      const key = `${loaded.corpus.identity.sha256}:${row.frozen.range_id}:${mode}:${trial}`;
      plans.push({ schema: REPLAY_RESULT_SCHEMA, id: digest(key).slice(0, 24), corpus_sha256: loaded.corpus.identity.sha256, range_id: row.frozen.range_id, repository: row.repository, pull_request: row.pull_request, base: row.frozen.base, head: row.frozen.head, range: row.frozen.range, mode, trial, target_ids: rows.map((candidate) => candidate.id).sort(), work_item_path: mode === "review-context" ? item?.path ?? null : null, work_item_sha256: mode === "review-context" ? item?.sha256 ?? null : null });
    }
  }
  assertUnique(plans.map((plan) => plan.id), "trial id");
  return plans;
}

export async function loadExperimentManifest(path: string, loaded: LoadedCorpus): Promise<ExperimentManifest> {
  const manifest = experimentManifestSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
  if (manifest.corpus.sha256 !== loaded.corpus.identity.sha256) throw new Error("experiment corpus SHA-256 does not match the loaded corpus");
  return manifest;
}

export function planExperimentTrials(loaded: LoadedCorpus, manifest: ExperimentManifest): TrialPlan[] {
  const grouped = new Map<string, CorpusRow[]>();
  for (const row of loaded.corpus.rows) grouped.set(row.frozen.range_id, [...(grouped.get(row.frozen.range_id) ?? []), row]);
  const groups = [...grouped.values()].sort((a, b) => a[0]!.frozen.range_id.localeCompare(b[0]!.frozen.range_id));
  const plans: TrialPlan[] = [];
  for (const configuration of manifest.configurations) for (let trial = 0; trial < configuration.trial_ids.length; trial++) for (const rows of groups) {
    const row = rows[0]!;
    const item = loaded.workItems[row.frozen.range_id];
    const trialId = configuration.trial_ids[trial]!;
    const key = `${configuration.configuration_sha256}:${row.frozen.range_id}:${trialId}`;
    plans.push({
      schema: REPLAY_RESULT_SCHEMA,
      id: digest(key).slice(0, 24),
      corpus_sha256: loaded.corpus.identity.sha256,
      range_id: row.frozen.range_id,
      repository: row.repository,
      pull_request: row.pull_request,
      base: row.frozen.base,
      head: row.frozen.head,
      range: row.frozen.range,
      mode: configuration.context_mode,
      trial: trial + 1,
      target_ids: rows.map((candidate) => candidate.id).sort(),
      work_item_path: configuration.context_mode === "review-context" ? item?.path ?? null : null,
      work_item_sha256: configuration.context_mode === "review-context" ? item?.sha256 ?? null : null,
      experiment: { configuration, trial_id: trialId, cache_state: trialId === configuration.cold_trial_id ? "cold" : "warm" },
    });
  }
  assertUnique(plans.map((plan) => plan.id), "experiment trial run id");
  return plans;
}

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> { const result = await exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return result.stdout.trim(); }
async function resolveCommit(repo: string, commit: string): Promise<boolean> {
  try { return await git(repo, ["rev-parse", "--verify", `${commit}^{commit}`]) === commit; }
  catch {
    try { await git(repo, ["fetch", "--quiet", "origin", commit]); } catch { return false; }
    try { return await git(repo, ["rev-parse", "--verify", `${commit}^{commit}`]) === commit; } catch { return false; }
  }
}

export interface RunnerContext { cwd: string; env: NodeJS.ProcessEnv }
export interface RunnerExecution { code: number; stdout: string; stderr: string; signal?: string; timedOut?: boolean }
export type ReplayRunner = (context: RunnerContext) => Promise<RunnerExecution>;
export type ReplayScan = typeof scan;
function commandRunner(command: string): ReplayRunner {
  const [file, ...args] = command.trim().split(/\s+/);
  if (!file) throw new Error("runner command is empty");
  return async ({ cwd, env }) => { const result = await runStreaming(file, args, cwd, { env, timeoutMs: 100 * 60_000, maxBuffer: 64 * 1024 * 1024 }); return { code: result.code, stdout: result.stdout, stderr: result.stderr, signal: result.signal, timedOut: result.timedOut }; };
}

export type InvalidCode = "missing-commit" | "base-mismatch" | "head-mismatch" | "missing-context" | "failed-precondition" | "runner-failure" | "incomplete-result" | "capability-mismatch" | "configuration-mismatch" | "incomplete-audit" | "orchestration-failure";
export interface InvalidReplay { schema: typeof REPLAY_RESULT_SCHEMA; plan: TrialPlan; status: "invalid"; phase: "preparation" | "precondition" | "scan" | "runner" | "audit"; reason: { code: InvalidCode; detail: string }; preconditions: PreconditionResult[]; audit_run_dir: string | null }
export interface CompleteReplay { schema: typeof REPLAY_RESULT_SCHEMA; plan: TrialPlan; status: "complete"; preconditions: PreconditionResult[]; audit_run_dir: string }
export type ReplayOutcome = InvalidReplay | CompleteReplay;
export interface RunTrialOptions { repo: string; traceRoot?: string; cacheRoot?: string; cache?: boolean; profilePath?: string; runner?: ReplayRunner; runnerCommand?: string; scanFn?: ReplayScan; expectedCapabilities?: Record<string, unknown>; discoveryMode?: "single" | "specialized/v1"; discoveryScheduler?: "serial/v1" | "bounded-concurrent/v1"; discoveryConcurrency?: number; routingPath?: string; routingSha256?: string }
function resultRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function completeResult(value: unknown): value is Record<string, unknown> { const record = resultRecord(value); return !!record && Array.isArray(record.verdicts) && Array.isArray(record.report) && !!resultRecord(record.coverage) && !!resultRecord(record.run_configuration); }
function capabilitiesMatch(result: Record<string, unknown>, expected: Record<string, unknown>): boolean { const configuration = resultRecord(result.run_configuration); const actual = resultRecord(configuration?.capabilities); return !!actual && Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value)); }
function experimentConfigurationGaps(result: Record<string, unknown>, configuration: ExperimentConfiguration): string[] {
  const run = resultRecord(result.run_configuration);
  const discovery = resultRecord(run?.discovery);
  const routing = resultRecord(run?.model_routing);
  const identities = resultRecord(run?.identities);
  const gaps: string[] = [];
  if (discovery?.mode !== configuration.discovery_mode) gaps.push("discovery mode");
  if (JSON.stringify(discovery?.scheduler ?? null) !== JSON.stringify(configuration.discovery_mode === "single" ? null : configuration.scheduler)) gaps.push("scheduler");
  if (routing?.sha256 !== configuration.routing.sha256 || routing?.schema !== configuration.routing.schema) gaps.push("routing");
  if (JSON.stringify(identities) !== JSON.stringify(configuration.identities)) gaps.push("prompt/tool/policy/card/rule/cache identities");
  return gaps;
}
function invalid(plan: TrialPlan, phase: InvalidReplay["phase"], code: InvalidCode, detail: string, preconditions: PreconditionResult[] = [], auditRunDir: string | null = null): InvalidReplay { return { schema: REPLAY_RESULT_SCHEMA, plan, status: "invalid", phase, reason: { code, detail }, preconditions, audit_run_dir: auditRunDir }; }

export async function runTrial(plan: TrialPlan, rows: CorpusRow[], options: RunTrialOptions): Promise<ReplayOutcome> {
  if (plan.experiment) {
    const configuration = plan.experiment.configuration;
    if (!options.routingPath || options.routingSha256 !== configuration.routing.sha256) {
      return invalid(plan, "preparation", "configuration-mismatch", "experiment runs require the pinned external model-routing file and exact SHA-256");
    }
    if (options.discoveryMode && options.discoveryMode !== configuration.discovery_mode) return invalid(plan, "preparation", "configuration-mismatch", "runner discovery mode differs from experiment manifest");
    if (options.discoveryScheduler && options.discoveryScheduler !== configuration.scheduler.id) return invalid(plan, "preparation", "configuration-mismatch", "runner scheduler differs from experiment manifest");
    if (options.discoveryConcurrency && options.discoveryConcurrency !== configuration.scheduler.concurrency_bound) return invalid(plan, "preparation", "configuration-mismatch", "runner concurrency differs from experiment manifest");
  }
  const repo = await realpath(options.repo);
  if (!await resolveCommit(repo, plan.base)) return invalid(plan, "preparation", "missing-commit", `base commit unavailable: ${plan.base}`);
  if (!await resolveCommit(repo, plan.head)) return invalid(plan, "preparation", "missing-commit", `head commit unavailable: ${plan.head}`);
  if (await git(repo, ["merge-base", plan.base, plan.head]) !== plan.base) return invalid(plan, "preparation", "base-mismatch", "frozen base is not the reviewed head's merge base");
  if (plan.mode === "review-context" && (!plan.work_item_path || !plan.work_item_sha256)) return invalid(plan, "preparation", "missing-context", "review-context mode requires its frozen work-item");
  if (plan.mode === "review-context") {
    try { if (digest(await readFile(plan.work_item_path!)) !== plan.work_item_sha256) return invalid(plan, "preparation", "missing-context", "frozen work-item hash mismatch"); }
    catch (error) { return invalid(plan, "preparation", "missing-context", String(error)); }
  }
  const root = await mkdtemp(join(tmpdir(), "leveret-replay-"));
  const checkout = join(root, "checkout");
  const runnerDir = join(root, "runner");
  await mkdir(runnerDir);
  let audit: Awaited<ReturnType<typeof createAuditRun>> = undefined;
  let auditRunDir: string | null = null;
  let preconditions: PreconditionResult[] = [];
  let trusted: TrustedReviewState | undefined;
  let cache: ReviewCache | undefined;
  let cacheCompletion: Omit<LastCompleted, "schema" | "version" | "repository_sha256" | "pull_request" | "completed_at"> | undefined;
  try {
    await git(repo, ["worktree", "add", "--quiet", "--detach", checkout, plan.head]);
    const actualHead = await git(checkout, ["rev-parse", "HEAD"]);
    if (actualHead !== plan.head) return invalid(plan, "preparation", "head-mismatch", `detached HEAD is ${actualHead}`);
    const actualBase = await git(checkout, ["merge-base", plan.base, "HEAD"]);
    if (actualBase !== plan.base) return invalid(plan, "preparation", "base-mismatch", `resolved base is ${actualBase}`);
    preconditions = await executePreconditions(checkout, rows.flatMap((row) => row.preconditions));
    const failed = preconditions.find((condition) => !condition.ok);
    if (failed) return invalid(plan, "precondition", "failed-precondition", `${failed.precondition.path}: ${failed.detail}`, preconditions);
    trusted = await materializeTrustedReviewState(checkout, plan.base);
    const traceRoot = resolve(options.traceRoot ?? join(tmpdir(), "leveret-replay-traces"));
    const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const rootPath of [harnessRoot, repo]) { const rel = relative(rootPath, traceRoot); if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) return invalid(plan, "preparation", "orchestration-failure", "private trace root must stay outside both repositories", preconditions); }
    await mkdir(traceRoot, { recursive: true });
    const runId = randomUUID();
    const traceEnvironment = { LEVERET_TRACE_ENABLED: "1", LEVERET_TRACE_ROOT: traceRoot, LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_FAILURE: "fail", LEVERET_TRACE_KEEP_UNPACKED: "1" };
    audit = await createAuditRun(auditConfig(traceRoot, traceEnvironment), runId);
    if (!audit) return invalid(plan, "audit", "incomplete-audit", "#51 audit capture is disabled", preconditions);
    cache = await ReviewCache.open({
      dataRoot: resolve(options.cacheRoot ?? traceRoot),
      repoRoot: checkout,
      repository: plan.repository,
      pullRequest: plan.pull_request,
      enabled: options.cache !== false,
    });
    const lastCompleted = await cache.readLastCompleted();
    await audit.record("repository", "cache_metadata", cache.lastCompletedDecision);
    const boundary = await incrementalDependencyBoundary(checkout, lastCompleted?.head ?? null, plan.head);
    await audit.record("repository", "incremental_range", boundary);
    let failure: InvalidReplay | undefined;
    let parsed: Record<string, unknown> | undefined;
    try {
      await withAuditTrace(audit, async () => {
        await audit!.record("app", "replay_started", { plan, corpus_target_ids: plan.target_ids });
        await audit!.record("repository", "defect_preconditions_validated", { results: preconditions });
        const preparationStartedAt = performance.now();
        const evidencePath = join(runnerDir, "change-evidence.v1.json");
        const manifestKey = cache!.key("change-manifest", plan.base, plan.head, {
          schema_version: 1,
          range: plan.range,
        }, boundary);
        const cachedManifest = await cache!.get<ChangeManifest>(manifestKey);
        await audit!.record("repository", "cache_decision", cachedManifest.decision);
        let evidence: ChangeEvidence;
        if (cachedManifest.value) {
          try {
            await writeFile(evidencePath, `${JSON.stringify(cachedManifest.value)}\n`);
            evidence = await openChangeEvidence(checkout, evidencePath);
          } catch (error) {
            await audit!.record("repository", "cache_decision", cache!.invalidate(manifestKey, `cached manifest failed checkout validation: ${String(error)}`));
            evidence = await materializeChangeEvidence(checkout, plan.base, evidencePath, plan.head);
            cache!.stage(manifestKey, evidence.manifest);
          }
        } else {
          evidence = await materializeChangeEvidence(checkout, plan.base, evidencePath, plan.head);
          cache!.stage(manifestKey, evidence.manifest);
        }
        const auditPatch = await evidence.auditPatch();
        await audit!.record("repository", "review_diff", {
          base_sha: evidence.manifest.base,
          head_sha: evidence.manifest.head,
          range: plan.range,
          changed_files: evidence.manifest.files.map((file) => file.path),
          change_manifest: evidence.manifest,
          unified_diff: auditPatch.patch,
          sha256: auditPatch.sha256,
          bytes: auditPatch.bytes,
        });
        const graphKey = cache!.key("graph-toolchain", plan.base, plan.head, {
          node: process.version,
          binary: process.env.LEVERET_CODEGRAPH_BIN ?? "codegraph",
          sandbox: "disabled",
        }, boundary);
        await audit!.record("repository", "cache_decision", cache!.fallback(graphKey, "checkout-local graph index must be rebuilt; dependency/tool sandbox is disabled"));
        const graph = await ensureGraph(checkout);
        const effectiveProfilePath = options.profilePath ?? trusted!.profilePath;
        const profile = await loadProfile(effectiveProfilePath);
        const profileSha256 = digest(stableJson(profile));
        const manifestSha256 = digest(stableJson(evidence.manifest));
        const engineIdentity = JSON.parse(stableJson(await Promise.all(ENGINES.map(async (engine) => ({
          id: engine.id,
          bin: engine.bin,
          executable: await executableIdentity(engine.bin, checkout),
        })))));
        const scanKey = cache!.key("scan-result", plan.base, plan.head, {
          manifest_sha256: manifestSha256,
          profile_sha256: profileSha256,
          trusted_base: plan.base,
          engines: engineIdentity,
          allow_custom_engines: false,
        }, boundary);
        const cachedScan = await cache!.get<unknown>(scanKey);
        await audit!.record("repository", "cache_decision", cachedScan.decision);
        const parsedScan = cachedScan.value === undefined ? undefined : scanResultCacheSchema.safeParse(cachedScan.value);
        if (parsedScan && !parsedScan.success) await audit!.record("repository", "cache_decision", cache!.invalidate(scanKey, `cached scan result failed strict schema validation: ${parsedScan.error.message}`));
        const cachedScanResult: ScanResult | undefined = parsedScan?.success ? parsedScan.data : undefined;
        const scanResult = cachedScanResult ?? await (options.scanFn ?? scan)({
          repo: checkout,
          base: evidence.manifest.base,
          manifest: evidence.manifest,
          profilePath: effectiveProfilePath,
          rulesRoot: trusted!.root,
          memoryRepo: trusted!.root,
          allowCustomEngines: false,
        });
        if (!cachedScanResult) cache!.stage(scanKey, scanResult);
        await audit!.record("repository", "scan_completed", { base_sha: plan.base, head_sha: plan.head, graph, scan: scanResult });
        const factsKey = cache!.key("project-facts", plan.base, plan.head, {
          manifest_sha256: manifestSha256,
          project_facts_version: 1,
        }, boundary);
        const cachedFacts = await cache!.get<unknown>(factsKey);
        await audit!.record("repository", "cache_decision", cachedFacts.decision);
        const parsedFacts = cachedFacts.value === undefined ? undefined : projectFactsCacheSchema.safeParse(cachedFacts.value);
        if (parsedFacts && !parsedFacts.success) await audit!.record("repository", "cache_decision", cache!.invalidate(factsKey, `cached project facts failed strict schema validation: ${parsedFacts.error.message}`));
        const cachedProjectFacts: ProjectFacts | undefined = parsedFacts?.success ? parsedFacts.data : undefined;
        if (lastCompleted?.head !== plan.head && boundary.reusable_artifacts.includes("project-facts")) {
          await audit!.record("repository", "cache_decision", cache!.fallback(factsKey, "cross-head project-facts reuse not proven against exact checkout; recomputing owning artifact"));
        }
        const facts = cachedProjectFacts ?? await projectFacts(checkout);
        if (!cachedProjectFacts) cache!.stage(factsKey, facts);
        const evidenceKey = cache!.key("evidence-pack", plan.base, plan.head, {
          manifest_sha256: manifestSha256,
          scan_key: cache!.keyDigest(scanKey),
          project_key: cache!.keyDigest(factsKey),
          profile_sha256: profileSha256,
          trusted_base: plan.base,
          engines: engineIdentity,
        }, boundary);
        const cachedPack = await cache!.get<EvidencePack>(evidenceKey);
        await audit!.record("repository", "cache_decision", cachedPack.decision);
        const evidencePack = cachedPack.value ?? await createEvidencePack({
          repo: checkout,
          manifest: evidence.manifest,
          profile,
          profilePath: effectiveProfilePath,
          rulesRoot: trusted!.root,
          project: facts,
          scan: scanResult,
          engines: ENGINES,
        });
        if (!cachedPack.value) cache!.stage(evidenceKey, evidencePack);
        const evidencePackFile = await writeEvidencePack(checkout, join(runnerDir, "evidence-pack.v1.json"), evidencePack);
        const guidanceKey = cache!.key("guidance-selection", plan.base, plan.head, {
          evidence_pack_sha256: evidencePackFile.sha256,
          trusted_base: plan.base,
          guidance_schema: "leveret.guidance-result/v1",
          card_set_sha256: CAVEAT_CARD_SET_SHA256,
          rule_set_sha256: SEMANTIC_RULE_SET_SHA256,
          data_sha256: SEMANTIC_DATA_SHA256,
        }, boundary);
        const cachedGuidance = await cache!.get<GuidanceResult>(guidanceKey);
        await audit!.record("repository", "cache_decision", cachedGuidance.decision);
        const guidance = cachedGuidance.value ?? await createGuidanceResult(checkout, evidencePackFile);
        if (!cachedGuidance.value) cache!.stage(guidanceKey, guidance);
        const guidanceFile = await writeGuidanceResult(checkout, join(runnerDir, "guidance-result.v1.json"), guidance);
        await audit!.record("repository", "evidence_pack", { pack: evidencePack, schema: evidencePack.schema, sha256: evidencePackFile.sha256, bytes: evidencePackFile.bytes });
        await audit!.record("repository", "guidance_result", { guidance: guidanceFile.guidance, schema: guidanceFile.guidance.schema, sha256: guidanceFile.sha256, bytes: guidanceFile.bytes, selected_card_ids: guidanceFile.guidance.selectedCards.map((card) => card.id), selected_rule_ids: guidanceFile.guidance.selectedCards.flatMap((card) => card.ruleId ? [card.ruleId] : []), emitted_rule_lead_ids: guidanceFile.guidance.ruleLeads.map((lead) => lead.id), selected_mutation_ids: [...new Set(guidanceFile.guidance.mutationLeads.map((lead) => lead.mutationId))].sort(), hashes: guidanceFile.guidance.provenance });
        await audit!.writeCapabilities({ graph, scanner: { engines: scanResult.engines }, evidence_pack: { schema: evidencePack.schema, sha256: evidencePackFile.sha256, bytes: evidencePackFile.bytes }, guidance: { schema: guidanceFile.guidance.schema, sha256: guidanceFile.sha256, bytes: guidanceFile.bytes }, node: process.version });
        let workItemPath: string | undefined;
        if (plan.mode === "review-context") { workItemPath = join(runnerDir, "work-item.json"); await copyFile(plan.work_item_path!, workItemPath); await audit!.record("app", "work_item_materialized", { schema: "leveret.work-item/v1", sha256: plan.work_item_sha256, path_role: "outside-checkout runner input" }); }
        else await audit!.record("app", "work_item_omitted", { context_mode: "diff-only" });
        const cacheRunPath = join(runnerDir, "cache-run.v1.json");
        await writeFile(cacheRunPath, `${stableJson({
          schema: "leveret.review-cache-run/v1",
          enabled: cache!.enabled,
          incremental: boundary,
          artifacts: cache!.decisions,
          optional_dependency_sandbox: "disabled",
        })}\n`);
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LEVERET_TRACE_")));
        const experimentConfiguration = plan.experiment?.configuration;
        const selectedDiscoveryMode = experimentConfiguration?.discovery_mode ?? options.discoveryMode ?? "single";
        const selectedScheduler = experimentConfiguration?.scheduler.id ?? options.discoveryScheduler ?? "serial/v1";
        const selectedConcurrency = experimentConfiguration?.scheduler.concurrency_bound ?? options.discoveryConcurrency ?? 1;
        const env = {
          ...inherited,
          ...traceEnvironment,
          LEVERET_REPO: checkout,
          LEVERET_BASE: plan.base,
          LEVERET_CHANGE_MANIFEST: evidencePath,
          LEVERET_EVIDENCE_PACK: evidencePackFile.path,
          LEVERET_EVIDENCE_PACK_SHA256: evidencePackFile.sha256,
          LEVERET_GUIDANCE: guidanceFile.path,
          LEVERET_GUIDANCE_SHA256: guidanceFile.sha256,
          LEVERET_CACHE_RUN: cacheRunPath,
          LEVERET_GRAPH: graph.ok ? "1" : "0",
          LEVERET_TRACE_DIR: audit!.partialDir,
          LEVERET_RUN_ID: runId,
          LEVERET_DATA: traceRoot,
          LEVERET_DISCOVERY_MODE: selectedDiscoveryMode,
          LEVERET_DISCOVERY_SCHEDULER: selectedScheduler,
          LEVERET_DISCOVERY_CONCURRENCY: String(selectedConcurrency),
          ...(options.routingPath ? { LEVERET_MODEL_ROUTING: resolve(options.routingPath), LEVERET_MODEL_ROUTING_SHA256: options.routingSha256! } : {}),
          ...(workItemPath ? { LEVERET_WORK_ITEM: workItemPath } : {}),
        };
        const runner = options.runner ?? commandRunner(options.runnerCommand ?? process.env.LEVERET_RUNNER ?? `${process.execPath} ${resolve(harnessRoot, "dist/runner/pi.js")}`);
        await audit!.record("lifecycle", "runner_started", { context_mode: plan.mode, discovery_mode: selectedDiscoveryMode, discovery_scheduler: selectedScheduler, discovery_concurrency: selectedConcurrency, experiment: plan.experiment ?? null, environment_names: Object.keys(env).sort() });
        const result = await runner({ cwd: runnerDir, env });
        await audit!.record("result", "runner_output_received", { raw: result.stdout, code: result.code, signal: result.signal ?? null, timed_out: result.timedOut ?? false });
        if (result.code !== 0) { failure = invalid(plan, "runner", "runner-failure", `runner exited ${result.code}${result.signal ? ` (${result.signal})` : ""}: ${result.stderr.slice(0, 500)}`, preconditions); return; }
        try { parsed = JSON.parse(result.stdout) as Record<string, unknown>; } catch (error) { failure = invalid(plan, "runner", "incomplete-result", `runner output is not JSON: ${String(error)}`, preconditions); return; }
        if (!completeResult(parsed)) { failure = invalid(plan, "runner", "incomplete-result", "runner result lacks verdicts, report, coverage, or run_configuration", preconditions); return; }
        if (options.expectedCapabilities && !capabilitiesMatch(parsed, options.expectedCapabilities)) { failure = invalid(plan, "runner", "capability-mismatch", "runner capabilities differ from the declared configuration", preconditions); return; }
        if (plan.experiment) {
          const gaps = experimentConfigurationGaps(parsed, plan.experiment.configuration);
          if (gaps.length > 0) { failure = invalid(plan, "runner", "configuration-mismatch", `runner output differs from experiment manifest: ${gaps.join(", ")}`, preconditions); return; }
        }
        await audit!.record("result", "runner_output_parsed", parsed);
        await audit!.writeResult(parsed);
        const runConfiguration = parsed.run_configuration as Record<string, unknown>;
        if (plan.experiment) runConfiguration.experiment = {
          schema: "leveret.replay-experiment-run/v1",
          configuration_id: plan.experiment.configuration.id,
          configuration_sha256: plan.experiment.configuration.configuration_sha256,
          trial_id: plan.experiment.trial_id,
          cache_state: plan.experiment.cache_state,
          reference_hardware: plan.experiment.configuration.reference_hardware,
        };
        const cacheConfiguration = {
          schema: "leveret.review-cache-run/v1",
          enabled: cache!.enabled,
          root: "host LEVERET_DATA/cache/review-v1 (outside reviewed checkout)",
          incremental: boundary,
          artifacts: cache!.decisions,
          optional_dependency_sandbox: "disabled",
        };
        runConfiguration.cache = cacheConfiguration;
        const timings = (runConfiguration.timings && typeof runConfiguration.timings === "object" ? runConfiguration.timings : {}) as Record<string, unknown>;
        timings.preparation_ms ??= Math.max(0, performance.now() - preparationStartedAt);
        timings.publication_ms ??= 0;
        timings.wall_ms ??= Math.max(0, performance.now() - preparationStartedAt);
        timings.summed_worker_compute_ms ??= null;
        runConfiguration.timings = timings;
        const resultKey = cache!.key("final-result", plan.base, plan.head, {
          evidence_pack_sha256: evidencePackFile.sha256,
          guidance_sha256: guidanceFile.sha256,
          trusted_base: plan.base,
          runner: options.runnerCommand ?? process.env.LEVERET_RUNNER ?? "direct-runner",
          system_prompt: JSON.parse(stableJson(runConfiguration.system_prompt ?? null)),
        }, boundary);
        const priorResult = await cache!.get(resultKey);
        await audit!.record("repository", "cache_decision", priorResult.decision);
        if (priorResult.value) await audit!.record("repository", "cache_decision", cache!.fallback(resultKey, "prior result retained as data; prompts, policy, knowledge, and verdicts are reevaluated"));
        cacheConfiguration.artifacts = cache!.decisions;
        cache!.stage(resultKey, parsed);
        cacheCompletion = {
          base: plan.base,
          head: plan.head,
          range: plan.range,
          artifact_keys: {},
          findings: [],
        };
        await audit!.writeResult(parsed);
      });
    } catch (error) { failure = invalid(plan, "runner", "orchestration-failure", error instanceof Error ? error.message : String(error), preconditions); }
    const finalized = await audit.finalize(failure ? "failed" : "complete", failure?.reason.detail);
    auditRunDir = finalized.runDir ?? null;
    if (failure) { cache?.discard(); return { ...failure, audit_run_dir: auditRunDir }; }
    if (finalized.status !== "complete" || finalized.completeness !== "complete" || !auditRunDir) {
      cache?.discard();
      return invalid(plan, "audit", "incomplete-audit", `audit finalized ${finalized.status}/${finalized.completeness}`, preconditions, auditRunDir);
    }
    if (cache?.enabled && cacheCompletion) await cache.commitCompleted(cacheCompletion);
    return { schema: REPLAY_RESULT_SCHEMA, plan, status: "complete", preconditions, audit_run_dir: auditRunDir };
  } catch (error) {
    try { if (audit && !auditRunDir) auditRunDir = (await audit.finalize("failed", error)).runDir ?? null; } catch { /* retain original failure */ }
    cache?.discard();
    return invalid(plan, "preparation", "orchestration-failure", error instanceof Error ? error.message : String(error), preconditions, auditRunDir);
  } finally {
    if (trusted) await trusted.close().catch(() => {});
    try { await git(repo, ["worktree", "remove", "--force", checkout]); } catch { /* not registered */ }
    await rm(root, { recursive: true, force: true });
  }
}

function option(args: string[], name: string, fallback?: string): string | undefined { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const corpusPath = option(args, "--corpus", join(dirname(fileURLToPath(import.meta.url)), "corpus.v1.json"))!;
  const loaded = await loadCorpus(corpusPath);
  const experimentPath = option(args, "--experiment");
  const experiment = experimentPath ? await loadExperimentManifest(experimentPath, loaded) : undefined;
  if (args.includes("--plan")) {
    if (!experiment) throw new Error("experiment planning requires --experiment manifest.json");
    process.stdout.write(`${JSON.stringify({ schema: "leveret.replay-plan/v1", corpus: experiment.corpus, configurations: experiment.configurations, runs: planExperimentTrials(loaded, experiment) }, null, 2)}\n`);
    return;
  }
  const repo = args[0];
  if (!repo || repo.startsWith("--")) throw new Error("usage: replay.mts <repo> [--experiment manifest.json --routing routing.json --routing-sha256 HASH] [--corpus path] [--mode diff-only|review-context|both] [--discovery-mode single|specialized/v1] [--discovery-scheduler serial/v1|bounded-concurrent/v1] [--discovery-concurrency 1..3] [--trials N] [--profile path] [--trace-root path] [--cache-root path] [--no-cache] [--runner command] [--capabilities expected.json]");
  const modeArg = option(args, "--mode", "both");
  const modes: ContextMode[] = modeArg === "both" ? ["diff-only", "review-context"] : modeArg === "diff-only" || modeArg === "review-context" ? [modeArg] : (() => { throw new Error(`invalid mode: ${modeArg}`); })();
  const capabilitiesPath = option(args, "--capabilities");
  const expectedCapabilities = capabilitiesPath ? resultRecord(JSON.parse(await readFile(capabilitiesPath, "utf8"))) ?? (() => { throw new Error("capabilities file must contain an object"); })() : undefined;
  const discoveryMode = option(args, "--discovery-mode", "single");
  if (discoveryMode !== "single" && discoveryMode !== "specialized/v1") throw new Error(`invalid discovery mode: ${discoveryMode}`);
  const discoveryScheduler = option(args, "--discovery-scheduler", "serial/v1");
  if (discoveryScheduler !== "serial/v1" && discoveryScheduler !== "bounded-concurrent/v1") throw new Error(`invalid discovery scheduler: ${discoveryScheduler}`);
  const discoveryConcurrency = Number(option(args, "--discovery-concurrency", discoveryScheduler === "serial/v1" ? "1" : "3"));
  const plans = experiment ? planExperimentTrials(loaded, experiment) : planTrials(loaded, modes, Number(option(args, "--trials", "1")));
  for (const plan of plans) {
    const rows = loaded.corpus.rows.filter((row) => row.frozen.range_id === plan.range_id);
    process.stdout.write(`${JSON.stringify(await runTrial(plan, rows, {
      repo,
      traceRoot: option(args, "--trace-root"),
      cacheRoot: option(args, "--cache-root"),
      cache: !args.includes("--no-cache"),
      profilePath: option(args, "--profile"),
      runnerCommand: option(args, "--runner"),
      expectedCapabilities,
      discoveryMode: experiment ? undefined : discoveryMode,
      discoveryScheduler: experiment ? undefined : discoveryScheduler,
      discoveryConcurrency: experiment ? undefined : discoveryConcurrency,
      routingPath: option(args, "--routing"),
      routingSha256: option(args, "--routing-sha256"),
    }))}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
