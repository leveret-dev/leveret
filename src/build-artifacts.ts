import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildArtifact, BuildEvidenceManifest, BuildEvidenceRequest } from "./build-evidence-contract.js";
import { readGitBlobs, readGitTree, type GitTreeEntry } from "./git-objects.js";

/**
 * Byte admission for a build-evidence manifest that already passed the strict wire parser.
 *
 * Authored originals come from regular blobs of the pinned Git revision, never from the payload. Every
 * other artifact is read from the payload root through a held directory descriptor: each component is
 * opened with O_DIRECTORY|O_NOFOLLOW and each leaf with O_NOFOLLOW, so a swapped or planted symlink can
 * never redirect a read (there is no realpath-then-open window). Node has no openat, so a child of a held
 * descriptor is addressed as `/proc/self/fd/<fd>/<name>`; this is the supported Linux host contract.
 * Verified bytes are copied into scratch owned by this call and nothing else is ever written or deleted.
 */

export type ArtifactRejection = {
  readonly artifactId: string;
  /** Fixed sentence: never a path, hash or manifest value. */
  readonly reason: string;
  /** Every compilation that references the artifact directly, through lineage, or through an upstream compilation. */
  readonly compilationIds: readonly string[];
};

export type FrozenSourceRoot = {
  readonly rootId: string;
  /** Private compiler layout: members sit at their member-relative paths, nothing else is present. */
  readonly path: string;
  readonly memberIds: readonly string[];
};

export type FrozenBuildArtifacts = {
  readonly available: ReadonlyMap<string, { artifact: BuildArtifact; path: string }>;
  readonly rejected: readonly ArtifactRejection[];
  /** Compilation id to verified roots. Compilations degraded by a rejection have no entry. */
  readonly sourceRoots: ReadonlyMap<string, readonly FrozenSourceRoot[]>;
};

type Available = Extract<BuildArtifact, { availability: "available" }>;
type AvailableDirectory = Extract<Available, { kind: "directory" }>;
type Item = { artifact: Available; dest: string };
type Capture = { signal: AbortSignal | undefined; chunk: Buffer };
type PathClaim = { owner: string; path: string; identity?: string; directory?: boolean };

const REASON = {
  gitRevision: "pinned Git revision could not be read",
  gitObject: "pinned Git object could not be read",
  gitMissing: "authored path is absent from the pinned Git revision",
  gitNonRegular: "authored path is not a regular Git blob",
  gitMismatch: "authored size or hash differs from the pinned Git blob",
  authoredLocation: "authored content must be read from the pinned Git revision",
  payloadLocation: "non-authored content must be read from the payload root",
  payloadRoot: "payload root is unavailable",
  unsafe: "artifact path is not a contained relative path",
  missing: "payload path is missing",
  symlink: "payload path crosses a symlink or non-directory",
  nonRegular: "payload member is not a regular file",
  mismatch: "payload size or hash differs from the manifest",
  changed: "payload changed while it was being captured",
  inventory: "payload directory members differ from the manifest inventory",
  collision: "artifact path collides with another by prefix, case or normalization",
  claims: "payload path carries conflicting size or hash claims",
  unreadable: "payload path could not be read",
} as const;

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants;
const DIRECTORY = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
// O_NONBLOCK keeps a planted FIFO from hanging the open; the fstat afterwards still demands a regular file.
const LEAF = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const CHUNK = 256 * 1024;
// Memory/transport safeguard for one `git cat-file --batch`, not a limit on how many artifacts are admitted.
const BATCH_BYTES = 16 * 1024 * 1024;
const REGULAR_GIT_MODES = ["100644", "100755"];
const RESOURCE_ERRORS = ["EMFILE", "ENFILE", "ENOMEM", "ENOSPC", "EDQUOT"];

/** A fixed-reason artifact rejection raised inside a capture. */
class Rejection extends Error {
  constructor(readonly reason: string) { super(reason); }
}

function reasonFor(error: unknown): string {
  if (error instanceof Rejection) return error.reason;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return REASON.missing;
  if (code === "ENOTDIR" || code === "ELOOP") return REASON.symlink;
  if (code === "ENXIO") return REASON.nonRegular;
  // Other errno failures are this artifact's problem; host exhaustion and programming errors are not.
  if (typeof code === "string" && /^E[A-Z]+$/.test(code) && !RESOURCE_ERRORS.includes(code)) return REASON.unreadable;
  throw error;
}

