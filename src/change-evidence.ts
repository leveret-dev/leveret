import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { run, safeChildEnvironment, type ExecResult } from "./exec.js";
import { pathIsInside } from "./path.js";

export const CHANGE_EVIDENCE_SCHEMA_VERSION = 1;
export const MAX_PATCH_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_PATCH_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 20;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

export type ChangeStatus = "add" | "modify" | "delete" | "rename" | "copy";

export interface ChangeHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangeSide {
  exists: boolean;
  oid: string | null;
  mode: string | null;
  bytes: number | null;
  type: "missing" | "text" | "binary" | "symlink" | "submodule";
}

export interface ChangeFile {
  path: string;
  oldPath: string;
  newPath: string;
  status: ChangeStatus;
  similarity: number | null;
  language: string | null;
  binary: boolean;
  lines: { added: number | null; deleted: number | null };
  old: ChangeSide;
  new: ChangeSide;
  truncated: boolean;
  hunks: ChangeHunk[];
  errors: string[];
}

export interface ChangeManifest {
  schema: typeof CHANGE_EVIDENCE_SCHEMA_VERSION;
  base: string;
  head: string;
  range: string;
  files: ChangeFile[];
  truncated: boolean;
  errors: string[];
}

export interface ManifestEvidenceResponse {
  kind: "manifest";
  manifest: ChangeManifest;
  modelBytes: number;
  auditBytes: 0;
  omittedBytes: 0;
  unknownOmittedBytes: false;
  returned: Array<{ path: string; hunks: number[] }>;
  omitted: Array<{ path: string; hunks: number[]; reason: string; bytes: number | null }>;
  nextCursor: null;
  complete: boolean;
  truncated: boolean;
  errors: string[];
}

export interface PatchEvidenceRequest {
  kind: "patch";
  paths: string[];
  context?: number;
  hunk?: number;
  range?: { start: number; end: number };
  byteBudget?: number;
  cursor?: string;
}

export interface PatchEvidenceResponse {
  kind: "patch";
  base: string;
  head: string;
  modelBytes: number;
  auditBytes: number;
  omittedBytes: number;
  unknownOmittedBytes: boolean;
  returned: Array<{
    path: string;
    hunks: number[];
    byteStart: number;
    byteEnd: number;
    bytes: number;
    complete: boolean;
    patch: string;
  }>;
  omitted: Array<{ path: string; hunks: number[]; reason: string; bytes: number | null }>;
  nextCursor: string | null;
  complete: boolean;
  truncated: boolean;
  errors: string[];
}

export type ChangeEvidenceRequest = { kind: "manifest" } | PatchEvidenceRequest;
export type ChangeEvidenceResponse = ManifestEvidenceResponse | PatchEvidenceResponse;

export interface ChangeEvidence {
  manifest: ChangeManifest;
  retrieve(request: ChangeEvidenceRequest): Promise<ChangeEvidenceResponse>;
  auditPatch(context?: number): Promise<{ patch: string; bytes: number; sha256: string }>;
}

interface RawEntry {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: string;
  score: string;
  oldPath: string;
  newPath: string;
}

interface NumstatEntry {
  oldPath: string;
  newPath: string;
  added: number | null;
  deleted: number | null;
  binary: boolean;
}

interface PatchItem {
  path: string;
  hunks: number[];
  patch: Buffer;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C", ".cc": "C++", ".cpp": "C++", ".cs": "C#", ".css": "CSS",
  ".go": "Go", ".h": "C", ".hpp": "C++", ".html": "HTML", ".java": "Java",
  ".js": "JavaScript", ".jsx": "JavaScript", ".json": "JSON", ".kt": "Kotlin",
  ".md": "Markdown", ".php": "PHP", ".py": "Python", ".rb": "Ruby", ".rs": "Rust",
  ".sh": "Shell", ".sql": "SQL", ".swift": "Swift", ".ts": "TypeScript",
  ".tsx": "TypeScript", ".vue": "Vue", ".xml": "XML", ".yaml": "YAML", ".yml": "YAML",
};

