import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { validateChangeManifestCheckout, type ChangeManifest } from "./change-evidence.js";
import { GitObjectError, gitBytes, isSafeRelativePath, readGitBlobs, readGitTree } from "./git-objects.js";
import { runStreaming } from "./exec.js";
import { pathIsInside } from "./path.js";
import { readBuildArtifact, type BuildArtifactReadReply, type BuildArtifactReadRequest } from "./build-artifact-reader.js";
import { prepareBuildJavaInputs, type BuildJavaDecision, type PreparedJavaCompilation } from "./build-java-inputs.js";
import type { BuildEvidencePin } from "./build-evidence-contract.js";
import {
  admitBuildEvidence, buildEvidenceSummary, type BuildEvidenceAdmission, type PublicBuildEvidenceSummary,
} from "./build-evidence.js";
import { refreshSecretPolicy, screenText, type SecretPolicy } from "./secret-screening.js";
import { analysisSummarySchema, inspectErrorSchema, referenceReplySchema, type AnalysisSummary, type InspectError, type ReferencePage, type ReferenceRequest } from "./inspect-java-contract.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const contextVariantSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("set"), value: z.string() }).strict(),
  z.object({ state: z.literal("unset"), value: z.null() }).strict(),
]);
const buildEvidencePinSchema: z.ZodType<BuildEvidencePin> = z.object({
  manifestPath: z.string().min(1), manifestSha256: hex, payloadRoot: z.string().min(1),
  expectedContext: z.object({
    id: z.string().min(1), profiles: z.array(z.string()).optional(), variant: contextVariantSchema.optional(),
  }).strict(),
  select: z.object({
    moduleDir: z.string(), productionId: z.string().min(1), testId: z.string().min(1).nullable(),
  }).strict(),
}).strict();
const configSchema = z.object({
  schema: z.literal(1), repositoryId: z.string().min(1), distribution: z.string().min(1),
  distributionFiles: z.record(z.string(), hex), jdkHome: z.string().min(1),
  jdkFiles: z.record(z.string(), hex),
  cache: z.string().min(1), module: z.string(), build: z.enum(["maven", "gradle"]),
  mainRoots: z.array(z.string()).length(1), testRoots: z.array(z.string()).length(1), javaLevel: z.string().regex(/^(?:1\.[1-9]|[1-9]\d*)$/),
  maxJavaFiles: positive.optional(),
  limits: z.object({ heapBytes: positive, addressSpaceBytes: positive, deadlineMs: positive, maxOutputBytes: positive }).strict(),
  buildEvidence: z.object({ base: buildEvidencePinSchema.optional(), head: buildEvidencePinSchema.optional() }).strict().optional(),
  screening: z.object({
    rules: z.array(z.object({
      id: z.string().min(1), source: z.string(), flags: z.string().regex(/^[dgimsuvy]*$/).optional().default(""),
    }).strict()).optional().default([]),
    nonSecretValues: z.array(z.string()).optional().default([]),
  }).strict().optional(),
}).strict();
const preparedSchema = z.object({ summary: analysisSummarySchema, artifacts: z.record(z.string(), hex) }).strict();
export type InspectJavaConfig = z.infer<typeof configSchema> & { readonly configPath: string; readonly configSha256: string };
export class InspectJavaError extends Error {
  constructor(readonly code: InspectError["code"], message: string, readonly requiredBytes?: number) { super(message); }
}
export type InspectJavaBuildEvidence = PublicBuildEvidenceSummary & {
  javaScopes: readonly {
    role: "production" | "test";
    compilationId: string | null;
    outcome: "prepared" | "fallback" | "unavailable";
    reason: string | null;
  }[];
};
export interface InspectJavaBridge {
  summaries: { base: AnalysisSummary; head: AnalysisSummary };
  identity: { configSha256: string; distributionSha256: string; jdkSha256: string };
  buildEvidence: { base: InspectJavaBuildEvidence; head: InspectJavaBuildEvidence };
  references(request: ReferenceRequest): Promise<ReferencePage>;
  readArtifact(side: "base" | "head", request: BuildArtifactReadRequest): Promise<BuildArtifactReadReply>;
  close(): Promise<void>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const EMPTY_PATHS: ReadonlySet<string> = new Set();

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Git readers throw GitObjectError; the bridge keeps exposing the same code and message as InspectJavaError. */
async function fromGit<T>(read: Promise<T>): Promise<T> {
  try { return await read; }
  catch (error) { throw error instanceof GitObjectError ? new InspectJavaError(error.code, error.message) : error; }
}

function safeRelative(path: string): string {
  if (!isSafeRelativePath(path)) throw new InspectJavaError("invalid-input", `Unsafe snapshot path: ${path}`);
  return path;
}

async function verifyToolchain(config: InspectJavaConfig): Promise<void> {
  const files = ["bin/leveret-inspect", ...(await readdir(join(config.distribution, "lib"))).map((name) => `lib/${name}`)].sort();
  if (files.join("\0") !== Object.keys(config.distributionFiles).sort().join("\0")) {
    throw new InspectJavaError("configuration-mismatch", "Installed Java distribution files differ from pinned configuration");
  }
  for (const name of files) {
    safeRelative(name);
    const path = join(config.distribution, name);
    if (!(await lstat(path).catch(() => null))?.isFile() || await digestFile(path) !== config.distributionFiles[name]) {
      throw new InspectJavaError("configuration-mismatch", `Installed distribution file changed: ${name}`);
    }
  }
  const requiredJdkFiles = ["bin/java", "release", "lib/modules", "lib/server/libjvm.so"];
  if (requiredJdkFiles.some((name) => !config.jdkFiles[name])) {
    throw new InspectJavaError("configuration-mismatch", "JDK identity is missing required runtime files");
  }
  for (const [name, sha256] of Object.entries(config.jdkFiles)) {
    safeRelative(name);
    const file = join(config.jdkHome, name);
    if (!(await lstat(file).catch(() => null))?.isFile() || await digestFile(file) !== sha256) {
      throw new InspectJavaError("configuration-mismatch", `Pinned JDK file changed: ${name}`);
    }
  }
}

async function validateOptionalConfig(repository: string, config: z.infer<typeof configSchema>): Promise<void> {
  for (const rule of config.screening?.rules ?? []) {
    try { new RegExp(rule.source, rule.flags); }
    catch { throw new InspectJavaError("invalid-input", "Java screening rule is not a valid regular expression"); }
  }
  for (const pin of Object.values(config.buildEvidence ?? {})) {
    if (!pin) continue;
    if (!isAbsolute(pin.manifestPath) || !isAbsolute(pin.payloadRoot) ||
      pathIsInside(repository, resolve(pin.manifestPath)) || pathIsInside(repository, resolve(pin.payloadRoot)) ||
      pathIsInside(resolve(pin.payloadRoot), repository) ||
      pin.select.moduleDir !== "." && !isSafeRelativePath(pin.select.moduleDir)) {
      throw new InspectJavaError("invalid-input", "Invalid build-evidence host path or selection");
    }
    const [manifestFile, payloadDirectory] = await Promise.all([
      lstat(pin.manifestPath).catch(() => null), lstat(pin.payloadRoot).catch(() => null),
    ]);
    if (manifestFile?.isSymbolicLink() || payloadDirectory?.isSymbolicLink()) {
      throw new InspectJavaError("invalid-input", "Build-evidence host paths must not be symbolic links");
    }
    if (manifestFile?.isFile() && (manifestFile.mode & 0o111) !== 0) {
      throw new InspectJavaError("invalid-input", "Build-evidence manifest must not select an executable");
    }
    for (const protectedRoot of [repository, config.distribution, config.jdkHome, config.cache]) {
      if (pathIsInside(protectedRoot, resolve(pin.manifestPath)) || pathIsInside(protectedRoot, resolve(pin.payloadRoot)) ||
        pathIsInside(resolve(pin.payloadRoot), protectedRoot)) {
        throw new InspectJavaError("invalid-input", "Build-evidence host paths overlap protected worker or repository state");
      }
    }
  }
}

export async function loadInspectJavaConfig(repo: string, path: string, sha256: string): Promise<InspectJavaConfig> {
  if (!hex.safeParse(sha256).success) throw new InspectJavaError("invalid-input", "Expected SHA-256 configuration pin");
  const [repository, file] = await Promise.all([realpath(repo), realpath(path)]);
  if (pathIsInside(repository, file)) throw new InspectJavaError("invalid-input", "Java configuration must be outside reviewed checkout");
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new InspectJavaError("configuration-mismatch", "Java configuration digest differs");
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(bytes)); }
  catch { throw new InspectJavaError("invalid-input", "Java configuration is not valid UTF-8 JSON"); }
  const validated = configSchema.safeParse(parsed);
  if (!validated.success) throw new InspectJavaError("invalid-input", "Java configuration does not match the supported contract");
  const config = validated.data;
  if (config.module !== ".") safeRelative(config.module);
  for (const root of [...config.mainRoots, ...config.testRoots]) {
    if (root === ".") throw new InspectJavaError("invalid-input", "Source roots must be explicit");
    safeRelative(root);
  }
  const main = config.mainRoots[0]!;
  const test = config.testRoots[0]!;
  if (main === test || main.startsWith(`${test}/`) || test.startsWith(`${main}/`)) {
    throw new InspectJavaError("invalid-input", "Main and test roots must not overlap");
  }
  for (const path of [config.distribution, config.jdkHome, config.cache]) {
    if (!isAbsolute(path) || pathIsInside(repository, await realpath(path))) {
      throw new InspectJavaError("invalid-input", "Worker paths must be absolute and outside reviewed checkout");
    }
  }
  if (config.limits.heapBytes < 16 * 1024 * 1024 || config.limits.heapBytes >= config.limits.addressSpaceBytes ||
    config.limits.maxOutputBytes > 8_388_608) {
    throw new InspectJavaError("invalid-input", "Invalid worker limits");
  }
  await validateOptionalConfig(repository, config);
  const result = { ...config, configPath: file, configSha256: sha256 };
  await verifyToolchain(result);
  return result;
}

