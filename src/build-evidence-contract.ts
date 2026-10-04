import { z } from "zod";

/**
 * Wire contract for the optional `leveret.build-evidence/v1` manifest (see the build-evidence design spec).
 * The manifest is untrusted data: decoding rejects the whole export on any grammar, shape or reference
 * violation, and error text is built from schema-owned wording and record positions, never raw values.
 */

export class BuildEvidenceInputError extends Error {
  constructor(readonly code: "invalid-input", readonly safeReason: string) {
    super(safeReason);
    this.name = "BuildEvidenceInputError";
  }
}

// ── primitives ─────────────────────────────────────────────────────────────────────────────────

/** Normalized repository/payload-relative path: `/` separated, no empty, `.` or `..` component. */
function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\\") || value.includes("\0")) return false;
  // A lone surrogate has no UTF-8 form: distinct strings would collide once written to disk.
  if (/\p{Cs}/u.test(value)) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** UTF-8 byte order is Unicode code point order (not UTF-16 code unit order). */
function compareUtf8(a: string, b: string): number {
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end;) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - b.length);
}

const count = (min: number, message: string) =>
  z.number().refine((value) => Number.isSafeInteger(value) && value >= min, message);
const size = count(0, "expected a nonnegative safe integer");
const line = count(1, "expected a one-based safe integer line");
const column = count(0, "expected a nonnegative safe integer column");

const id = z.string().min(1);
const text = z.string();
const nullableText = z.string().nullable();
const reason = z.string().min(1);
const relativePath = z.string().refine(isRelativePath, "invalid relative path");
const moduleDir = z.string().refine((value) => value === "." || isRelativePath(value), "invalid module directory");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");

// ── manifest envelope ──────────────────────────────────────────────────────────────────────────

const producer = z.strictObject({
  name: text, version: text, buildTool: z.strictObject({ name: text, version: text }), runId: id,
});

/** `set` carries a string; `unset` and `unknown` carry null. Unknown never becomes unset. */
const settable = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("set"), value: text }),
  z.strictObject({ state: z.literal("unset"), value: z.null() }),
  z.strictObject({ state: z.literal("unknown"), value: z.null() }),
]);
const variant = settable;
const release = settable;

const context = z.strictObject({ id, profiles: z.array(text).nullable(), variant });

// ── artifacts ──────────────────────────────────────────────────────────────────────────────────

const role = z.enum(["source", "resource", "template", "schema", "build-config", "classes", "dependency", "report"]);
const origin = z.enum(["authored", "materialized", "external"]);
const artifactBase = { id, role, origin, repositoryPath: relativePath.nullable() };
const fileContent = z.strictObject({
  location: z.strictObject({ kind: z.enum(["repository", "payload"]), path: relativePath }),
  sha256, sizeBytes: size,
});
const directoryEntry = z.strictObject({ path: relativePath, sha256, sizeBytes: size });

const availableFile = z.strictObject({
  ...artifactBase, kind: z.literal("file"), availability: z.literal("available"), content: fileContent, encoding: nullableText,
});
const availableDirectory = z.strictObject({
  ...artifactBase, kind: z.literal("directory"), availability: z.literal("available"),
  location: z.strictObject({ kind: z.literal("payload"), path: relativePath }), entries: z.array(directoryEntry),
});
const nonavailable = z.strictObject({
  ...artifactBase, kind: z.enum(["file", "directory"]), availability: z.enum(["missing", "not-produced", "withheld"]), reason,
});
const artifact = z.discriminatedUnion("availability", [
  z.discriminatedUnion("kind", [availableFile, availableDirectory]),
  nonavailable,
]);

// ── compilations ───────────────────────────────────────────────────────────────────────────────

const coordinates = z.strictObject({ group: text, name: text, version: text, classifier: nullableText, type: text });
const pathEntry = z.strictObject({ artifactId: id, coordinates: coordinates.nullable(), upstreamCompilationId: id.nullable() });
/** Complete-empty and unknown stay distinct: only `unknown` implies (and requires) empty entries. */
const pathSet = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("complete"), reason: z.null(), entries: z.array(pathEntry) }),
  z.strictObject({ state: z.literal("partial"), reason, entries: z.array(pathEntry) }),
  z.strictObject({ state: z.literal("unknown"), reason, entries: z.array(pathEntry).length(0) }),
]);

