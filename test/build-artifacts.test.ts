import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildEvidenceSchema, type BuildEvidenceRequest } from "../src/build-evidence-contract.js";
import { freezeBuildArtifacts, type FrozenBuildArtifacts } from "../src/build-artifacts.js";
import { readGitBlobs, readGitTree } from "../src/git-objects.js";
import { createBuildFixture, fixtureGit, fixtureRequest, type BuildFixture, type FixtureSide } from "./build-evidence-fixture.js";
import type * as FsPromises from "node:fs/promises";
import type * as GitObjects from "../src/git-objects.js";

// Failure injection at two host boundaries. Everything delegates to the real implementation unless a test arms a
// hook: the Git readers (to land cancellation or a host failure exactly between two Git operations) and `open` (to
// produce permission and read-only errors that a root-run suite cannot create with chmod).
const hooks = vi.hoisted(() => ({
  tree: undefined as (() => void) | undefined,
  blobs: undefined as (() => void) | undefined,
  open: undefined as ((path: string) => Error | undefined) | undefined,
}));
vi.mock("../src/git-objects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitObjects>();
  return {
    ...actual,
    readGitTree: (...args: Parameters<typeof actual.readGitTree>) => { hooks.tree?.(); return actual.readGitTree(...args); },
    readGitBlobs: (...args: Parameters<typeof actual.readGitBlobs>) => { hooks.blobs?.(); return actual.readGitBlobs(...args); },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: (path: unknown, ...rest: unknown[]) => {
      const failed = hooks.open?.(String(path));
      return failed ? Promise.reject(failed) : (actual.open as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});
afterEach(() => { hooks.tree = undefined; hooks.blobs = undefined; hooks.open = undefined; });
const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

// Manifests are mutated as loose JSON on purpose (as in the contract tests): admission must stay safe even when
// it is handed a manifest that never went through the strict parser, so each case changes exactly one thing.
type Json = any;

let home: string;
let inPlace: BuildFixture;
let valid: BuildFixture;
let serial = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "leveret-build-artifacts-"));
  [inPlace, valid] = await Promise.all([
    createBuildFixture(join(home, "in-place"), "in-place"),
    createBuildFixture(join(home, "valid"), "valid"),
  ]);
}, 180_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const HASH = "a".repeat(64);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const art = (m: Json, id: string): Json => m.artifacts.find((a: Json) => a.id === id);
const comp = (m: Json, id: string): Json => m.compilations.find((c: Json) => c.id === id);
const gitBlob = (repo: string, revision: string, path: string) =>
  execFileSync("git", ["-C", repo, "cat-file", "blob", `${revision}:${path}`], { maxBuffer: 64 << 20 });

function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(join(dir, entry.name), path) : [path];
  }).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** One private working copy of a fixture export: mutable manifest, payload snapshot and fresh runtime directory. */
interface Case { request: BuildEvidenceRequest; manifest: Json; payload: string; runtime: string; dir: string }

function setup(f: BuildFixture, side: FixtureSide = "head"): Case {
  const dir = join(home, `case-${++serial}`);
  const payload = join(dir, "payload");
  const runtime = join(dir, "runtime");
  mkdirSync(dir, { recursive: true });
  cpSync(f.pins[side].payloadRoot, payload, { recursive: true });
  const request: BuildEvidenceRequest = { ...fixtureRequest(f, side, runtime), pin: { ...f.pins[side], payloadRoot: payload } };
  return { request, manifest: structuredClone(f.manifests[side]), payload, runtime, dir };
}

const freeze = (c: Case) => freezeBuildArtifacts(c.request, c.manifest);
const bytesOf = (frozen: FrozenBuildArtifacts, id: string) => readFileSync(frozen.available.get(id)!.path);
const payloadPath = (c: Case, id: string): string => {
  const a = art(c.manifest, id);
  return (a.kind === "file" ? a.content.location : a.location).path;
};
const livePath = (c: Case, id: string) => join(c.payload, payloadPath(c, id));
const put = (c: Case, path: string, bytes: Uint8Array | string) => {
  mkdirSync(dirname(join(c.payload, path)), { recursive: true });
  writeFileSync(join(c.payload, path), bytes);
};

const SAFE_REASON = /^[A-Za-z][A-Za-z0-9 ,.-]*$/;

/** The artifact is rejected for the expected class of reason, degrades exactly the expected scopes and is not served. */
function rejected(frozen: FrozenBuildArtifacts, id: string, reason: RegExp, scopes: readonly string[]): void {
  const entry = frozen.rejected.find((item) => item.artifactId === id);
  expect(entry, `${id} must be rejected`).toBeDefined();
  expect(entry!.reason).toMatch(reason);
  expect(entry!.reason, "reason must be a fixed sentence without paths, hashes or values").toMatch(SAFE_REASON);
  expect([...entry!.compilationIds].sort()).toEqual([...scopes].sort());
  expect(frozen.available.has(id), `${id} must not stay available`).toBe(false);
}

/** Everything in the private scratch is served: a rejected artifact leaves no partial copy behind. */
function expectNoOrphans(c: Case, frozen: FrozenBuildArtifacts): void {
  const [scratch, ...others] = readdirSync(c.runtime);
  expect(others).toEqual([]);
  const count = (path: string) => (lstatSync(path).isFile() ? 1 : filesUnder(path).length);
  const served = [...frozen.available.values()].map((stored) => count(stored.path))
    .concat([...frozen.sourceRoots.values()].flatMap((roots) => roots.map((root) => count(root.path))));
  expect(filesUnder(join(c.runtime, scratch!)).length).toBe(served.reduce((sum, n) => sum + n, 0));
}

const extraFile = (id: string, path: string, bytes: Uint8Array, role = "resource"): Json => ({
  id, kind: "file", role, origin: "external", repositoryPath: null, availability: "available",
  content: { location: { kind: "payload", path }, sha256: sha256(bytes), sizeBytes: bytes.length }, encoding: null,
});
const extraDirectory = (id: string, path: string, entries: Json[] = []): Json => ({
  id, kind: "directory", role: "classes", origin: "materialized", repositoryPath: null, availability: "available",
  location: { kind: "payload", path }, entries,
});
const extraAuthored = (id: string, path: string, bytes: Uint8Array | null): Json => ({
  id, kind: "file", role: "source", origin: "authored", repositoryPath: path, availability: "available",
  content: { location: { kind: "repository", path }, sha256: bytes ? sha256(bytes) : HASH, sizeBytes: bytes ? bytes.length : 0 },
  encoding: null,
});

function cloneOf(f: BuildFixture): string {
  const dir = join(home, `clone-${++serial}`);
  fixtureGit(f.repo, "clone", "--quiet", "--no-hardlinks", f.repo, dir);
  return dir;
}
function commitIn(dir: string): string {
  fixtureGit(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "edit");
  return fixtureGit(dir, "rev-parse", "HEAD");
}
function atRevision(f: BuildFixture, target: { repo: string; revision: string }): Case {
  const c = setup(f);
  c.request = { ...c.request, repo: target.repo, revision: target.revision };
  return c;
}

/** Many ordinary payload files in a standalone manifest without compilations (strictly valid, no hidden shape tricks). */
function bulk(c: Case, count: number): { request: BuildEvidenceRequest; manifest: Json; payload: string } {
  const payload = join(c.dir, "bulk-payload");
  const artifacts = Array.from({ length: count }, (_, n) => {
    const bytes = Buffer.from(`ordinary artifact ${n}\n`);
    const path = `bulk/${n % 17}/item-${n}.txt`;
    mkdirSync(join(payload, dirname(path)), { recursive: true });
    writeFileSync(join(payload, path), bytes);
    return extraFile(`bulk-${n}`, path, bytes);
  });
  const manifest = { ...structuredClone(c.manifest), artifacts, compilations: [], transformations: [], diagnostics: [] };
  buildEvidenceSchema.parse(manifest);
  return { manifest, payload, request: { ...c.request, pin: { ...c.request.pin!, payloadRoot: payload } } };
}

/** Every entry (files, directories, symlinks) below `dir`, relative and sorted, so an empty leftover directory counts too. */
function everything(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [path, ...everything(join(dir, entry.name), path)] : [path];
  }).sort();
}

/** A real AbortSignal whose `poll`-th `throwIfAborted()` call aborts it, so cancellation lands at an exact, repeatable point. */
function abortingAt(poll: number): { signal: AbortSignal; polls: () => number } {
  const controller = new AbortController();
  let polls = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "throwIfAborted") return () => { if (++polls === poll) controller.abort(); target.throwIfAborted(); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { signal, polls: () => polls };
}