async function verifyFrozenArtifacts(config: InspectJavaConfig, artifacts: Record<string, string>): Promise<void> {
  const cache = await realpath(config.cache);
  for (const [path, sha256] of Object.entries(artifacts)) {
    safeRelative(path);
    const file = await realpath(join(cache, path)).catch(() => null);
    if (!file || !pathIsInside(cache, file) || await digestFile(file) !== sha256) {
      throw new InspectJavaError("configuration-mismatch", `Classpath artifact changed: ${path}`);
    }
  }
}

function modulePath(path: string, module: string): string | null {
  return module === "." ? path : path.startsWith(`${module}/`) ? path.slice(module.length + 1) : null;
}

function selected(path: string, config: InspectJavaConfig): boolean {
  const moduleRelative = modulePath(path, config.module);
  if (moduleRelative === null) return false;
  return [...config.mainRoots, ...config.testRoots].some((root) => moduleRelative.startsWith(`${root}/`) && moduleRelative.endsWith(".java")) ||
    ["pom.xml", "gradle.lockfile", "settings.gradle", "settings.gradle.kts", "gradle/libs.versions.toml"].includes(moduleRelative);
}

async function snapshot(
  repo: string, revision: string, destination: string, config: InspectJavaConfig, live: boolean,
  withheld: ReadonlySet<string> = EMPTY_PATHS, policy?: SecretPolicy,
): Promise<Array<{ path: string; sourceSet: "main" | "test"; reason: string }>> {
  const treeEntries = await fromGit(readGitTree(repo, revision));
  const held = new Set(withheld);
  const candidates = treeEntries.filter((item) => selected(item.path, config) && !held.has(item.path));
  if (config.maxJavaFiles !== undefined) {
    const count = treeEntries.reduce((total, item) => total + Number(item.path.endsWith(".java")), 0);
    if (count > config.maxJavaFiles) {
      throw new InspectJavaError("resource-exhausted", `Repository contains ${count} Java files; configured maxJavaFiles is ${config.maxJavaFiles}`);
    }
  }
  if (candidates.some((item) => !["100644", "100755"].includes(item.mode))) {
    throw new InspectJavaError("snapshot-mismatch", "Analyzed inputs include a symlink or nonregular file");
  }
  const contents = await fromGit(readGitBlobs(repo, candidates));
  const root = await realpath(repo);
  for (const entry of candidates) {
    const data = contents.get(entry.path)!;
    let text: string | undefined;
    if (entry.path.endsWith(".java") || entry.path.endsWith(".xml") || entry.path.endsWith(".gradle") ||
      entry.path.endsWith(".kts") || entry.path.endsWith(".lockfile") || entry.path.endsWith(".toml")) {
      try { text = decoder.decode(data); }
      catch { throw new InspectJavaError("invalid-input", `Analyzed input is not UTF-8: ${entry.path}`); }
    }
    if (policy && text !== undefined && screenText(text, policy).state === "withheld") held.add(entry.path);
    if (live) {
      const livePath = join(root, entry.path);
      const file = await lstat(livePath).catch(() => null);
      const actual = await realpath(livePath).catch(() => null);
      if (!file?.isFile() || actual !== livePath || !(await readFile(livePath)).equals(data)) {
        throw new InspectJavaError("snapshot-mismatch", `Dirty analyzed input: ${entry.path}`);
      }
    }
  }
  const entries = candidates.filter((item) => !held.has(item.path));
  if (!entries.some((item) => item.path.endsWith(".java"))) throw new InspectJavaError("analysis-unavailable", "No screened Java sources are available");
  for (const entry of entries) {
    const target = join(destination, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents.get(entry.path)!, { mode: 0o600 });
  }
  if (live) {
    const prefix = config.module === "." ? "" : `${config.module}/`;
    const others = await fromGit(gitBytes(repo, [
      "ls-files", "--others", "-z", "--", `:(glob)${prefix}**/*.java`, `:(glob)${prefix}*.java`,
    ]));
    for (const path of others.toString("binary").split("\0")) {
      if (path && selected(decoder.decode(Buffer.from(path, "binary")), config)) {
        throw new InspectJavaError("snapshot-mismatch", "Untracked Java source in configured module");
      }
    }
  }
  const moduleRoot = config.module === "." ? destination : join(destination, config.module);
  for (const path of [...config.mainRoots, ...config.testRoots]) {
    await mkdir(join(moduleRoot, path), { recursive: true });
  }
  return treeEntries.filter((item) => item.path.endsWith(".java") && (!selected(item.path, config) || held.has(item.path)))
    .map(({ path }) => ({
      path, sourceSet: path.split("/").includes("test") ? "test" as const : "main" as const,
      reason: held.has(path) ? "withheld by build-evidence policy" : "unsupported Java root or module",
    }));
}

