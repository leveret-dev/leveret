#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadProfile } from "../profile.js";
import { scan } from "../scan.js";
import type { Finding, ScanResult } from "../findings.js";
import { ensureGraph } from "./graph.js";
import { botLogin, fetchReviewThreads, makeApp, postComment, postReview, replyInThread, resolveThread, updateComment } from "./github.js";
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
import { makeLogger } from "./log.js";
import { materializeTrustedReviewState, type TrustedReviewState } from "../trusted-state.js";
import { preBodyReject, readCappedBody, routeEvent, verifySignature, type Job } from "./webhook.js";

// The App layer: GitHub plumbing only. It holds the App key and webhook secret —
// never a model credential. The BYOAI seam is LEVERET_RUNNER: a user-supplied
// command (their agent, their provider, their hardware) that turns scan leads into
// a verified report. Without one, reviews run deterministic-only.
//
// Unconfigured servers boot into SETUP MODE: /setup drives GitHub's App Manifest
// flow, creating an App the USER owns (webhook pre-pointed here) and storing the
// returned credentials on this machine only.

const exec = promisify(execFile);

const DATA_DIR = process.env.LEVERET_DATA ?? join(homedir(), ".leveret-app");
const APP_CHILD_TIMEOUT_MS = 15 * 60_000;

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

