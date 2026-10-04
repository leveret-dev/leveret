import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, open, readdir, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuildArtifact, BuildCompilation, BuildEvidenceManifest, BuildEvidenceRequest } from "./build-evidence-contract.js";
import { GitObjectError, readGitBlobs, readGitTree, type GitTreeEntry } from "./git-objects.js";

/**
 * Byte admission for a build-evidence manifest that already passed the strict wire parser.
 *
 * Authored originals come from regular blobs of the pinned Git revision, never from the payload. Every
 * other artifact is read from the payload root through a held directory descriptor: each component is
 * opened with O_DIRECTORY|O_NOFOLLOW and each leaf with O_NOFOLLOW, so a swapped or planted symlink can
 * never redirect a read (there is no realpath-then-open window). Node has no openat, so a child of a held
 * descriptor is addressed as `/proc/self/fd/<fd>/<name>`; this is the supported Linux host contract.
 * Verified bytes are copied into scratch owned by this call and nothing else is ever written or deleted.
 *
 * Failures are classified by the operation that raised them. A fault of the named source (a missing or
 * unlistable payload path, a symlink, a Git object that does not match) rejects that artifact and the scopes
 * that depend on it. A fault of the host (descriptor or memory exhaustion, a Git process that cannot run, a
 * scratch directory that cannot be written) is not the artifact's fault and rejects the whole call.
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
  /** Private directory that holds every path above. The caller that consumes the result releases it; nothing here removes it after success. */
  readonly scratch: string;
};

type Available = Extract<BuildArtifact, { availability: "available" }>;
type AvailableFile = Extract<Available, { kind: "file" }>;
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
  tooLong: "artifact path is too long for the private copy",
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

/** A source-root member whose manifest-chosen relative path cannot be laid out in the private scratch. */
class LayoutFault extends Error {
  constructor(readonly artifactId: string) { super(REASON.tooLong); }
}

const errnoOf = (error: unknown): string | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** Faults of the named source: the artifact is rejected. Host failures, aborts and bugs keep propagating. */
function sourceFault(error: unknown): never {
  if (error instanceof Rejection) throw error;
  const code = errnoOf(error);
  if (code === "ENOENT") throw new Rejection(REASON.missing);
  if (code === "ENOTDIR" || code === "ELOOP") throw new Rejection(REASON.symlink);
  if (code === "ENXIO") throw new Rejection(REASON.nonRegular);
  if (code !== undefined && /^E[A-Z0-9]+$/.test(code) && !RESOURCE_ERRORS.includes(code)) throw new Rejection(REASON.unreadable);
  throw error;
}

/** Awaits an operation on the manifest-named source, mapping its faults to artifact rejections. */
async function fromSource<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; } catch (error) { return sourceFault(error); }
}

/**
 * Awaits a write whose destination name was chosen by the manifest (a directory member or a source-root
 * member). Only a name too long for the host filesystem is the manifest's fault; any other failure writing
 * scratch stays a host failure.
 */
async function fromLayout<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; } catch (error) {
    throw errnoOf(error) === "ENAMETOOLONG" ? new Rejection(REASON.tooLong) : error;
  }
}

/** Failures that are about the pinned Git content rather than the host: bad revision, object, path or encoding. */
const isGitContentFault = (error: unknown): boolean =>
  error instanceof GitObjectError || (error instanceof TypeError && errnoOf(error) === "ERR_ENCODING_INVALID_ENCODED_DATA");

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
      const next = await fromSource(open(under(parent, name), DIRECTORY));
      if (parent !== root) await parent.close();
      parent = next;
    }
    return await fromSource(open(under(parent, parts[parts.length - 1]!), last));
  } finally {
    if (parent !== root) await parent.close();
  }
}