async function sandbox(
  config: InspectJavaConfig, inputs: { snapshotDir?: string; preparedDir?: string },
  storeDir: string, work: string, command: object,
): Promise<unknown> {
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "request.json"), JSON.stringify(command), { mode: 0o600 });
  const limits = config.limits;
  const jvm = `-Xmx${Math.floor(limits.heapBytes / (1024 * 1024))}m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=128m -XX:ReservedCodeCacheSize=128m`;
  const tools = ["dash", "uname", "ls", "xargs", "echo", "sed", "tr"];
  const mounts = tools.flatMap((name) => ["--ro-bind", `/usr/bin/${name}`, `/usr/bin/${name}`]);
  const inputMounts = [
    ...(inputs.snapshotDir ? ["--ro-bind", inputs.snapshotDir, "/source", "--ro-bind", config.cache, "/cache"] : []),
    ...(inputs.preparedDir ? ["--ro-bind", inputs.preparedDir, "/prepared"] : []),
  ];
  const args = [
    `--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`, "--", "/usr/bin/bwrap",
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--dir", "/usr", "--dir", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind", "/usr/lib64", "/usr/lib64", ...mounts,
    "--symlink", "dash", "/usr/bin/sh", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", config.jdkHome, "/jdk", "--ro-bind", config.distribution, "/tool", ...inputMounts,
    "--bind", storeDir, "/store", "--bind", work, "/work",
    "--tmpfs", "/tmp", "--dir", "/home", "--proc", "/proc", "--dev", "/dev",
    "--setenv", "HOME", "/home", "--setenv", "XDG_CACHE_HOME", "/tmp/xdg", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "LANG", "C.UTF-8", "--setenv", "PATH", "/usr/bin", "--setenv", "JAVA_HOME", "/jdk",
    "--setenv", "JAVA_OPTS", jvm, "--chdir", "/work", "/tool/bin/leveret-inspect", "java", "--request", "/work/request.json",
  ];
  const result = await runStreaming("/usr/bin/prlimit", args, "/", {
    env: { PATH: "/usr/bin", HOME: "/nonexistent" }, timeoutMs: limits.deadlineMs,
    maxBuffer: limits.maxOutputBytes,
  });
  if (result.timedOut || result.truncated || result.signal || result.spawnError) {
    throw new InspectJavaError(result.timedOut || result.truncated ? "resource-exhausted" : "worker-failed", "Java worker terminated or exceeded limits");
  }
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); }
  catch { throw new InspectJavaError("worker-failed", `Invalid Java worker response (${result.code}): ${result.stderr.slice(0, 200)}`); }
  const page = referenceReplySchema.safeParse(raw);
  if (page.success) {
    if (!page.data.ok) {
      const diagnostic = page.data.error.code === "worker-failed" && result.stderr.trim()
        ? `: ${result.stderr.trim().slice(0, 500)}` : "";
      throw new InspectJavaError(page.data.error.code, `${page.data.error.message}${diagnostic}`, page.data.error.requiredBytes);
    }
    if (result.code !== 0) throw new InspectJavaError("worker-failed", "Worker reported success but exited unsuccessfully");
    return page.data.result;
  }
  const summary = z.object({ ok: z.literal(true), result: preparedSchema }).strict().safeParse(raw);
  if (summary.success && result.code === 0) return summary.data.result;
  const failure = z.object({ ok: z.literal(false), error: inspectErrorSchema }).strict().safeParse(raw);
  if (failure.success) throw new InspectJavaError(failure.data.error.code, failure.data.error.message, failure.data.error.requiredBytes);
  throw new InspectJavaError("worker-failed", `Invalid Java worker response (${result.code}): ${result.stderr.slice(0, 200)}`);
}