const fingerprint = z.strictObject({ name: z.enum(["release", "modules", "ct.sym", "rt.jar"]), sha256 });
const platform = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unknown"), fingerprints: z.array(fingerprint).length(0) }),
  z.strictObject({ state: z.literal("identified"), fingerprints: z.array(fingerprint) }),
]);
const moduleOptions = z.strictObject({
  sourcePath: pathSet,
  bootClasspath: pathSet,
  addReads: z.array(z.strictObject({ module: text, targets: z.array(text) })).nullable(),
  addExports: z.array(z.strictObject({ module: text, package: text, targets: z.array(text) })).nullable(),
  patchModules: z.array(z.strictObject({ module: text, path: pathSet })).nullable(),
  addModules: z.array(text).nullable(),
  limitModules: z.array(text).nullable(),
});
const compiler = z.strictObject({
  name: nullableText, version: nullableText, javaVersion: nullableText, platform, release,
  sourceLevel: nullableText, targetLevel: nullableText, encoding: nullableText, preview: z.boolean().nullable(),
  moduleOptions: moduleOptions.nullable(),
});

const sourceRoot = z.strictObject({
  id, repositoryPath: relativePath.nullable(),
  members: z.array(z.strictObject({ artifactId: id, relativePath })),
});
const inventory = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("complete"), reason: z.null() }),
  z.strictObject({ state: z.literal("partial"), reason }),
  z.strictObject({ state: z.literal("unknown"), reason }),
]);
const stepState = z.enum(["succeeded", "failed", "not-run", "unknown"]);

const compilation = z.strictObject({
  id, moduleId: id, moduleDir, name: text,
  sourceSetRole: z.enum(["production", "test", "other"]),
  language: z.literal("java"),
  inputArtifactIds: z.array(id),
  sourceRoots: z.array(sourceRoot),
  authoredArtifactIds: z.array(id),
  resourceArtifactIds: z.array(id),
  outputArtifactIds: z.array(id),
  inventory, compiler,
  compileClasspath: pathSet, modulePath: pathSet, processorPath: pathSet,
  generationState: stepState, resourceState: stepState, compilationState: stepState,
});

// ── transformations and diagnostics ────────────────────────────────────────────────────────────

const position = z.strictObject({ line, column });
const range = z.strictObject({ start: position, end: position });
const transformation = z.strictObject({
  id,
  producer: z.strictObject({ name: text, version: nullableText, executionId: id }),
  kind: z.enum(["generate", "transform", "resource-process"]),
  inputArtifactIds: z.array(id),
  outputArtifactIds: z.array(id),
  basis: z.enum(["exporter-recorded", "inferred"]),
  locations: z.array(z.strictObject({ inputArtifactId: id, outputArtifactId: id, inputRange: range, outputRange: range })),
});
const diagnostic = z.strictObject({ code: text, message: text, compilationId: id.nullable(), artifactIds: z.array(id) });

const manifestSchema = z.strictObject({
  schema: z.literal("leveret.build-evidence/v1"),
  repositoryId: id,
  revision: id,
  producer, context,
  artifacts: z.array(artifact),
  compilations: z.array(compilation),
  transformations: z.array(transformation),
  diagnostics: z.array(diagnostic),
});

export type BuildEvidenceManifest = z.infer<typeof manifestSchema>;
export type BuildProducer = z.infer<typeof producer>;
export type BuildContext = z.infer<typeof context>;
export type BuildVariant = z.infer<typeof variant>;
export type BuildArtifact = z.infer<typeof artifact>;
export type BuildCompilation = z.infer<typeof compilation>;
export type BuildCompiler = z.infer<typeof compiler>;
export type BuildPathSet = z.infer<typeof pathSet>;
export type BuildPathEntry = z.infer<typeof pathEntry>;
export type BuildSourceRoot = z.infer<typeof sourceRoot>;
export type BuildTransformation = z.infer<typeof transformation>;
export type BuildDiagnostic = z.infer<typeof diagnostic>;