function comparePath(a: ChangeFile, b: ChangeFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function gitError(label: string, result: ExecResult): string {
  const detail = result.stderr.trim().slice(0, 500);
  return `${label} failed${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}: ${detail || `exit ${result.code}`}`;
}

async function git(repo: string, args: string[], maxBuffer = GIT_OUTPUT_LIMIT) {
  return run("git", args, repo, { timeoutMs: 120_000, env: safeChildEnvironment(), maxBuffer });
}

async function commit(repo: string, ref: string): Promise<string> {
  const result = await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`cannot resolve commit ${ref}: ${result.stderr.slice(0, 500)}`);
  return sha;
}

async function checkoutRoot(repo: string): Promise<string> {
  const canonicalRepo = await realpath(repo);
  const result = await git(canonicalRepo, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new Error(gitError("git checkout root", result));
  const root = await realpath(result.stdout.trim());
  if (root !== canonicalRepo) throw new Error("reviewed checkout path must be its canonical Git root");
  return root;
}

function parseRaw(raw: string): { entries: RawEntry[]; errors: string[] } {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: RawEntry[] = [];
  const errors: string[] = [];
  for (let i = 0; i < fields.length;) {
    const header = fields[i++]!;
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/);
    if (!match) {
      errors.push(`malformed raw diff field ${i}: ${JSON.stringify(header.slice(0, 120))}`);
      continue;
    }
    const oldPath = fields[i++];
    const secondPath = match[5] === "R" || match[5] === "C" ? fields[i++] : oldPath;
    if (oldPath === undefined || secondPath === undefined) {
      errors.push(`raw diff entry ${entries.length + 1} is missing a path`);
      break;
    }
    entries.push({
      oldMode: match[1]!, newMode: match[2]!, oldOid: match[3]!, newOid: match[4]!,
      status: match[5]!, score: match[6]!, oldPath, newPath: secondPath,
    });
  }
  return { entries, errors };
}

function parseNumstat(raw: string): { entries: NumstatEntry[]; errors: string[] } {
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: NumstatEntry[] = [];
  const errors: string[] = [];
  for (let i = 0; i < fields.length;) {
    const field = fields[i++]!;
    const first = field.indexOf("\t");
    const second = first < 0 ? -1 : field.indexOf("\t", first + 1);
    if (first < 0 || second < 0) {
      errors.push(`malformed numstat field ${i}: ${JSON.stringify(field.slice(0, 120))}`);
      continue;
    }
    const addedText = field.slice(0, first);
    const deletedText = field.slice(first + 1, second);
    const inlinePath = field.slice(second + 1);
    const oldPath = inlinePath || fields[i++];
    const newPath = inlinePath || fields[i++];
    if (oldPath === undefined || newPath === undefined) {
      errors.push(`numstat entry ${entries.length + 1} is missing a path`);
      break;
    }
    const binary = addedText === "-" || deletedText === "-";
    const added = binary ? null : Number(addedText);
    const deleted = binary ? null : Number(deletedText);
    if (!binary && (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted))) {
      errors.push(`invalid numstat counts for ${JSON.stringify(newPath)}`);
      continue;
    }
    entries.push({ oldPath, newPath, added, deleted, binary });
  }
  return { entries, errors };
}

function status(raw: RawEntry, errors: string[]): ChangeStatus {
  if (raw.status === "A") return "add";
  if (raw.status === "D") return "delete";
  if (raw.status === "R") return "rename";
  if (raw.status === "C") return "copy";
  if (raw.status !== "M") errors.push(`raw status ${raw.status} treated as modify`);
  return "modify";
}

function objectType(mode: string, exists: boolean, binary: boolean): ChangeSide["type"] {
  if (!exists) return "missing";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "submodule";
  return binary ? "binary" : "text";
}

async function objectSize(repo: string, oid: string, exists: boolean): Promise<{ bytes: number | null; error?: string }> {
  if (!exists) return { bytes: null };
  const result = await git(repo, ["cat-file", "-s", oid], 1024 * 1024);
  const bytes = Number(result.stdout.trim());
  if (result.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 0) return { bytes: null, error: gitError(`git cat-file ${oid}`, result) };
  return { bytes };
}