/** Normalized relative path components, or null when any component could leave or alias the containing directory. */
function components(path: string): string[] | null {
  if (/\p{Cs}/u.test(path)) return null;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0") && !part.includes("\\")) ? parts : null;
}

/**
 * Artifacts whose paths cannot coexist: spelled differently but equal after NFC and case folding, one path
 * claimed with different size/hash, or a file that is also the parent of another path. Returns owner -> reason.
 */
function conflicts(claims: readonly PathClaim[]): Map<string, string> {
  // ponytail: NFC + lowercase approximates case folding; exotic folds (e.g. sharp s) are not unified.
  const fold = (path: string) => path.normalize("NFC").toLowerCase();
  const bad = new Map<string, string>();
  const flag = (owners: Iterable<string>, reason: string) => {
    for (const owner of owners) if (!bad.has(owner)) bad.set(owner, reason);
  };
  const files = new Map<string, { spellings: Set<string>; identities: Set<string>; owners: Set<string> }>();
  for (const claim of claims) {
    if (claim.directory) continue;
    const key = fold(claim.path);
    const entry = files.get(key) ?? { spellings: new Set<string>(), identities: new Set<string>(), owners: new Set<string>() };
    entry.spellings.add(claim.path);
    entry.identities.add(claim.identity ?? "");
    entry.owners.add(claim.owner);
    files.set(key, entry);
  }
  for (const entry of files.values()) {
    if (entry.spellings.size > 1) flag(entry.owners, REASON.collision);
    else if (entry.identities.size > 1) flag(entry.owners, REASON.claims);
  }
  for (const claim of claims) {
    const key = fold(claim.path);
    const parents = [claim.directory ? key : null];
    for (let at = key.indexOf("/"); at >= 0; at = key.indexOf("/", at + 1)) parents.push(key.slice(0, at));
    for (const parent of parents) {
      const file = parent === null ? undefined : files.get(parent);
      if (!file) continue;
      flag(file.owners, REASON.collision);
      flag([claim.owner], REASON.collision);
    }
  }
  return bad;
}

const under = (dir: FileHandle, name?: string) => `/proc/self/fd/${dir.fd}${name === undefined ? "" : `/${name}`}`;

/** Opens `parts` below `root`: every intermediate component must be a real directory, the last uses `last` flags. */
async function openBelow(root: FileHandle, parts: readonly string[], last: number): Promise<FileHandle> {
  let parent = root;
  try {
    for (const name of parts.slice(0, -1)) {
      const next = await open(under(parent, name), DIRECTORY);
      if (parent !== root) await parent.close();
      parent = next;
    }
    return await open(under(parent, parts[parts.length - 1]!), last);
  } finally {
    if (parent !== root) await parent.close();
  }
}

/** Streams a regular file into a new private copy while hashing; any mismatch removes the copy. */
async function copyVerified(source: FileHandle, destination: string, expected: { sha256: string; sizeBytes: number }, ctx: Capture): Promise<void> {
  const before = await source.stat({ bigint: true });
  if (!before.isFile()) throw new Rejection(REASON.nonRegular);
  if (before.size !== BigInt(expected.sizeBytes)) throw new Rejection(REASON.mismatch);
  const out = await open(destination, "wx", 0o400);
  let complete = false;
  try {
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      ctx.signal?.throwIfAborted();
      const { bytesRead } = await source.read(ctx.chunk, 0, ctx.chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.sizeBytes) throw new Rejection(REASON.mismatch);
      hash.update(ctx.chunk.subarray(0, bytesRead));
      for (let at = 0; at < bytesRead;) at += (await out.write(ctx.chunk, at, bytesRead - at)).bytesWritten;
    }
    const after = await source.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Rejection(REASON.changed);
    if (total !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) throw new Rejection(REASON.mismatch);
    complete = true;
  } finally {
    await out.close();
    if (!complete) await rm(destination, { force: true });
  }
}

/**
 * Copies a pinned directory in one walk below its held descriptor. Every actual member must be listed (a
 * symlink, special file or unlisted file rejects the directory) and every listed member must exist.
 */
