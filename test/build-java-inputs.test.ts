import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChangeManifest } from "../src/change-evidence.js";
import { prepareBuildJavaInputs, type BuildJavaDecision } from "../src/build-java-inputs.js";
import type { BuildEvidenceManifest, BuildEvidenceRequest } from "../src/build-evidence-contract.js";
import { admitBuildEvidence, type AdmittedBuildEvidence } from "../src/build-evidence.js";
import { loadInspectJavaConfig, openInspectJava, type InspectJavaConfig } from "../src/inspect-java.js";
import type { SecretPolicy } from "../src/secret-screening.js";
import { createBuildFixture, fixtureRequest, type BuildFixture, type FixtureSide } from "./build-evidence-fixture.js";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const policy = (): SecretPolicy => ({
  id: "build-java-inputs-test", available: false, knownValues: new Set(),
  refreshKnownValues: async () => [], additionalRules: [], nonSecretValues: new Set(),
});

let home: string;
let valid: BuildFixture;
let secret: BuildFixture;
let config: InspectJavaConfig;
let serial = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "leveret-build-java-inputs-"));
  [valid, secret] = await Promise.all([
    createBuildFixture(join(home, "valid"), "valid"),
    createBuildFixture(join(home, "secret"), "secret-resource"),
  ]);
  const java = execFileSync("realpath", [execFileSync("which", ["java"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();
  const jdkHome = dirname(dirname(java));
  const jdkFiles = Object.fromEntries(["bin/java", "release", "lib/modules", "lib/server/libjvm.so"].map((name) =>
    [name, sha256(readFileSync(join(jdkHome, name)))]));
  config = {
    schema: 1, repositoryId: "fixture", distribution: home, distributionFiles: {}, jdkHome, jdkFiles,
    cache: join(home, "legacy-cache"), module: ".", build: "gradle", mainRoots: ["src/main/java"],
    testRoots: ["src/test/java"], javaLevel: "21",
    limits: { heapBytes: 1_073_741_824, addressSpaceBytes: 8_589_934_592, deadlineMs: 180_000, maxOutputBytes: 8_388_608 },
    configPath: join(home, "config.json"), configSha256: "0".repeat(64),
  };
  mkdirSync(config.cache);
}, 180_000);

afterAll(() => rmSync(home, { recursive: true, force: true }));

function republish(fixture: BuildFixture, side: FixtureSide, mutate: (manifest: BuildEvidenceManifest) => void): BuildEvidenceRequest {
  const dir = join(home, `case-${++serial}`);
  const payloadRoot = join(dir, "payload");
  const manifestPath = join(dir, "manifest.json");
  mkdirSync(dir, { recursive: true });
  cpSync(fixture.pins[side].payloadRoot, payloadRoot, { recursive: true });
  const manifest = structuredClone(fixture.manifests[side]) as BuildEvidenceManifest;
  mutate(manifest);
  const bytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(manifestPath, bytes);
  const base = fixtureRequest(fixture, side, join(dir, "admission"));
  return { ...base, pin: { ...base.pin!, manifestPath, payloadRoot, manifestSha256: sha256(bytes) } };
}

async function admitted(request: BuildEvidenceRequest, secretPolicy = policy()): Promise<AdmittedBuildEvidence> {
  const result = await admitBuildEvidence(request, secretPolicy);
  if (result.outcome !== "admitted") throw new Error(`expected admitted export, got ${result.outcome}`);
  return result;
}

function role(decision: BuildJavaDecision, name: "production" | "test") {
  const found = decision.scopes.find((scope) => scope.role === name);
  if (!found) throw new Error(`missing ${name} decision`);
  return found;
}

describe("prepareBuildJavaInputs", () => {
  it("normalizes explicit selected compilations into one read-only worker view without raw host roots", async () => {
    const admission = await admitted(fixtureRequest(valid, "head", join(home, `admission-${++serial}`)));
    try {
      const decision = await prepareBuildJavaInputs(admission, config);
      const production = role(decision, "production");
      const test = role(decision, "test");
      expect(production).toMatchObject({ outcome: "prepared", compilationId: "prod", compilation: {
        id: `export:${admission.manifestSha256}:prod`, resolutionDomain: `build:${admission.manifestSha256}:prod`, sourceSet: "main",
        files: expect.arrayContaining([
          expect.objectContaining({ displayPath: "src/main/java/example/Consumer.java", encoding: "UTF-8",
            buildArtifact: { manifestSha256: admission.manifestSha256, artifactId: "consumer-original", origin: "authored" } }),
          expect.objectContaining({ displayPath: "build/generated/example/Pricing.java", encoding: "UTF-8",
            buildArtifact: { manifestSha256: admission.manifestSha256, artifactId: "pricing-output", origin: "materialized" } }),
        ]),
      } });
      expect(test).toMatchObject({ outcome: "prepared", compilationId: "test", compilation: {
        id: `export:${admission.manifestSha256}:test`, sourceSet: "test",
        classpath: expect.arrayContaining([expect.stringMatching(/^\/prepared\/artifacts\//)]),
        origins: expect.arrayContaining([expect.objectContaining({
          ownerCompilationId: `export:${admission.manifestSha256}:prod`,
        })]),
      } });
      const serialized = JSON.stringify(decision);
      expect(serialized).not.toContain(admission.frozen.scratch);
      expect(serialized).not.toContain(valid.pins.head.payloadRoot);
      expect(serialized).not.toContain(process.env.HOME ?? "__no_home__");
      expect(serialized).not.toContain("pricing-template");
      expect(serialized).not.toContain("pricing-generator-config");
      expect(decision.workerView).toMatch(/^\//);
    } finally {
      rmSync(admission.frozen.scratch, { recursive: true, force: true });
    }
  });

  it("uses a complete supported environment even when compilation was not run", async () => {
    const admission = await admitted(republish(valid, "head", (manifest) => {
      const compilation = manifest.compilations.find((item) => item.id === "prod");
      if (!compilation) throw new Error("fixture production compilation is missing");
      compilation.compilationState = "not-run";
    }));
    try {
      const decision = await prepareBuildJavaInputs(admission, config);
      expect(role(decision, "production")).toMatchObject({ outcome: "prepared", compilationId: "prod" });
    } finally {
      rmSync(admission.frozen.scratch, { recursive: true, force: true });
    }
  });

  it("falls back coherently for an unsupported platform without retaining exported fragments", async () => {
    const admission = await admitted(republish(valid, "head", (manifest) => {
      const compilation = manifest.compilations.find((item) => item.id === "prod");
      if (!compilation || compilation.compiler.platform.state !== "identified") {
        throw new Error("fixture production platform is missing");
      }
      const modules = compilation.compiler.platform.fingerprints.find((item) => item.name === "modules");
      if (!modules) throw new Error("fixture modules fingerprint is missing");
      modules.sha256 = "f".repeat(64);
    }));
    try {
      const decision = await prepareBuildJavaInputs(admission, config);
      const production = role(decision, "production");
      expect(production).toMatchObject({ outcome: "fallback", compilationId: "prod", reason: "unsupported-platform" });
      expect(JSON.stringify(production)).not.toContain("pricing-output");
      expect(JSON.stringify(production)).not.toContain(admission.frozen.scratch);
    } finally {
      rmSync(admission.frozen.scratch, { recursive: true, force: true });
    }
  });

  it("does not report successful empty facts when a required generated input is unavailable", async () => {
    const request = republish(valid, "head", () => undefined);
    rmSync(join(request.pin!.payloadRoot, "generated/main/example/Pricing.java"));
    const admission = await admitted(request);
    try {
      const decision = await prepareBuildJavaInputs(admission, config);
      expect(role(decision, "production")).toMatchObject({ outcome: "fallback", compilationId: "prod", reason: "artifact-rejected" });
      expect(role(decision, "test")).toMatchObject({ outcome: "fallback", compilationId: "test", reason: "artifact-rejected" });
      expect(decision.scopes.every((scope) => scope.outcome !== "unavailable" || scope.reason.length > 0)).toBe(true);
    } finally {
      rmSync(admission.frozen.scratch, { recursive: true, force: true });
    }
  });

  it("carries withheld repository paths into independent fallback instead of rediscovering them", async () => {
    const admission = await admitted(fixtureRequest(secret, "head", join(home, `secret-admission-${++serial}`)), {
      ...policy(), refreshKnownValues: async () => ["ghp_LeveretFixtureSecret0123456789abcdef"],
    });
    try {
      const decision = await prepareBuildJavaInputs(admission, config);
      const production = role(decision, "production");
      expect(production).toMatchObject({ outcome: "fallback", reason: "artifact-withheld" });
      expect(production.withheldRepositoryPaths).toContain("src/main/resources/application.properties");
      expect(JSON.stringify(production)).not.toContain("ghp_LeveretFixtureSecret0123456789abcdef");
    } finally {
      rmSync(admission.frozen.scratch, { recursive: true, force: true });
    }
  });
});

async function installedConfig(
  fixture: BuildFixture,
  pins: { base?: BuildFixture["pins"]["base"]; head?: BuildFixture["pins"]["head"] },
  name: string,
): Promise<InspectJavaConfig> {
  const distribution = resolve("inspect/runtime/build/install/leveret-inspect");
  const distributionNames = ["bin/leveret-inspect", ...readdirSync(join(distribution, "lib")).map((entry) => `lib/${entry}`)];
  const distributionFiles = Object.fromEntries(distributionNames.map((entry) =>
    [entry, sha256(readFileSync(join(distribution, entry)))]));
  const raw = {
    schema: 1, repositoryId: "fixture", distribution, distributionFiles, jdkHome: config.jdkHome, jdkFiles: config.jdkFiles,
    cache: config.cache, module: ".", build: "gradle", mainRoots: ["src/main/java"], testRoots: ["src/test/java"], javaLevel: "21",
    buildEvidence: pins, screening: { rules: [], nonSecretValues: [] },
    limits: config.limits,
  };
  const path = join(home, `${name}.json`);
  writeFileSync(path, JSON.stringify(raw));
  return loadInspectJavaConfig(fixture.repo, path, sha256(readFileSync(path)));
}

describe("installed optional build-evidence bridge", () => {
  it("prefers the complete exported environment over source-incomplete legacy metadata and supports artifact targets", async () => {
    const loaded = await installedConfig(valid, valid.pins, `installed-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.base).toMatchObject({ outcome: "admitted", scopes: [
        expect.objectContaining({ role: "production", state: "selected" }),
        expect.objectContaining({ role: "test", state: "selected" }),
      ] });
      expect(bridge.buildEvidence.head).toMatchObject({ outcome: "admitted" });
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId,
        configurationSha256: bridge.summaries.head.configurationSha256,
        manifest,
        side: "head",
        target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
        referenceScope: "all",
      });
      expect(page.target.location.buildArtifact).toEqual({
        manifestSha256: valid.pins.head.manifestSha256, artifactId: "pricing-output", origin: "materialized",
      });
      expect(page.items.filter((item) => item.reference).map((item) => item.reference!.location.path))
        .toEqual(expect.arrayContaining(["src/main/java/example/Consumer.java", "src/test/java/example/PricingTest.java"]));
      const authored = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { path: "src/main/java/example/Consumer.java", position: { line: 4, column: 16 } },
      });
      expect(authored.target.location.buildArtifact).toEqual({
        manifestSha256: valid.pins.head.manifestSha256, artifactId: "consumer-original", origin: "authored",
      });
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("records a configured missing head export while resolving head fallback independently from admitted base", async () => {
    const absentHead = { ...valid.pins.head, manifestPath: join(home, "absent-head-manifest.json") };
    const loaded = await installedConfig(valid, { base: valid.pins.base, head: absentHead }, `mixed-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `mixed-run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.base).toMatchObject({ outcome: "admitted" });
      expect(bridge.buildEvidence.head).toMatchObject({ outcome: "rejected", reason: "manifest-absent" });
      expect(bridge.summaries.base.revision).toBe(manifest.base);
      expect(bridge.summaries.head.revision).toBe(manifest.head);
      await expect(bridge.references({
        analysisId: bridge.summaries.head.analysisId,
        configurationSha256: bridge.summaries.head.configurationSha256,
        manifest,
        side: "head",
        target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
      })).rejects.toMatchObject({ code: "invalid-input" });
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("keeps opposite-side revision mismatches visible instead of borrowing the other export", async () => {
    const loaded = await installedConfig(valid, { base: valid.pins.head, head: valid.pins.head }, `revision-mismatch-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `revision-run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.base).toMatchObject({ outcome: "rejected", reason: "revision-mismatch" });
      expect(bridge.buildEvidence.head).toMatchObject({ outcome: "admitted" });
      expect(bridge.summaries.base.revision).toBe(manifest.base);
      expect(bridge.summaries.head.revision).toBe(manifest.head);
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("keeps supported exported production queryable while test resolves independent fallback", async () => {
    const request = republish(valid, "head", (exported) => {
      const testCompilation = exported.compilations.find((item) => item.id === "test");
      if (!testCompilation || testCompilation.compiler.platform.state !== "identified") throw new Error("fixture test platform is missing");
      const modules = testCompilation.compiler.platform.fingerprints.find((item) => item.name === "modules");
      if (!modules) throw new Error("fixture test modules fingerprint is missing");
      modules.sha256 = "e".repeat(64);
    });
    const loaded = await installedConfig(valid, { base: valid.pins.base, head: request.pin! }, `mixed-test-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `mixed-test-run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.head.javaScopes).toEqual([
        expect.objectContaining({ role: "production", outcome: "prepared", compilationId: "prod" }),
        expect.objectContaining({ role: "test", outcome: "fallback", compilationId: "test", reason: "unsupported-platform" }),
      ]);
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-output", position: { line: 4, column: 22 } }, referenceScope: "all",
      });
      expect(page.target.location.buildArtifact).toMatchObject({ artifactId: "pricing-output", origin: "materialized" });
      expect(page.items.some((item) => item.reference?.location.path === "src/main/java/example/Consumer.java")).toBe(true);
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("keeps supported exported test queryable while production resolves independent fallback", async () => {
    const request = republish(valid, "head", (exported) => {
      const production = exported.compilations.find((item) => item.id === "prod");
      if (!production || production.compiler.platform.state !== "identified") throw new Error("fixture production platform is missing");
      const modules = production.compiler.platform.fingerprints.find((item) => item.name === "modules");
      if (!modules) throw new Error("fixture production modules fingerprint is missing");
      modules.sha256 = "d".repeat(64);
    });
    const loaded = await installedConfig(valid, { base: valid.pins.base, head: request.pin! }, `mixed-production-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `mixed-production-run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.head.javaScopes).toEqual([
        expect.objectContaining({ role: "production", outcome: "fallback", compilationId: "prod", reason: "unsupported-platform" }),
        expect.objectContaining({ role: "test", outcome: "prepared", compilationId: "test" }),
      ]);
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-test", position: { line: 4, column: 10 } }, referenceScope: "all",
      });
      expect(page.target.location.buildArtifact).toMatchObject({ artifactId: "pricing-test", origin: "authored" });
      expect(page.target.sourceSet).toBe("test");
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("keeps exporter compilation IDs disjoint from fallback IDs", async () => {
    const request = republish(valid, "head", (exported) => {
      const production = exported.compilations.find((item) => item.id === "prod");
      const testCompilation = exported.compilations.find((item) => item.id === "test");
      if (!production || !testCompilation || testCompilation.compiler.platform.state !== "identified") {
        throw new Error("fixture compilations are missing");
      }
      production.id = "test";
      testCompilation.id = "fixture-test";
      for (const compilation of exported.compilations) {
        for (const entry of compilation.compileClasspath.entries) {
          if (entry.upstreamCompilationId === "prod") entry.upstreamCompilationId = "test";
        }
      }
      const modules = testCompilation.compiler.platform.fingerprints.find((item) => item.name === "modules");
      if (!modules) throw new Error("fixture test modules fingerprint is missing");
      modules.sha256 = "b".repeat(64);
    });
    request.pin = { ...request.pin!, select: { moduleDir: ".", productionId: "test", testId: "fixture-test" } };
    const loaded = await installedConfig(valid, { base: valid.pins.base, head: request.pin }, `id-collision-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `id-collision-run-${++serial}`), policy());
    try {
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
      });
      expect(page.target.location.buildArtifact).toMatchObject({ artifactId: "pricing-output" });
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("does not reuse same-revision analyses across different explicit selections", async () => {
    const request = republish(valid, "head", (exported) => {
      const production = exported.compilations.find((item) => item.id === "prod");
      if (!production) throw new Error("fixture production compilation is missing");
      exported.compilations.push({ ...structuredClone(production), id: "prod-alt", name: "alternate-main" });
    });
    const basePin = { ...request.pin!, select: { moduleDir: ".", productionId: "prod", testId: "test" } };
    const headPin = { ...request.pin!, select: { moduleDir: ".", productionId: "prod-alt", testId: "test" } };
    const loaded = await installedConfig(valid, { base: basePin, head: headPin }, `same-revision-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.head);
    const bridge = await openInspectJava(valid.repo, manifest, loaded, join(home, `same-revision-run-${++serial}`), policy());
    try {
      expect(bridge.buildEvidence.base.selection?.productionId).toBe("prod");
      expect(bridge.buildEvidence.head.selection?.productionId).toBe("prod-alt");
      expect(bridge.summaries.base.analysisId).not.toBe(bridge.summaries.head.analysisId);
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
      });
      expect(page.target.id).toContain(":prod-alt:");
      expect(page.target.location.buildArtifact).toMatchObject({ artifactId: "pricing-output" });
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("mixed fallback validates only consumed live roots while prepared in-place production stays immutable", async () => {
    const fixture = await createBuildFixture(join(home, `mixed-in-place-${++serial}`), "in-place");
    const request = republish(fixture, "head", (exported) => {
      const testCompilation = exported.compilations.find((item) => item.id === "test");
      if (!testCompilation || testCompilation.compiler.platform.state !== "identified") throw new Error("fixture test platform is missing");
      const modules = testCompilation.compiler.platform.fingerprints.find((item) => item.name === "modules");
      if (!modules) throw new Error("fixture test modules fingerprint is missing");
      modules.sha256 = "c".repeat(64);
    });
    const generated = fixture.outputBytes.get("pricing-output");
    if (!generated) throw new Error("fixture generated output is missing");
    writeFileSync(join(fixture.repo, "src/main/java/example/Pricing.java"), generated);
    const loaded = await installedConfig(fixture, { base: fixture.pins.base, head: request.pin! }, `mixed-in-place-${++serial}`);
    const manifest = await buildChangeManifest(fixture.repo, fixture.base);
    const bridge = await openInspectJava(fixture.repo, manifest, loaded, join(home, `mixed-in-place-run-${++serial}`), policy());
    try {
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
      });
      expect(page.target.location.buildArtifact).toMatchObject({ artifactId: "pricing-output", origin: "materialized" });
      const original = await bridge.readArtifact("head", {
        manifestSha256: request.pin!.manifestSha256, artifactId: "pricing-original", range: null, byteBudget: 65_536,
      });
      expect(original).toMatchObject({ ok: true, result: { text: expect.stringContaining("@FACTOR@") } });
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("rotated policy invalidates prepared lineage inputs and consumed fallback build metadata", async () => {
    let values: readonly string[] = [];
    const changing: SecretPolicy = { ...policy(), refreshKnownValues: async () => values };
    const preparedConfig = await installedConfig(valid, valid.pins, `rotated-prepared-${++serial}`);
    const manifest = await buildChangeManifest(valid.repo, valid.base);
    const preparedBridge = await openInspectJava(valid.repo, manifest, preparedConfig, join(home, `rotated-prepared-run-${++serial}`), changing);
    try {
      values = ["endpoint=https://billing.example.test"];
      await expect(preparedBridge.references({
        analysisId: preparedBridge.summaries.head.analysisId,
        configurationSha256: preparedBridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { artifactId: "pricing-output", position: { line: 4, column: 22 } },
      })).rejects.toMatchObject({ code: "analysis-unavailable" });
    } finally {
      await preparedBridge.close();
    }
    values = [];
    changing.available = false;
    changing.knownValues.clear();
    const absentHead = { ...valid.pins.head, manifestPath: join(home, `absent-rotated-${++serial}.json`) };
    const fallbackConfig = await installedConfig(valid, { base: valid.pins.base, head: absentHead }, `rotated-fallback-${++serial}`);
    const fallbackBridge = await openInspectJava(valid.repo, manifest, fallbackConfig, join(home, `rotated-fallback-run-${++serial}`), changing);
    try {
      values = ["empty=compileClasspath,testCompileClasspath"];
      await expect(fallbackBridge.references({
        analysisId: fallbackBridge.summaries.head.analysisId,
        configurationSha256: fallbackBridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { path: "src/main/java/example/Consumer.java", position: { line: 4, column: 16 } },
      })).rejects.toMatchObject({ code: "analysis-unavailable" });
    } finally {
      await fallbackBridge.close();
    }
  }, 240_000);

  it("serves the authored bytes through the bridge after an in-place transformation", async () => {
    const fixture = await createBuildFixture(join(home, `installed-in-place-${++serial}`), "in-place");
    const loaded = await installedConfig(fixture, fixture.pins, `in-place-config-${++serial}`);
    const manifest = await buildChangeManifest(fixture.repo, fixture.base);
    const bridge = await openInspectJava(fixture.repo, manifest, loaded, join(home, `in-place-run-${++serial}`), policy());
    try {
      const original = await bridge.readArtifact("head", {
        manifestSha256: fixture.pins.head.manifestSha256, artifactId: "pricing-original", range: null, byteBudget: 65_536,
      });
      const generated = await bridge.readArtifact("head", {
        manifestSha256: fixture.pins.head.manifestSha256, artifactId: "pricing-output", range: null, byteBudget: 65_536,
      });
      expect(original).toMatchObject({ ok: true, result: { text: expect.stringContaining("@FACTOR@") } });
      expect(generated).toMatchObject({ ok: true, result: { text: expect.stringContaining("quantity * 12") } });
      expect(original.ok && original.result.text).not.toBe(generated.ok && generated.result.text);
    } finally {
      await bridge.close();
    }
  }, 240_000);

  it("rejects a build-evidence pin that selects an installed executable before any fallback", async () => {
    const executable = resolve("inspect/runtime/build/install/leveret-inspect/bin/leveret-inspect");
    const unsafe = { ...valid.pins.head, manifestPath: executable, manifestSha256: sha256(readFileSync(executable)) };
    await expect(installedConfig(valid, { head: unsafe }, `executable-pin-${++serial}`))
      .rejects.toMatchObject({ code: "invalid-input" });
  });
});