function diffPaths(file: Pick<ChangeFile, "path" | "oldPath" | "newPath" | "status">): string[] {
  return file.status === "rename" || file.status === "copy"
    ? file.oldPath === file.newPath ? [file.path] : [file.oldPath, file.newPath]
    : [file.path];
}

function hunkRanges(patch: string): ChangeHunk[] {
  const result: ChangeHunk[] = [];
  const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of patch.matchAll(pattern)) {
    result.push({
      index: result.length + 1,
      oldStart: Number(match[1]), oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]), newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return result;
}

async function filePatch(repo: string, manifest: ChangeManifest, file: ChangeFile, context: number) {
  return git(repo, [
    "diff", "--no-ext-diff", `--unified=${context}`, "-M", "-C", "--find-copies-harder",
    manifest.range, "--", ...diffPaths(file),
  ]);
}
export async function buildChangeManifest(repo: string, baseRef: string, headRef = "HEAD"): Promise<ChangeManifest> {
  const canonicalRepo = await checkoutRoot(repo);
  const [base, head] = await Promise.all([commit(canonicalRepo, baseRef), commit(canonicalRepo, headRef)]);
  const range = `${base}...${head}`;
  const [rawResult, numstatResult] = await Promise.all([
    git(canonicalRepo, ["diff", "--raw", "-z", "--no-abbrev", "-M", "-C", "--find-copies-harder", range]),
    git(canonicalRepo, ["diff", "--numstat", "-z", "-M", "-C", "--find-copies-harder", range]),
  ]);
  const parsedRaw = parseRaw(rawResult.stdout);
  const parsedNumstat = parseNumstat(numstatResult.stdout);
  const errors = [...parsedRaw.errors, ...parsedNumstat.errors];
  if (rawResult.code !== 0 || rawResult.truncated) errors.unshift(gitError("git diff --raw", rawResult));
  if (numstatResult.code !== 0 || numstatResult.truncated) errors.push(gitError("git diff --numstat", numstatResult));
  if ((rawResult.code !== 0 || rawResult.truncated) && parsedRaw.entries.length === 0) throw new Error(errors[0]);
  const stats = new Map(parsedNumstat.entries.map((entry) => [`${entry.oldPath}\0${entry.newPath}`, entry]));
  const files: ChangeFile[] = [];
  for (const raw of parsedRaw.entries) {
    const fileErrors: string[] = [];
    const changeStatus = status(raw, fileErrors);
    const stat = stats.get(`${raw.oldPath}\0${raw.newPath}`);
    if (!stat) fileErrors.push("numstat entry is missing");
    const binary = stat?.binary ?? false;
    const oldExists = raw.oldMode !== "000000";
    const newExists = raw.newMode !== "000000";
    const [oldSize, newSize] = await Promise.all([
      objectSize(canonicalRepo, raw.oldOid, oldExists), objectSize(canonicalRepo, raw.newOid, newExists),
    ]);
    if (oldSize.error) fileErrors.push(oldSize.error);
    if (newSize.error) fileErrors.push(newSize.error);
    const path = changeStatus === "delete" ? raw.oldPath : raw.newPath;
    const file: ChangeFile = {
      path, oldPath: raw.oldPath, newPath: raw.newPath, status: changeStatus,
      similarity: raw.score ? Number(raw.score) : null,
      language: LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()] ?? null,
      binary,
      lines: { added: stat?.added ?? null, deleted: stat?.deleted ?? null },
      old: {
        exists: oldExists, oid: oldExists ? raw.oldOid : null, mode: oldExists ? raw.oldMode : null,
        bytes: oldSize.bytes, type: objectType(raw.oldMode, oldExists, binary),
      },
      new: {
        exists: newExists, oid: newExists ? raw.newOid : null, mode: newExists ? raw.newMode : null,
        bytes: newSize.bytes, type: objectType(raw.newMode, newExists, binary),
      },
      hunks: [], errors: fileErrors, truncated: false,
    };
    const patch = await filePatch(canonicalRepo, { schema: 1, base, head, range, files: [], errors: [], truncated: false }, file, 0);
    if (patch.code !== 0 || patch.truncated) {
      file.truncated = patch.truncated === true;
      file.errors.push(gitError(`git diff ${JSON.stringify(path)}`, patch));
    }
    else file.hunks = hunkRanges(patch.stdout);
    files.push(file);
  }
  files.sort(comparePath);
  return { schema: CHANGE_EVIDENCE_SCHEMA_VERSION, base, head, range, files, errors, truncated: rawResult.truncated === true || numstatResult.truncated === true };
}