// ── reference graph and conditional-field validation ───────────────────────────────────────────

type Path = readonly (string | number)[];

class GraphError extends Error {
  constructor(readonly path: Path, message: string) { super(message); }
}

function fail(path: Path, message: string): never {
  throw new GraphError(path, message);
}

function indexById<T extends { id: string }>(records: readonly T[], collection: string, duplicate: string): Map<string, T> {
  const byId = new Map<string, T>();
  records.forEach((record, index) => {
    if (byId.has(record.id)) fail([collection, index, "id"], duplicate);
    byId.set(record.id, record);
  });
  return byId;
}

function validateArtifacts(manifest: BuildEvidenceManifest): void {
  const authoredPaths = new Set<string>();
  const payloadClaims = new Map<string, string>();
  const claim = (payloadPath: string, content: { sha256: string; sizeBytes: number }, where: Path) => {
    const identity = `${content.sha256}:${content.sizeBytes}`;
    const known = payloadClaims.get(payloadPath);
    if (known !== undefined && known !== identity) fail(where, "one payload path carries conflicting size or hash claims");
    payloadClaims.set(payloadPath, identity);
  };
  manifest.artifacts.forEach((item, index) => {
    const where = (...rest: (string | number)[]): Path => ["artifacts", index, ...rest];
    if (item.kind === "directory") {
      if (item.role !== "classes" && item.role !== "dependency") fail(where("role"), "directory artifacts are limited to the classes and dependency roles");
      if (item.origin === "authored") fail(where("origin"), "directory artifacts cannot be authored");
    }
    if (item.origin === "authored") {
      if (item.repositoryPath === null) fail(where("repositoryPath"), "authored artifacts require a repository path");
      if (authoredPaths.has(item.repositoryPath)) fail(where("repositoryPath"), "more than one authored artifact claims a repository path");
      authoredPaths.add(item.repositoryPath);
    }
    if (item.availability !== "available") return;
    if (item.kind === "file") {
      const { location } = item.content;
      if (item.origin === "authored") {
        if (location.kind !== "repository" || location.path !== item.repositoryPath) {
          fail(where("content", "location"), "authored content must be the repository path read from the pinned revision");
        }
        return;
      }
      if (location.kind !== "payload") fail(where("content", "location", "kind"), "materialized and external content must use a payload location");
      claim(location.path, item.content, where("content"));
      return;
    }
    let previous: string | undefined;
    item.entries.forEach((entry, entryIndex) => {
      if (previous !== undefined && compareUtf8(previous, entry.path) >= 0) {
        fail(where("entries", entryIndex, "path"), "directory entries must be unique and sorted in UTF-8 byte order");
      }
      previous = entry.path;
      claim(`${item.location.path}/${entry.path}`, entry, where("entries", entryIndex));
    });
  });
}