async function reviewJob(job: Extract<Job, { kind: "review" }>, creds: AppCredentials): Promise<void> {
  const runId = randomUUID();
  const log = makeLogger({ runId, prUrl: `https://github.com/${job.repo}/pull/${job.pr}` });
  log.info("review job started", { headSha: job.headSha, action: job.action });
  const app = job.installationId ? makeApp({ appId: creds.appId, privateKey: creds.privateKey }) : null;
  let ackId: number | undefined;
  const work = await mkdtemp(join(tmpdir(), "leveret-app-"));
  const runnerWork = await mkdtemp(join(tmpdir(), "leveret-runner-"));
  let trusted: TrustedReviewState | undefined;
  try {
    await exec("git", ["clone", "--quiet", job.cloneUrl, work], { timeout: APP_CHILD_TIMEOUT_MS });
    await exec("git", ["fetch", "--quiet", "origin", `pull/${job.pr}/head`], { cwd: work, timeout: APP_CHILD_TIMEOUT_MS });
    await exec("git", ["checkout", "--quiet", job.headSha], { cwd: work, timeout: APP_CHILD_TIMEOUT_MS });
    const base = `origin/${job.baseRef}`;
    trusted = await materializeTrustedReviewState(work, base);

    // the repo's config may ask Leveret to stand down — say so once, then leave
    const profile = await loadProfile(trusted.profilePath);
    let skipReason: string | null = null;
    if (!profile.review.enabled) skipReason = "`review.enabled` is false in `.leveret.yml`";
    else if (profile.review.skipTitle && new RegExp(profile.review.skipTitle).test(job.title)) {
      skipReason = `the PR title matches \`review.skipTitle\` (\`${profile.review.skipTitle}\`)`;
    }
    if (skipReason) {
      if (app && job.installationId && job.action === "opened") {
        await postComment(app, job.installationId, job.repo, job.pr, skipMessage(skipReason)).catch(() => {});
      }
      return;
    }

    // the friendly heads-up, EDITED to the outcome when the job ends — a PR should
    // never show a silent bot or an eternal "working on it"
    if (app && job.installationId) {
      const model = process.env.LEVERET_RUNNER_MODEL ?? "gpt-5.6-sol";
      ackId = await postComment(app, job.installationId, job.repo, job.pr, ackMessage(job.headSha, model)).catch(
        () => undefined,
      );
    }
    // the checkout gets its code graph before any agent looks at it (owner ruling:
    // the graph is derived and always buildable — structure is queried, not grepped)
    const graph = await ensureGraph(work);
    if (!graph.ok) log.warn("codegraph unavailable", { detail: graph.detail });
    const result = await scan({
      repo: work,
      base,
      profilePath: trusted.profilePath,
      rulesRoot: trusted.root,
      memoryRepo: trusted.root,
      allowCustomEngines: false,
    });

    // incremental re-review: hand the runner the bot's own unresolved threads
    let prior: PriorFinding[] = [];
    if (app && job.installationId && job.action !== "opened") {
      try {
        const threads = await fetchReviewThreads(app, job.installationId, job.repo, job.pr);
        prior = parsePriorThreads(threads as Parameters<typeof parsePriorThreads>[0], await botLogin(app));
        if (prior.length > 0) {
          await writeFile(join(runnerWork, "prior.json"), JSON.stringify(prior, null, 1));
        }
      } catch (err) {
        log.warn("prior-thread fetch failed; reviewing without incremental context", { err });
      }
    }

    let verify: VerifyOutput;
    if (process.env.LEVERET_RUNNER) {
      const leadsPath = join(runnerWork, "leads.json");
      await writeFile(leadsPath, JSON.stringify(result, null, 1));
      const [cmd, ...args] = process.env.LEVERET_RUNNER.split(" ") as [string, ...string[]];
      // Default Pi budget: review + verify + one schema-correction phase, each 30m,
      // plus startup/cleanup slack. Custom runners can override explicitly.
      const runnerTimeout = Number(process.env.LEVERET_RUNNER_TIMEOUT_MS ?? 100 * 60_000);
      if (!Number.isFinite(runnerTimeout) || runnerTimeout <= 0) {
        throw new Error("LEVERET_RUNNER_TIMEOUT_MS must be a positive number");
      }
      const r = await exec(cmd, args, {
        cwd: runnerWork,
        maxBuffer: 64 * 1024 * 1024,
        timeout: runnerTimeout,
        env: {
          ...process.env,
          LEVERET_REPO: work,
          LEVERET_BASE: base,
          LEVERET_LEADS: leadsPath,
          LEVERET_GRAPH: graph.ok ? "1" : "0",
          ...(prior.length > 0 ? { LEVERET_PRIOR: join(runnerWork, "prior.json") } : {}),
        },
      });
      verify = JSON.parse(r.stdout) as VerifyOutput;
      // raw output persisted per run: schema forensics beat guessing
      await mkdir(join(DATA_DIR, "runs"), { recursive: true });
      await writeFile(join(DATA_DIR, "runs", `${runId}.json`), r.stdout).catch(() => {});
    } else {
      verify = reportFromScan(result);
    }

    if (app && job.installationId) {
      await postReview(
        app,
        job.installationId,
        job.repo,
        job.pr,
        job.headSha,
        renderWalkthrough(verify, result, graph),
        renderInline(verify),
      );
      if (ackId) {
        await updateComment(app, job.installationId, job.repo, ackId, doneMessage(verify)).catch(() => {});
      }
      // act on the verifier's resolutions: short reply + resolve the thread
      for (const res of verify.resolutions ?? []) {
        if (res.status !== "resolved") continue;
        const pf = prior.find((p) => p.threadId === res.threadId);
        try {
          if (pf?.commentId) {
            await replyInThread(app, job.installationId, job.repo, job.pr, pf.commentId, resolvedReply(res.note, job.headSha));
          }
          await resolveThread(app, job.installationId, res.threadId);
        } catch (err) {
          log.warn("thread resolution failed", { threadId: res.threadId, err });
        }
      }
      log.info("review posted", {
        findings: verify.report.length,
        resolved: (verify.resolutions ?? []).filter((r) => r.status === "resolved").length,
      });
    } else {
      console.log(renderWalkthrough(verify, result, graph));
    }
  } catch (err) {
    log.error("review job failed", { err });
    // the crash report reaches the PR with the run id even when the ack never posted
    if (app && job.installationId) {
      const body = failMessage(err, runId);
      if (ackId) await updateComment(app, job.installationId, job.repo, ackId, body).catch(() => {});
      else await postComment(app, job.installationId, job.repo, job.pr, body).catch(() => {});
    }
    throw err;
  } finally {
    await trusted?.close().catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(runnerWork, { recursive: true, force: true }).catch(() => {});
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
        creds ? 200 : 503,
        page(
          "Leveret",
          creds
            ? '<p class="card">Running — waiting on pull request webhooks.</p>'
            : '<p class="card">Unconfigured. <a href="/setup">Create your GitHub App</a> to get started.</p>',
        ),
      );
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
        job = routeEvent(event, JSON.parse(body));
      } catch {
        /* unparseable payload: acknowledge and ignore */
      }
      res.writeHead(202).end(); // ack fast; work happens after
      if (!job) return;
      const run = job.kind === "review" ? reviewJob(job, activeCreds) : learnFeedJob(job);
      run.catch(() => {}); // job-level loggers already reported with the run id
    });
  });
  server.listen(port, () =>
    console.log(
      creds
        ? `Leveret listening on :${port} (credentials in ${DATA_DIR})`
        : `Leveret UNCONFIGURED — open http://127.0.0.1:${port}/setup to create your GitHub App (credentials will be written to ${DATA_DIR})`,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
