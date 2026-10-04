import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceSchema, type BuildEvidenceRequest } from "../src/build-evidence-contract.js";
import { freezeBuildArtifacts, type FrozenBuildArtifacts } from "../src/build-artifacts.js";
import { readGitBlobs, readGitTree } from "../src/git-objects.js";
import { createBuildFixture, fixtureGit, fixtureRequest, type BuildFixture, type FixtureSide } from "./build-evidence-fixture.js";

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

const extraFile = (id: string, path: string, bytes: Uint8Array): Json => ({
  id, kind: "file", role: "resource", origin: "external", repositoryPath: null, availability: "available",
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

  describe("scale and cancellation", () => {
    it("admits 2,001 ordinary payload artifacts without a default count gate", async () => {
      const { request, manifest } = bulk(setup(valid), 2001);
      const frozen = await freezeBuildArtifacts(request, manifest);
      expect(frozen.rejected).toEqual([]);
      expect(frozen.available.size).toBe(2001);
      expect(new Set([...frozen.available.values()].map((stored) => stored.path)).size).toBe(2001);
      for (const n of [0, 1000, 2000]) expect(readFileSync(frozen.available.get(`bulk-${n}`)!.path, "utf8")).toBe(`ordinary artifact ${n}\n`);
    });

    it("a signal aborted before the call rejects with the abort reason and creates nothing", async () => {
      const c = setup(inPlace);
      const listing = filesUnder(c.payload);
      await expect(freezeBuildArtifacts({ ...c.request, signal: AbortSignal.abort() }, c.manifest)).rejects.toMatchObject({ name: "AbortError" });
      expect(existsSync(c.runtime) ? readdirSync(c.runtime) : []).toEqual([]);
      expect(filesUnder(c.payload)).toEqual(listing);
    });

    it("an abort during admission publishes no admission, removes only its own scratch and leaves inputs intact", async () => {
      const { request, manifest, payload } = bulk(setup(valid), 2001);
      const listing = filesUnder(payload);
      const controller = new AbortController();
      const pending = freezeBuildArtifacts({ ...request, signal: controller.signal }, manifest);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(existsSync(request.runtimeDir) ? readdirSync(request.runtimeDir) : []).toEqual([]);
      expect(filesUnder(payload)).toEqual(listing);
    });

    it("leaves a pre-existing sibling in the runtime directory alone when admission is cancelled", async () => {
      const { request, manifest } = bulk(setup(valid), 300);
      mkdirSync(request.runtimeDir, { recursive: true });
      writeFileSync(join(request.runtimeDir, "unrelated.txt"), "owned by someone else");
      const controller = new AbortController();
      const pending = freezeBuildArtifacts({ ...request, signal: controller.signal }, manifest);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(readdirSync(request.runtimeDir)).toEqual(["unrelated.txt"]);
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
