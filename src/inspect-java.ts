import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { validateChangeManifestCheckout, type ChangeManifest } from "./change-evidence.js";
import { runStreaming } from "./exec.js";
import { pathIsInside } from "./path.js";
import { analysisSummarySchema, inspectErrorSchema, referenceReplySchema, type AnalysisSummary, type InspectError, type ReferencePage, type ReferenceRequest } from "./inspect-java-contract.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive();
const configSchema = z.object({
  schema: z.literal(1), repositoryId: z.string().min(1), distribution: z.string().min(1),
  distributionFiles: z.record(z.string(), hex), jdkHome: z.string().min(1),
  jdkFiles: z.record(z.string(), hex),
  cache: z.string().min(1), module: z.string(), build: z.enum(["maven", "gradle"]),
  mainRoots: z.array(z.string()).length(1), testRoots: z.array(z.string()).length(1), javaLevel: z.string().regex(/^\d+$/),
  limits: z.object({ heapBytes: positive, addressSpaceBytes: positive, deadlineMs: positive, maxOutputBytes: positive }).strict(),
}).strict();
const preparedSchema = z.object({ summary: analysisSummarySchema, artifacts: z.record(z.string(), hex) }).strict();
export type InspectJavaConfig = z.infer<typeof configSchema> & { readonly configPath: string; readonly configSha256: string };
export class InspectJavaError extends Error {
  constructor(readonly code: InspectError["code"], message: string, readonly requiredBytes?: number) { super(message); }
}
export interface InspectJavaBridge {
  summaries: { base: AnalysisSummary; head: AnalysisSummary };
  references(request: ReferenceRequest): Promise<ReferencePage>;
  close(): Promise<void>;
}

const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_GIT_BYTES = 64 * 1024 * 1024;

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeRelative(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new InspectJavaError("invalid-input", `Unsafe snapshot path: ${path}`);
  }
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

async function gitBytes(repo: string, args: string[], input?: Buffer): Promise<Buffer> {
  // This project targets ES2023, before Promise.withResolvers is available.
  return new Promise<Buffer>((done, fail) => {
    const child = spawn("git", args, { cwd: repo, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_GIT_BYTES) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 4096); });
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > MAX_GIT_BYTES) fail(new InspectJavaError("worker-failed", `Git object read failed: ${stderr || code}`));
      else done(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

interface TreeEntry { path: string; oid: string; mode: string }
async function tree(repo: string, revision: string): Promise<TreeEntry[]> {
  const bytes = await gitBytes(repo, ["ls-tree", "-r", "-z", revision]);
  const result: TreeEntry[] = [];
  for (const chunk of bytes.toString("binary").split("\0")) {
    if (!chunk) continue;
    const item = decoder.decode(Buffer.from(chunk, "binary"));
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t(.+)$/s.exec(item);
    if (!match) throw new InspectJavaError("snapshot-mismatch", "Unsupported Git tree entry");
    result.push({ mode: match[1]!, oid: match[3]!, path: safeRelative(match[4]!) });
  }
  return result;
}

async function blobs(repo: string, entries: TreeEntry[]): Promise<Map<string, Buffer>> {
  const bytes = await gitBytes(repo, ["cat-file", "--batch"], Buffer.from(`${entries.map((item) => item.oid).join("\n")}\n`));
  let offset = 0;
  const result = new Map<string, Buffer>();
  for (const item of entries) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new InspectJavaError("snapshot-mismatch", "Incomplete Git object header");
    const header = decoder.decode(bytes.subarray(offset, end));
    const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== item.oid) throw new InspectJavaError("snapshot-mismatch", "Git object identity differs");
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length > MAX_GIT_BYTES || end + 1 + length >= bytes.length || bytes[end + 1 + length] !== 10) {
      throw new InspectJavaError("snapshot-mismatch", "Incomplete Git object body");
    }
    const content = bytes.subarray(end + 1, end + 1 + length);
    result.set(item.path, content);
    offset = end + length + 2;
  }
  if (offset !== bytes.length) throw new InspectJavaError("snapshot-mismatch", "Unrequested Git object content");
  return result;
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

async function snapshot(repo: string, revision: string, destination: string, config: InspectJavaConfig, live: boolean):
  Promise<Array<{ path: string; sourceSet: "main" | "test"; reason: string }>> {
  const treeEntries = await tree(repo, revision);
  const entries = treeEntries.filter((item) => selected(item.path, config));
  const skipped = treeEntries.filter((item) => item.path.endsWith(".java") && !selected(item.path, config));
  if (skipped.length > 2000) throw new InspectJavaError("resource-exhausted", "More than 2000 unsupported Java files");
  if (!entries.some((item) => item.path.endsWith(".java"))) throw new InspectJavaError("invalid-input", "No Java sources in configured module");
  if (entries.some((item) => !["100644", "100755"].includes(item.mode))) {
    throw new InspectJavaError("snapshot-mismatch", "Analyzed inputs include a symlink or nonregular file");
  }
  const contents = await blobs(repo, entries);
  const root = await realpath(repo);
  for (const entry of entries) {
    const data = contents.get(entry.path)!;
    if (entry.path.endsWith(".java") || entry.path.endsWith(".xml") || entry.path.endsWith(".gradle") ||
      entry.path.endsWith(".kts") || entry.path.endsWith(".lockfile") || entry.path.endsWith(".toml")) {
      try { decoder.decode(data); }
      catch { throw new InspectJavaError("invalid-input", `Analyzed input is not UTF-8: ${entry.path}`); }
    }
    if (live) {
      const livePath = join(root, entry.path);
      const file = await lstat(livePath).catch(() => null);
      const actual = await realpath(livePath).catch(() => null);
      if (!file?.isFile() || actual !== livePath || !(await readFile(livePath)).equals(data)) {
        throw new InspectJavaError("snapshot-mismatch", `Dirty analyzed input: ${entry.path}`);
      }
    }
    const relativePath = modulePath(entry.path, config.module)!;
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o600 });
  }
  if (live) {
    const prefix = config.module === "." ? "" : `${config.module}/`;
    const others = await gitBytes(repo, [
      "ls-files", "--others", "-z", "--", `:(glob)${prefix}**/*.java`, `:(glob)${prefix}*.java`,
    ]);
    for (const path of others.toString("binary").split("\0")) {
      if (path && decoder.decode(Buffer.from(path, "binary")).endsWith(".java")) {
        throw new InspectJavaError("snapshot-mismatch", "Untracked Java source in configured module");
      }
    }
  }
  for (const path of [...config.mainRoots, ...config.testRoots]) {
    await mkdir(join(destination, path), { recursive: true });
  }
  return skipped.map(({ path }) => ({
    path, sourceSet: path.split("/").includes("test") ? "test" as const : "main" as const,
    reason: "unsupported Java root or module",
  }));
}