function secretPolicy(config: InspectJavaConfig, supplied?: SecretPolicy): SecretPolicy {
  if (!config.screening && supplied) return supplied;
  const configuredRules = (config.screening?.rules ?? []).map((rule) => ({
    id: rule.id, pattern: new RegExp(rule.source, rule.flags),
  }));
  return {
    id: supplied?.id ?? `inspect-java:${config.configSha256}`,
    available: supplied?.available ?? false,
    knownValues: supplied?.knownValues ?? new Set(),
    refreshKnownValues: supplied?.refreshKnownValues ?? (async () => []),
    additionalRules: [...(supplied?.additionalRules ?? []), ...configuredRules],
    nonSecretValues: new Set([...(supplied?.nonSecretValues ?? []), ...(config.screening?.nonSecretValues ?? [])]),
  };
}

async function verifyAdmission(admission: BuildEvidenceAdmission): Promise<void> {
  if (admission.outcome !== "admitted") return;
  for (const frozen of admission.frozen.available.values()) {
    const artifact = frozen.artifact;
    if (artifact.availability !== "available") throw new InspectJavaError("snapshot-mismatch", "Admitted artifact state changed");
    if (artifact.kind === "file") {
      const file = await lstat(frozen.path).catch(() => null);
      if (!file?.isFile() || file.isSymbolicLink() || file.size !== artifact.content.sizeBytes ||
        await digestFile(frozen.path) !== artifact.content.sha256) {
        throw new InspectJavaError("snapshot-mismatch", "Frozen build artifact changed");
      }
      continue;
    }
    const actual = new Map<string, { size: number; sha256: string }>();
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new InspectJavaError("snapshot-mismatch", "Frozen build artifact contains a symlink");
        if (entry.isDirectory()) await walk(path, relative);
        else if (entry.isFile()) {
          const stat = await lstat(path);
          actual.set(relative, { size: stat.size, sha256: await digestFile(path) });
        } else throw new InspectJavaError("snapshot-mismatch", "Frozen build artifact contains a non-file");
      }
    };
    await walk(frozen.path, "");
    if (actual.size !== artifact.entries.length || artifact.entries.some((entry) => {
      const found = actual.get(entry.path);
      return !found || found.size !== entry.sizeBytes || found.sha256 !== entry.sha256;
    })) throw new InspectJavaError("snapshot-mismatch", "Frozen build artifact changed");
  }
}