function assertSafeManifestPath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || isAbsolute(path)
    || path.split(/[\\/]/).some((part) => part === "..") || resolve("/", path) === "/") {
    throw new Error(`invalid ${label} path in change manifest`);
  }
}
function validCount(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function validateSide(side: unknown, label: string): asserts side is ChangeSide {
  if (!side || typeof side !== "object") throw new Error(`invalid ${label} side in change manifest`);
  const value = side as Partial<ChangeSide>;
  if (typeof value.exists !== "boolean" || !validCount(value.bytes)
    || !["missing", "text", "binary", "symlink", "submodule"].includes(String(value.type))) {
    throw new Error(`invalid ${label} side in change manifest`);
  }
  if (value.exists) {
    if (typeof value.oid !== "string" || !/^[0-9a-f]{40,64}$/.test(value.oid)
      || typeof value.mode !== "string" || !/^\d{6}$/.test(value.mode) || value.type === "missing") {
      throw new Error(`invalid existing ${label} side in change manifest`);
    }
  } else if (value.oid !== null || value.mode !== null || value.bytes !== null || value.type !== "missing") {
    throw new Error(`invalid missing ${label} side in change manifest`);
  }
}


function validateManifest(value: unknown): ChangeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("change manifest must be an object");
  const manifest = value as Partial<ChangeManifest>;
  if (manifest.schema !== CHANGE_EVIDENCE_SCHEMA_VERSION) throw new Error(`unsupported change manifest schema ${String(manifest.schema)}`);
  if (typeof manifest.base !== "string" || typeof manifest.head !== "string"
    || !/^[0-9a-f]{40,64}$/.test(manifest.base) || !/^[0-9a-f]{40,64}$/.test(manifest.head)
    || manifest.range !== `${manifest.base}...${manifest.head}`) throw new Error("invalid change manifest base/head identity");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.errors) || !manifest.errors.every((error) => typeof error === "string")
    || typeof manifest.truncated !== "boolean") {
    throw new Error("invalid change manifest files/errors");
  }
  const seen = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (!file || typeof file !== "object") throw new Error(`invalid change manifest file ${index + 1}`);
    assertSafeManifestPath(file.path, "canonical");
    assertSafeManifestPath(file.oldPath, "old");
    assertSafeManifestPath(file.newPath, "new");
    if (seen.has(file.path)) throw new Error(`duplicate change manifest path ${JSON.stringify(file.path)}`);
    seen.add(file.path);
    if (!["add", "modify", "delete", "rename", "copy"].includes(file.status)
      || typeof file.binary !== "boolean" || (file.language !== null && typeof file.language !== "string")
      || (file.similarity !== null && (!Number.isSafeInteger(file.similarity) || file.similarity < 0 || file.similarity > 100))
      || !file.lines || !validCount(file.lines.added) || !validCount(file.lines.deleted)
      || typeof file.truncated !== "boolean" || !Array.isArray(file.hunks)
      || !Array.isArray(file.errors) || !file.errors.every((error) => typeof error === "string")) {
      throw new Error(`invalid change manifest metadata for ${JSON.stringify(file.path)}`);
    }
    validateSide(file.old, "old");
    validateSide(file.new, "new");
    if ((file.status === "add" && (file.old.exists || !file.new.exists))
      || (file.status === "delete" && (!file.old.exists || file.new.exists))
      || (file.status !== "add" && file.status !== "delete" && (!file.old.exists || !file.new.exists))
      || (file.status === "delete" ? file.path !== file.oldPath : file.path !== file.newPath)) {
      throw new Error(`inconsistent change manifest status for ${JSON.stringify(file.path)}`);
    }
    for (const [hunkIndex, hunk] of file.hunks.entries()) {
      if (hunk.index !== hunkIndex + 1 || ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((part) => Number.isSafeInteger(part) && part >= 0)) {
        throw new Error(`invalid hunk metadata for ${JSON.stringify(file.path)}`);
      }
    }
  }
  return manifest as ChangeManifest;
}

