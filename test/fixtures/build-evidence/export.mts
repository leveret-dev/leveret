// Test-owned stand-in for a client's pipeline export step. It is NOT shipped product code and the
// consumer never runs it: the fixture helper runs it as the "client stage", exactly like a client
// would run its own command, and the consumer later sees only the published manifest + payload.
//
// The command is a real (tiny) pipeline: it reads originals from the pinned Git objects, extracts a
// workspace for the build, expands the Java template and filters resources from build properties,
// compiles with the installed javac, captures payload bytes, and publishes the manifest last via an
// atomic rename. Modes change actual inputs/outcomes; no response is prewritten.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MODES = ["valid", "in-place", "generation-failed", "template-defect", "secret-resource"];
// Mirrors FIXTURE_SECRET_MARKER in test/build-evidence-fixture.ts; the fixture test asserts parity.
const SECRET = "ghp_LeveretFixtureSecret0123456789abcdef";
const DOLLAR = /\$\{([A-Za-z][A-Za-z0-9]*)\}/g;
const AT = /@([A-Z][A-Z0-9]*)@/g;

class PropertyError extends Error {}

const { values } = parseArgs({
  options: { repo: { type: "string" }, revision: { type: "string" }, output: { type: "string" }, mode: { type: "string" } },
  strict: true,
});
for (const flag of ["repo", "revision", "output", "mode"] as const) if (!values[flag]) throw new Error(`--${flag} is required`);
const repo = resolve(values.repo!);
const out = resolve(values.output!);
const mode = values.mode!;
if (!MODES.includes(mode)) throw new Error(`unknown --mode ${mode}`);

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args: string[]): Buffer => execFileSync("git", ["-C", repo, ...args], { env, maxBuffer: 256 << 20 });
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const byUtf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const commit = git(["rev-parse", "--verify", `${values.revision}^{commit}`]).toString().trim();

/** Authored bytes come from the pinned Git object, never from the (possibly mutated) workspace. */
function original(path: string): Buffer {
  const [meta] = git(["ls-tree", "-z", commit, "--", path]).toString().split("\t");
  const [fileMode, type] = (meta ?? "").split(" ");
  if (type !== "blob" || !["100644", "100755"].includes(fileMode)) throw new Error(`${path} is not a regular blob at ${commit}`);
  return git(["cat-file", "blob", `${commit}:${path}`]);
}

type Position = { line: number; column: number };
const position = (text: string, index: number): Position => {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: index - (before.lastIndexOf("\n") + 1) };
};

/** Placeholder expansion that records the exact input/output ranges (one-based lines, UTF-16 columns). */
function expand(text: string, pattern: RegExp, lookup: (key: string) => string | undefined) {
  let result = "";
  let cursor = 0;
  const spans: { inStart: number; inEnd: number; outStart: number; outEnd: number }[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = lookup(match[1]);
    if (value === undefined) throw new PropertyError(`unresolved property ${match[1]}`);
    if (/[\r\n]/.test(value)) throw new PropertyError("multi-line property value");
    result += text.slice(cursor, match.index) + value;
    cursor = match.index + match[0].length;
    spans.push({ inStart: match.index, inEnd: cursor, outStart: result.length - value.length, outEnd: result.length });
  }
  result += text.slice(cursor);
  const locations = spans.map((span) => ({
    inputRange: { start: position(text, span.inStart), end: position(text, span.inEnd) },
    outputRange: { start: position(result, span.outStart), end: position(result, span.outEnd) },
  }));
  return { text: result, locations };
}

function properties(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    map.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  return map;
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(join(dir, entry.name), path);
    if (!entry.isFile()) throw new Error(`non-regular build output ${path}`);
    return [path];
  }).sort(byUtf8);
}

