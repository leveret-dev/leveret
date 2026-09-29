import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChangeManifest, type ChangeEvidence, type ChangeManifest } from "../src/change-evidence.js";
import { loadInspectJavaConfig, openInspectJava } from "../src/inspect-java.js";
import { referenceReplySchema } from "../src/inspect-java-contract.js";
import { SPECIALIZED_LEG_DEFINITIONS, TARGETED_VERIFIER_TOOLS, selectPhaseTools } from "../src/runner/discovery-legs.js";
import { buildPiTools } from "../src/runner/pi-tools.js";

const home = mkdtempSync(join(tmpdir(), "leveret-java-boundary-"));
const repo = join(home, "repo");
const main = join(repo, "src/main/java/example/Pricing.java");
const test = join(repo, "src/test/java/example/PricingTest.java");
const distribution = resolve("inspect/runtime/build/install/leveret-inspect");
const cachedArtifact = join(home, "cache/t/present/1/present-1.jar");
const env = { ...process.env, GIT_AUTHOR_NAME: "Leveret", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Leveret", GIT_COMMITTER_EMAIL: "test@example.invalid" };
const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
let manifest: ChangeManifest;
let configPath: string;
let digest: string;

beforeAll(async () => {
  mkdirSync(dirname(main), { recursive: true });
  mkdirSync(dirname(test), { recursive: true });
  git(["init", "-b", "main"]);
  writeFileSync(join(repo, "gradle.lockfile"), "t:present:1=compileClasspath,testCompileClasspath\n");
  writeFileSync(main, "package example;\nclass Pricing {\n static int price(int n) { return n * 10; }\n static int price(String s) { return s.length(); }\n}\n");
  writeFileSync(test, "package example;\nclass PricingTest {\n int numeric() { return Pricing.price(3); }\n int textual() { return Pricing.price(\"ABC\"); }\n}\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(main, readFileSync(main, "utf8").replace("n * 10", "n * 12"));
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "head"]);
  manifest = await buildChangeManifest(repo, base);
  const javaPath = execFileSync("realpath", [execFileSync("which", ["java"], { encoding: "utf8" }).trim()], { encoding: "utf8" }).trim();
  configPath = join(home, "java-config.json");
  const files = ["bin/leveret-inspect", ...readdirSync(join(distribution, "lib")).map((name) => `lib/${name}`)];
  const distributionFiles = Object.fromEntries(files.map((file) => [
    file, createHash("sha256").update(readFileSync(join(distribution, file))).digest("hex"),
  ]));
  const jdkHome = dirname(dirname(javaPath));
  const jdkFiles = Object.fromEntries(["bin/java", "release", "lib/modules", "lib/server/libjvm.so"].map((file) => [
    file, createHash("sha256").update(readFileSync(join(jdkHome, file))).digest("hex"),
  ]));
  const config = {
    schema: 1, repositoryId: "fixture", distribution, distributionFiles,
    jdkHome, jdkFiles, cache: join(home, "cache"), module: ".", build: "gradle",
    mainRoots: ["src/main/java"], testRoots: ["src/test/java"], javaLevel: "21",
    limits: { heapBytes: 1_073_741_824, addressSpaceBytes: 8_589_934_592, deadlineMs: 180_000, maxOutputBytes: 8_388_608 },
  };
  mkdirSync(config.cache);
  mkdirSync(dirname(cachedArtifact), { recursive: true });
  const empty = join(home, "empty");
  mkdirSync(empty);
  execFileSync("jar", ["--create", "--file", cachedArtifact, "-C", empty, "."]);
  writeFileSync(configPath, JSON.stringify(config));
  digest = createHash("sha256").update(readFileSync(configPath)).digest("hex");
}, 30_000);

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("Inspect Java boundary", () => {
  it("retrieves the exact unchanged test caller through installed JVM and sandbox", async () => {
    const config = await loadInspectJavaConfig(repo, configPath, digest);
    const bridge = await openInspectJava(repo, manifest, config, join(home, "runs"));
    try {
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
      });
      expect(page.items.filter((item) => item.kind === "reference").map((item) => item.reference?.location.path))
        .toEqual(["src/test/java/example/PricingTest.java"]);
      expect(page.summary.coverage.complete).toBe(true);
    } finally { await bridge.close(); }
  }, 240_000);

  it("resolves explicit Maven-style Java 8 language settings", async () => {
    const path = join(home, "java8-config.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), javaLevel: "1.8" }));
    const config = await loadInspectJavaConfig(repo, path, createHash("sha256").update(readFileSync(path)).digest("hex"));
    const bridge = await openInspectJava(repo, manifest, config, join(home, "java8-runs"));
    try {
      const page = await bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
      });
      expect(page.items.filter((item) => item.kind === "reference").map((item) => item.reference?.location.path))
        .toEqual(["src/test/java/example/PricingTest.java"]);
    } finally { await bridge.close(); }
  }, 240_000);

  it("registered reviewer phases retrieve checked test caller evidence", async () => {
    const config = await loadInspectJavaConfig(repo, configPath, digest);
    const bridge = await openInspectJava(repo, manifest, config, join(home, "tool-runs"));
    const evidence: ChangeEvidence = {
      manifest,
      async retrieve() { throw new Error("diff retrieval is outside this Java reference query"); },
      async auditPatch() { throw new Error("audit patch is outside this Java reference query"); },
    };
    const bundle = await buildPiTools({
      repo, base: manifest.base, evidence, inspectJava: bridge,
      graphLive: false, sandboxed: false, profilePath: join(home, "profile"),
      rulesRoot: home, memoryRepo: home,
    });
    try {
      const selected = [
        bundle.tools.filter((tool) => tool.name !== "leveret_scan"),
        ...SPECIALIZED_LEG_DEFINITIONS.map((leg) => selectPhaseTools(bundle.tools, leg.requiredTools, leg.optionalTools)),
        selectPhaseTools(bundle.tools, TARGETED_VERIFIER_TOOLS.required, TARGETED_VERIFIER_TOOLS.optional, true),
      ];
      for (const [index, tools] of selected.entries()) {
        const tool = tools.find((item) => item.name === "leveret_java_references");
        expect(tool, `phase ${index} must expose the real Java reference query`).toBeDefined();
        const result = await tool!.execute(`java-${index}`, {
          side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
        }, undefined, undefined, {} as never);
        expect(result.content[0]?.text).toBe(`evidence_id: java-${index}`);
        const payload = result.content.find((item) => item.type === "text" && item.text?.startsWith("{"))?.text;
        const reply = referenceReplySchema.parse(JSON.parse(payload ?? "null"));
        if (!reply.ok) throw new Error(reply.error.message);
        expect(reply.result.items.filter((item) => item.kind === "reference").map((item) => ({
          path: item.reference?.location.path, kind: item.reference?.kind, basis: item.reference?.basis,
        }))).toEqual([{ path: "src/test/java/example/PricingTest.java", kind: "call", basis: "checked" }]);
        expect(reply.result.summary.coverage.complete).toBe(true);
        const source = await tools.find((item) => item.name === "leveret_read")!.execute(`source-${index}`, {
          path: "src/test/java/example/PricingTest.java", line_start: 3, line_end: 3,
        }, undefined, undefined, {} as never);
        expect(source.content[0]?.text).toBe(`evidence_id: source-${index}`);
        expect(source.content.some((item) => item.text?.includes("Pricing.price(3)"))).toBe(true);
      }
    } finally {
      await bundle.close();
    }
  }, 240_000);

  it("registered tool keeps checked caller alongside missing-input coverage", async () => {
    writeFileSync(test, readFileSync(test, "utf8").replace("\n}\n",
      "\n int unknown() { return Pricing.price(MissingInputs.quantity()); }\n}\n"));
    git(["add", "src/test/java/example/PricingTest.java"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "missing argument fixture"]);
    const incomplete = await buildChangeManifest(repo, manifest.head);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      const bridge = await openInspectJava(repo, incomplete, config, join(home, "unresolved-tool-runs"));
      const bundle = await buildPiTools({
        repo, base: incomplete.base, inspectJava: bridge,
        evidence: { manifest: incomplete,
          async retrieve() { throw new Error("diff retrieval not needed"); },
          async auditPatch() { throw new Error("audit patch not needed"); } },
        graphLive: false, sandboxed: false, profilePath: join(home, "profile"), rulesRoot: home, memoryRepo: home,
      });
      try {
        const tool = bundle.tools.find((item) => item.name === "leveret_java_references")!;
        const response = await tool.execute("unresolved-evidence", {
          side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
        }, undefined, undefined, {} as never);
        const payload = response.content.find((item) => item.type === "text" && item.text?.startsWith("{"))?.text;
        const reply = referenceReplySchema.parse(JSON.parse(payload ?? "null"));
        if (!reply.ok) throw new Error(reply.error.message);
        expect(reply.result.items.filter((item) => item.kind === "reference").map((item) => item.reference?.location.range.start.line))
          .toEqual([3]);
        expect(reply.result.items.some((item) => item.kind === "unresolved" && item.unresolved?.sourceSet === "test")).toBe(true);
        expect(reply.result.summary.coverage.complete).toBe(false);
      } finally { await bundle.close(); }
    } finally { git(["reset", "--hard", manifest.head]); }
  }, 240_000);

  it("registered tool selects deleted methods on base without falling back from head", async () => {
    writeFileSync(main, readFileSync(main, "utf8").replace(" static int price(int n) { return n * 12; }\n", "\n"));
    git(["add", "src/main/java/example/Pricing.java"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "deleted method fixture"]);
    const deletion = await buildChangeManifest(repo, manifest.head);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      const bridge = await openInspectJava(repo, deletion, config, join(home, "base-tool-runs"));
      const bundle = await buildPiTools({
        repo, base: deletion.base, inspectJava: bridge,
        evidence: { manifest: deletion,
          async retrieve() { throw new Error("diff retrieval not needed"); },
          async auditPatch() { throw new Error("audit patch not needed"); } },
        graphLive: false, sandboxed: false, profilePath: join(home, "profile"), rulesRoot: home, memoryRepo: home,
      });
      try {
        const tool = bundle.tools.find((item) => item.name === "leveret_java_references")!;
        const target = { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } };
        const baseResult = await tool.execute("base-ref", { side: "base", target }, undefined, undefined, {} as never);
        const baseReply = referenceReplySchema.parse(JSON.parse(baseResult.content.find((item) => item.text?.startsWith("{"))?.text ?? "null"));
        if (!baseReply.ok) throw new Error(baseReply.error.message);
        expect(baseReply.result.items.filter((item) => item.kind === "reference").map((item) => item.reference?.location.path))
          .toEqual(["src/test/java/example/PricingTest.java"]);
        const headResult = await tool.execute("head-ref", { side: "head", target }, undefined, undefined, {} as never);
        const headReply = referenceReplySchema.parse(JSON.parse(headResult.content.find((item) => item.text?.startsWith("{"))?.text ?? "null"));
        expect(headReply).toMatchObject({ ok: false, error: { code: "target-missing" } });
      } finally { await bundle.close(); }
    } finally { git(["reset", "--hard", manifest.head]); }
  }, 240_000);

  it("rejects dirty Java outside the diff before publishing an analysis", async () => {
    writeFileSync(test, readFileSync(test, "utf8").replace("Pricing.price(3)", "Pricing.price(4)"));
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, manifest, config, join(home, "dirty-runs")))
        .rejects.toMatchObject({ code: "snapshot-mismatch" });
    } finally { git(["checkout", "--", "src/test/java/example/PricingTest.java"]); }
  }, 240_000);

  it("rejects non-UTF8 Java source with a structured input error", async () => {
    writeFileSync(test, Buffer.from([0xff, 0xfe]));
    git(["add", "src/test/java/example/PricingTest.java"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "invalid UTF-8 fixture"]);
    const malformed = await buildChangeManifest(repo, manifest.head);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, malformed, config, join(home, "encoding-runs")))
        .rejects.toMatchObject({ code: "invalid-input" });
    } finally { git(["reset", "--hard", manifest.head]); }
  }, 240_000);

  it("rejects ignored untracked Java inside the selected root", async () => {
    const ignored = join(repo, "src/main/java/example/ignored.java");
    writeFileSync(join(repo, ".gitignore"), "ignored.java\n");
    writeFileSync(ignored, "class Hidden { }\n");
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, manifest, config, join(home, "ignored-runs")))
        .rejects.toMatchObject({ code: "snapshot-mismatch" });
    } finally {
      rmSync(ignored);
      rmSync(join(repo, ".gitignore"));
    }
  }, 240_000);

  it("rejects a source-root symlink escaping the checkout even when bytes match", async () => {
    const root = join(repo, "src/test/java");
    const external = join(home, "external-test-java");
    renameSync(root, external);
    symlinkSync(external, root);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, manifest, config, join(home, "symlink-runs")))
        .rejects.toMatchObject({ code: "snapshot-mismatch" });
    } finally {
      rmSync(root);
      renameSync(external, root);
    }
  }, 240_000);

  it("rejects runtime state reached through a symlink into the checkout", async () => {
    const link = join(home, "checkout-link");
    symlinkSync(repo, link);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, manifest, config, join(link, "internal-state")))
        .rejects.toMatchObject({ code: "invalid-input" });
    } finally {
      rmSync(link);
      rmSync(join(repo, "internal-state"), { recursive: true, force: true });
    }
  }, 240_000);

  it("rejects a derived-facts symlink into the checkout", async () => {
    const state = join(home, "store-link-runs");
    mkdirSync(state);
    const link = join(state, "java-facts");
    symlinkSync(repo, link);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      await expect(openInspectJava(repo, manifest, config, state))
        .rejects.toMatchObject({ code: "invalid-input" });
    } finally {
      rmSync(link);
      rmSync(join(repo, "refs.mv.db"), { force: true });
      rmSync(join(repo, "refs.trace.db"), { force: true });
    }
  }, 240_000);

  it("rejects a changed cached artifact at the same path before querying", async () => {
    const config = await loadInspectJavaConfig(repo, configPath, digest);
    const bridge = await openInspectJava(repo, manifest, config, join(home, "artifact-runs"));
    const original = readFileSync(cachedArtifact);
    try {
      writeFileSync(cachedArtifact, Buffer.from("changed artifact"));
      await expect(bridge.references({
        analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
        manifest, side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
      })).rejects.toMatchObject({ code: "configuration-mismatch" });
    } finally {
      writeFileSync(cachedArtifact, original);
      await bridge.close();
    }
  }, 240_000);
  it("keeps host network, HOME, credentials, and excess heap outside the worker", async () => {
    const server = createServer();
    let reachedHost = false;
    server.on("connection", () => { reachedHost = true; });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP fixture did not bind");
    const probeDist = join(home, "probe-distribution");
    const source = join(home, "Probe.java");
    const classes = join(home, "probe-classes");
    const sentinel = join(home, "host-sentinel");
    mkdirSync(join(probeDist, "bin"), { recursive: true });
    mkdirSync(join(probeDist, "lib"), { recursive: true });
    mkdirSync(classes);
    writeFileSync(sentinel, "private host data");
    writeFileSync(source, `
      import java.net.*; import java.nio.file.*;
      public class Probe {
        public static void main(String[] args) throws Exception {
          boolean network;
          try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", ${address.port}), 500);
            network = true;
          } catch (Exception denied) { network = false; }
          boolean home = Files.exists(Path.of(${JSON.stringify(sentinel)}));
          boolean credentials = System.getenv("GITHUB_TOKEN") != null || System.getenv("JAVA_TOOL_OPTIONS") != null;
          boolean heapDenied;
          try { byte[] oversized = new byte[1_500_000_000]; heapDenied = false; }
          catch (OutOfMemoryError denied) { heapDenied = true; }
          String limits = Files.readString(Path.of("/proc/self/limits"));
          Files.writeString(Path.of("/store/probe.txt"),
            "network=" + network + "\\nHOME=" + home + "\\ncredentials=" + credentials +
            "\\nheapDenied=" + heapDenied + "\\naddressSpaceLimited=" + limits.contains("8589934592") + "\\n");
          System.out.println("{\\"ok\\":false,\\"error\\":{\\"code\\":\\"worker-failed\\",\\"message\\":\\"probe finished\\"}}");
        }
      }
    `);
    execFileSync("javac", ["-d", classes, source]);
    const jar = join(probeDist, "lib/probe.jar");
    execFileSync("jar", ["--create", "--file", jar, "-C", classes, "."]);
    const launcher = join(probeDist, "bin/leveret-inspect");
    writeFileSync(launcher, "#!/bin/sh\nexec /jdk/bin/java $JAVA_OPTS -cp /tool/lib/probe.jar Probe\n", { mode: 0o755 });
    const originalConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const files = ["bin/leveret-inspect", "lib/probe.jar"];
    const probePath = join(home, "probe-config.json");
    writeFileSync(probePath, JSON.stringify({
      ...originalConfig, distribution: probeDist,
      distributionFiles: Object.fromEntries(files.map((file) => [
        file, createHash("sha256").update(readFileSync(join(probeDist, file))).digest("hex"),
      ])),
    }));
    const previousGithub = process.env.GITHUB_TOKEN;
    const previousJVM = process.env.JAVA_TOOL_OPTIONS;
    process.env.GITHUB_TOKEN = "must-not-reach-worker";
    process.env.JAVA_TOOL_OPTIONS = "must-not-reach-worker";
    try {
      const config = await loadInspectJavaConfig(repo, probePath,
        createHash("sha256").update(readFileSync(probePath)).digest("hex"));
      await expect(openInspectJava(repo, manifest, config, join(home, "probe-runs")))
        .rejects.toMatchObject({ code: "worker-failed" });
      expect(readFileSync(join(home, "probe-runs/java-facts/probe.txt"), "utf8"))
        .toBe("network=false\nHOME=false\ncredentials=false\nheapDenied=true\naddressSpaceLimited=true\n");
      expect(reachedHost).toBe(false);
    } finally {
      if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousGithub;
      if (previousJVM === undefined) delete process.env.JAVA_TOOL_OPTIONS;
      else process.env.JAVA_TOOL_OPTIONS = previousJVM;
      server.close();
    }
  }, 240_000);

  it("kills a TERM-ignoring worker at the deadline without publishing facts", async () => {
    const dist = join(home, "hung-distribution");
    mkdirSync(join(dist, "bin"), { recursive: true });
    mkdirSync(join(dist, "lib"), { recursive: true });
    const script = join(dist, "bin/leveret-inspect");
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", { mode: 0o755 });
    const configPathHung = join(home, "hung-config.json");
    const original = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPathHung, JSON.stringify({
      ...original, distribution: dist,
      distributionFiles: { "bin/leveret-inspect": createHash("sha256").update(readFileSync(script)).digest("hex") },
      limits: { ...(original.limits as object), deadlineMs: 1000 },
    }));
    const config = await loadInspectJavaConfig(repo, configPathHung,
      createHash("sha256").update(readFileSync(configPathHung)).digest("hex"));
    const runDir = join(home, "hung-runs");
    await expect(openInspectJava(repo, manifest, config, runDir))
      .rejects.toMatchObject({ code: "resource-exhausted" });
    expect(readdirSync(runDir)).toEqual(["java-facts"]);
    expect(readdirSync(join(runDir, "java-facts"))).toEqual([]);
  }, 240_000);

  it("never executes a Gradle script from the reviewed repository", async () => {
    const script = join(repo, "build.gradle.kts");
    writeFileSync(script, "java.nio.file.Files.writeString(java.nio.file.Path.of(\"/store/poisoned\"), \"executed\")\n");
    git(["add", "build.gradle.kts"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "poisoned build fixture"]);
    const poisoned = await buildChangeManifest(repo, manifest.head);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      const state = join(home, "poisoned-runs");
      const bridge = await openInspectJava(repo, poisoned, config, state);
      try {
        expect(bridge.summaries.head.coverage.complete).toBe(true);
        expect(readdirSync(join(state, "java-facts")).some((name) => name === "poisoned")).toBe(false);
      } finally { await bridge.close(); }
    } finally {
      git(["reset", "--hard", manifest.head]);
    }
  }, 240_000);

  it("discloses a second Java module as unexamined coverage", async () => {
    const extra = join(repo, "other/src/main/java/Other.java");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, "class Other { void consumer() {} }\n");
    git(["add", "other/src/main/java/Other.java"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "extra module"]);
    const expanded = await buildChangeManifest(repo, manifest.head);
    try {
      const config = await loadInspectJavaConfig(repo, configPath, digest);
      const bridge = await openInspectJava(repo, expanded, config, join(home, "other-module-runs"));
      try {
        const page = await bridge.references({
          analysisId: bridge.summaries.head.analysisId, configurationSha256: bridge.summaries.head.configurationSha256,
          manifest: expanded, side: "head", target: { path: "src/main/java/example/Pricing.java", position: { line: 3, column: 14 } },
        });
        expect(page.summary.coverage.complete).toBe(false);
        expect(page.items.some((item) => item.file?.path === "other/src/main/java/Other.java" && item.file.examined === false)).toBe(true);
      } finally { await bridge.close(); }
    } finally {
      git(["reset", "--hard", manifest.head]);
      rmSync(join(repo, "other"), { recursive: true, force: true });
    }
  }, 240_000);
});