function validateCompilations(
  manifest: BuildEvidenceManifest,
  artifacts: ReadonlyMap<string, BuildArtifact>,
  compilations: ReadonlyMap<string, BuildCompilation>,
): void {
  const outputs = new Map([...compilations.values()].map((item): [string, Set<string>] => [item.id, new Set(item.outputArtifactIds)]));
  const resolve = (artifactId: string, where: Path): BuildArtifact => artifacts.get(artifactId) ?? fail(where, "unresolved artifact reference");
  const checkPathSet = (set: BuildPathSet, where: Path) => {
    set.entries.forEach((entry, entryIndex) => {
      const entryPath = [...where, "entries", entryIndex];
      resolve(entry.artifactId, [...entryPath, "artifactId"]);
      if (entry.upstreamCompilationId === null) return;
      const upstream = outputs.get(entry.upstreamCompilationId);
      if (!upstream) fail([...entryPath, "upstreamCompilationId"], "unresolved compilation reference");
      if (!upstream.has(entry.artifactId)) fail([...entryPath, "artifactId"], "path entry is not an output of its upstream compilation");
    });
  };

  manifest.compilations.forEach((item, index) => {
    const where = (...rest: (string | number)[]): Path => ["compilations", index, ...rest];

    const inputs = new Set<string>();
    const inputPaths = new Set<string>();
    item.inputArtifactIds.forEach((artifactId, inputIndex) => {
      const input = resolve(artifactId, where("inputArtifactIds", inputIndex));
      if (input.kind !== "file" || input.role !== "source") fail(where("inputArtifactIds", inputIndex), "effective inputs must be source files");
      if (inputs.has(artifactId)) fail(where("inputArtifactIds", inputIndex), "duplicate effective input");
      inputs.add(artifactId);
      if (input.repositoryPath === null) return;
      if (inputPaths.has(input.repositoryPath)) fail(where("inputArtifactIds", inputIndex), "more than one effective input shares a repository path");
      inputPaths.add(input.repositoryPath);
    });

    const rootIds = new Set<string>();
    const placed = new Set<string>();
    item.sourceRoots.forEach((root, rootIndex) => {
      if (rootIds.has(root.id)) fail(where("sourceRoots", rootIndex, "id"), "duplicate source root id");
      rootIds.add(root.id);
      const names = new Set<string>();
      root.members.forEach((member, memberIndex) => {
        const memberPath = where("sourceRoots", rootIndex, "members", memberIndex);
        if (!inputs.has(member.artifactId)) fail([...memberPath, "artifactId"], "source root member is not an effective input");
        if (placed.has(member.artifactId)) fail([...memberPath, "artifactId"], "an effective input is placed more than once");
        placed.add(member.artifactId);
        if (names.has(member.relativePath)) fail([...memberPath, "relativePath"], "duplicate relative path within a source root");
        names.add(member.relativePath);
      });
    });
    for (const artifactId of inputs) {
      if (!placed.has(artifactId)) fail(where("sourceRoots"), "an effective input is not placed in any source root");
    }

    item.authoredArtifactIds.forEach((artifactId, i) => {
      if (resolve(artifactId, where("authoredArtifactIds", i)).origin !== "authored") fail(where("authoredArtifactIds", i), "only authored artifacts can be listed as originals");
    });
    item.resourceArtifactIds.forEach((artifactId, i) => {
      if (resolve(artifactId, where("resourceArtifactIds", i)).role !== "resource") fail(where("resourceArtifactIds", i), "only resource artifacts can be listed as resources");
    });
    item.outputArtifactIds.forEach((artifactId, i) => { resolve(artifactId, where("outputArtifactIds", i)); });

    checkPathSet(item.compileClasspath, where("compileClasspath"));
    checkPathSet(item.modulePath, where("modulePath"));
    checkPathSet(item.processorPath, where("processorPath"));
    const options = item.compiler.moduleOptions;
    if (options !== null) {
      checkPathSet(options.sourcePath, where("compiler", "moduleOptions", "sourcePath"));
      checkPathSet(options.bootClasspath, where("compiler", "moduleOptions", "bootClasspath"));
      options.patchModules?.forEach((patch, patchIndex) => {
        checkPathSet(patch.path, where("compiler", "moduleOptions", "patchModules", patchIndex, "path"));
      });
    }

    const { platform: identity } = item.compiler;
    if (identity.state === "identified") {
      const names = new Set<string>();
      identity.fingerprints.forEach((print, printIndex) => {
        if (names.has(print.name)) fail(where("compiler", "platform", "fingerprints", printIndex, "name"), "duplicate platform fingerprint name");
        names.add(print.name);
      });
      if (!names.has("modules") && !names.has("rt.jar")) {
        fail(where("compiler", "platform", "fingerprints"), "an identified platform requires a modules or rt.jar fingerprint");
      }
    }
  });
}