// ── stage 0: client workspace for the requested revision ────────────────────────────────────────
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out);
const workspace = join(out, "workspace");
mkdirSync(workspace);
execFileSync("tar", ["-x", "-C", workspace], { input: git(["archive", "--format=tar", commit]), maxBuffer: 256 << 20 });
const payload = join(out, "payload");
mkdirSync(payload);
const read = (path: string) => readFileSync(join(workspace, path), "utf8");
const write = (root: string, path: string, content: Buffer | string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, { flag: "wx" });
};

// ── stage 1: build properties, source generation and resource processing ────────────────────────
const buildProperties = properties(read("generator.properties"));
if (mode === "secret-resource") buildProperties.set("apiToken", SECRET); // CI-provided, never tracked
let generationState = "succeeded";
let generated: ReturnType<typeof expand> | null = null;
const generatedSource = mode === "in-place" ? "src/main/java/example/Pricing.java" : "build/generated/example/Pricing.java";
try {
  if (mode === "in-place") {
    // In-place transformation: the tracked workspace file is overwritten; the Git original is untouched.
    generated = expand(read(generatedSource), AT, (key) => buildProperties.get(key.toLowerCase()));
    writeFileSync(join(workspace, generatedSource), generated.text);
  } else {
    generated = expand(read("templates/Pricing.java.tpl"), DOLLAR, (key) => buildProperties.get(key));
    write(workspace, generatedSource, generated.text);
  }
} catch (error) {
  if (!(error instanceof PropertyError)) throw error;
  generationState = "failed";
}
const resource = expand(read("src/main/resources/application.properties"), DOLLAR, (key) => buildProperties.get(key));
write(workspace, "build/resources/main/application.properties", resource.text);

// ── stage 2: compile with the installed javac (effective, not launcher, settings) ───────────────
const javac = realpathSync(execFileSync("which", ["javac"], { encoding: "utf8" }).trim());
const jdk = dirname(dirname(javac));
const javaVersion = /^JAVA_VERSION="([^"]+)"/m.exec(readFileSync(join(jdk, "release"), "utf8"))?.[1];
if (!javaVersion) throw new Error("JDK release file has no JAVA_VERSION");
mkdirSync(join(workspace, "build/empty"), { recursive: true });
/**
 * Every fixture mode is designed to compile, so a javac failure is a fixture bug, never a silently
 * recorded "failed" outcome: surface the compiler's own diagnostics and abort before any publish.
 */
function compile(classes: string, sources: string[], classpath: string): "succeeded" {
  mkdirSync(classes, { recursive: true });
  try {
    execFileSync(javac, ["-proc:none", "-encoding", "UTF-8", "-source", "21", "-target", "21", "-Xlint:-options",
      "-classpath", classpath, "-d", classes, ...sources], { env, stdio: "pipe" });
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`javac failed for ${classes}:\n${stderr?.toString("utf8") ?? ""}${stdout?.toString("utf8") ?? ""}`, { cause: error });
  }
  return "succeeded";
}
const prodClasses = join(workspace, "build/classes/main");
const testClasses = join(workspace, "build/classes/test");
const prodState = generationState === "failed" ? "not-run"
  : compile(prodClasses, [join(workspace, "src/main/java/example/Consumer.java"), join(workspace, generatedSource)], join(workspace, "build/empty"));
const testState = prodState !== "succeeded" ? "not-run"
  : compile(testClasses, [join(workspace, "src/test/java/example/PricingTest.java")], prodClasses);

