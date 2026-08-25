import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { loadCorpus, planTrials, runTrial, type CorpusRow, type ReplayRunner, type TrialPlan } from "../bench/replay.mjs";

const created: string[] = [];
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
function repository(): { root: string; repo: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "leveret-replay-test-"));
  created.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Replay Test");
  writeFileSync(join(repo, "target.txt"), "base\n");
  git(repo, "add", "target.txt");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "target.txt"), "defect-present\n");
  git(repo, "commit", "-qam", "head");
  return { root, repo, base, head: git(repo, "rev-parse", "HEAD") };
}
function plan(base: string, head: string, mode: TrialPlan["mode"] = "diff-only"): TrialPlan {
  return { schema: "leveret.replay-result/v1", id: "trial", corpus_sha256: "a".repeat(64), range_id: "range", repository: "pfBlockerNG/pfBlockerNG", pull_request: 2444, base, head, range: `${base}..${head}`, mode, trial: 1, target_ids: ["target"], work_item_path: null, work_item_sha256: null };
}
function row(preconditions: CorpusRow["preconditions"]): CorpusRow {
  return { id: "pfblockerng-2444-r3790082579", repository: "pfBlockerNG/pfBlockerNG", pull_request: 2444, pull_request_url: "https://github.com/pfBlockerNG/pfBlockerNG/pull/2444", external_id: "discussion_r3790082579", external_url: "https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790082579", disposition: "accepted", disposition_provenance: { kind: "maintainer-reply", url: "https://github.com/pfBlockerNG/pfBlockerNG/pull/2444#discussion_r3790182789", note: "applied" }, original_commit_id: "e".repeat(40), frozen: { range_id: "range", base: "b".repeat(40), head: "e".repeat(40), range: `${"b".repeat(40)}..${"e".repeat(40)}` }, source: { file: "target.txt", lines: { start: 1, end: 1 }, mechanism: "fixture" }, scorer_notes: "fixture", preconditions, work_item: { path: "work-item.json", schema: "leveret.work-item/v1", sha256: "f".repeat(64) } };
}
const scanResult = { findings: [], suppressed: [], reminders: [], engines: [], preExisting: 0, baseErrors: [] };
const completeRunner: ReplayRunner = async ({ env }) => ({ code: 0, stderr: "", stdout: JSON.stringify({ verdicts: [], report: [], coverage: { files: [], lenses: [] }, run_configuration: { capabilities: { probe: false }, tool_calls: [], system_prompt: { version: "2", sha256: "x" } } }) });
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("frozen full replay", () => {
  it("invalidates a failed defect precondition before scan or runner", async () => {
    const fixture = repository();
    const runner = vi.fn(completeRunner);
    const scan = vi.fn(async () => scanResult) as never;
    const outcome = await runTrial(plan(fixture.base, fixture.head), [row([{ kind: "contains", path: "target.txt", text: "already-repaired" }])], { repo: fixture.repo, traceRoot: join(fixture.root, "traces"), runner, scanFn: scan });
    expect(outcome).toMatchObject({ status: "invalid", phase: "precondition", reason: { code: "failed-precondition" } });
    expect(scan).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("invalidates missing review context while the identical diff-only trial remains runnable", async () => {
    const fixture = repository();
    let handedPack: unknown;
    let handedGuidance: unknown;
    const runner = vi.fn<ReplayRunner>(async (context) => {
      handedPack = JSON.parse(readFileSync(context.env.LEVERET_EVIDENCE_PACK!, "utf8"));
      handedGuidance = JSON.parse(readFileSync(context.env.LEVERET_GUIDANCE!, "utf8"));
      return completeRunner(context);
    });
    const target = row([{ kind: "contains", path: "target.txt", text: "defect-present" }]);
    const context = await runTrial(plan(fixture.base, fixture.head, "review-context"), [target], { repo: fixture.repo, traceRoot: join(fixture.root, "traces"), runner, scanFn: (async () => scanResult) as never });
    expect(context).toMatchObject({ status: "invalid", reason: { code: "missing-context" } });
    const diff = await runTrial(plan(fixture.base, fixture.head), [target], { repo: fixture.repo, traceRoot: join(fixture.root, "traces"), runner, scanFn: (async () => scanResult) as never, discoveryMode: "specialized-serial/v1" });
    expect(diff.status).toBe("complete");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![0].env.LEVERET_WORK_ITEM).toBeUndefined();
    expect(runner.mock.calls[0]![0].env.LEVERET_LEADS).toBeUndefined();
    expect(runner.mock.calls[0]![0].env.LEVERET_DISCOVERY_MODE).toBe("specialized-serial/v1");
    expect(runner.mock.calls[0]![0].env.LEVERET_TARGET_IDS).toBeUndefined();
    expect(runner.mock.calls[0]![0].env.LEVERET_EVIDENCE_PACK_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(runner.mock.calls[0]![0].env.LEVERET_GUIDANCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(handedPack).toMatchObject({ schema: "leveret.evidence-pack/v1", base: fixture.base, head: fixture.head });
    expect(handedGuidance).toMatchObject({ schema: "leveret.guidance-result/v1", base: fixture.base, head: fixture.head });
  });

  it("mechanically validates the fixture and makes repeated plans stable and unique", async () => {
    const corpus = await loadCorpus(join(dirname(fileURLToPath(import.meta.url)), "../bench/corpus.v1.json"));
    expect(corpus.corpus.rows.filter((item) => item.disposition === "accepted")).toHaveLength(12);
    expect(corpus.corpus.rows.filter((item) => item.disposition === "rejected")).toHaveLength(1);
    const first = planTrials(corpus, ["diff-only", "review-context"], 3);
    const second = planTrials(corpus, ["diff-only", "review-context"], 3);
    expect(second).toEqual(first);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);
    expect(first).toHaveLength(12);
  });
});
