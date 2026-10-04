import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { BuildEvidenceManifest, BuildEvidencePin, BuildEvidenceRequest } from "../src/build-evidence-contract.js";

const run = promisify(execFile);
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const exporter = fileURLToPath(new URL("./fixtures/build-evidence/export.mts", import.meta.url));

export const FIXTURE_MODES = ["valid", "in-place", "generation-failed", "template-defect", "secret-resource"] as const;
export type BuildFixtureMode = (typeof FIXTURE_MODES)[number];
export type FixtureSide = "base" | "head";
export const FIXTURE_REPOSITORY_ID = "fixture";
/** Credential-shaped marker the secret-resource export leaks into a filtered resource; mirrors export.mts. */
export const FIXTURE_SECRET_MARKER = "ghp_LeveretFixtureSecret0123456789abcdef";

/**
 * Head-side artifact IDs each mode exposes for review: the authored original and the generated
 * evidence derived from it. Compilation IDs are always `prod` and `test`.
 */
export const fixtureSelectedArtifacts: Record<BuildFixtureMode, { originalArtifactId: string; generatedArtifactId: string }> = {
  valid: { originalArtifactId: "pricing-template", generatedArtifactId: "pricing-output" },
  "in-place": { originalArtifactId: "pricing-original", generatedArtifactId: "pricing-output" },
  "generation-failed": { originalArtifactId: "pricing-template", generatedArtifactId: "pricing-output" },
  "template-defect": { originalArtifactId: "pricing-template", generatedArtifactId: "pricing-output" },
  "secret-resource": { originalArtifactId: "app-resource-original", generatedArtifactId: "app-resource-output" },
};

/**
 * `originalBytes` and `outputBytes` describe the HEAD export only (artifact IDs are stable across sides,
 * so base bytes would collide). Directory artifacts have no single byte string and are omitted; read
 * base bytes from the base pin's payload root or `git cat-file blob <base>:<path>`.
 */
export interface BuildFixture {
  repo: string;
  base: string;
  head: string;
  pins: { base: BuildEvidencePin; head: BuildEvidencePin };
  manifests: { base: BuildEvidenceManifest; head: BuildEvidenceManifest };
  originalBytes: ReadonlyMap<string, Uint8Array>;
  outputBytes: ReadonlyMap<string, Uint8Array>;
}

const gitEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Leveret", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-10-04T00:00:00Z",
  GIT_COMMITTER_NAME: "Leveret", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_COMMITTER_DATE: "2026-10-04T00:00:00Z",
};

/** Runs git in a fixture repository with host config isolated and a fixed identity/date. */
export function fixtureGit(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
}

/** Tracked files of one side. The head commit is where each mode's behavior-defining change lands. */
function repoFiles(mode: BuildFixtureMode, side: FixtureSide): Record<string, string> {
  const head = side === "head";
  const factor = head && mode !== "template-defect" ? "12" : "10";
  const operator = head && mode === "template-defect" ? "/" : "*";
  const pricing = (placeholder: string) =>
    `package example;\n\npublic final class Pricing {\n    public static int price(int quantity) { return quantity ${operator} ${placeholder}; }\n`
    + "    public static int price(String code) { return code.length(); }\n}\n";
  const files: Record<string, string> = {
    // A head that drops `factor` makes the real template generation fail.
    "generator.properties": `endpoint=https://billing.example.test\n${mode === "generation-failed" && head ? "" : `factor=${factor}\n`}`,
    "src/main/java/example/Consumer.java": "package example;\n\npublic final class Consumer {\n    public int total() { return Pricing.price(3); }\n}\n",
    "src/test/java/example/PricingTest.java":
      "package example;\n\npublic final class PricingTest {\n    int numeric() { return Pricing.price(3); }\n    int textual() { return Pricing.price(\"ABC\"); }\n}\n",
    // The secret-resource head introduces a filtered line whose value only CI knows; it is never tracked.
    "src/main/resources/application.properties": `endpoint=\${endpoint}\nregion=eu\n${mode === "secret-resource" && head ? "token=${apiToken}\n" : ""}`,
    // The imported compilation must win over this coherent but source-incomplete legacy fallback.
    "gradle.lockfile": "empty=compileClasspath,testCompileClasspath\n",
  };
  if (mode === "in-place") files["src/main/java/example/Pricing.java"] = pricing("@FACTOR@");
  else files["templates/Pricing.java.tpl"] = pricing("${factor}");
  return files;
}

/** Runs the test-owned client export command (the fixture's client stage; the consumer never does). */
export async function runFixtureExporter(repo: string, revision: string, output: string, mode: BuildFixtureMode): Promise<void> {
  await run(process.execPath, [tsx, exporter, "--repo", repo, "--revision", revision, "--output", output, "--mode", mode], {
    env: process.env, maxBuffer: 16 * 1024 * 1024,
  });
}

export async function createBuildFixture(dir: string, mode: BuildFixtureMode = "valid"): Promise<BuildFixture> {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  fixtureGit(repo, "init", "-b", "main");
  const commits = {} as Record<FixtureSide, string>;
  for (const side of ["base", "head"] as const) {
    for (const [path, content] of Object.entries(repoFiles(mode, side))) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    fixtureGit(repo, "add", "-A");
    fixtureGit(repo, "-c", "commit.gpgsign=false", "commit", "-m", side);
    commits[side] = fixtureGit(repo, "rev-parse", "HEAD");
  }
  const pins = {} as Record<FixtureSide, BuildEvidencePin>;
  const manifests = {} as Record<FixtureSide, BuildEvidenceManifest>;
  await Promise.all((["base", "head"] as const).map(async (side) => {
    const output = join(dir, "exports", side);
    await runFixtureExporter(repo, commits[side], output, mode);
    const manifestPath = join(output, "manifest.json");
    const bytes = readFileSync(manifestPath);
    manifests[side] = JSON.parse(bytes.toString("utf8")) as BuildEvidenceManifest;
    pins[side] = {
      manifestPath, manifestSha256: createHash("sha256").update(bytes).digest("hex"), payloadRoot: join(output, "payload"),
      expectedContext: { id: manifests[side].context.id, profiles: [], variant: { state: "unset", value: null } },
      select: { moduleDir: ".", productionId: "prod", testId: "test" },
    };
  }));
  const originalBytes = new Map<string, Uint8Array>();
  const outputBytes = new Map<string, Uint8Array>();
  for (const artifact of manifests.head.artifacts) {
    if (artifact.availability !== "available" || artifact.kind !== "file") continue;
    if (artifact.origin === "authored") {
      originalBytes.set(artifact.id, execFileSync("git", ["-C", repo, "cat-file", "blob", `${commits.head}:${artifact.repositoryPath}`], { env: gitEnv, maxBuffer: 64 << 20 }));
    } else if (artifact.origin === "materialized") {
      outputBytes.set(artifact.id, readFileSync(join(pins.head.payloadRoot, artifact.content.location.path)));
    }
  }
  return { repo, base: commits.base, head: commits.head, pins, manifests, originalBytes, outputBytes };
}

export function fixtureRequest(f: BuildFixture, side: FixtureSide, runtimeDir: string): BuildEvidenceRequest {
  return { repo: f.repo, repositoryId: FIXTURE_REPOSITORY_ID, revision: f[side], side, pin: f.pins[side], runtimeDir };
}