async function verifyPreparedScreening(
  admission: BuildEvidenceAdmission, compilations: readonly PreparedJavaCompilation[], policy: SecretPolicy,
): Promise<void> {
  if (admission.outcome !== "admitted") return;
  await refreshSecretPolicy(policy);
  if (!policy.available) throw new InspectJavaError("analysis-unavailable", "Build-evidence screening became unavailable");
  const ids = new Set(compilations.flatMap((compilation) => compilation.files.map((file) => file.buildArtifact.artifactId)));
  for (const id of ids) {
    const frozen = admission.frozen.available.get(id);
    if (!frozen || frozen.artifact.availability !== "available" || frozen.artifact.kind !== "file") {
      throw new InspectJavaError("snapshot-mismatch", "Prepared source disappeared after admission");
    }
    let text: string;
    try { text = decoder.decode(await readFile(frozen.path)); }
    catch { throw new InspectJavaError("analysis-unavailable", "Prepared source encoding became unavailable"); }
    if (screenText(text, policy).state === "withheld") {
      throw new InspectJavaError("analysis-unavailable", "Prepared Java input became withheld");
    }
  }
  for (const diagnostic of admission.diagnostics) {
    if (diagnostic.state === "available" &&
      (screenText(diagnostic.code, policy).state === "withheld" || screenText(diagnostic.message, policy).state === "withheld")) {
      throw new InspectJavaError("analysis-unavailable", "Build diagnostic became withheld");
    }
  }
}