/** One admission input set: request, manifest and the payload directory that must come out of any run unchanged. */
type Run = { request: BuildEvidenceRequest; manifest: Json; payload: string };

/** Total `throwIfAborted()` polls of an uncancelled admission, measured in a runtime directory of its own. */
async function pollsOf(run: Run): Promise<number> {
  const probe = abortingAt(Number.POSITIVE_INFINITY);
  await freezeBuildArtifacts({ ...run.request, runtimeDir: `${run.request.runtimeDir}-probe`, signal: probe.signal }, run.manifest);
  return probe.polls();
}

/** Runtime state owned by someone else, which cancellation must never touch. */
function withBystanders(runtime: string): string[] {
  mkdirSync(join(runtime, "bystander-dir"), { recursive: true });
  writeFileSync(join(runtime, "bystander.txt"), "owned by someone else");
  writeFileSync(join(runtime, "bystander-dir/keep.txt"), "kept");
  return everything(runtime);
}

async function expectCancelledAtEveryPoll(run: Run, polls: readonly number[]): Promise<void> {
  const bystanders = withBystanders(run.request.runtimeDir);
  const payloadBefore = treeDigest(run.payload);
  for (const poll of polls) {
    const { signal } = abortingAt(poll);
    await expect(freezeBuildArtifacts({ ...run.request, signal }, run.manifest), `cancelled at poll ${poll}`)
      .rejects.toMatchObject({ name: "AbortError" });
    expect(everything(run.request.runtimeDir), `scratch or stray file left after cancelling at poll ${poll}`).toEqual(bystanders);
    expect(treeDigest(run.payload), `payload changed after cancelling at poll ${poll}`).toEqual(payloadBefore);
  }
  expect(readFileSync(join(run.request.runtimeDir, "bystander-dir/keep.txt"), "utf8")).toBe("kept");
}

/** A standalone, strictly valid manifest of payload artifacts written by `build`, with its own payload and runtime directories. */
function scenario(c: Case, name: string, build: (write: (path: string, bytes: Uint8Array) => void) => Json[], compilations: Json[] = []): Run {
  const payload = join(c.dir, `${name}-payload`);
  mkdirSync(payload, { recursive: true });
  const write = (path: string, bytes: Uint8Array) => { mkdirSync(join(payload, dirname(path)), { recursive: true }); writeFileSync(join(payload, path), bytes); };
  const manifest = { ...structuredClone(c.manifest), artifacts: build(write), compilations, transformations: [], diagnostics: [] };
  buildEvidenceSchema.parse(manifest);
  return { manifest, payload, request: { ...c.request, runtimeDir: join(c.dir, `${name}-runtime`), pin: { ...c.request.pin!, payloadRoot: payload } } };
}

const emptyFiles = (count: number, role: string) => (write: (path: string, bytes: Uint8Array) => void): Json[] =>
  Array.from({ length: count }, (_, n) => {
    const path = `empty/f${String(n).padStart(2, "0")}.txt`;
    write(path, Buffer.alloc(0));
    return extraFile(`f${n}`, path, Buffer.alloc(0), role);
  });

/** `count` authored originals committed to a private clone, with a manifest that claims all of them. */
function authoredScenario(f: BuildFixture, count: number): Run {
  const repo = cloneOf(f);
  const files = Array.from({ length: count }, (_, n) => ({ path: `many/a${String(n).padStart(2, "0")}.txt`, bytes: Buffer.from(`authored ${n}\n`) }));
  for (const { path, bytes } of files) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), bytes);
  }
  fixtureGit(repo, "add", "-A");
  const revision = commitIn(repo);
  const c = setup(f);
  const manifest = {
    ...structuredClone(c.manifest), compilations: [], transformations: [], diagnostics: [],
    artifacts: files.map(({ path, bytes }, n) => ({ ...extraAuthored(`authored-${n}`, path, bytes), encoding: "UTF-8" })),
  };
  buildEvidenceSchema.parse(manifest);
  return { manifest, payload: c.payload, request: { ...c.request, repo, revision } };
}

/** A valid compilation (cloned from the fixture's test scope) with only the given fields changed. */
function compilationOver(c: Case, id: string, patch: Json): Json {
  return Object.assign(structuredClone(comp(c.manifest, "test")), {
    id, inputArtifactIds: [], sourceRoots: [], authoredArtifactIds: [], resourceArtifactIds: [], outputArtifactIds: [],
    compileClasspath: { state: "complete", reason: null, entries: [] },
  }, patch);
}

/** A complete path set naming one artifact, optionally as the output of an upstream compilation. */
const complete = (artifactId: string, upstreamCompilationId: string | null = null): Json => ({
  state: "complete", reason: null, entries: [{ artifactId, coordinates: null, upstreamCompilationId }],
});

/** A nonavailable artifact: a gap that is resolvable by reference but supplies no bytes. */
const gap = (id: string, availability: string, role = "resource"): Json => ({
  id, kind: "file", role, origin: "materialized", repositoryPath: null, availability, reason: "not captured",
});
const producedBy = (id: string, inputs: string[], outputs: string[]): Json => ({
  id, producer: { name: "fixture-hop", version: null, executionId: `${id}-run` }, kind: "transform",
  inputArtifactIds: inputs, outputArtifactIds: outputs, basis: "exporter-recorded", locations: [],
});