// ── stage 3: capture payload, then describe it ──────────────────────────────────────────────────
const capture = (path: string, bytes: Buffer | string) => { write(payload, path, bytes); return { sha256: sha256(bytes), sizeBytes: Buffer.byteLength(bytes) }; };
const authored = (id: string, role: string, path: string) => {
  const bytes = original(path);
  return { id, kind: "file", role, origin: "authored", repositoryPath: path, availability: "available",
    content: { location: { kind: "repository", path }, sha256: sha256(bytes), sizeBytes: bytes.length }, encoding: "UTF-8" };
};
const file = (id: string, role: string, repositoryPath: string, payloadPath: string, text: string) => ({
  id, kind: "file", role, origin: "materialized", repositoryPath, availability: "available",
  content: { location: { kind: "payload", path: payloadPath }, ...capture(payloadPath, text) }, encoding: "UTF-8",
});
const directory = (id: string, repositoryPath: string, payloadPath: string, root: string) => ({
  id, kind: "directory", role: "classes", origin: "materialized", repositoryPath, availability: "available",
  location: { kind: "payload", path: payloadPath },
  entries: walk(root).map((path) => ({ path, ...capture(`${payloadPath}/${path}`, readFileSync(join(root, path))) })),
});
const absent = (id: string, kind: string, role: string, repositoryPath: string, availability: string, reason: string) =>
  ({ id, kind, role, origin: "materialized", repositoryPath, availability, reason });

const pricingOriginal = mode === "in-place"
  ? authored("pricing-original", "source", "src/main/java/example/Pricing.java")
  : authored("pricing-template", "template", "templates/Pricing.java.tpl");
const pricingOutput = generated
  ? file("pricing-output", "source", generatedSource, "generated/main/example/Pricing.java", generated.text)
  : absent("pricing-output", "file", "source", generatedSource, "not-produced", "generation failed before this file was written");
const resourceOutput = file("app-resource-output", "resource", "build/resources/main/application.properties", "resources/main/application.properties", resource.text);
const prodOutput = prodState === "succeeded"
  ? directory("prod-classes", "build/classes/main", "classes/main", prodClasses)
  : absent("prod-classes", "directory", "classes", "build/classes/main", "not-produced", "compilation did not produce classes");
const testOutput = testState === "succeeded"
  ? directory("test-classes", "build/classes/test", "classes/test", testClasses)
  : absent("test-classes", "directory", "classes", "build/classes/test", "not-produced", "compilation did not produce classes");

const artifacts = [
  pricingOriginal,
  authored("pricing-generator-config", "build-config", "generator.properties"),
  authored("consumer-original", "source", "src/main/java/example/Consumer.java"),
  authored("app-resource-original", "resource", "src/main/resources/application.properties"),
  authored("pricing-test", "source", "src/test/java/example/PricingTest.java"),
  pricingOutput, resourceOutput, prodOutput, testOutput,
];