function preparedCommand(
  admission: Extract<BuildEvidenceAdmission, { outcome: "admitted" }>,
  decision: BuildJavaDecision,
  skippedFiles: readonly { path: string; sourceSet: "main" | "test"; reason: string }[],
): { input: object; compilations: readonly PreparedJavaCompilation[] } {
  const compilations = decision.scopes.flatMap((scope) => scope.outcome === "prepared" ? [scope.compilation] : []);
  const diagnostics = admission.diagnostics.flatMap((item) => item.state === "available" ? [`${item.code}: ${item.message}`] : []);
  return {
    compilations,
    input: {
      kind: "prepared", repositoryId: admission.repositoryId, revision: admission.revision,
      pathRoot: "/prepared", artifactRoot: "/prepared/artifacts", compilations, skippedFiles, diagnostics,
      buildIdentity: `build-evidence:${admission.manifestSha256}`,
    },
  };
}

function withheldPaths(decision: BuildJavaDecision): ReadonlySet<string> {
  return new Set(decision.scopes.flatMap((scope) => scope.outcome === "fallback" ? scope.withheldRepositoryPaths : []));
}

function coherentDecision(decision: BuildJavaDecision): BuildJavaDecision {
  if (!decision.scopes.some((scope) => scope.outcome === "fallback")) return decision;
  const first = decision.scopes[0];
  const second = decision.scopes[1];
  return {
    workerView: decision.workerView,
    scopes: [
      first.outcome === "prepared"
        ? { role: first.role, compilationId: first.compilationId, withheldRepositoryPaths: first.withheldRepositoryPaths,
          outcome: "fallback", reason: "coherent-side-fallback" }
        : first,
      second.outcome === "prepared"
        ? { role: second.role, compilationId: second.compilationId, withheldRepositoryPaths: second.withheldRepositoryPaths,
          outcome: "fallback", reason: "coherent-side-fallback" }
        : second,
    ],
  };
}

function javaEvidenceSummary(admission: BuildEvidenceAdmission, decision: BuildJavaDecision): InspectJavaBuildEvidence {
  return {
    ...buildEvidenceSummary(admission),
    javaScopes: decision.scopes.map((scope) => ({
      role: scope.role, compilationId: scope.compilationId, outcome: scope.outcome,
      reason: scope.outcome === "prepared" ? null : scope.reason,
    })),
  };
}