async function outsideCheckout(repo: string, path: string, existing: boolean): Promise<{ repo: string; path: string }> {
  const canonicalRepo = await realpath(repo);
  const canonicalPath = existing ? await realpath(resolve(path)) : join(await realpath(dirname(resolve(path))), basename(resolve(path)));
  if (pathIsInside(canonicalRepo, canonicalPath)) throw new Error("change manifest must stay outside the reviewed checkout");
  return { repo: canonicalRepo, path: canonicalPath };
}

async function writeManifest(repo: string, path: string, manifest: ChangeManifest): Promise<string> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const canonical = await outsideCheckout(repo, path, false);
  if (existsSync(canonical.path) && (await lstat(canonical.path)).isSymbolicLink()) throw new Error("change manifest path must not be a symbolic link");
  const temporary = `${canonical.path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 1)}\n`, { mode: 0o600 });
    await rename(temporary, canonical.path);
  } finally {
    await rm(temporary, { force: true });
  }
  return canonical.path;
}

async function loadManifest(repo: string, path: string): Promise<{ repo: string; path: string; manifest: ChangeManifest }> {
  const canonical = await outsideCheckout(repo, path, true);
  const manifest = validateManifest(JSON.parse(await readFile(canonical.path, "utf8")));
  return { ...canonical, manifest };
}

export async function validateChangeManifestCheckout(repo: string, manifest: ChangeManifest): Promise<void> {
  validateManifest(manifest);
  const canonicalRepo = await checkoutRoot(repo);
  const [base, head] = await Promise.all([commit(canonicalRepo, manifest.base), commit(canonicalRepo, "HEAD")]);
  if (base !== manifest.base || head !== manifest.head) throw new Error("change manifest base/head does not match the reviewed checkout");
}

function splitPatch(path: string, patch: string, manifestHunks: ChangeHunk[]): PatchItem[] {
  const starts = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)];
  if (starts.length === 0) return patch ? [{ path, hunks: [], patch: Buffer.from(patch) }] : [];
  const header = patch.slice(0, starts[0]!.index!);
  return starts.map((match, index) => {
    const newStart = Number(match[3]);
    const newEnd = newStart + Math.max(match[4] === undefined ? 1 : Number(match[4]), 1) - 1;
    const hunks = manifestHunks
      .filter((hunk) => hunk.newStart + Math.max(hunk.newLines, 1) - 1 >= newStart && hunk.newStart <= newEnd)
      .map((hunk) => hunk.index);
    return {
      path,
      hunks: hunks.length > 0 ? hunks : [index + 1],
      patch: Buffer.from(header + patch.slice(match.index!, starts[index + 1]?.index ?? patch.length)),
    };
  });
}

function requestFingerprint(manifest: ChangeManifest, request: Omit<PatchEvidenceRequest, "cursor" | "byteBudget">): string {
  return createHash("sha256").update(JSON.stringify({ base: manifest.base, head: manifest.head, ...request })).digest("hex");
}

function cursorValue(fingerprint: string, item: number, offset: number): string {
  return Buffer.from(JSON.stringify({ fingerprint, item, offset })).toString("base64url");
}

function parseCursor(cursor: string | undefined, fingerprint: string, itemCount: number): { item: number; offset: number } {
  if (!cursor) return { item: 0, offset: 0 };
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new Error("invalid change evidence cursor"); }
  if (!value || typeof value !== "object") throw new Error("invalid change evidence cursor");
  const parsed = value as { fingerprint?: unknown; item?: unknown; offset?: unknown };
  if (parsed.fingerprint !== fingerprint || typeof parsed.item !== "number" || typeof parsed.offset !== "number"
    || !Number.isSafeInteger(parsed.item) || !Number.isSafeInteger(parsed.offset)
    || parsed.item < 0 || parsed.item > itemCount || parsed.offset < 0
    || (parsed.item === itemCount && parsed.offset !== 0)) {
    throw new Error("change evidence cursor does not match this request");
  }
  return { item: parsed.item, offset: parsed.offset };
}