function validateTransformations(manifest: BuildEvidenceManifest, artifacts: ReadonlyMap<string, BuildArtifact>): void {
  manifest.transformations.forEach((item, index) => {
    const where = (...rest: (string | number)[]): Path => ["transformations", index, ...rest];
    const inputs = new Set<string>();
    item.inputArtifactIds.forEach((artifactId, i) => {
      if (!artifacts.has(artifactId)) fail(where("inputArtifactIds", i), "unresolved artifact reference");
      if (inputs.has(artifactId)) fail(where("inputArtifactIds", i), "duplicate transformation input");
      inputs.add(artifactId);
    });
    const outputs = new Set<string>();
    item.outputArtifactIds.forEach((artifactId, i) => {
      const output = artifacts.get(artifactId) ?? fail(where("outputArtifactIds", i), "unresolved artifact reference");
      if (output.origin === "authored") fail(where("outputArtifactIds", i), "transformations cannot output authored originals");
      if (outputs.has(artifactId)) fail(where("outputArtifactIds", i), "duplicate transformation output");
      outputs.add(artifactId);
    });
    if (item.basis === "inferred" && item.locations.length > 0) fail(where("locations"), "inferred lineage cannot carry precise source maps");
    item.locations.forEach((map, i) => {
      if (!inputs.has(map.inputArtifactId)) fail(where("locations", i, "inputArtifactId"), "source map input is not an input of its transformation");
      if (!outputs.has(map.outputArtifactId)) fail(where("locations", i, "outputArtifactId"), "source map output is not an output of its transformation");
    });
  });
}

function validateDiagnostics(
  manifest: BuildEvidenceManifest,
  artifacts: ReadonlyMap<string, BuildArtifact>,
  compilations: ReadonlyMap<string, BuildCompilation>,
): void {
  manifest.diagnostics.forEach((item, index) => {
    if (item.compilationId !== null && !compilations.has(item.compilationId)) {
      fail(["diagnostics", index, "compilationId"], "unresolved compilation reference");
    }
    item.artifactIds.forEach((artifactId, i) => {
      if (!artifacts.has(artifactId)) fail(["diagnostics", index, "artifactIds", i], "unresolved artifact reference");
    });
  });
}

/**
 * Strict structure plus reference graph. Zod can still run this refinement after non-aborting leaf
 * failures (`min`, `regex`, `refine`), so the graph code relies on the types being right and treats
 * every value as untrusted: unresolved or malformed values become graph errors, never exceptions.
 */
export const buildEvidenceSchema = manifestSchema.superRefine((manifest, ctx) => {
  try {
    const artifacts = indexById(manifest.artifacts, "artifacts", "duplicate artifact id");
    const compilations = indexById(manifest.compilations, "compilations", "duplicate compilation id");
    indexById(manifest.transformations, "transformations", "duplicate transformation id");
    validateArtifacts(manifest);
    validateCompilations(manifest, artifacts, compilations);
    validateTransformations(manifest, artifacts);
    validateDiagnostics(manifest, artifacts, compilations);
  } catch (error) {
    if (!(error instanceof GraphError)) throw error;
    ctx.addIssue({ code: "custom", path: [...error.path], message: error.message });
  }
});

// ── host pins and requests (consumed by later admission code) ──────────────────────────────────

export type BuildEvidencePin = {
  manifestPath: string; manifestSha256: string; payloadRoot: string;
  expectedContext: { id: string; profiles?: readonly string[]; variant?: BuildVariant };
  select: { moduleDir: string; productionId: string; testId: string | null };
};

export type BuildEvidenceRequest = {
  repo: string; repositoryId: string; revision: string; side: "base" | "head";
  pin: BuildEvidencePin | undefined; runtimeDir: string; signal?: AbortSignal;
};

// ── strict decoder ─────────────────────────────────────────────────────────────────────────────

const utf8 = new TextDecoder("utf-8", { fatal: true });

const DUPLICATE_KEY = "manifest repeats an object key";
const INEXACT_NUMBER = "manifest contains a number that is not an exact safe integer";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Whether a grammar-valid JSON number token denotes, exactly, a safe integer. The decimal coefficient
 * and scale are evaluated directly, because JSON.parse silently rounds `12.00000000000000001` to 12
 * and `12e-999999999999` to 0. Alternate spellings of an exact integer (`1e2`, `1.0`, `-0`) are the
 * same value and stay valid; fractional, negative nonzero and unsafe values are not.
 */