export async function openInspectJava(
  repo: string, manifest: ChangeManifest, config: InspectJavaConfig, runtimeDir: string, suppliedPolicy?: SecretPolicy,
): Promise<InspectJavaBridge> {
  await validateChangeManifestCheckout(repo, manifest);
  await verifyToolchain(config);
  const repository = await realpath(repo);
  const location = resolve(runtimeDir);
  const parent = await realpath(dirname(location)).catch(() => null);
  if (!parent || pathIsInside(repository, join(parent, basename(location))) ||
    (await lstat(location).catch(() => null))?.isSymbolicLink()) {
    throw new InspectJavaError("invalid-input", "Java runtime state must be outside reviewed checkout");
  }
  await mkdir(location, { recursive: true, mode: 0o700 });
  const canonical = await realpath(location);
  if (pathIsInside(repository, canonical)) throw new InspectJavaError("invalid-input", "Java runtime state entered reviewed checkout");
  const storeDir = join(canonical, "java-facts");
  const existingStore = await lstat(storeDir).catch(() => null);
  if (existingStore && !existingStore.isDirectory()) {
    throw new InspectJavaError("invalid-input", "Java fact store must not be a symlink or file");
  }
  await mkdir(storeDir, { recursive: true, mode: 0o700 });
  if (await realpath(storeDir) !== storeDir) throw new InspectJavaError("invalid-input", "Java fact store escaped runtime state");
  const scratch = await mkdtemp(join(canonical, "inspect-java-"));
  const policy = secretPolicy(config, suppliedPolicy);
  let closed = false;
  let serial = Promise.resolve();
  let calls = 0;
  try {
    const summaries = {} as { base: AnalysisSummary; head: AnalysisSummary };
    const admissions = {} as Record<"base" | "head", BuildEvidenceAdmission>;
    const decisions = {} as Record<"base" | "head", BuildJavaDecision>;
    const artifacts = {} as Record<"base" | "head", Record<string, string>>;
    const modes = {} as Record<"base" | "head", "cache-only" | "prepared">;
    const preparedCompilations = {} as Record<"base" | "head", readonly PreparedJavaCompilation[]>;
    const identities = {} as Record<"base" | "head", string>;
    for (const side of ["base", "head"] as const) {
      const revision = manifest[side];
      const admission = await admitBuildEvidence({
        repo, repositoryId: config.repositoryId, revision, side, pin: config.buildEvidence?.[side],
        runtimeDir: join(scratch, `admission-${side}`),
      }, policy);
      admissions[side] = admission;
      const decision = coherentDecision(await prepareBuildJavaInputs(admission, config));
      decisions[side] = decision;
      const prepared = decision.scopes.filter((scope) => scope.outcome === "prepared");
      const mode = prepared.length > 0 && decision.scopes.every((scope) => scope.outcome !== "fallback") ? "prepared" : "cache-only";
      modes[side] = mode;
      identities[side] = `${mode}:${admission.outcome === "admitted" ? admission.manifestSha256 : admission.outcome}`;
      if (side === "head" && revision === manifest.base && identities.head === identities.base) {
        summaries.head = summaries.base;
        artifacts.head = artifacts.base;
        preparedCompilations.head = preparedCompilations.base;
        continue;
      }
      let result: unknown;
      if (mode === "prepared" && admission.outcome === "admitted") {
        await verifyAdmission(admission);
        const compiledPaths = new Set(prepared.flatMap((scope) => scope.outcome === "prepared"
          ? scope.compilation.files.map((file) => file.displayPath) : []));
        const skippedFiles = (await fromGit(readGitTree(repo, revision)))
          .filter((entry) => entry.path.endsWith(".java") && !compiledPaths.has(entry.path))
          .map((entry) => ({
            path: entry.path, sourceSet: entry.path.split("/").includes("test") ? "test" as const : "main" as const,
            reason: "not in the selected exported compilation",
          }));
        const command = preparedCommand(admission, decision, skippedFiles);
        preparedCompilations[side] = command.compilations;
        result = await sandbox(config, { preparedDir: join(admission.frozen.scratch, "java-worker-view") },
          storeDir, join(scratch, `work-${side}`), {
            schema: 2, kind: "analyze", store: "/store/refs", input: command.input,
          });
      } else {
        const folder = join(scratch, `source-${side}`);
        await mkdir(folder);
        const fallbackPolicy = config.buildEvidence?.[side] ? policy : undefined;
        if (fallbackPolicy) await refreshSecretPolicy(fallbackPolicy);
        const skippedFiles = await snapshot(repo, revision, folder, config, side === "head", withheldPaths(decision), fallbackPolicy);
        preparedCompilations[side] = [];
        result = await sandbox(config, { snapshotDir: folder }, storeDir, join(scratch, `work-${side}`), {
          schema: 2, kind: "analyze", store: "/store/refs",
          input: {
            kind: "cache-only", snapshot: config.module === "." ? "/source" : `/source/${config.module}`, pathRoot: "/source",
            repositoryId: config.repositoryId, revision, javaLevel: config.javaLevel, build: config.build,
            mainRoots: config.mainRoots, testRoots: config.testRoots, cache: "/cache", artifacts: "/work/artifacts", skippedFiles,
          },
        });
      }
      const decoded = preparedSchema.parse(result);
      summaries[side] = decoded.summary;
      artifacts[side] = decoded.artifacts;
    }

    type WorkerTarget = {
      path: string;
      position: { line: number; column: number };
      buildArtifact: { manifestSha256: string; artifactId: string; origin: "authored" | "materialized" | "external" } | null;
    };
    const normalizeTarget = (side: "base" | "head", target: ReferenceRequest["target"]): WorkerTarget => {
      const position = target.position;
      if (!position || !Number.isSafeInteger(position.line) || position.line < 1 ||
        !Number.isSafeInteger(position.column) || position.column < 0) {
        throw new InspectJavaError("invalid-input", "Invalid Java target position");
      }
      if ("path" in target) {
        if (Object.keys(target).sort().join(",") !== "path,position" || !isSafeRelativePath(target.path)) {
          throw new InspectJavaError("invalid-input", "Invalid Java path target");
        }
        return { path: target.path, position, buildArtifact: null };
      }
      if (Object.keys(target).sort().join(",") !== "artifactId,position" || !target.artifactId ||
        modes[side] !== "prepared" || admissions[side].outcome !== "admitted") {
        throw new InspectJavaError("invalid-input", "Artifact targets require the pinned imported view");
      }
      const file = preparedCompilations[side].flatMap((compilation) => compilation.files)
        .find((candidate) => candidate.buildArtifact.artifactId === target.artifactId);
      if (!file) throw new InspectJavaError("invalid-input", "Artifact target is not in the pinned imported view");
      return { path: file.displayPath, position, buildArtifact: file.buildArtifact };
    };

    const verifyRun = async (side: "base" | "head") => {
      await verifyToolchain(config);
      if (await digestFile(config.configPath) !== config.configSha256) {
        throw new InspectJavaError("configuration-mismatch", "Java configuration changed during review");
      }
      await validateChangeManifestCheckout(repo, manifest);
      await verifyAdmission(admissions.base);
      await verifyAdmission(admissions.head);
      await verifyFrozenArtifacts(config, artifacts.base);
      await verifyFrozenArtifacts(config, artifacts.head);
      if (modes[side] === "cache-only") {
        const baseline = withheldPaths(decisions[side]);
        const fallbackPolicy = config.buildEvidence?.[side] ? policy : undefined;
        if (fallbackPolicy) await refreshSecretPolicy(fallbackPolicy);
        const skipped = await snapshot(repo, manifest[side], join(scratch, `source-${side}`), config, side === "head", baseline, fallbackPolicy);
        if (skipped.some((item) => item.reason === "withheld by build-evidence policy" && !baseline.has(item.path))) {
          throw new InspectJavaError("analysis-unavailable", "Fallback Java inputs became withheld");
        }
      } else {
        await verifyPreparedScreening(admissions[side], preparedCompilations[side], policy);
      }
    };

    return {
      summaries,
      identity: {
        configSha256: config.configSha256,
        distributionSha256: createHash("sha256").update(JSON.stringify(Object.entries(config.distributionFiles).sort())).digest("hex"),
        jdkSha256: createHash("sha256").update(JSON.stringify(Object.entries(config.jdkFiles).sort())).digest("hex"),
      },
      buildEvidence: {
        base: javaEvidenceSummary(admissions.base, decisions.base),
        head: javaEvidenceSummary(admissions.head, decisions.head),
      },
      references(request) {
        if (closed) return Promise.reject(new InspectJavaError("analysis-unavailable", "Java bridge is closed"));
        const side = request.side;
        const expected = summaries[side];
        if (!expected || request.analysisId !== expected.analysisId || request.configurationSha256 !== expected.configurationSha256 ||
          JSON.stringify(request.manifest) !== JSON.stringify(manifest)) {
          return Promise.reject(new InspectJavaError("snapshot-mismatch", "Java query identity differs from pinned review"));
        }
        let target: WorkerTarget;
        try { target = normalizeTarget(side, request.target); }
        catch (error) { return Promise.reject(error); }
        const action = async () => {
          await verifyRun(side);
          const { target: _hostTarget, ...rest } = request;
          return await sandbox(config, {}, storeDir, join(scratch, `work-query-${++calls}`), {
            schema: 2, kind: "references", store: "/store/refs",
            request: {
              ...rest, target, referenceScope: request.referenceScope ?? "outside-diff",
              byteBudget: request.byteBudget ?? 65536, cursor: request.cursor ?? null,
            },
          }) as ReferencePage;
        };
        const next = serial.then(action);
        serial = next.then(() => undefined, () => undefined);
        return next;
      },
      readArtifact(side, request) {
        if (closed) return Promise.resolve({ ok: false, error: { code: "artifact-unavailable", message: "Java bridge is closed" } });
        const action = async () => {
          await verifyRun(side);
          return readBuildArtifact(admissions[side], request, policy);
        };
        const next = serial.then(action);
        serial = next.then(() => undefined, () => undefined);
        return next;
      },
      async close() {
        if (closed) return;
        closed = true;
        await serial;
        await rm(scratch, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await serial;
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
