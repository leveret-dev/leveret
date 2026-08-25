import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeChangeEvidence, type ChangeEvidence } from "../src/change-evidence.js";
import {
  changeManifestSha256,
  createEvidencePack,
  loadEvidencePack,
  validateEvidencePack,
  writeEvidencePack,
  type EvidencePack,
} from "../src/evidence-pack.js";
import type { Engine } from "../src/engines/registry.js";
import type { ScanResult } from "../src/findings.js";
import type { Profile } from "../src/profile.js";
import { projectFacts } from "../src/project-facts.js";

const root = mkdtempSync(join(tmpdir(), "leveret-evidence-pack-"));
const repo = join(root, "repo");
const manifestPath = join(root, "change-evidence.v1.json");
const packPath = join(root, "evidence-pack.v1.json");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Leveret Test",
  GIT_AUTHOR_EMAIL: "leveret@example.invalid",
  GIT_COMMITTER_NAME: "Leveret Test",
  GIT_COMMITTER_EMAIL: "leveret@example.invalid",
};
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
const profile: Profile = { engines: {}, suppress: [], custom: [], reminders: true, review: { enabled: true } };
const engine = (id: string): Engine => ({ id, bin: process.execPath, select: (context) => context.files, scan: async () => [] });
const engines = [engine("clean"), engine("degraded"), engine("failure"), engine("none")];
let evidence: ChangeEvidence;
let pack: EvidencePack;
let scanResult: ScanResult;