async function sandbox(config: InspectJavaConfig, snapshotDir: string, storeDir: string, work: string, command: object): Promise<unknown> {
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "request.json"), JSON.stringify(command), { mode: 0o600 });
  const limits = config.limits;
  const jvm = `-Xmx${Math.floor(limits.heapBytes / (1024 * 1024))}m -XX:MaxMetaspaceSize=256m -XX:MaxDirectMemorySize=128m -XX:ReservedCodeCacheSize=128m`;
  const tools = ["dash", "uname", "ls", "xargs", "echo", "sed", "tr"];
  const mounts = tools.flatMap((name) => ["--ro-bind", `/usr/bin/${name}`, `/usr/bin/${name}`]);
  const args = [
    `--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`, "--", "/usr/bin/bwrap",
    "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
    "--dir", "/usr", "--dir", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind", "/usr/lib64", "/usr/lib64", ...mounts,
    "--symlink", "dash", "/usr/bin/sh", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", config.jdkHome, "/jdk", "--ro-bind", config.distribution, "/tool",
    "--ro-bind", snapshotDir, "/source", "--ro-bind", config.cache, "/cache",
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
    if (!page.data.ok) throw new InspectJavaError(page.data.error.code, page.data.error.message, page.data.error.requiredBytes);
    if (result.code !== 0) throw new InspectJavaError("worker-failed", "Worker reported success but exited unsuccessfully");
    return page.data.result;
  }
  const summary = z.object({ ok: z.literal(true), result: preparedSchema }).strict().safeParse(raw);
  if (summary.success && result.code === 0) return summary.data.result;
  const failure = z.object({ ok: z.literal(false), error: inspectErrorSchema }).strict().safeParse(raw);
  if (failure.success) throw new InspectJavaError(failure.data.error.code, failure.data.error.message, failure.data.error.requiredBytes);
  throw new InspectJavaError("worker-failed", `Invalid Java worker response (${result.code}): ${result.stderr.slice(0, 200)}`);
}

export async function openInspectJava(repo: string, manifest: ChangeManifest, config: InspectJavaConfig, runtimeDir: string): Promise<InspectJavaBridge> {
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
  let closed = false;
  let serial = Promise.resolve();
  let calls = 0;
  try {
    const summaries = {} as { base: AnalysisSummary; head: AnalysisSummary };
    const artifacts = {} as Record<"base" | "head", Record<string, string>>;
    for (const side of ["base", "head"] as const) {
      const folder = join(scratch, side);
      await mkdir(folder);
      const skippedFiles = await snapshot(repo, manifest[side], folder, config, side === "head");
      const result = await sandbox(config, folder, storeDir, join(scratch, `work-${side}`), {
        schema: 1, kind: "analyze", store: "/store/refs", snapshot: "/source",
        repositoryId: config.repositoryId, revision: manifest[side], javaLevel: config.javaLevel,
        build: config.build, mainRoots: config.mainRoots, testRoots: config.testRoots,
        cache: "/cache", artifacts: "/work/artifacts", skippedFiles,
      });
      const prepared = preparedSchema.parse(result);
      summaries[side] = prepared.summary;
      artifacts[side] = prepared.artifacts;
    }
    return {
      summaries,
      references(request) {
        if (closed) return Promise.reject(new InspectJavaError("analysis-unavailable", "Java bridge is closed"));
        const side = request.side;
        const expected = summaries[side];
        if (!expected || request.analysisId !== expected.analysisId || request.configurationSha256 !== expected.configurationSha256 ||
          JSON.stringify(request.manifest) !== JSON.stringify(manifest)) {
          return Promise.reject(new InspectJavaError("snapshot-mismatch", "Java query identity differs from pinned review"));
        }
        const action = async () => {
          await verifyToolchain(config);
          if (await digestFile(config.configPath) !== config.configSha256) {
            throw new InspectJavaError("configuration-mismatch", "Java configuration changed during review");
          }
          await verifyFrozenArtifacts(config, artifacts.base);
          await verifyFrozenArtifacts(config, artifacts.head);
          await snapshot(repo, manifest.head, join(scratch, "head"), config, true);
          return await sandbox(config, join(scratch, side), storeDir, join(scratch, `work-query-${++calls}`), {
            schema: 1, kind: "references", store: "/store/refs",
            request: { ...request, byteBudget: request.byteBudget ?? 65536, cursor: request.cursor ?? null },
          }) as ReferencePage;
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