async function captureDirectory(root: FileHandle, item: AvailableDirectory, destination: string, ctx: Capture): Promise<void> {
  const members = new Map(item.entries.map((entry): [string, typeof entry] => [entry.path, entry]));
  const parents = new Set<string>();
  for (const path of members.keys()) for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) parents.add(path.slice(0, at));
  const seen = new Set<string>();
  const walk = async (dir: FileHandle, prefix: string): Promise<void> => {
    for (const entry of await readdir(under(dir), { withFileTypes: true })) {
      ctx.signal?.throwIfAborted();
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Rejection(REASON.symlink);
      if (entry.isDirectory()) {
        const child = await open(under(dir, entry.name), DIRECTORY);
        try {
          if (parents.has(path)) {
            await mkdir(join(destination, path), { mode: 0o700 });
            await walk(child, `${path}/`);
          } else if ((await readdir(under(child))).length > 0) {
            throw new Rejection(REASON.inventory);
          }
        } finally {
          await child.close();
        }
      } else if (entry.isFile()) {
        const expected = members.get(path);
        if (!expected) throw new Rejection(REASON.inventory);
        const leaf = await open(under(dir, entry.name), LEAF);
        try {
          await copyVerified(leaf, join(destination, path), expected, ctx);
        } finally {
          await leaf.close();
        }
        seen.add(path);
      } else {
        throw new Rejection(REASON.nonRegular);
      }
    }
  };
  const top = await openBelow(root, components(item.location.path)!, DIRECTORY);
  try {
    await mkdir(destination, { mode: 0o700 });
    await walk(top, "");
    if (seen.size !== members.size) throw new Rejection(REASON.inventory);
  } finally {
    await top.close();
  }
}

/** Reads blobs together; if the batch fails, retries one by one so a single bad object only rejects itself. */
async function readBlobs(repo: string, entries: readonly GitTreeEntry[], signal: AbortSignal | undefined): Promise<Map<string, Buffer | null>> {
  const attempt = async (group: readonly GitTreeEntry[]) => {
    try { return await readGitBlobs(repo, group, signal); }
    catch (error) { signal?.throwIfAborted(); return null; }
  };
  const together = await attempt(entries);
  if (together) return together;
  if (entries.length === 1) return new Map<string, Buffer | null>([[entries[0]!.path, null]]);
  const result = new Map<string, Buffer | null>();
  for (const entry of entries) result.set(entry.path, (await attempt([entry]))?.get(entry.path) ?? null);
  return result;
}

async function admitAuthored(
  request: BuildEvidenceRequest, authored: readonly Item[], reject: (id: string, reason: string) => void,
  stored: Map<string, string>, ctx: Capture,
): Promise<void> {
  let tree: Map<string, GitTreeEntry>;
  try {
    tree = new Map((await readGitTree(request.repo, request.revision, ctx.signal)).map((entry): [string, GitTreeEntry] => [entry.path, entry]));
  } catch (error) {
    ctx.signal?.throwIfAborted();
    for (const { artifact } of authored) reject(artifact.id, REASON.gitRevision);
    return;
  }
  const batches: Array<Array<{ item: Item; entry: GitTreeEntry; file: Extract<Available, { kind: "file" }> }>> = [[]];
  let batchBytes = 0;
  for (const item of authored) {
    const file = item.artifact as Extract<Available, { kind: "file" }>;
    const entry = tree.get(file.content.location.path);
    if (!entry) reject(file.id, REASON.gitMissing);
    else if (!REGULAR_GIT_MODES.includes(entry.mode)) reject(file.id, REASON.gitNonRegular);
    else {
      if (batchBytes > 0 && batchBytes + file.content.sizeBytes > BATCH_BYTES) { batches.push([]); batchBytes = 0; }
      batches[batches.length - 1]!.push({ item, entry, file });
      batchBytes += file.content.sizeBytes;
    }
  }
  for (const batch of batches) {
    if (batch.length === 0) continue;
    const blobs = await readBlobs(request.repo, batch.map(({ entry }) => entry), ctx.signal);
    for (const { item, entry, file } of batch) {
      ctx.signal?.throwIfAborted();
      const bytes = blobs.get(entry.path);
      if (!bytes) reject(file.id, REASON.gitObject);
      else if (bytes.length !== file.content.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.content.sha256) {
        reject(file.id, REASON.gitMismatch);
      } else {
        await writeFile(item.dest, bytes, { flag: "wx", mode: 0o400 });
        stored.set(file.id, item.dest);
      }
    }
  }
}

