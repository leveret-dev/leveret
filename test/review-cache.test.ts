import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReviewCache,
  canonicalRepositoryIdentity,
  compareColdWarmResults,
  findingSnapshot,
  incrementalDependencyBoundary,
  publicationDecisions,
  reconcileFindings,
} from "../src/review-cache.js";

const roots: string[] = [];
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function repository() {
  const root = mkdtempSync(join(tmpdir(), "leveret-cache-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo);
  mkdirSync(data);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "cache@example.invalid");
  git(repo, "config", "user.name", "Cache Test");
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return { root, repo, data, base: git(repo, "rev-parse", "HEAD") };
}

function completed(base: string, head = base) {
  return { base, head, range: `${base}..${head}`, artifact_keys: {}, findings: [] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host-owned review cache", () => {
  it("hits an exact warm key and preserves canonical cold/warm behavior", async () => {
    const fixture = repository();
    const cold = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "Owner/Repo", pullRequest: 64 });
    const coldBoundary = await incrementalDependencyBoundary(fixture.repo, null, fixture.base);
    const key = cold.key("change-manifest", fixture.base, fixture.base, { source: sha256("fixed") }, coldBoundary);
    expect((await cold.get(key)).decision).toMatchObject({ outcome: "miss", reason: expect.any(String) });
    cold.stage(key, { manifest: "fixed" });
    await cold.commitCompleted(completed(fixture.base));

    const warm = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/repo", pullRequest: 64 });
    const warmBoundary = await incrementalDependencyBoundary(fixture.repo, fixture.base, fixture.base);
    const warmKey = warm.key("change-manifest", fixture.base, fixture.base, { source: sha256("fixed") }, warmBoundary);
    expect(await warm.get(warmKey)).toMatchObject({ value: { manifest: "fixed" }, decision: { outcome: "hit", reason: expect.any(String) } });
    expect(compareColdWarmResults(
      { report: [{ id: "R1" }], run_configuration: { cache: { hit: false }, timings: { wall_ms: 9 }, process: { pid: 1 } } },
      { run_configuration: { process: { pid: 2 }, timings: { wall_ms: 1 }, cache: { hit: true } }, report: [{ id: "R1" }] },
    )).toMatchObject({ equal: true, cold_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("falls back for source and policy changes while identifying docs-only safe identities", async () => {
    const fixture = repository();
    writeFileSync(join(fixture.repo, "source.ts"), "export const value = 2;\n");
    git(fixture.repo, "commit", "-qam", "source");
    const sourceHead = git(fixture.repo, "rev-parse", "HEAD");
    const source = await incrementalDependencyBoundary(fixture.repo, fixture.base, sourceHead);
    expect(source).toMatchObject({ full_recompute: true, fallback_reason: expect.stringContaining("source changed") });
    expect(source.affected_paths).toContainEqual({ path: "source.ts", reasons: expect.arrayContaining(["changed in exact incremental range"]) });

    writeFileSync(join(fixture.repo, "README.md"), "docs\n");
    git(fixture.repo, "add", "README.md");
    git(fixture.repo, "commit", "-qm", "docs");
    const docsHead = git(fixture.repo, "rev-parse", "HEAD");
    const docs = await incrementalDependencyBoundary(fixture.repo, sourceHead, docsHead);
    expect(docs).toMatchObject({ full_recompute: false, fallback_reason: null });
    expect(docs.reusable_artifacts).toEqual(["project-facts", "graph-toolchain"]);

    writeFileSync(join(fixture.repo, ".leveret.yml"), "review: { enabled: true }\n");
    git(fixture.repo, "add", ".leveret.yml");
    git(fixture.repo, "commit", "-qm", "policy");
    const policy = await incrementalDependencyBoundary(fixture.repo, docsHead, git(fixture.repo, "rev-parse", "HEAD"));
    expect(policy).toMatchObject({ full_recompute: true, fallback_reason: expect.stringContaining("policy") });
  });

  it("invalidates tool, card, policy, and knowledge identities without cross-repository reuse", async () => {
    const fixture = repository();
    const boundary = await incrementalDependencyBoundary(fixture.repo, null, fixture.base);
    const first = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/one", pullRequest: 7 });
    const key = first.key("guidance-selection", fixture.base, fixture.base, { tool: "1", card: "a", policy: "a", knowledge: "a" }, boundary);
    first.stage(key, { selected: ["card-a"] });
    await first.commitCompleted(completed(fixture.base));

    for (const changed of ["tool", "card", "policy", "knowledge"] as const) {
      const inputs = { tool: "1", card: "a", policy: "a", knowledge: "a", [changed]: "changed" };
      const changedKey = first.key("guidance-selection", fixture.base, fixture.base, inputs, boundary);
      expect((await first.get(changedKey)).decision.outcome).toBe("miss");
    }
    const other = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/two", pullRequest: 7 });
    const otherKey = other.key("guidance-selection", fixture.base, fixture.base, { tool: "1", card: "a", policy: "a", knowledge: "a" }, boundary);
    expect((await other.get(otherKey)).decision).toMatchObject({ outcome: "miss" });
    expect(canonicalRepositoryIdentity("https://github.com/OWNER/ONE.git")).toBe("owner/one");
    expect(() => canonicalRepositoryIdentity("../one")).toThrow();
  });
  it("keeps the deterministic no-cache path cold and non-persistent", async () => {
    const fixture = repository();
    const boundary = await incrementalDependencyBoundary(fixture.repo, null, fixture.base);
    const cache = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/repo", pullRequest: 8, enabled: false });
    const key = cache.key("change-manifest", fixture.base, fixture.base, { version: 1 }, boundary);
    expect((await cache.get(key)).decision).toMatchObject({ outcome: "fallback", reason: expect.stringContaining("disabled") });
    cache.stage(key, { value: "not-written" });
    expect(await cache.readLastCompleted()).toBeNull();
  });


  it("recovers a corrupt current generation by recomputing and never reports false clean", async () => {
    const fixture = repository();
    const boundary = await incrementalDependencyBoundary(fixture.repo, null, fixture.base);
    const cache = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/repo", pullRequest: 9 });
    const key = cache.key("scan-result", fixture.base, fixture.base, { tool: "v1" }, boundary);
    cache.stage(key, { findings: [{ id: "R1" }] });
    await cache.commitCompleted(completed(fixture.base));
    const repositoryHash = sha256("owner/repo");
    const entryRoot = join(fixture.data, "cache", "review-v1", "repositories", repositoryHash, "pr-9", "entries", "scan-result", cache.keyDigest(key));
    const pointer = JSON.parse(readFileSync(join(entryRoot, "current.json"), "utf8")) as { generation: string };
    writeFileSync(join(entryRoot, pointer.generation), "{corrupt");

    const recovered = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/repo", pullRequest: 9 });
    const lookup = await recovered.get(key);
    expect(lookup.value).toBeUndefined();
    expect(lookup.decision).toMatchObject({ outcome: "corrupt-recovered", reason: expect.stringContaining("recompute required") });
    recovered.stage(key, { findings: [] });
    await recovered.commitCompleted(completed(fixture.base));
    expect(await recovered.get(key)).toMatchObject({ value: { findings: [] }, decision: { outcome: "hit" } });
  });

  it("does not advance last-completed metadata for a discarded failed run", async () => {
    const fixture = repository();
    const boundary = await incrementalDependencyBoundary(fixture.repo, null, fixture.base);
    const cache = await ReviewCache.open({ dataRoot: fixture.data, repoRoot: fixture.repo, repository: "owner/repo", pullRequest: 10 });
    const key = cache.key("project-facts", fixture.base, fixture.base, { version: 1 }, boundary);
    cache.stage(key, { trackedFiles: 1 });
    cache.discard();
    expect(await cache.readLastCompleted()).toBeNull();
    expect((await cache.get(key)).decision.outcome).toBe("miss");
  });
});

describe("verified finding lifecycle", () => {
  const snapshot = (id: string, file: string, context: string, grade = "actionable") => findingSnapshot({
    id, concernSource: "correctness", rule: "unsafe-write", file, start: 4, context,
    evidenceHashes: [sha256("evidence")], grade,
  });

  it("reconciles persisting, moved, changed, resolved, reopened, ignored, and unverifiable states", () => {
    const priorExact = snapshot("R1", "src/a.ts", "same");
    const priorResolved = snapshot("R2", "src/b.ts", "returned");
    expect(reconcileFindings([snapshot("N1", "src/a.ts", "same")], [{ finding: priorExact, state: "persisting" }])[0]!.state).toBe("persisting");
    expect(reconcileFindings([snapshot("N1", "src/moved.ts", "same")], [{ finding: priorExact, state: "persisting" }])[0]!.state).toBe("moved");
    expect(reconcileFindings([snapshot("N1", "src/a.ts", "changed")], [{ finding: priorExact, state: "persisting" }])[0]!.state).toBe("materially-changed");
    expect(reconcileFindings([], [{ finding: priorExact, state: "persisting" }])[0]!.state).toBe("resolved");
    expect(reconcileFindings([snapshot("N2", "src/b.ts", "returned")], [{ finding: priorResolved, state: "resolved" }])[0]!.state).toBe("reopened");
    expect(reconcileFindings([snapshot("N3", "src/c.ts", "ignored", "ignored")])[0]!.state).toBe("ignored");
    expect(reconcileFindings([snapshot("N4", "src/d.ts", "unknown", "unverifiable")])[0]!.state).toBe("unverifiable");
  });

  it("suppresses only mechanically persisting unchanged findings", () => {
    const prior = snapshot("R1", "src/a.ts", "same");
    const lifecycle = reconcileFindings([snapshot("N1", "src/a.ts", "same"), snapshot("N2", "src/b.ts", "new")], [{ finding: prior, state: "persisting" }]);
    expect(publicationDecisions(lifecycle)).toEqual([
      { id: "N1", publish: false, state: "persisting", reason: "mechanically unchanged finding was already published" },
      { id: "N2", publish: true, state: "new", reason: "no prior finding has this normalized mechanism" },
    ]);
  });
});