/** Streams a regular file into a new private copy while hashing; any mismatch removes the copy. */
async function copyVerified(source: FileHandle, destination: string, expected: { sha256: string; sizeBytes: number }, ctx: Capture): Promise<void> {
  const before = await fromSource(source.stat({ bigint: true }));
  if (!before.isFile()) throw new Rejection(REASON.nonRegular);
  if (before.size !== BigInt(expected.sizeBytes)) throw new Rejection(REASON.mismatch);
  const out = await open(destination, "wx", 0o400);
  let complete = false;
  try {
    const hash = createHash("sha256");
    let total = 0;
    for (;;) {
      ctx.signal?.throwIfAborted();
      const { bytesRead } = await fromSource(source.read(ctx.chunk, 0, ctx.chunk.length, null));
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.sizeBytes) throw new Rejection(REASON.mismatch);
      hash.update(ctx.chunk.subarray(0, bytesRead));
      for (let at = 0; at < bytesRead;) at += (await out.write(ctx.chunk, at, bytesRead - at)).bytesWritten;
    }
    const after = await fromSource(source.stat({ bigint: true }));
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
    for (const entry of await fromSource(readdir(under(dir), { withFileTypes: true }))) {
      ctx.signal?.throwIfAborted();
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Rejection(REASON.symlink);
      if (entry.isDirectory()) {
        const child = await fromSource(open(under(dir, entry.name), DIRECTORY));
        try {
          if (parents.has(path)) {
            await fromLayout(mkdir(join(destination, path), { mode: 0o700 }));
            await walk(child, `${path}/`);
          } else if ((await fromSource(readdir(under(child)))).length > 0) {
            throw new Rejection(REASON.inventory);
          }
        } finally {
          await child.close();
        }
      } else if (entry.isFile()) {
        const expected = members.get(path);
        if (!expected) throw new Rejection(REASON.inventory);
        const leaf = await fromSource(open(under(dir, entry.name), LEAF));
        try {
          await fromLayout(copyVerified(leaf, join(destination, path), expected, ctx));
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

/**
 * Reads blobs together; if the batch fails on its content, retries one by one so a single bad object only
 * rejects itself. Anything that is not a content fault (a Git process that cannot run, exhaustion) propagates.
 */
async function readBlobs(repo: string, entries: readonly GitTreeEntry[], signal: AbortSignal | undefined): Promise<Map<string, Buffer | null>> {
  const attempt = async (group: readonly GitTreeEntry[]) => {
    try { return await readGitBlobs(repo, group, signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (!isGitContentFault(error)) throw error;
      return null;
    }
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
    if (!isGitContentFault(error)) throw error;
    for (const { artifact } of authored) reject(artifact.id, REASON.gitRevision);
    return;
  }
  const batches: Array<Array<{ item: Item; entry: GitTreeEntry; file: AvailableFile }>> = [[]];
  let batchBytes = 0;
  for (const item of authored) {
    const file = item.artifact as AvailableFile;
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
    const code = errnoOf(error);
    if (!(error instanceof Rejection) && (code === undefined || RESOURCE_ERRORS.includes(code))) throw error;
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
        if (!(error instanceof Rejection)) throw error;
        reject(artifact.id, error.reason);
        await rm(dest, { recursive: true, force: true });
      }
    }
  } finally {
    await root.close();
  }
}

/** Every artifact id a compilation names directly (inputs, root members, original/resource/output lists, path sets). */
function forEachReference(compilation: BuildCompilation, visit: (artifactId: string, upstreamCompilationId: string | null) => void): void {
  for (const id of compilation.inputArtifactIds) visit(id, null);
  for (const root of compilation.sourceRoots) for (const member of root.members) visit(member.artifactId, null);
  for (const id of compilation.authoredArtifactIds) visit(id, null);
  for (const id of compilation.resourceArtifactIds) visit(id, null);
  for (const id of compilation.outputArtifactIds) visit(id, null);
  const options = compilation.compiler.moduleOptions;
  const pathSets = [compilation.compileClasspath, compilation.modulePath, compilation.processorPath,
    ...(options ? [options.sourcePath, options.bootClasspath, ...(options.patchModules ?? []).map((patch) => patch.path)] : [])];
  for (const set of pathSets) for (const entry of set.entries) visit(entry.artifactId, entry.upstreamCompilationId);
}

/**
 * Maps an artifact to the compilations it degrades: direct references, transformation lineage (an output
 * is only as good as its inputs), then every consumer of an upstream compilation. The graph is built on
 * first use, so an admission without rejections never pays for it; each transformation is expanded once
 * per compilation however many inputs and outputs it lists. Exported so consumer-side withholding reuses
 * this one traversal instead of walking the graph again.
 */
export function scopeResolver(manifest: Pick<BuildEvidenceManifest, "compilations" | "transformations">): (artifactId: string) => string[] {
  let graph: { reaches: Map<string, Set<string>>; consumers: Map<string, string[]> } | undefined;
  const build = () => {
    const producers = new Map<string, number[]>();
    manifest.transformations.forEach((transformation, index) => {
      for (const output of transformation.outputArtifactIds) {
        const list = producers.get(output);
        if (list) list.push(index); else producers.set(output, [index]);
      }
    });
    const reaches = new Map<string, Set<string>>();
    const consumers = new Map<string, string[]>();
    for (const compilation of manifest.compilations) {
      const seen = new Set<string>();
      const expanded = new Set<number>();
      const pending: string[] = [];
      const reach = (artifactId: string) => { if (!seen.has(artifactId)) { seen.add(artifactId); pending.push(artifactId); } };
      forEachReference(compilation, (artifactId, upstream) => {
        reach(artifactId);
        if (upstream === null) return;
        const list = consumers.get(upstream);
        if (list) list.push(compilation.id); else consumers.set(upstream, [compilation.id]);
      });
      for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
        for (const index of producers.get(id) ?? []) {
          if (expanded.has(index)) continue;
          expanded.add(index);
          for (const input of manifest.transformations[index]!.inputArtifactIds) reach(input);
        }
      }
      reaches.set(compilation.id, seen);
    }
    return { reaches, consumers };
  };
  const memo = new Map<string, string[]>();
  return (artifactId) => {
    const known = memo.get(artifactId);
    if (known) return known;
    graph ??= build();
    const affected = new Set(manifest.compilations.filter((compilation) => graph!.reaches.get(compilation.id)!.has(artifactId)).map((compilation) => compilation.id));
    // A Set iteration also visits entries added meanwhile, so this walks the whole upstream-consumer closure.
    for (const id of affected) for (const consumer of graph.consumers.get(id) ?? []) affected.add(consumer);
    const scopes = manifest.compilations.filter((compilation) => affected.has(compilation.id)).map((compilation) => compilation.id);
    memo.set(artifactId, scopes);
    return scopes;
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

  // Source roots are rebuilt from explicit verified members only. A member whose manifest-chosen relative path
  // cannot be laid out is itself rejected, which can degrade more compilations, so the layout repeats until
  // every undegraded compilation has its roots and every degraded one has none.
  const scopesOf = scopeResolver(manifest);
  const kinds = new Map(manifest.artifacts.map((artifact): [string, BuildArtifact["kind"]] => [artifact.id, artifact.kind]));
  const built = new Map<string, { index: number; roots: FrozenSourceRoot[] }>();
  const rootsDir = (index: number) => join(scratch, "roots", String(index));
  const layoutRoots = async (compilation: BuildCompilation, index: number): Promise<FrozenSourceRoot[]> => {
    const roots: FrozenSourceRoot[] = [];
    for (const [rootIndex, root] of compilation.sourceRoots.entries()) {
      const path = join(rootsDir(index), String(rootIndex));
      await mkdir(path, { recursive: true, mode: 0o700 });
      const memberIds: string[] = [];
      for (const member of root.members) {
        ctx.signal?.throwIfAborted();
        const source = reasons.has(member.artifactId) ? undefined : stored.get(member.artifactId);
        if (source === undefined || kinds.get(member.artifactId) !== "file") continue;
        const target = join(path, member.relativePath);
        try {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        } catch (error) {
          throw errnoOf(error) === "ENAMETOOLONG" ? new LayoutFault(member.artifactId) : error;
        }
        memberIds.push(member.artifactId);
      }
      roots.push({ rootId: root.id, path, memberIds });
    }
    return roots;
  };
  for (;;) {
    const degraded = new Set<string>();
    for (const id of reasons.keys()) for (const scope of scopesOf(id)) degraded.add(scope);
    for (const [id, { index }] of [...built]) {
      if (!degraded.has(id)) continue;
      await rm(rootsDir(index), { recursive: true, force: true });
      built.delete(id);
    }
    let laidOut = true;
    for (const [index, compilation] of manifest.compilations.entries()) {
      if (degraded.has(compilation.id) || built.has(compilation.id)) continue;
      try {
        built.set(compilation.id, { index, roots: await layoutRoots(compilation, index) });
      } catch (error) {
        if (!(error instanceof LayoutFault)) throw error;
        reject(error.artifactId, REASON.tooLong);
        await rm(rootsDir(index), { recursive: true, force: true });
        await rm(stored.get(error.artifactId)!, { force: true });
        laidOut = false;
        break;
      }
    }
    if (laidOut) break;
  }

  const rejected = manifest.artifacts.filter((artifact) => reasons.has(artifact.id))
    .map((artifact): ArtifactRejection => ({ artifactId: artifact.id, reason: reasons.get(artifact.id)!, compilationIds: scopesOf(artifact.id) }));
  const available = new Map<string, { artifact: BuildArtifact; path: string }>();
  for (const { artifact } of items) {
    const path = stored.get(artifact.id);
    if (path !== undefined && !reasons.has(artifact.id)) available.set(artifact.id, { artifact, path });
  }
  const sourceRoots = new Map<string, readonly FrozenSourceRoot[]>();
  for (const compilation of manifest.compilations) {
    const frozen = built.get(compilation.id);
    if (frozen) sourceRoots.set(compilation.id, frozen.roots);
  }
  return { available, rejected, sourceRoots, scratch };
}

/**
 * Admits and freezes every available artifact of one manifest. Failures of an artifact reject it (with every
 * scope that depends on it) and never the rest; cancellation or a host failure removes the scratch created
 * here, rejects the call and publishes nothing.
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