async function admitPayload(
  request: BuildEvidenceRequest, payload: readonly Item[], reject: (id: string, reason: string) => void,
  stored: Map<string, string>, ctx: Capture,
): Promise<void> {
  let root: FileHandle;
  try {
    if (!request.pin) throw new Rejection(REASON.payloadRoot);
    root = await open(request.pin.payloadRoot, O_RDONLY | O_DIRECTORY);
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (!(error instanceof Rejection) && (typeof code !== "string" || RESOURCE_ERRORS.includes(code))) throw error;
    for (const { artifact } of payload) reject(artifact.id, REASON.payloadRoot);
    return;
  }
  try {
    // Without /proc/self/fd the held-descriptor reads cannot be made; fail loudly instead of rejecting every artifact.
    await access(under(root)).catch(() => { throw new Error("Contained payload reads require /proc/self/fd (Linux)"); });
    for (const { artifact, dest } of payload) {
      ctx.signal?.throwIfAborted();
      try {
        if (artifact.kind === "file") {
          const leaf = await openBelow(root, components(artifact.content.location.path)!, LEAF);
          try { await copyVerified(leaf, dest, artifact.content, ctx); } finally { await leaf.close(); }
        } else {
          await captureDirectory(root, artifact, dest, ctx);
        }
        stored.set(artifact.id, dest);
      } catch (error) {
        ctx.signal?.throwIfAborted();
        reject(artifact.id, reasonFor(error));
        await rm(dest, { recursive: true, force: true });
      }
    }
  } finally {
    await root.close();
  }
}

/** Maps an artifact to the compilations it degrades: references, transformation lineage, then upstream consumers. */
function scopeResolver(manifest: BuildEvidenceManifest): (artifactId: string) => string[] {
  const lineage = new Map<string, string[]>();
  for (const transformation of manifest.transformations) {
    for (const output of transformation.outputArtifactIds) lineage.set(output, [...(lineage.get(output) ?? []), ...transformation.inputArtifactIds]);
  }
  const reaches = new Map<string, Set<string>>();
  const consumers = new Map<string, string[]>();
  for (const compilation of manifest.compilations) {
    const options = compilation.compiler.moduleOptions;
    const pathSets = [compilation.compileClasspath, compilation.modulePath, compilation.processorPath,
      ...(options ? [options.sourcePath, options.bootClasspath, ...(options.patchModules ?? []).map((patch) => patch.path)] : [])];
    const pending = [
      ...compilation.inputArtifactIds, ...compilation.sourceRoots.flatMap((root) => root.members.map((member) => member.artifactId)),
      ...compilation.authoredArtifactIds, ...compilation.resourceArtifactIds, ...compilation.outputArtifactIds,
    ];
    for (const entry of pathSets.flatMap((set) => set.entries)) {
      pending.push(entry.artifactId);
      if (entry.upstreamCompilationId !== null) consumers.set(entry.upstreamCompilationId, [...(consumers.get(entry.upstreamCompilationId) ?? []), compilation.id]);
    }
    const seen = new Set<string>();
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(lineage.get(id) ?? []));
    }
    reaches.set(compilation.id, seen);
  }
  return (artifactId) => {
    const affected = new Set(manifest.compilations.filter((compilation) => reaches.get(compilation.id)!.has(artifactId)).map((compilation) => compilation.id));
    // A Set iteration also visits entries added meanwhile, so this walks the whole upstream-consumer closure.
    for (const id of affected) for (const consumer of consumers.get(id) ?? []) affected.add(consumer);
    return manifest.compilations.filter((compilation) => affected.has(compilation.id)).map((compilation) => compilation.id);
  };
}