const emptyPath = () => ({ state: "complete", reason: null, entries: [] });
/** The platform image is large (JDK `lib/modules`); stream it so parallel exports stay small. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const compiler = {
  name: "javac", version: javaVersion, javaVersion,
  platform: { state: "identified", fingerprints: [
    { name: "release", sha256: await sha256File(join(jdk, "release")) },
    { name: "modules", sha256: await sha256File(join(jdk, "lib/modules")) },
  ] },
  release: { state: "unset", value: null }, sourceLevel: "21", targetLevel: "21", encoding: "UTF-8", preview: false,
  moduleOptions: { sourcePath: emptyPath(), bootClasspath: emptyPath(), addReads: [], addExports: [], patchModules: [], addModules: [], limitModules: [] },
};
const inPlaceRoot = mode === "in-place"
  ? { id: "main", repositoryPath: "src/main/java", members: [
    { artifactId: "consumer-original", relativePath: "example/Consumer.java" },
    { artifactId: "pricing-output", relativePath: "example/Pricing.java" },
  ] }
  : null;
const compilations = [
  {
    id: "prod", moduleId: "root", moduleDir: ".", name: "main", sourceSetRole: "production", language: "java",
    inputArtifactIds: ["consumer-original", "pricing-output"],
    sourceRoots: inPlaceRoot ? [inPlaceRoot] : [
      { id: "authored-main", repositoryPath: "src/main/java", members: [{ artifactId: "consumer-original", relativePath: "example/Consumer.java" }] },
      { id: "generated-main", repositoryPath: "build/generated", members: [{ artifactId: "pricing-output", relativePath: "example/Pricing.java" }] },
    ],
    authoredArtifactIds: [pricingOriginal.id, "pricing-generator-config", "consumer-original", "app-resource-original"],
    resourceArtifactIds: ["app-resource-output"],
    outputArtifactIds: ["prod-classes"],
    inventory: generated
      ? { state: "complete", reason: null }
      : { state: "partial", reason: "generated source pricing-output was not produced" },
    compiler,
    compileClasspath: emptyPath(), modulePath: emptyPath(), processorPath: emptyPath(),
    generationState, resourceState: "succeeded", compilationState: prodState,
  },
  {
    id: "test", moduleId: "root", moduleDir: ".", name: "test", sourceSetRole: "test", language: "java",
    inputArtifactIds: ["pricing-test"],
    sourceRoots: [{ id: "authored-test", repositoryPath: "src/test/java", members: [{ artifactId: "pricing-test", relativePath: "example/PricingTest.java" }] }],
    authoredArtifactIds: ["pricing-test"],
    resourceArtifactIds: [],
    outputArtifactIds: ["test-classes"],
    inventory: { state: "complete", reason: null },
    compiler,
    compileClasspath: { state: "complete", reason: null, entries: [{ artifactId: "prod-classes", coordinates: null, upstreamCompilationId: "prod" }] },
    modulePath: emptyPath(), processorPath: emptyPath(),
    generationState: "not-run", resourceState: "not-run", compilationState: testState,
  },
];

const transformations = [
  ...(generated ? [mode === "in-place"
    ? { id: "pricing-inplace", producer: { name: "fixture-inplace-expander", version: null, executionId: "expand-pricing" },
      kind: "transform", inputArtifactIds: ["pricing-original", "pricing-generator-config"], outputArtifactIds: ["pricing-output"],
      basis: "exporter-recorded", locations: generated.locations.map((l) => ({ inputArtifactId: "pricing-original", outputArtifactId: "pricing-output", ...l })) }
    : { id: "pricing-generate", producer: { name: "fixture-template-generator", version: "1.0.0", executionId: "generate-pricing" },
      kind: "generate", inputArtifactIds: ["pricing-template", "pricing-generator-config"], outputArtifactIds: ["pricing-output"],
      basis: "exporter-recorded", locations: generated.locations.map((l) => ({ inputArtifactId: "pricing-template", outputArtifactId: "pricing-output", ...l })) }] : []),
  { id: "resource-filter", producer: { name: "fixture-resource-filter", version: "1.0.0", executionId: "filter-resources" },
    kind: "resource-process", inputArtifactIds: ["app-resource-original", "pricing-generator-config"], outputArtifactIds: ["app-resource-output"],
    basis: "exporter-recorded", locations: resource.locations.map((l) => ({ inputArtifactId: "app-resource-original", outputArtifactId: "app-resource-output", ...l })) },
];

const diagnostics = generated ? [] : [
  { code: "generation-failed", message: "template generation failed for compilation prod", compilationId: "prod", artifactIds: ["pricing-output"] },
];

const manifest = {
  schema: "leveret.build-evidence/v1", repositoryId: "fixture", revision: commit,
  producer: { name: "leveret-fixture-exporter", version: "1.0.0", buildTool: { name: "fixture-pipeline", version: "1" }, runId: `${mode}-${commit.slice(0, 12)}` },
  context: { id: "fixture-main", profiles: [], variant: { state: "unset", value: null } },
  artifacts, compilations, transformations, diagnostics,
};

// ── stage 4: publish — payload is complete, so the manifest appears atomically and last ─────────
writeFileSync(join(out, "manifest.json.tmp"), `${JSON.stringify(manifest)}\n`, { flag: "wx" });
renameSync(join(out, "manifest.json.tmp"), join(out, "manifest.json"));