function utf8End(buffer: Buffer, start: number, budget: number): number {
  let end = Math.min(buffer.length, start + budget);
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return end;
}

async function retrievePatches(repo: string, manifest: ChangeManifest, request: PatchEvidenceRequest): Promise<PatchEvidenceResponse> {
  if (!Array.isArray(request.paths) || request.paths.length === 0) throw new Error("patch evidence requires at least one manifest path");
  if (new Set(request.paths).size !== request.paths.length) throw new Error("patch evidence paths must be unique");
  const context = request.context ?? DEFAULT_CONTEXT_LINES;
  if (!Number.isSafeInteger(context) || context < 0 || context > MAX_CONTEXT_LINES) throw new Error(`context must be between 0 and ${MAX_CONTEXT_LINES}`);
  const budget = request.byteBudget ?? DEFAULT_PATCH_RESPONSE_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 4 || budget > MAX_PATCH_RESPONSE_BYTES) throw new Error(`byteBudget must be between 4 and ${MAX_PATCH_RESPONSE_BYTES}`);
  if (request.hunk !== undefined && (!Number.isSafeInteger(request.hunk) || request.hunk < 1)) throw new Error("hunk must be a positive integer");
  if (request.range && (!Number.isSafeInteger(request.range.start) || !Number.isSafeInteger(request.range.end)
    || request.range.start < 1 || request.range.end < request.range.start)) throw new Error("range must be positive and ordered");
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));
  const selected = request.paths.map((path) => {
    assertSafeManifestPath(path, "requested");
    const file = byPath.get(path);
    if (!file) throw new Error(`unknown change manifest path ${JSON.stringify(path)}`);
    return file;
  });
  const items: PatchItem[] = [];
  const omitted: PatchEvidenceResponse["omitted"] = [];
  const errors: string[] = [];
  let auditBytes = 0;
  for (const file of selected) {
    errors.push(...file.errors.map((error) => `${file.path}: ${error}`));
    const result = await filePatch(repo, manifest, file, context);
    auditBytes += Buffer.byteLength(result.stdout);
    if (result.code !== 0 || result.truncated) {
      const error = gitError(`git diff ${JSON.stringify(file.path)}`, result);
      errors.push(error);
      omitted.push({ path: file.path, hunks: file.hunks.map((hunk) => hunk.index), reason: error, bytes: null });
      continue;
    }
    let fileItems = splitPatch(file.path, result.stdout, file.hunks);
    if (request.hunk !== undefined) fileItems = fileItems.filter((item) => item.hunks.includes(request.hunk!));
    if (request.range) {
      const overlapping = new Set(file.hunks
        .filter((hunk) => hunk.newStart + Math.max(hunk.newLines, 1) - 1 >= request.range!.start && hunk.newStart <= request.range!.end)
        .map((hunk) => hunk.index));
      fileItems = fileItems.filter((item) => item.hunks.some((hunk) => overlapping.has(hunk)));
    }
    if (fileItems.length === 0) {
      omitted.push({
        path: file.path,
        hunks: request.hunk ? [request.hunk] : file.hunks.map((hunk) => hunk.index),
        reason: "no matching patch evidence",
        bytes: 0,
      });
    }
    items.push(...fileItems);
  }
  const normalizedRequest = { ...request, cursor: undefined, byteBudget: undefined };
  const fingerprint = requestFingerprint(manifest, normalizedRequest);
  const cursor = parseCursor(request.cursor, fingerprint, items.length);
  if (cursor.item < items.length && cursor.offset > items[cursor.item]!.patch.length) throw new Error("change evidence cursor offset is out of range");
  const returned: PatchEvidenceResponse["returned"] = [];
  let modelBytes = 0;
  let itemIndex = cursor.item;
  let itemOffset = cursor.offset;
  while (itemIndex < items.length && modelBytes < budget) {
    const item = items[itemIndex]!;
    const end = utf8End(item.patch, itemOffset, budget - modelBytes);
    if (end === itemOffset) break;
    const chunk = item.patch.subarray(itemOffset, end);
    returned.push({
      path: item.path, hunks: item.hunks, byteStart: itemOffset, byteEnd: end,
      bytes: chunk.length, complete: end === item.patch.length, patch: chunk.toString("utf8"),
    });
    modelBytes += chunk.length;
    if (end < item.patch.length) {
      itemOffset = end;
      break;
    }
    itemIndex++;
    itemOffset = 0;
  }
  const nextCursor = itemIndex < items.length ? cursorValue(fingerprint, itemIndex, itemOffset) : null;
  for (let index = itemIndex; index < items.length; index++) {
    const item = items[index]!;
    const start = index === itemIndex ? itemOffset : 0;
    omitted.push({
      path: item.path,
      hunks: item.hunks,
      reason: index === itemIndex && itemOffset > 0 ? `byte budget; resume at byte ${itemOffset}` : "byte budget",
      bytes: item.patch.length - start,
    });
  }
  const omittedBytes = omitted.reduce((bytes, item) => bytes + (item.bytes ?? 0), 0);
  return {
    kind: "patch", base: manifest.base, head: manifest.head, modelBytes, auditBytes,
    omittedBytes, unknownOmittedBytes: omitted.some((item) => item.bytes === null),
    returned, omitted, nextCursor, complete: nextCursor === null && errors.length === 0,
    truncated: nextCursor !== null, errors,
  };
}
async function openLoadedEvidence(repo: string, manifest: ChangeManifest): Promise<ChangeEvidence> {
  await validateChangeManifestCheckout(repo, manifest);
  const canonicalRepo = await realpath(repo);
  return {
    manifest,
    retrieve: async (request) => {
      if (request.kind === "manifest") {
        const modelBytes = Buffer.byteLength(JSON.stringify(manifest));
        const errors = [
          ...manifest.errors,
          ...manifest.files.flatMap((file) => file.errors.map((error) => `${file.path}: ${error}`)),
        ];
        return {
          kind: "manifest", manifest, modelBytes, auditBytes: 0, omittedBytes: 0, unknownOmittedBytes: false,
          returned: manifest.files.map((file) => ({ path: file.path, hunks: file.hunks.map((hunk) => hunk.index) })),
          omitted: [], nextCursor: null, complete: errors.length === 0 && !manifest.truncated,
          truncated: manifest.truncated, errors,
        };
      }
      return retrievePatches(canonicalRepo, manifest, request);
    },
    auditPatch: async (context = 80) => {
      if (!Number.isSafeInteger(context) || context < 0) throw new Error("audit patch context must be a non-negative integer");
      const result = await git(canonicalRepo, ["diff", "--no-ext-diff", `--unified=${context}`, "-M", "-C", "--find-copies-harder", manifest.range]);
      if (result.code !== 0 || result.truncated) throw new Error(gitError("git diff audit patch", result));
      return { patch: result.stdout, bytes: Buffer.byteLength(result.stdout), sha256: createHash("sha256").update(result.stdout).digest("hex") };
    },
  };
}

export async function materializeChangeEvidence(repo: string, base: string, path: string, head = "HEAD"): Promise<ChangeEvidence> {
  const manifest = await buildChangeManifest(repo, base, head);
  await writeManifest(repo, path, manifest);
  return openLoadedEvidence(repo, manifest);
}

export async function openChangeEvidence(repo: string, path: string): Promise<ChangeEvidence> {
  const loaded = await loadManifest(repo, path);
  return openLoadedEvidence(loaded.repo, loaded.manifest);
}

export async function ensureChangeEvidence(repo: string, base: string, path: string, head = "HEAD"): Promise<ChangeEvidence> {
  if (!existsSync(path)) return materializeChangeEvidence(repo, base, path, head);
  const evidence = await openChangeEvidence(repo, path);
  const resolvedBase = await commit(repo, base);
  const resolvedHead = await commit(repo, head);
  if (evidence.manifest.base !== resolvedBase || evidence.manifest.head !== resolvedHead) {
    throw new Error("existing change manifest does not match the requested base/head");
  }
  return evidence;
}