describe("build artifact admission", () => {
  describe("authored originals and transformed outputs", () => {
    it("keeps the in-place original and its transformed output as distinct exact byte views", async () => {
      const c = setup(inPlace);
      const frozen = await freeze(c);
      expect(frozen.rejected).toEqual([]);
      expect(bytesOf(frozen, "pricing-original")).toEqual(Buffer.from(inPlace.originalBytes.get("pricing-original")!));
      expect(bytesOf(frozen, "pricing-output")).toEqual(Buffer.from(inPlace.outputBytes.get("pricing-output")!));
      expect(bytesOf(frozen, "pricing-original").toString("utf8")).toContain("@FACTOR@");
      expect(bytesOf(frozen, "pricing-output").toString("utf8")).not.toContain("@FACTOR@");
      expect(frozen.available.get("pricing-original")!.artifact.origin).toBe("authored");
      expect(frozen.available.get("pricing-output")!.artifact.origin).toBe("materialized");
      // Same logical Git path, different identities: the views never alias each other.
      expect(frozen.available.get("pricing-original")!.artifact.repositoryPath)
        .toBe(frozen.available.get("pricing-output")!.artifact.repositoryPath);
      expect(frozen.available.get("pricing-original")!.path).not.toBe(frozen.available.get("pricing-output")!.path);
      expect([...frozen.available.keys()].sort())
        .toEqual(c.manifest.artifacts.filter((a: Json) => a.availability === "available").map((a: Json) => a.id).sort());
    });

    it("freezes every payload file and directory member byte-for-byte into private read-only scratch", async () => {
      const c = setup(inPlace);
      const frozen = await freeze(c);
      for (const a of c.manifest.artifacts as Json[]) {
        const stored = frozen.available.get(a.id)!;
        expect(stored.artifact).toEqual(a);
        if (a.kind === "file") {
          expect(sha256(readFileSync(stored.path))).toBe(a.content.sha256);
        } else {
          expect(filesUnder(stored.path)).toEqual(a.entries.map((e: Json) => e.path));
          for (const e of a.entries) expect(sha256(readFileSync(join(stored.path, e.path)))).toBe(e.sha256);
        }
        expect(relative(c.runtime, stored.path).startsWith("..")).toBe(false);
        expect(relative(c.payload, stored.path).startsWith("..")).toBe(true);
        expect(lstatSync(stored.path).isSymbolicLink()).toBe(false);
        if (a.kind === "file") expect(statSync(stored.path).mode & 0o222).toBe(0);
      }
    });

    it("reads base-side originals from the base commit and outputs from the base payload, not from the head view", async () => {
      const c = setup(inPlace, "base");
      const frozen = await freeze(c);
      expect(frozen.rejected).toEqual([]);
      for (const a of (c.manifest.artifacts as Json[]).filter((item) => item.origin === "authored")) {
        expect(bytesOf(frozen, a.id)).toEqual(gitBlob(inPlace.repo, inPlace.base, a.repositoryPath));
      }
      expect(bytesOf(frozen, "pricing-output")).toEqual(readFileSync(join(inPlace.pins.base.payloadRoot, payloadPath(c, "pricing-output"))));
      // The same artifact ID carries different bytes on the two sides.
      expect(bytesOf(frozen, "pricing-output")).not.toEqual(Buffer.from(inPlace.outputBytes.get("pricing-output")!));
    });

    it("keeps template and generated-source originals distinct in the template layout", async () => {
      const c = setup(valid);
      const frozen = await freeze(c);
      expect(frozen.rejected).toEqual([]);
      expect(bytesOf(frozen, "pricing-template")).toEqual(Buffer.from(valid.originalBytes.get("pricing-template")!));
      expect(bytesOf(frozen, "pricing-output")).toEqual(Buffer.from(valid.outputBytes.get("pricing-output")!));
      expect(frozen.available.get("pricing-template")!.artifact.origin).toBe("authored");
      expect(frozen.available.get("pricing-output")!.artifact.origin).toBe("materialized");
    });

    it("keeps frozen bytes unchanged when the live payload is edited, replaced or deleted after capture", async () => {
      const c = setup(inPlace);
      const first = await freeze(c);
      const second = await freeze(c);
      const before = new Map([...first.available].map(([id, stored]) => [id, treeDigest(stored.path)]));
      writeFileSync(livePath(c, "pricing-output"), "edited after capture\n");
      unlinkSync(livePath(c, "app-resource-output"));
      rmSync(join(c.payload, "classes"), { recursive: true });
      for (const [id, stored] of first.available) expect(treeDigest(stored.path), id).toEqual(before.get(id));
      // Each admission owns its own scratch; the second never aliases or reuses the first.
      for (const [id, stored] of second.available) expect(stored.path).not.toBe(first.available.get(id)!.path);
      expect(readFileSync(livePath(c, "pricing-output"), "utf8")).toBe("edited after capture\n");
    });
  });

  describe("pinned Git originals", () => {
    let edited: { repo: string; revision: string };

    beforeAll(() => {
      // One real follow-up commit: a symlink, a deletion, a content change, a gitlink, an executable and an odd path.
      const repo = cloneOf(inPlace);
      rmSync(join(repo, "src/main/java/example/Consumer.java"));
      symlinkSync("Pricing.java", join(repo, "src/main/java/example/Consumer.java"));
      rmSync(join(repo, "src/main/resources/application.properties"));
      writeFileSync(join(repo, "src/test/java/example/PricingTest.java"), "package example;\n\npublic final class PricingTest {}\n");
      mkdirSync(join(repo, "odd dir"), { recursive: true });
      writeFileSync(join(repo, "odd dir/ünï\ncode.txt"), "odd\n");
      fixtureGit(repo, "add", "-A");
      fixtureGit(repo, "update-index", "--chmod=+x", "generator.properties");
      fixtureGit(repo, "update-index", "--add", "--cacheinfo", `160000,${inPlace.head},vendor/sub`);
      edited = { repo, revision: commitIn(repo) };
    });

    it("rejects symlink and gitlink tree entries while unrelated originals stay available", async () => {
      const c = atRevision(inPlace, edited);
      c.manifest.artifacts.push(extraAuthored("vendored", "vendor/sub", null));
      const frozen = await freeze(c);
      rejected(frozen, "consumer-original", /regular Git blob/, ["prod", "test"]);
      rejected(frozen, "vendored", /regular Git blob/, []);
      expect(bytesOf(frozen, "pricing-original")).toEqual(gitBlob(edited.repo, edited.revision, "src/main/java/example/Pricing.java"));
    });

    it("admits an executable regular blob and reads the pinned object, never the dirty live workspace", async () => {
      const c = atRevision(inPlace, edited);
      writeFileSync(join(edited.repo, "generator.properties"), "dirty live workspace\n");
      const frozen = await freeze(c);
      expect(fixtureGit(edited.repo, "ls-tree", edited.revision, "generator.properties")).toMatch(/^100755 blob /);
      expect(frozen.rejected.map((item) => item.artifactId)).not.toContain("pricing-generator-config");
      expect(bytesOf(frozen, "pricing-generator-config")).toEqual(Buffer.from(inPlace.originalBytes.get("pricing-generator-config")!));
      expect(bytesOf(frozen, "pricing-generator-config").toString("utf8")).not.toContain("dirty");
    });

    it("rejects an original whose path is deleted at the pinned revision and degrades its scopes", async () => {
      const frozen = await freeze(atRevision(inPlace, edited));
      rejected(frozen, "app-resource-original", /absent from the pinned Git revision/, ["prod", "test"]);
      expect(frozen.available.has("app-resource-output")).toBe(true);
    });

    it("rejects an original whose pinned blob differs from the claimed size and hash", async () => {
      const frozen = await freeze(atRevision(inPlace, edited));
      rejected(frozen, "pricing-test", /size or hash/, ["test"]);
      // The shared follow-up commit also breaks prod's own originals (symlink, deletion), so prod and test are both
      // legitimately degraded here and publish no roots. Only a test-only failure keeps prod's roots; the propagation
      // table below pins that guarantee for this same artifact.
      expect(frozen.rejected.map((item) => item.artifactId).sort()).toEqual(["app-resource-original", "consumer-original", "pricing-test"]);
      expect([...frozen.sourceRoots.keys()]).toEqual([]);
    });

    it("rejects every authored original when the pinned revision cannot be read, keeping payload bytes", async () => {
      const c = setup(inPlace);
      c.request = { ...c.request, revision: "0".repeat(40) };
      const frozen = await freeze(c);
      const authored = (c.manifest.artifacts as Json[]).filter((a) => a.origin === "authored").map((a) => a.id).sort();
      expect(frozen.rejected.map((item) => item.artifactId).sort()).toEqual(authored);
      for (const id of authored) rejected(frozen, id, /revision could not be read/, id === "pricing-test" ? ["test"] : ["prod", "test"]);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it("isolates one unreadable Git object instead of rejecting its whole batch", async () => {
      const oid = fixtureGit(inPlace.repo, "rev-parse", `${inPlace.head}:src/main/java/example/Consumer.java`);
      const repo = cloneOf(inPlace);
      const loose = join(repo, ".git/objects", oid.slice(0, 2), oid.slice(2));
      expect(existsSync(loose), "the clone keeps loose objects, so deleting one deletes exactly that blob").toBe(true);
      unlinkSync(loose);
      const c = atRevision(inPlace, { repo, revision: inPlace.head });
      const frozen = await freeze(c);
      rejected(frozen, "consumer-original", /Git object could not be read/, ["prod", "test"]);
      expect(frozen.rejected).toHaveLength(1);
      expectNoOrphans(c, frozen);
      expect(bytesOf(frozen, "pricing-original")).toEqual(Buffer.from(inPlace.originalBytes.get("pricing-original")!));
    });

    it.each([
      ["payload location", (a: Json, c: Case) => {
        const out = art(c.manifest, "pricing-output");
        a.content = { location: { kind: "payload", path: payloadPath(c, "pricing-output") }, sha256: out.content.sha256, sizeBytes: out.content.sizeBytes };
      }, /authored content must be read/],
      ["repository location for another path", (a: Json) => { a.content.location = { kind: "repository", path: "src/main/java/example/Consumer.java" }; }, /authored content must be read/],
      ["claim copied from the transformed output", (a: Json, c: Case) => {
        a.content.sha256 = art(c.manifest, "pricing-output").content.sha256;
        a.content.sizeBytes = art(c.manifest, "pricing-output").content.sizeBytes;
      }, /size or hash/],
    ])("rejects payload bytes masquerading as an authored original: %s", async (_label, mutate, reason) => {
      const c = setup(inPlace);
      mutate(art(c.manifest, "pricing-original"), c);
      const frozen = await freeze(c);
      rejected(frozen, "pricing-original", reason, ["prod", "test"]);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it("rejects materialized content that claims a repository location", async () => {
      const c = setup(inPlace);
      art(c.manifest, "pricing-output").content.location = { kind: "repository", path: "src/main/java/example/Pricing.java" };
      const frozen = await freeze(c);
      rejected(frozen, "pricing-output", /non-authored content/, ["prod", "test"]);
    });

    it("admits 2,001 authored originals without a default count gate", async () => {
      const repo = cloneOf(valid);
      const files = Array.from({ length: 2001 }, (_, n) => ({ path: `bulk/${n % 31}/n${n}.txt`, bytes: Buffer.from(`authored ${n}\n`) }));
      for (const { path, bytes } of files) {
        mkdirSync(join(repo, dirname(path)), { recursive: true });
        writeFileSync(join(repo, path), bytes);
      }
      fixtureGit(repo, "add", "-A");
      const revision = commitIn(repo);
      const c = setup(valid);
      const manifest = {
        ...structuredClone(c.manifest), compilations: [], transformations: [], diagnostics: [],
        artifacts: files.map(({ path, bytes }, n) => ({ ...extraAuthored(`authored-${n}`, path, bytes), encoding: "UTF-8" })),
      };
      buildEvidenceSchema.parse(manifest);
      const frozen = await freezeBuildArtifacts({ ...c.request, repo, revision }, manifest);
      expect(frozen.rejected).toEqual([]);
      expect(frozen.available.size).toBe(2001);
      for (const n of [0, 1000, 2000]) expect(bytesOf(frozen, `authored-${n}`)).toEqual(files[n]!.bytes);
    });
  });

  describe("contained payload bytes", () => {
    it.each([
      ["same size, different bytes", (b: Buffer) => { const x = Buffer.from(b); x[0] = x[0] === 0x41 ? 0x42 : 0x41; return x; }],
      ["truncated", (b: Buffer) => b.subarray(0, b.length - 1)],
      ["extended", (b: Buffer) => Buffer.concat([b, Buffer.from("\n")])],
      ["emptied", () => Buffer.alloc(0)],
    ])("rejects payload bytes that are %s after capture and degrades only the referencing scopes", async (_label, edit) => {
      const c = setup(inPlace);
      writeFileSync(livePath(c, "pricing-output"), edit(readFileSync(livePath(c, "pricing-output"))));
      const frozen = await freeze(c);
      rejected(frozen, "pricing-output", /size or hash/, ["prod", "test"]);
      expect(frozen.rejected).toHaveLength(1);
      expectNoOrphans(c, frozen);
      expect(frozen.available.has("app-resource-output")).toBe(true);
    });

    it("rejects a claimed hash the payload does not match", async () => {
      const c = setup(inPlace);
      art(c.manifest, "app-resource-output").content.sha256 = HASH;
      rejected(await freeze(c), "app-resource-output", /size or hash/, ["prod", "test"]);
    });

    it("rejects an ancestor directory symlink even when the target holds identical bytes", async () => {
      const c = setup(inPlace);
      const outside = join(c.dir, "outside");
      renameSync(join(c.payload, "generated"), outside);
      symlinkSync(outside, join(c.payload, "generated"));
      const frozen = await freeze(c);
      rejected(frozen, "pricing-output", /symlink/, ["prod", "test"]);
      expect(frozen.available.has("app-resource-output")).toBe(true);
      expect(readFileSync(join(outside, "main/example/Pricing.java"), "utf8")).toContain("class Pricing");
    });

    it.each([
      ["outside the payload root", (c: Case, real: string) => { const copy = join(c.dir, "outside-copy"); renameSync(real, copy); symlinkSync(copy, real); }],
      ["inside the payload root", (_c: Case, real: string) => { cpSync(real, `${real}.copy`); rmSync(real); symlinkSync(`${real}.copy`, real); }],
    ])("rejects a leaf file symlink to identical bytes %s", async (_label, link) => {
      const c = setup(inPlace);
      link(c, livePath(c, "app-resource-output"));
      const frozen = await freeze(c);
      rejected(frozen, "app-resource-output", /symlink/, ["prod", "test"]);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it("rejects a directory location that is a symlink and leaves the sibling directory available", async () => {
      const c = setup(inPlace);
      const real = livePath(c, "prod-classes");
      const outside = join(c.dir, "outside-classes");
      renameSync(real, outside);
      symlinkSync(outside, real);
      const frozen = await freeze(c);
      rejected(frozen, "prod-classes", /symlink/, ["prod", "test"]);
      expect(frozen.available.has("test-classes")).toBe(true);
      expect(readdirSync(outside).length).toBeGreaterThan(0);
    });

    it("rejects special, directory and missing leaves without hanging on a FIFO", async () => {
      const fifo = setup(inPlace);
      rmSync(livePath(fifo, "app-resource-output"));
      execFileSync("mkfifo", [livePath(fifo, "app-resource-output")]);
      rejected(await freeze(fifo), "app-resource-output", /regular file/, ["prod", "test"]);

      const folder = setup(inPlace);
      rmSync(livePath(folder, "app-resource-output"));
      mkdirSync(livePath(folder, "app-resource-output"));
      rejected(await freeze(folder), "app-resource-output", /regular file/, ["prod", "test"]);

      const gone = setup(inPlace);
      rmSync(livePath(gone, "app-resource-output"));
      rejected(await freeze(gone), "app-resource-output", /missing/, ["prod", "test"]);

      const noParent = setup(inPlace);
      rmSync(join(noParent.payload, "resources"), { recursive: true });
      rejected(await freeze(noParent), "app-resource-output", /missing/, ["prod", "test"]);

      const blocked = setup(inPlace);
      rmSync(join(blocked.payload, "resources"), { recursive: true });
      writeFileSync(join(blocked.payload, "resources"), "a file where a directory belongs");
      rejected(await freeze(blocked), "app-resource-output", /symlink or non-directory/, ["prod", "test"]);
    });

    it("rejects payload artifacts when the payload root is unavailable but still admits authored originals", async () => {
      const gone = setup(inPlace);
      rmSync(gone.payload, { recursive: true });
      const frozen = await freeze(gone);
      const payloadIds = (gone.manifest.artifacts as Json[]).filter((a) => a.origin !== "authored").map((a) => a.id).sort();
      expect(frozen.rejected.map((item) => item.artifactId).sort()).toEqual(payloadIds);
      for (const id of payloadIds) expect(frozen.rejected.find((item) => item.artifactId === id)!.reason).toMatch(/payload root/);
      expect(frozen.available.has("pricing-original")).toBe(true);

      const unset = setup(inPlace);
      unset.request = { ...unset.request, pin: undefined };
      expect((await freeze(unset)).rejected.map((item) => item.artifactId).sort()).toEqual(payloadIds);
    });

    it("never deletes input roots, payload files or symlink targets when it rejects", async () => {
      const c = setup(inPlace);
      const outside = join(c.dir, "outside-resource");
      renameSync(livePath(c, "app-resource-output"), outside);
      symlinkSync(outside, livePath(c, "app-resource-output"));
      writeFileSync(livePath(c, "pricing-output"), "tampered\n");
      const listing = filesUnder(c.payload);
      const repoBefore = fixtureGit(inPlace.repo, "status", "--porcelain");
      await freeze(c);
      expect(filesUnder(c.payload)).toEqual(listing);
      expect(readFileSync(outside, "utf8")).toContain("endpoint=");
      expect(readFileSync(livePath(c, "pricing-output"), "utf8")).toBe("tampered\n");
      expect(fixtureGit(inPlace.repo, "status", "--porcelain")).toBe(repoBefore);
    });
  });

  describe("directory inventories", () => {
    const member = (dir: string, c: Case) => join(dir, art(c.manifest, "prod-classes").entries[0].path);

    it.each([
      ["an unlisted regular file", (dir: string) => writeFileSync(join(dir, "Evil.class"), "x"), /inventory/],
      ["an unlisted nested file", (dir: string) => { mkdirSync(join(dir, "evil/deep"), { recursive: true }); writeFileSync(join(dir, "evil/deep/Evil.class"), "x"); }, /inventory/],
      ["an unlisted file beside listed members", (dir: string, c: Case) => writeFileSync(join(dirname(member(dir, c)), "Evil.class"), "x"), /inventory/],
      ["a missing listed member", (dir: string, c: Case) => unlinkSync(member(dir, c)), /inventory/],
      ["a tampered member", (dir: string, c: Case) => writeFileSync(member(dir, c), "tampered"), /size or hash/],
      ["a symlink member with identical bytes", (dir: string, c: Case) => {
        const real = member(dir, c);
        const copy = join(dirname(dir), "stolen.class");
        writeFileSync(copy, readFileSync(real));
        unlinkSync(real);
        symlinkSync(copy, real);
      }, /symlink/],
      ["a FIFO member", (dir: string, c: Case) => { unlinkSync(member(dir, c)); execFileSync("mkfifo", [member(dir, c)]); }, /regular file/],
    ])("rejects a directory with %s and degrades every referencing scope", async (_label, attack, reason) => {
      const c = setup(inPlace);
      attack(livePath(c, "prod-classes"), c);
      const frozen = await freeze(c);
      rejected(frozen, "prod-classes", reason, ["prod", "test"]);
      expect(frozen.available.has("test-classes")).toBe(true);
      expect(frozen.rejected).toHaveLength(1);
      // Nothing from a rejected directory is served, not even its valid members, and nothing stray is left behind.
      expectNoOrphans(c, frozen);
    });

    it("admits an empty pinned directory and rejects it as soon as an unlisted file appears", async () => {
      const c = setup(inPlace);
      mkdirSync(join(c.payload, "classes/empty"));
      c.manifest.artifacts.push(extraDirectory("empty-classes", "classes/empty"));
      const admitted = await freeze(c);
      expect(admitted.rejected).toEqual([]);
      expect(readdirSync(admitted.available.get("empty-classes")!.path)).toEqual([]);
      writeFileSync(join(c.payload, "classes/empty/Stale.class"), "inherited from an earlier build");
      rejected(await freeze(c), "empty-classes", /inventory/, []);
    });
  });

  describe("collisions and unsafe locations", () => {
    it("rejects artifacts whose payload paths differ only by case, keeping a distinct control", async () => {
      const c = setup(inPlace);
      put(c, "ci/Data.txt", "upper\n");
      put(c, "ci/data.txt", "lower\n");
      put(c, "ci/other.txt", "control\n");
      c.manifest.artifacts.push(extraFile("ci-upper", "ci/Data.txt", Buffer.from("upper\n")));
      c.manifest.artifacts.push(extraFile("ci-lower", "ci/data.txt", Buffer.from("lower\n")));
      c.manifest.artifacts.push(extraFile("ci-control", "ci/other.txt", Buffer.from("control\n")));
      const frozen = await freeze(c);
      rejected(frozen, "ci-upper", /collide/, []);
      rejected(frozen, "ci-lower", /collide/, []);
      expect(bytesOf(frozen, "ci-control").toString("utf8")).toBe("control\n");
    });

    it("rejects artifacts whose payload paths differ only by Unicode normalization", async () => {
      const c = setup(inPlace);
      put(c, "uni/caf\u00e9.txt", "composed\n");
      put(c, "uni/cafe\u0301.txt", "decomposed\n");
      c.manifest.artifacts.push(extraFile("uni-nfc", "uni/caf\u00e9.txt", Buffer.from("composed\n")));
      c.manifest.artifacts.push(extraFile("uni-nfd", "uni/cafe\u0301.txt", Buffer.from("decomposed\n")));
      const frozen = await freeze(c);
      rejected(frozen, "uni-nfc", /collide/, []);
      rejected(frozen, "uni-nfd", /collide/, []);
    });

    it("rejects a file path that is also the parent of another payload path, including directory members", async () => {
      const c = setup(inPlace);
      put(c, "pfx/x", "file x\n");
      c.manifest.artifacts.push(extraFile("pfx-file", "pfx/x", Buffer.from("file x\n")));
      c.manifest.artifacts.push(extraFile("pfx-child", "pfx/x/e", Buffer.from("child\n")));
      put(c, "dirx/a", "member\n");
      c.manifest.artifacts.push(extraDirectory("dirx", "dirx", [{ path: "a", sha256: sha256("member\n"), sizeBytes: 7 }]));
      c.manifest.artifacts.push(extraFile("dirx-below-member", "dirx/a/b", Buffer.from("below\n")));
      const frozen = await freeze(c);
      for (const id of ["pfx-file", "pfx-child", "dirx", "dirx-below-member"]) rejected(frozen, id, /collide/, []);
    });

    it("rejects every artifact claiming one payload path with conflicting size or hash", async () => {
      const c = setup(inPlace);
      const resource = art(c.manifest, "app-resource-output");
      c.manifest.artifacts.push(extraFile("alias", resource.content.location.path, Buffer.from("different claim")));
      const frozen = await freeze(c);
      rejected(frozen, "app-resource-output", /conflicting/, ["prod", "test"]);
      rejected(frozen, "alias", /conflicting/, []);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it.each(["../outside.txt", "a/../../outside.txt", "ABSOLUTE", "a//b.txt", "a/./b.txt", "a\\b.txt", "a\0b.txt", ""])(
      "rejects the uncontained payload path %j before touching the filesystem", async (path) => {
        const c = setup(inPlace);
        const outside = Buffer.from("outside the payload root\n");
        writeFileSync(join(c.dir, "outside.txt"), outside);
        c.manifest.artifacts.push(extraFile("uncontained", path === "ABSOLUTE" ? join(c.dir, "outside.txt") : path, outside));
        c.manifest.artifacts.push(extraDirectory("uncontained-dir", "classes/uncontained", [{ path: path === "ABSOLUTE" ? "/etc/hostname" : path, sha256: HASH, sizeBytes: 1 }]));
        const frozen = await freeze(c);
        rejected(frozen, "uncontained", /contained relative path/, []);
        rejected(frozen, "uncontained-dir", /contained relative path/, []);
      });

    it("rejects an authored original with an uncontained repository path without consulting Git", async () => {
      const c = setup(inPlace);
      c.manifest.artifacts.push(extraAuthored("escape", "../Consumer.java", Buffer.from("x")));
      rejected(await freeze(c), "escape", /contained relative path/, []);
    });
  });

  describe("dependency rejection propagation", () => {
    const clean = (frozen: FrozenBuildArtifacts, c: Case, except: readonly string[]) => {
      for (const a of c.manifest.artifacts as Json[]) expect(frozen.available.has(a.id), a.id).toBe(!except.includes(a.id));
    };

    it.each([
      ["a classes directory that is an output and an upstream classpath entry", "prod-classes", ["prod", "test"], false],
      ["a test-only output", "test-classes", ["test"], false],
      ["a test-only authored original", "pricing-test", ["test"], false],
      ["an authored input that only the downstream scope reaches through its upstream classpath", "consumer-original", ["prod", "test"], false],
      ["a filtered resource output referenced as a resource", "app-resource-output", ["prod", "test"], false],
      ["a build-config original reachable only through transformation lineage", "pricing-generator-config", ["prod", "test"], true],
      ["a resource original reachable only through resource lineage", "app-resource-original", ["prod", "test"], true],
    ])("degrades the right scopes for %s", async (_label, id, scopes, lineageOnly) => {
      const c = setup(inPlace);
      if (lineageOnly) comp(c.manifest, "prod").authoredArtifactIds = comp(c.manifest, "prod").authoredArtifactIds.filter((x: string) => x !== id);
      const target = art(c.manifest, id);
      if (target.kind === "file") target.content.sha256 = HASH;
      else target.entries[0].sha256 = HASH;
      const frozen = await freeze(c);
      expect(frozen.rejected.map((item) => item.artifactId)).toEqual([id]);
      rejected(frozen, id, /size or hash/, scopes);
      clean(frozen, c, [id]);
      // A degraded scope publishes no private source layout; an unaffected scope keeps its verified one.
      expect(frozen.sourceRoots.has("prod")).toBe(!scopes.includes("prod"));
      expect(frozen.sourceRoots.has("test")).toBe(!scopes.includes("test"));
    });

    it("reports every failure once, in manifest order, with its own affected scopes", async () => {
      const c = setup(inPlace);
      art(c.manifest, "pricing-test").content.sha256 = HASH;
      art(c.manifest, "prod-classes").entries[0].sha256 = HASH;
      const frozen = await freeze(c);
      expect(frozen.rejected.map((item) => item.artifactId)).toEqual(["pricing-test", "prod-classes"]);
      rejected(frozen, "pricing-test", /size or hash/, ["test"]);
      rejected(frozen, "prod-classes", /size or hash/, ["prod", "test"]);
      clean(frozen, c, ["pricing-test", "prod-classes"]);
    });

    it("does not degrade a compilation that shares no dependency with the failure", async () => {
      const c = setup(inPlace);
      const lone = structuredClone(comp(c.manifest, "test"));
      lone.id = "lone";
      lone.outputArtifactIds = [];
      lone.compileClasspath = { state: "complete", reason: null, entries: [] };
      c.manifest.compilations.push(lone);
      buildEvidenceSchema.parse(c.manifest);
      art(c.manifest, "consumer-original").content.sha256 = HASH;
      const frozen = await freeze(c);
      rejected(frozen, "consumer-original", /size or hash/, ["prod", "test"]);
      expect(frozen.sourceRoots.has("lone")).toBe(true);
    });

    it("treats nonavailable artifacts as gaps, not as admission failures", async () => {
      const c = setup(valid);
      const out = art(c.manifest, "pricing-output");
      for (const key of ["content", "encoding"]) delete out[key];
      out.availability = "not-produced";
      out.reason = "generation failed before this file was written";
      const frozen = await freeze(c);
      expect(frozen.rejected).toEqual([]);
      expect(frozen.available.has("pricing-output")).toBe(false);
      const generated = frozen.sourceRoots.get("prod")!.find((root) => root.rootId === "generated-main")!;
      expect(generated.memberIds).toEqual([]);
      expect(frozen.sourceRoots.get("prod")!.find((root) => root.rootId === "authored-main")!.memberIds).toEqual(["consumer-original"]);
    });

    // The old quadratic lineage copy needs gigabytes at this size. The case runs in a child process with a 512 MiB heap
    // so that a regression is a clean child failure (not a parent OOM) and no wall-clock threshold is involved.
    it("propagates through one transformation of 20,000 inputs and 20,000 outputs within a 512 MiB heap", async () => {
      const size = 20_000;
      const c = setup(valid);
      const payload = join(c.dir, "scale-payload");
      mkdirSync(payload, { recursive: true });
      const stale = Buffer.from("these bytes do not match their claimed hash\n");
      const safe = Buffer.from("unrelated and intact\n");
      writeFileSync(join(payload, "input-0.txt"), stale);
      writeFileSync(join(payload, "safe.txt"), safe);
      const tampered = extraFile("input-0", "input-0.txt", stale);
      tampered.content.sha256 = HASH;
      const inputs = Array.from({ length: size }, (_, n) => `input-${n}`);
      const outputs = Array.from({ length: size }, (_, n) => `output-${n}`);
      const manifest = {
        ...structuredClone(c.manifest),
        artifacts: [tampered, ...inputs.slice(1).map((id) => gap(id, "missing")), ...outputs.map((id) => gap(id, "not-produced")), extraFile("safe", "safe.txt", safe)],
        compilations: [compilationOver(c, "scale", { outputArtifactIds: outputs }), compilationOver(c, "other", { outputArtifactIds: ["safe"] })],
        transformations: [producedBy("many-to-many", inputs, outputs)],
        diagnostics: [],
      };
      buildEvidenceSchema.parse(manifest);
      const input = join(c.dir, "scale-input.json");
      writeFileSync(input, JSON.stringify({ request: { ...c.request, pin: { ...c.request.pin!, payloadRoot: payload } }, manifest }));
      const root = fileURLToPath(new URL("..", import.meta.url));
      const program = [
        'import { readFileSync } from "node:fs";',
        `import { freezeBuildArtifacts } from ${JSON.stringify(pathToFileURL(join(root, "src/build-artifacts.ts")).href)};`,
        "const { request, manifest } = JSON.parse(readFileSync(process.env.SCALE_INPUT, 'utf8'));",
        "const frozen = await freezeBuildArtifacts(request, manifest);",
        "process.stdout.write(JSON.stringify({ rejected: frozen.rejected,",
        "  available: Object.fromEntries([...frozen.available].map(([id, stored]) => [id, stored.path])), roots: [...frozen.sourceRoots.keys()] }));",
      ].join("\n");
      const { stdout } = await promisify(execFile)(
        process.execPath, ["--max-old-space-size=512", "--import", "tsx", "--input-type=module", "--eval", program],
        { cwd: root, env: { ...process.env, SCALE_INPUT: input }, maxBuffer: 16 << 20, timeout: 110_000 },
      );
      const result = JSON.parse(stdout) as { rejected: FrozenBuildArtifacts["rejected"]; available: Record<string, string>; roots: string[] };
      const frozen = {
        rejected: result.rejected,
        available: new Map(Object.entries(result.available).map(([id, path]) => [id, { artifact: art(manifest, id), path }])),
        sourceRoots: new Map(result.roots.map((id) => [id, []])),
      } as FrozenBuildArtifacts;
      expect(frozen.rejected).toHaveLength(1);
      rejected(frozen, "input-0", /size or hash/, ["scale"]);
      expect(frozen.sourceRoots.has("scale")).toBe(false);
      expect(frozen.sourceRoots.has("other")).toBe(true);
      expect([...frozen.available.keys()]).toEqual(["safe"]);
      expect(bytesOf(frozen, "safe")).toEqual(safe);
    }, 120_000);

    it("follows lineage across several transformations to every compilation that reaches the failed input", async () => {
      const c = setup(inPlace);
      put(c, "chain/a.txt", "stage a\n");
      c.manifest.artifacts.push(extraFile("stage-a", "chain/a.txt", Buffer.from("stage a\n")), gap("stage-b", "missing"), gap("stage-c", "missing"));
      c.manifest.transformations.push(producedBy("hop-1", ["stage-a"], ["stage-b"]), producedBy("hop-2", ["stage-b"], ["stage-c"]));
      c.manifest.compilations.push(
        compilationOver(c, "reaches-c", { resourceArtifactIds: ["stage-c"] }),
        compilationOver(c, "reaches-b", { resourceArtifactIds: ["stage-b"] }),
        compilationOver(c, "unrelated", {}),
      );
      buildEvidenceSchema.parse(c.manifest);
      art(c.manifest, "stage-a").content.sha256 = HASH;
      const frozen = await freeze(c);
      rejected(frozen, "stage-a", /size or hash/, ["reaches-b", "reaches-c"]);
      expect(frozen.rejected).toHaveLength(1);
      for (const id of ["reaches-b", "reaches-c"]) expect(frozen.sourceRoots.has(id), id).toBe(false);
      for (const id of ["unrelated", "prod", "test"]) expect(frozen.sourceRoots.has(id), id).toBe(true);
    });

    it.each([
      ["modulePath", (x: Json, id: string) => { x.modulePath = complete(id); }],
      ["processorPath", (x: Json, id: string) => { x.processorPath = complete(id); }],
      ["compiler sourcePath", (x: Json, id: string) => { x.compiler.moduleOptions.sourcePath = complete(id); }],
      ["compiler bootClasspath", (x: Json, id: string) => { x.compiler.moduleOptions.bootClasspath = complete(id); }],
      ["compiler patchModules path", (x: Json, id: string) => { x.compiler.moduleOptions.patchModules = [{ module: "m", path: complete(id) }]; }],
      ["compileClasspath entry that names no upstream compilation", (x: Json, id: string) => { x.compileClasspath = complete(id); }],
    ])("degrades a compilation that reaches the failed artifact through its %s", async (_label, wire) => {
      const c = setup(inPlace);
      put(c, "deps/library.bin", "library bytes\n");
      c.manifest.artifacts.push(extraFile("library", "deps/library.bin", Buffer.from("library bytes\n"), "dependency"));
      const via = compilationOver(c, "via-path", {});
      wire(via, "library");
      c.manifest.compilations.push(via);
      buildEvidenceSchema.parse(c.manifest);
      art(c.manifest, "library").content.sha256 = HASH;
      const frozen = await freeze(c);
      rejected(frozen, "library", /size or hash/, ["via-path"]);
      expect(frozen.sourceRoots.has("via-path")).toBe(false);
      for (const id of ["prod", "test"]) expect(frozen.sourceRoots.has(id), id).toBe(true);
    });

    it.each([
      ["a production input", "consumer-original", ["chain-x", "chain-y", "prod", "test"]],
      ["a test-only original", "pricing-test", ["chain-x", "chain-y", "test"]],
    ])("degrades every scope downstream of an upstream compilation through several hops: %s", async (_label, id, scopes) => {
      const c = setup(inPlace);
      c.manifest.artifacts.push(gap("x-out", "not-produced", "classes"));
      c.manifest.compilations.push(
        compilationOver(c, "chain-x", { outputArtifactIds: ["x-out"], compileClasspath: complete("test-classes", "test") }),
        compilationOver(c, "chain-y", { compileClasspath: complete("x-out", "chain-x") }),
        compilationOver(c, "bystander", {}),
      );
      buildEvidenceSchema.parse(c.manifest);
      art(c.manifest, id).content.sha256 = HASH;
      const frozen = await freeze(c);
      rejected(frozen, id, /size or hash/, scopes);
      for (const scope of ["prod", "test", "chain-x", "chain-y"]) expect(frozen.sourceRoots.has(scope), scope).toBe(!scopes.includes(scope));
      expect(frozen.sourceRoots.has("bystander")).toBe(true);
    });
  });

  describe("source root layout", () => {
    it("materializes explicit members only at their member-relative paths, one root per declared root", async () => {
      const c = setup(inPlace);
      put(c, "generated/main/example/Evil.java", "class Evil {}\n");
      const frozen = await freeze(c);
      const prod = frozen.sourceRoots.get("prod")!;
      expect(prod.map((root) => root.rootId)).toEqual(["main"]);
      expect(prod[0]!.memberIds).toEqual(["consumer-original", "pricing-output"]);
      expect(filesUnder(prod[0]!.path)).toEqual(["example/Consumer.java", "example/Pricing.java"]);
      expect(readFileSync(join(prod[0]!.path, "example/Consumer.java"))).toEqual(Buffer.from(inPlace.originalBytes.get("consumer-original")!));
      // The root serves the transformed view; the authored template-like original is not smuggled in beside it.
      expect(readFileSync(join(prod[0]!.path, "example/Pricing.java"))).toEqual(Buffer.from(inPlace.outputBytes.get("pricing-output")!));
      const test = frozen.sourceRoots.get("test")!;
      expect(test.map((root) => [root.rootId, root.memberIds])).toEqual([["authored-test", ["pricing-test"]]]);
      expect(readFileSync(join(test[0]!.path, "example/PricingTest.java"))).toEqual(Buffer.from(inPlace.originalBytes.get("pricing-test")!));
      for (const root of [...prod, ...test]) expect(relative(c.runtime, root.path).startsWith("..")).toBe(false);
    });

    it("keeps separate roots for authored and generated members in the template layout", async () => {
      const frozen = await freeze(setup(valid));
      const prod = frozen.sourceRoots.get("prod")!;
      expect(prod.map((root) => [root.rootId, root.memberIds])).toEqual([
        ["authored-main", ["consumer-original"]], ["generated-main", ["pricing-output"]],
      ]);
      expect(new Set(prod.map((root) => root.path)).size).toBe(2);
      expect(filesUnder(prod[1]!.path)).toEqual(["example/Pricing.java"]);
    });

    it("does not flatten same-basename members and ignores root labels", async () => {
      const c = setup(inPlace);
      const root = comp(c.manifest, "prod").sourceRoots[0];
      root.repositoryPath = "../../elsewhere";
      root.members[0].relativePath = "a/Same.java";
      root.members[1].relativePath = "b/Same.java";
      const frozen = await freeze(c);
      const placed = frozen.sourceRoots.get("prod")![0]!;
      expect(filesUnder(placed.path)).toEqual(["a/Same.java", "b/Same.java"]);
      expect(readFileSync(join(placed.path, "a/Same.java"))).toEqual(Buffer.from(inPlace.originalBytes.get("consumer-original")!));
      expect(readFileSync(join(placed.path, "b/Same.java"))).toEqual(Buffer.from(inPlace.outputBytes.get("pricing-output")!));
      expect(relative(c.runtime, placed.path).startsWith("..")).toBe(false);
    });

    it.each([
      ["a case-only collision", "example/consumer.java"],
      ["a member nested below another member file", "example/Consumer.java/Inner.java"],
      ["a normalization-only collision", "example/Consume\u0301r.java"],
    ])("rejects both members of %s and degrades the compilation", async (_label, relativePath) => {
      const c = setup(inPlace);
      comp(c.manifest, "prod").sourceRoots[0].members[1].relativePath = relativePath;
      if (relativePath.includes("\u0301")) comp(c.manifest, "prod").sourceRoots[0].members[0].relativePath = "example/Consum\u00e9r.java";
      const frozen = await freeze(c);
      rejected(frozen, "consumer-original", /collide/, ["prod", "test"]);
      rejected(frozen, "pricing-output", /collide/, ["prod", "test"]);
      expect(frozen.sourceRoots.has("prod")).toBe(false);
    });

    it.each(["../../escape.java", "/absolute/escape.java", "a//b.java", "a\\b.java"])(
      "rejects the member whose relative path %j would escape its root and writes nothing outside it", async (relativePath) => {
        const c = setup(inPlace);
        comp(c.manifest, "prod").sourceRoots[0].members[1].relativePath = relativePath;
        const frozen = await freeze(c);
        rejected(frozen, "pricing-output", /contained relative path/, ["prod", "test"]);
        expect(frozen.available.has("consumer-original")).toBe(true);
        expect(filesUnder(c.runtime).filter((p) => p.endsWith("escape.java") || p.endsWith("b.java"))).toEqual([]);
      });
  });

  describe("scale", () => {
    it("admits 2,001 ordinary payload artifacts without a default count gate", async () => {
      const { request, manifest } = bulk(setup(valid), 2001);
      const frozen = await freezeBuildArtifacts(request, manifest);
      expect(frozen.rejected).toEqual([]);
      expect(frozen.available.size).toBe(2001);
      expect(new Set([...frozen.available.values()].map((stored) => stored.path)).size).toBe(2001);
      for (const n of [0, 1000, 2000]) expect(readFileSync(frozen.available.get(`bulk-${n}`)!.path, "utf8")).toBe(`ordinary artifact ${n}\n`);
    });

  });

  describe("cancellation", () => {
    const inPlaceRun = (): Run => {
      const c = setup(inPlace);
      return { request: c.request, manifest: c.manifest, payload: c.payload };
    };

    it("a signal aborted before the call rejects with the abort reason and creates nothing", async () => {
      const c = setup(inPlace);
      const listing = filesUnder(c.payload);
      await expect(freezeBuildArtifacts({ ...c.request, signal: AbortSignal.abort() }, c.manifest)).rejects.toMatchObject({ name: "AbortError" });
      expect(existsSync(c.runtime) ? readdirSync(c.runtime) : []).toEqual([]);
      expect(filesUnder(c.payload)).toEqual(listing);
    });

    it("stops at every successive poll of a real admission, removing only its own scratch and touching no input", async () => {
      const r = inPlaceRun();
      const total = await pollsOf(r);
      // Git blobs, payload files, directory members and source-root members are all polled inside one admission.
      expect(total).toBeGreaterThan(15);
      await expectCancelledAtEveryPoll(r, Array.from({ length: total }, (_, i) => i + 1));
      const completed = await freezeBuildArtifacts(r.request, r.manifest);
      expect(completed.rejected).toEqual([]);
      expect(completed.available.size).toBeGreaterThan(0);
    });

    it("cancels in the middle of a streamed file and discards the partial copy", async () => {
      const c = setup(valid);
      const big = scenario(c, "big", (write) => {
        write("big/blob.bin", Buffer.alloc(3 * 1024 * 1024, 0x61));
        return [extraFile("big", "big/blob.bin", Buffer.alloc(3 * 1024 * 1024, 0x61))];
      });
      const small = scenario(c, "small", (write) => {
        write("big/blob.bin", Buffer.from("x"));
        return [extraFile("small", "big/blob.bin", Buffer.from("x"))];
      });
      const [bigPolls, smallPolls] = [await pollsOf(big), await pollsOf(small)];
      // Streaming itself is polled: at least once per half MiB of the 3 MiB file.
      expect(bigPolls - smallPolls).toBeGreaterThanOrEqual(5);
      await expectCancelledAtEveryPoll(big, Array.from({ length: bigPolls }, (_, i) => i + 1));
    });

    it("polls at least once per artifact, directory member, Git blob and source-root member", async () => {
      const c = setup(valid);
      const members = Array.from({ length: 30 }, (_, n) => `m${String(n).padStart(2, "0")}.class`);
      const none = scenario(c, "none", () => []);
      const plain = scenario(c, "plain", emptyFiles(30, "source"));
      const rooted = scenario(c, "rooted", emptyFiles(30, "source"), [compilationOver(c, "rooted", {
        inputArtifactIds: Array.from({ length: 30 }, (_, n) => `f${n}`),
        sourceRoots: [{ id: "many", repositoryPath: null, members: Array.from({ length: 30 }, (_, n) => ({ artifactId: `f${n}`, relativePath: `p/F${n}.java` })) }],
      })]);
      const directory = scenario(c, "directory", (write) => {
        for (const name of members) write(`classes/many/${name}`, Buffer.alloc(0));
        return [extraDirectory("many", "classes/many", members.map((path) => ({ path, sha256: sha256(Buffer.alloc(0)), sizeBytes: 0 })))];
      });
      const base = await pollsOf(none);
      // Each of 30 artifacts is polled when reached and again while its (empty) copy streams.
      expect((await pollsOf(plain)) - base).toBeGreaterThanOrEqual(60);
      // Placing 30 verified members into a source root polls once per member.
      expect((await pollsOf(rooted)) - (await pollsOf(plain))).toBeGreaterThanOrEqual(30);
      // A directory polls once per entry it walks and once per member copy.
      expect((await pollsOf(directory)) - base).toBeGreaterThanOrEqual(60);
      // Each authored blob is polled before it is verified and written.
      expect((await pollsOf(authoredScenario(valid, 30))) - base).toBeGreaterThanOrEqual(30);
    });

    it.each([
      ["listing the pinned tree", (stop: () => void) => { hooks.tree = stop; }],
      ["reading the pinned blobs", (stop: () => void) => { hooks.blobs = stop; }],
    ])("cancels while Git is %s", async (_label, arm) => {
      const r = inPlaceRun();
      const bystanders = withBystanders(r.request.runtimeDir);
      const payloadBefore = treeDigest(r.payload);
      const controller = new AbortController();
      arm(() => controller.abort());
      await expect(freezeBuildArtifacts({ ...r.request, signal: controller.signal }, r.manifest)).rejects.toMatchObject({ name: "AbortError" });
      expect(everything(r.request.runtimeDir)).toEqual(bystanders);
      expect(treeDigest(r.payload)).toEqual(payloadBefore);
    });
  });

  describe("host failures versus artifact faults", () => {
    it.each([
      ["a repository directory that does not exist", (c: Case) => join(c.dir, "no-such-repository")],
      ["a repository path that is a file", (c: Case) => livePath(c, "app-resource-output")],
    ])("rejects the whole call, not every original, when the Git process cannot run in %s", async (_label, repository) => {
      const c = setup(inPlace);
      const bystanders = withBystanders(c.runtime);
      c.request = { ...c.request, repo: repository(c) };
      await expect(freeze(c)).rejects.toMatchObject({ code: expect.stringMatching(/^E(NOENT|NOTDIR)$/) });
      expect(everything(c.runtime)).toEqual(bystanders);
    });

    it.each([
      ["listing the tree", (error: Error) => { hooks.tree = () => { throw error; }; }],
      ["reading the blobs", (error: Error) => { hooks.blobs = () => { throw error; }; }],
    ])("lets resource exhaustion while %s escape instead of degrading the originals", async (_label, arm) => {
      const c = setup(inPlace);
      const bystanders = withBystanders(c.runtime);
      arm(failure("EMFILE"));
      await expect(freeze(c)).rejects.toMatchObject({ code: "EMFILE" });
      expect(everything(c.runtime)).toEqual(bystanders);
    });

    it.each([
      ["a path that is not valid UTF-8", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74])],
      ["a path containing a backslash", Buffer.from("back\\slash.txt")],
    ])("rejects every authored original, not the call, when the pinned tree holds %s", async (_label, name) => {
      const repo = cloneOf(inPlace);
      writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), name]), "content\n");
      fixtureGit(repo, "add", "-A");
      const c = atRevision(inPlace, { repo, revision: commitIn(repo) });
      const frozen = await freeze(c);
      const authored = (c.manifest.artifacts as Json[]).filter((a) => a.origin === "authored").map((a) => a.id).sort();
      expect(frozen.rejected.map((item) => item.artifactId).sort()).toEqual(authored);
      for (const id of authored) expect(frozen.rejected.find((item) => item.artifactId === id)!.reason).toMatch(/revision could not be read/);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it("still rejects only the artifact when the payload source is unreadable", async () => {
      const c = setup(inPlace);
      hooks.open = (path) => (path.startsWith("/proc/self/fd/") && path.endsWith("/application.properties") ? failure("EACCES") : undefined);
      const frozen = await freeze(c);
      rejected(frozen, "app-resource-output", /could not be read/, ["prod", "test"]);
      expect(frozen.rejected).toHaveLength(1);
      expect(frozen.available.has("pricing-output")).toBe(true);
    });

    it("lets descriptor exhaustion while opening a payload source escape", async () => {
      const c = setup(inPlace);
      const bystanders = withBystanders(c.runtime);
      hooks.open = (path) => (path.startsWith("/proc/self/fd/") ? failure("EMFILE") : undefined);
      await expect(freeze(c)).rejects.toMatchObject({ code: "EMFILE" });
      expect(everything(c.runtime)).toEqual(bystanders);
    });

    it("lets a failure writing the private copy escape instead of blaming the payload artifact", async () => {
      const c = setup(inPlace);
      const bystanders = withBystanders(c.runtime);
      hooks.open = (path) => (path.startsWith(c.runtime) ? failure("EROFS") : undefined);
      await expect(freeze(c)).rejects.toMatchObject({ code: "EROFS" });
      expect(everything(c.runtime)).toEqual(bystanders);
    });

    it("rejects the member, not the call, when a source-root member path is too long to lay out", async () => {
      const c = setup(inPlace);
      comp(c.manifest, "prod").sourceRoots[0].members[1].relativePath = `example/${"n".repeat(300)}/Pricing.java`;
      const frozen = await freeze(c);
      rejected(frozen, "pricing-output", /too long/, ["prod", "test"]);
      expect(frozen.rejected).toHaveLength(1);
      expect(frozen.sourceRoots.has("prod")).toBe(false);
      expect(frozen.available.has("consumer-original")).toBe(true);
      expectNoOrphans(c, frozen);
    });

    it("rejects a directory whose tree is too deep for the private copy, not the call", async () => {
      const c = setup(valid);
      const name = "n".repeat(200);
      const depth = 30; // about 6 KB of relative path: readable one component at a time, never as one host path
      const payload = join(c.dir, "deep-payload");
      const deep = scenario(c, "deep", (write) => {
        write("ok.txt", Buffer.from("ok\n"));
        mkdirSync(join(payload, "deep"), { recursive: true });
        execFileSync("bash", ["-c", `for i in $(seq ${depth}); do mkdir ${name} && cd ${name} || exit 1; done; printf x > leaf.bin`], { cwd: join(payload, "deep") });
        return [
          extraFile("ok", "ok.txt", Buffer.from("ok\n")),
          extraDirectory("deep-classes", "deep", [{ path: `${`${name}/`.repeat(depth)}leaf.bin`, sha256: sha256("x"), sizeBytes: 1 }]),
        ];
      });
      try {
        const frozen = await freezeBuildArtifacts(deep.request, deep.manifest);
        rejected(frozen, "deep-classes", /too long/, []);
        expect(frozen.rejected).toHaveLength(1);
        expect(bytesOf(frozen, "ok").toString("utf8")).toBe("ok\n");
        const [scratch, ...others] = readdirSync(deep.request.runtimeDir);
        expect(others).toEqual([]);
        expect(filesUnder(join(deep.request.runtimeDir, scratch!))).toEqual(["artifacts/0"]);
      } finally {
        execFileSync("rm", ["-rf", join(payload, "deep")]);
      }
    });
  });

  describe("git object readers", () => {
    it("lists NUL-delimited tree entries and reads exact blob bytes, including odd paths, symlinks and gitlinks", async () => {
      const repo = cloneOf(inPlace);
      mkdirSync(join(repo, "odd dir"), { recursive: true });
      writeFileSync(join(repo, "odd dir/ünï\ncode.txt"), "odd\n");
      symlinkSync("Pricing.java", join(repo, "link.java"));
      fixtureGit(repo, "add", "-A");
      fixtureGit(repo, "update-index", "--add", "--cacheinfo", `160000,${inPlace.head},vendor/sub`);
      const revision = commitIn(repo);

      const entries = await readGitTree(repo, revision);
      const listed = fixtureGit(repo, "ls-tree", "-r", "-z", revision).split("\0").filter(Boolean).map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, , oid] = meta!.split(" ");
        return { mode, oid, path };
      });
      expect(entries).toEqual(listed);
      expect(entries.map((e) => e.path)).toContain("odd dir/ünï\ncode.txt");
      expect(entries.find((e) => e.path === "link.java")!.mode).toBe("120000");
      expect(entries.find((e) => e.path === "vendor/sub")).toMatchObject({ mode: "160000", oid: inPlace.head });

      const readable = entries.filter((e) => e.mode !== "160000");
      const blobs = await readGitBlobs(repo, readable);
      expect([...blobs.keys()]).toEqual(readable.map((e) => e.path));
      for (const e of readable) expect(blobs.get(e.path), e.path).toEqual(gitBlob(repo, revision, e.path));
    });

    it("reports unreadable revisions and objects with the stable error codes the Inspect bridge maps", async () => {
      await expect(readGitTree(inPlace.repo, "0".repeat(40))).rejects.toMatchObject({ code: "worker-failed" });
      await expect(readGitBlobs(inPlace.repo, [{ path: "missing.txt", oid: "1".repeat(40), mode: "100644" }]))
        .rejects.toMatchObject({ code: "snapshot-mismatch" });
    });

    it("stops a Git read when the signal aborts", async () => {
      await expect(readGitTree(inPlace.repo, inPlace.head, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    });
  });
});

/** Recursive path -> sha256 map of a frozen artifact (file or directory). */
function treeDigest(path: string): Record<string, string> {
  if (lstatSync(path).isFile()) return { "": sha256(readFileSync(path)) };
  return Object.fromEntries(filesUnder(path).map((member) => [member, sha256(readFileSync(join(path, member)))]));
}