async function admit(request: BuildEvidenceRequest, manifest: BuildEvidenceManifest, scratch: string, ctx: Capture): Promise<FrozenBuildArtifacts> {
  await mkdir(join(scratch, "artifacts"), { mode: 0o700 });
  const items = manifest.artifacts.flatMap((artifact, index): Item[] =>
    artifact.availability === "available" ? [{ artifact, dest: join(scratch, "artifacts", String(index)) }] : []);
  const reasons = new Map<string, string>();
  const reject = (id: string, reason: string) => { if (!reasons.has(id)) reasons.set(id, reason); };
  const stored = new Map<string, string>();

  // Static rules first: where each artifact's bytes may come from, and whether its paths are contained.
  for (const { artifact } of items) {
    if (artifact.origin === "authored") {
      if (artifact.kind !== "file" || artifact.content.location.kind !== "repository" || artifact.content.location.path !== artifact.repositoryPath) {
        reject(artifact.id, REASON.authoredLocation);
      } else if (!components(artifact.content.location.path)) {
        reject(artifact.id, REASON.unsafe);
      }
    } else if (artifact.kind === "file") {
      if (artifact.content.location.kind !== "payload") reject(artifact.id, REASON.payloadLocation);
      else if (!components(artifact.content.location.path)) reject(artifact.id, REASON.unsafe);
    } else if (!components(artifact.location.path) || artifact.entries.some((entry) => !components(entry.path))) {
      reject(artifact.id, REASON.unsafe);
    }
  }
  const claims: PathClaim[] = [];
  for (const { artifact } of items) {
    if (reasons.has(artifact.id) || artifact.origin === "authored") continue;
    if (artifact.kind === "file") {
      claims.push({ owner: artifact.id, path: artifact.content.location.path, identity: `${artifact.content.sha256}:${artifact.content.sizeBytes}` });
      continue;
    }
    claims.push({ owner: artifact.id, path: artifact.location.path, directory: true });
    for (const entry of artifact.entries) {
      claims.push({ owner: artifact.id, path: `${artifact.location.path}/${entry.path}`, identity: `${entry.sha256}:${entry.sizeBytes}` });
    }
  }
  for (const [owner, reason] of conflicts(claims)) reject(owner, reason);
  const placed = new Set(items.filter(({ artifact }) => !reasons.has(artifact.id)).map(({ artifact }) => artifact.id));
  for (const compilation of manifest.compilations) {
    for (const root of compilation.sourceRoots) {
      const layout: PathClaim[] = [];
      for (const member of root.members) {
        if (!placed.has(member.artifactId) || reasons.has(member.artifactId)) continue;
        if (components(member.relativePath)) layout.push({ owner: member.artifactId, path: member.relativePath, identity: member.artifactId });
        else reject(member.artifactId, REASON.unsafe);
      }
      for (const owner of conflicts(layout).keys()) reject(owner, REASON.collision);
    }
  }

  ctx.signal?.throwIfAborted();
  const candidates = items.filter(({ artifact }) => !reasons.has(artifact.id));
  const authored = candidates.filter(({ artifact }) => artifact.origin === "authored");
  if (authored.length > 0) await admitAuthored(request, authored, reject, stored, ctx);
  const payload = candidates.filter(({ artifact }) => artifact.origin !== "authored");
  if (payload.length > 0) await admitPayload(request, payload, reject, stored, ctx);

  const scopesOf = scopeResolver(manifest);
  const rejected = manifest.artifacts.filter((artifact) => reasons.has(artifact.id))
    .map((artifact): ArtifactRejection => ({ artifactId: artifact.id, reason: reasons.get(artifact.id)!, compilationIds: scopesOf(artifact.id) }));
  const degraded = new Set(rejected.flatMap((entry) => entry.compilationIds));
  const available = new Map<string, { artifact: BuildArtifact; path: string }>();
  for (const { artifact } of items) {
    const path = stored.get(artifact.id);
    if (path !== undefined && !reasons.has(artifact.id)) available.set(artifact.id, { artifact, path });
  }

  // Source roots are rebuilt from explicit verified members only; a degraded compilation publishes none.
  const sourceRoots = new Map<string, readonly FrozenSourceRoot[]>();
  for (const [compilationIndex, compilation] of manifest.compilations.entries()) {
    if (degraded.has(compilation.id)) continue;
    const roots: FrozenSourceRoot[] = [];
    for (const [rootIndex, root] of compilation.sourceRoots.entries()) {
      const path = join(scratch, "roots", String(compilationIndex), String(rootIndex));
      await mkdir(path, { recursive: true, mode: 0o700 });
      const memberIds: string[] = [];
      for (const member of root.members) {
        ctx.signal?.throwIfAborted();
        const source = available.get(member.artifactId);
        if (source?.artifact.kind !== "file") continue;
        const target = join(path, member.relativePath);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(source.path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        memberIds.push(member.artifactId);
      }
      roots.push({ rootId: root.id, path, memberIds });
    }
    sourceRoots.set(compilation.id, roots);
  }
  return { available, rejected, sourceRoots };
}

/**
 * Admits and freezes every available artifact of one manifest. Failures reject the artifact (with every
 * scope that depends on it) and never the rest; cancellation or an unexpected host failure removes the
 * scratch created here and publishes nothing.
 */
export async function freezeBuildArtifacts(request: BuildEvidenceRequest, manifest: BuildEvidenceManifest): Promise<FrozenBuildArtifacts> {
  const signal = request.signal;
  signal?.throwIfAborted();
  await mkdir(request.runtimeDir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(request.runtimeDir, "build-artifacts-"));
  try {
    return await admit(request, manifest, scratch, { signal, chunk: Buffer.allocUnsafe(CHUNK) });
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