beforeAll(async () => {
  mkdirSync(repo);
  git(["init", "-b", "main"]);
  writeFileSync(join(repo, "delete.txt"), "deleted\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  git(["add", "--", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);

  unlinkSync(join(repo, "delete.txt"));
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 9, 8]));
  for (const directory of ["src", "tests", "docs", "dist", "vendor", "scripts", ".github/workflows"]) mkdirSync(join(repo, directory), { recursive: true });
  writeFileSync(join(repo, "src/code.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "tests/code.test.ts"), "export const testValue = 1;\n");
  writeFileSync(join(repo, "docs/readme.md"), "# Read me\n");
  writeFileSync(join(repo, "dist/client.generated.js"), "generated();\n");
  writeFileSync(join(repo, "vendor/library.js"), "vendored();\n");
  writeFileSync(join(repo, "scripts/publish.sh"), "npm publish\n");
  writeFileSync(join(repo, "package.json"), "{\"dependencies\":{\"react\":\"1\"}}\n");
  writeFileSync(join(repo, "package-lock.json"), "{}\n");
  writeFileSync(join(repo, "quote\"\t雪.odd"), "unknown\n");
  writeFileSync(join(repo, ".github/workflows/ci.yml"), `name: CI
defaults:
  run:
    shell: bash
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - id: kill
        name: Kill and test
        shell: sh
        run: |
          sudo pkill stale
          uv run pytest
      - uses: actions/checkout@v4
  release:
    runs-on: windows-latest
    steps:
      - run: npm publish
`);
  writeFileSync(join(repo, ".github/workflows/bad.yml"), "jobs: [unterminated\n");
  git(["add", "-A", "--", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "head"]);
  evidence = await materializeChangeEvidence(repo, base, manifestPath);

  const findings = Array.from({ length: 205 }, (_, index) => ({
    engine: "clean",
    rule: `R${index}`,
    severity: "warning" as const,
    file: "src/code.ts",
    line: index + 1,
    message: `lead ${index}`,
    provenance: "introduced" as const,
  }));
  findings.push({ ...findings[0]! });
  scanResult = {
    findings,
    reminders: [],
    engines: [
      { engine: "clean", status: "clean", found: 0, kept: 0, selectedFiles: ["src/code.ts"], durationMs: 12 },
      { engine: "degraded", status: "clean", found: 0, kept: 0, selectedFiles: ["tests/code.test.ts"], durationMs: 4 },
      { engine: "failure", status: "error", detail: "local failure", selectedFiles: ["src/code.ts"], durationMs: 3 },
      { engine: "none", status: "not-applicable", selectedFiles: [], durationMs: 0 },
    ],
    suppressed: [{ rule: "clean/OLD", count: 2, reason: "trusted profile" }],
    preExisting: 3,
    baseErrors: [{ engine: "degraded", status: "error", detail: "base failed", selectedFiles: ["tests/code.test.ts"], durationMs: 2 }],
  };
  const facts = await projectFacts(repo);
  pack = await createEvidencePack({ repo, manifest: evidence.manifest, profile, project: facts, scan: scanResult, engines });
}, 30_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("evidence pack", () => {
  it("classifies every hostile manifest path exactly once with explicit kinds and facts", () => {
    expect(pack.files).toHaveLength(evidence.manifest.files.length);
    expect(new Set(pack.files.map((file) => file.path)).size).toBe(pack.files.length);
    const dispositions = Object.fromEntries(pack.files.map((file) => [file.path, file.disposition]));
    expect(dispositions).toMatchObject({
      "src/code.ts": "selected",
      "tests/code.test.ts": "selected",
      "docs/readme.md": "no-reviewable",
      "dist/client.generated.js": "generated",
      "vendor/library.js": "ignored",
      "package-lock.json": "lock",
      "binary.bin": "binary",
      "delete.txt": "deleted",
      "quote\"\t雪.odd": "selected",
    });
    expect(pack.files.find((file) => file.path === "quote\"\t雪.odd")).toMatchObject({ language: "unknown", kind: "unknown" });
    expect(pack.files.every((file) => file.reason && file.evidenceId && file.facts)).toBe(true);
  });

  it("extracts job-local workflow shells, literal tools, actions, and local malformed-file degradation", () => {
    const valid = pack.workflows.files.find((workflow) => workflow.path.endsWith("ci.yml"))!;
    const malformed = pack.workflows.files.find((workflow) => workflow.path.endsWith("bad.yml"))!;
    expect(valid.status).toBe("completed");
    expect(valid.jobs.map((job) => job.id)).toEqual(["build", "release"]);
    expect(valid.jobs[0]).toMatchObject({ shell: "bash", shellSource: "workflow" });
    expect(valid.jobs[0]!.steps[0]).toMatchObject({ shell: "sh", shellSource: "step", commandNames: ["pkill", "uv"] });
    expect(valid.jobs[0]!.steps[1]).toMatchObject({ kind: "uses", uses: "actions/checkout@v4" });
    expect(valid.jobs[1]).toMatchObject({ shell: "bash", shellSource: "workflow" });
    expect(malformed.status).toBe("degraded");
    expect(malformed.errors.length).toBeGreaterThan(0);
    expect(valid.errors).toEqual([]);
  });

  it("records analyzer applicability/failure/degradation without treating static clean as semantic coverage", () => {
    expect(pack.analyzers.find((analyzer) => analyzer.id === "clean")).toMatchObject({ applicability: "applicable", lifecycle: "completed", staticResult: "clean", durationMs: 12, cache: "unknown", semanticCoverage: false });
    expect(pack.analyzers.find((analyzer) => analyzer.id === "degraded")).toMatchObject({ applicability: "applicable", lifecycle: "degraded" });
    expect(pack.analyzers.find((analyzer) => analyzer.id === "failure")).toMatchObject({ applicability: "applicable", lifecycle: "failed", detail: "local failure" });
    expect(pack.analyzers.find((analyzer) => analyzer.id === "none")).toMatchObject({ applicability: "not_applicable", lifecycle: "not_applicable" });
    expect(pack.completeness.staticCleanIsSemanticCoverage).toBe(false);
  });

  it("produces stable hashes and lead IDs, deduplicates before the cap, and exposes overflow", async () => {
    const repeated = await createEvidencePack({ repo, manifest: evidence.manifest, profile, project: await projectFacts(repo), scan: scanResult, engines });
    expect(repeated).toEqual(pack);
    expect(pack.provenance.changeManifestSha256).toBe(changeManifestSha256(evidence.manifest));
    expect(pack.leads.items).toHaveLength(200);
    expect(pack.leads.deduplicated).toBe(1);
    expect(pack.leads.omittedIdCount).toBe(5);
    expect(new Set(pack.leads.items.map((lead) => lead.id)).size).toBe(200);
  });

  it("strictly writes and loads outside the checkout and rejects base/head/hash/path mismatches", async () => {
    const written = await writeEvidencePack(repo, packPath, pack);
    const loaded = await loadEvidencePack(repo, packPath, { base: pack.base, head: pack.head, changeManifestSha256: changeManifestSha256(evidence.manifest), sha256: written.sha256 });
    expect(loaded.pack).toEqual(pack);
    expect(loaded.bytes).toBe(readFileSync(packPath).byteLength);
    await expect(loadEvidencePack(repo, packPath, { base: "0".repeat(40), head: pack.head })).rejects.toThrow(/expected base\/head/);
    await expect(loadEvidencePack(repo, packPath, { base: pack.base, head: "0".repeat(40) })).rejects.toThrow(/expected base\/head/);
    await expect(loadEvidencePack(repo, packPath, { base: pack.base, head: pack.head, sha256: "0".repeat(64) })).rejects.toThrow(/file hash/);
    await expect(writeEvidencePack(repo, join(repo, "inside.json"), pack)).rejects.toThrow(/outside|stay outside/);
    expect(() => validateEvidencePack({ ...pack, unexpected: true })).toThrow(/fields/);
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(["add", "later.txt"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "later"]);
    await expect(loadEvidencePack(repo, packPath, { base: pack.base, head: pack.head })).rejects.toThrow(/reviewed checkout/);
  });
});