function isExactSafeInteger(token: string): boolean {
  const negative = token.startsWith("-");
  const body = negative ? token.slice(1) : token;
  let marker = body.indexOf("e");
  if (marker < 0) marker = body.indexOf("E");
  const mantissa = marker < 0 ? body : body.slice(0, marker);
  const exponent = marker < 0 ? 0 : Number(body.slice(marker + 1));
  const dot = mantissa.indexOf(".");
  const fraction = dot < 0 ? "" : mantissa.slice(dot + 1);
  const digits = (dot < 0 ? mantissa : mantissa.slice(0, dot)) + fraction;
  let first = 0;
  while (first < digits.length && digits[first] === "0") first++;
  if (first === digits.length) return true; // zero, however it is spelled (including -0)
  let last = digits.length;
  while (digits[last - 1] === "0") last--;
  const significant = digits.slice(first, last);
  // value = significant * 10^scale; an absurd exponent overflows Number to +/-Infinity, which still
  // lands on the correct side of both comparisons below.
  const scale = exponent - fraction.length + (digits.length - last);
  if (negative || scale < 0 || significant.length + scale > 16) return false;
  return BigInt(significant) * 10n ** BigInt(scale) <= MAX_SAFE;
}

/**
 * Walks a document that already passed the standard JSON grammar check (so every string is terminated
 * and every number token is well formed) and returns a safe reason for the first violation JSON.parse
 * cannot see, or null:
 * - an object that repeats a key after escape decoding (`id` and `\u0069d` are the same key; JSON.parse
 *   silently keeps the last one);
 * - a number that is not exactly a safe integer (every number in this contract is a size, line or column).
 * Structure is tracked by token: strings are skipped as a unit, so braces, commas and quotes inside
 * them never count, and only a string in key position is decoded.
 */
function lexicalViolation(source: string): string | null {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") { stack.push(new Set()); expectKey = true; }
    else if (char === "[") { stack.push(null); expectKey = false; }
    else if (char === "}" || char === "]") { stack.pop(); expectKey = false; }
    else if (char === ",") expectKey = stack.at(-1) instanceof Set;
    else if (char === '"') {
      let end = i + 1;
      while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      const keys = expectKey ? stack.at(-1) : null;
      if (keys) {
        const token = source.slice(i, end + 1);
        const key = token.includes("\\") ? (JSON.parse(token) as string) : token.slice(1, -1);
        if (keys.has(key)) return DUPLICATE_KEY;
        keys.add(key);
        expectKey = false;
      }
      i = end;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = i + 1;
      while (end < source.length && "0123456789+-.eE".includes(source[end])) end++;
      if (!isExactSafeInteger(source.slice(i, end))) return INEXACT_NUMBER;
      i = end - 1;
    }
  }
  return null;
}

function describeIssue(issue: z.ZodError["issues"][number]): string {
  const where = issue.path.reduce<string>(
    (acc, part) => typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part), "") || "manifest";
  switch (issue.code) {
    case "invalid_type": return `${where}: expected ${String(issue.expected)}`;
    case "unrecognized_keys": return `${where}: unrecognized field`;
    case "invalid_value": return `${where}: unsupported value`;
    case "invalid_union": return `${where}: no variant matches`;
    case "too_small":
    case "too_big": return `${where}: value out of range`;
    case "invalid_format": return `${where}: invalid format`;
    case "custom": return `${where}: ${issue.message}`;
    default: return `${where}: invalid value`;
  }
}

export function parseBuildEvidence(bytes: Uint8Array): BuildEvidenceManifest {
  let source: string;
  try { source = utf8.decode(bytes); }
  catch { throw new BuildEvidenceInputError("invalid-input", "manifest is not valid UTF-8"); }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new BuildEvidenceInputError("invalid-input", "manifest is not a single valid JSON document"); }
  const violation = lexicalViolation(source);
  if (violation) throw new BuildEvidenceInputError("invalid-input", violation);
  const result = buildEvidenceSchema.safeParse(value);
  if (!result.success) throw new BuildEvidenceInputError("invalid-input", describeIssue(result.error.issues[0]));
  return result.data;
}
