import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BuildArtifact, BuildTransformation } from "./build-evidence-contract.js";
import type { ArtifactState, BuildEvidenceAdmission } from "./build-evidence.js";
import { refreshSecretPolicy, screenText, type SecretPolicy } from "./secret-screening.js";

type Admitted = Extract<BuildEvidenceAdmission, { outcome: "admitted" }>;
type TextArtifact = Extract<BuildArtifact, { availability: "available"; kind: "file" }>;

export type BuildArtifactReadRequest = {
  manifestSha256: string;
  artifactId: string;
  range: { startLine: number; endLine: number } | null;
  byteBudget: number;
  cursor?: string;
};

export type BuildArtifactReadErrorCode =
  | "invalid-input" | "snapshot-mismatch" | "artifact-unavailable" | "unsupported-artifact"
  | "unsupported-encoding" | "secret-detected" | "screening-unavailable" | "invalid-cursor" | "budget-too-small";
export type BuildArtifactReadError = { code: BuildArtifactReadErrorCode; message: string; requiredBytes?: number };
export type BuildArtifactLineage = {
  transformationId: string;
  kind: BuildTransformation["kind"];
  basis: BuildTransformation["basis"];
  direction: "input" | "output";
  relatedArtifactIds: readonly string[];
};
/** One-based line, zero-based UTF-16 column, exclusive end: the positions Inspect reports. */
export type SourcePosition = { line: number; column: number };
export type SourceRange = { start: SourcePosition; end: SourcePosition };
/**
 * A precise exporter-recorded mapping, exposed only after both ranges validated against the exact frozen text
 * of both artifacts. `precision` is `lines` when both ranges cover whole lines and `span` for a sub-line token:
 * a token map says where one token came from, not that anything else on its line is causally related.
 */
export type BuildArtifactMap = {
  transformationId: string;
  /** Position inside the transformation's `locations`; stable across reads. */
  index: number;
  /** Which end of the transformation this artifact is. */
  side: "input" | "output";
  range: SourceRange;
  precision: "lines" | "span";
  counterpart: { artifactId: string; origin: BuildArtifact["origin"]; repositoryPath: string | null; range: SourceRange };
};
export type BuildArtifactMapDiagnostic = {
  transformationId: string;
  reason: "range-reversed" | "range-out-of-bounds" | "counterpart-unavailable";
  count: number;
};
/** `unknown` is a materialized artifact with no recorded incoming transformation: nothing is inferred for it. */
export type BuildArtifactProvenance = "authored" | "external" | "exporter-recorded" | "inferred" | "unknown";
export type BuildArtifactReadResult = {
  citation: { manifestSha256: string; artifactId: string; range: { startLine: number; endLine: number } };
  origin: BuildArtifact["origin"];
  role: BuildArtifact["role"];
  repositoryPath: string | null;
  provenance: BuildArtifactProvenance;
  text: string;
  range: { startLine: number; endLine: number };
  /** Lines in the artifact, so a citation can be bounds-checked without another read. */
  lineCount: number;
  lineage: readonly BuildArtifactLineage[];
  /** Validated precise maps that touch the returned lines. Dropped maps appear only in `mapDiagnostics`. */
  maps: readonly BuildArtifactMap[];
  mapDiagnostics: readonly BuildArtifactMapDiagnostic[];
  delivery: { complete: boolean; truncated: boolean; nextCursor: string | null };
};
export type BuildArtifactReadReply =
  | { ok: true; result: BuildArtifactReadResult }
  | { ok: false; error: BuildArtifactReadError };
type Failure = Extract<BuildArtifactReadReply, { ok: false }>;

export type BuildArtifactDescriptor = {
  id: string;
  role: BuildArtifact["role"];
  origin: BuildArtifact["origin"];
  repositoryPath: string | null;
  state: ArtifactState;
  provenance: BuildArtifactProvenance;
};
export type BuildArtifactInventory = { artifacts: readonly BuildArtifactDescriptor[]; unlistedTextArtifacts: number };

const TEXT_ROLES: Readonly<Record<BuildArtifact["role"], boolean>> = {
  source: true, resource: true, template: true, schema: true, "build-config": true, report: true,
  classes: false, dependency: false,
};
const MAP_REASONS = ["range-reversed", "range-out-of-bounds", "counterpart-unavailable"] as const;
const MAX_BUDGET = 262_144;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function failure(code: BuildArtifactReadErrorCode, message: string, requiredBytes?: number): Failure {
  return { ok: false, error: requiredBytes === undefined ? { code, message } : { code, message, requiredBytes } };
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function cursorKey(
  admission: Admitted, artifact: TextArtifact, request: BuildArtifactReadRequest, policy: SecretPolicy,
): string {
  return digest(JSON.stringify({
    schema: 1, manifestSha256: admission.manifestSha256, artifactId: artifact.id, artifactSha256: artifact.content.sha256,
    range: request.range === null ? null : { startLine: request.range.startLine, endLine: request.range.endLine }, policyId: policy.id,
  }));
}

function encodeCursor(key: string, line: number): string {
  return Buffer.from(JSON.stringify({ schema: 1, key, line }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, key: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!("schema" in parsed) || parsed.schema !== 1 || !("key" in parsed) || parsed.key !== key || !("line" in parsed)) return null;
    return validInteger(parsed.line, 1) ? parsed.line : null;
  } catch {
    return null;
  }
}

function lineage(admission: Admitted, artifactId: string): BuildArtifactLineage[] {
  const result: BuildArtifactLineage[] = [];
  for (const transformation of admission.manifest.transformations) {
    if (transformation.inputArtifactIds.includes(artifactId)) {
      result.push({ transformationId: transformation.id, kind: transformation.kind, basis: transformation.basis,
        direction: "input", relatedArtifactIds: [...transformation.outputArtifactIds] });
    }
    if (transformation.outputArtifactIds.includes(artifactId)) {
      result.push({ transformationId: transformation.id, kind: transformation.kind, basis: transformation.basis,
        direction: "output", relatedArtifactIds: [...transformation.inputArtifactIds] });
    }
  }
  return result;
}

/** Labels each artifact by what is recorded about its origin; an unrecorded materialized artifact stays `unknown`. */
function provenanceIndex(admission: Admitted): (artifact: BuildArtifact) => BuildArtifactProvenance {
  const recorded = new Set<string>();
  const inferred = new Set<string>();
  for (const transformation of admission.manifest.transformations) {
    for (const id of transformation.outputArtifactIds) (transformation.basis === "exporter-recorded" ? recorded : inferred).add(id);
  }
  return (artifact) => {
    if (artifact.origin !== "materialized") return artifact.origin;
    if (recorded.has(artifact.id)) return "exporter-recorded";
    return inferred.has(artifact.id) ? "inferred" : "unknown";
  };
}

/**
 * The retrievable text artifacts a reviewer can name: every materialized one and every authored one a
 * transformation touches. Authored files no transformation touches are ordinary Git files, counted but not listed.
 */
export function describeBuildArtifacts(admission: BuildEvidenceAdmission): BuildArtifactInventory {
  if (admission.outcome !== "admitted") return { artifacts: [], unlistedTextArtifacts: 0 };
  const linked = new Set(admission.manifest.transformations.flatMap((item) => [...item.inputArtifactIds, ...item.outputArtifactIds]));
  const provenance = provenanceIndex(admission);
  const artifacts: BuildArtifactDescriptor[] = [];
  let unlisted = 0;
  for (const artifact of admission.manifest.artifacts) {
    if (artifact.kind !== "file" || !TEXT_ROLES[artifact.role]) continue;
    if (artifact.origin === "authored" && !linked.has(artifact.id)) {
      unlisted += 1;
      continue;
    }
    artifacts.push({
      id: artifact.id, role: artifact.role, origin: artifact.origin, repositoryPath: artifact.repositoryPath,
      state: admission.artifacts.get(artifact.id)?.state ?? "missing", provenance: provenance(artifact),
    });
  }
  return { artifacts, unlistedTextArtifacts: unlisted };
}

// ── line model ─────────────────────────────────────────────────────────────────────────────────

/**
 * Lines end at CRLF, CR or LF, the delimiters Inspect's Java parser counts, and keep their delimiter so the
 * concatenated lines are the exact text. `lengths` exclude the delimiter; columns are UTF-16 code units.
 */
type LineModel = { lines: string[]; lengths: number[]; trailingEmpty: boolean };

function lineModel(text: string): LineModel {
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [""];
  const lengths = lines.map((line) => line.length - (line.endsWith("\r\n") ? 2 : /[\r\n]$/.test(line) ? 1 : 0));
  return { lines, lengths, trailingEmpty: /[\r\n]$/.test(text) };
}

function validPosition(model: LineModel, { line, column }: SourcePosition): boolean {
  if (!validInteger(line, 1) || !validInteger(column, 0)) return false;
  if (line === model.lines.length + 1) return model.trailingEmpty && column === 0;
  if (line > model.lines.length) return false;
  const length = model.lengths[line - 1]!;
  if (column > length) return false;
  if (column > 0 && column < length) {
    const before = model.lines[line - 1]!.charCodeAt(column - 1);
    const after = model.lines[line - 1]!.charCodeAt(column);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) return false; // inside a surrogate pair
  }
  return true;
}

export const positionBefore = (a: SourcePosition, b: SourcePosition): boolean => a.line < b.line || (a.line === b.line && a.column < b.column);
/** The last line a range touches: an end at column 0 of a later line excludes that line. */
export const lastLine = (range: SourceRange): number =>
  range.end.column === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;

function rangeProblem(model: LineModel, range: SourceRange): "range-reversed" | "range-out-of-bounds" | null {
  if (positionBefore(range.end, range.start)) return "range-reversed";
  return validPosition(model, range.start) && validPosition(model, range.end) ? null : "range-out-of-bounds";
}

/**
 * Whether `span` is an ordered, in-bounds UTF-16 range of the artifact, judged against the whole lines `text` carries,
 * which begin at line `firstLine` of the artifact. Unavailable columns or lines cannot validate a claim.
 */
export function spanInExcerpt(text: string, firstLine: number, span: SourceRange): boolean {
  const shift = ({ line, column }: SourcePosition): SourcePosition => ({ line: line - firstLine + 1, column });
  return rangeProblem(lineModel(text), { start: shift(span.start), end: shift(span.end) }) === null;
}

/** True when a valid range starts at a line start and ends at a line end (or the next line start). */
function coversWholeLines(model: LineModel, range: SourceRange): boolean {
  if (range.start.column !== 0 || !positionBefore(range.start, range.end)) return false;
  if (range.end.column === 0 && range.end.line > range.start.line) return true;
  return range.end.column === model.lengths[range.end.line - 1];
}

const copyRange = (range: SourceRange): SourceRange => ({
  start: { line: range.start.line, column: range.start.column }, end: { line: range.end.line, column: range.end.column },
});

// ── frozen text and maps ───────────────────────────────────────────────────────────────────────

type Loaded = { ok: true; artifact: TextArtifact; text: string } | { ok: false; reply: Failure };

/** Reads one admitted text artifact from its frozen bytes, rechecking size, hash and strict UTF-8 each time. */
async function loadText(admission: Admitted, artifactId: string): Promise<Loaded> {
  const artifact = admission.manifest.artifacts.find((item) => item.id === artifactId);
  const status = admission.artifacts.get(artifactId);
  if (!artifact || !status || status.state !== "available") {
    return { ok: false, reply: failure("artifact-unavailable", "Build artifact is unavailable") };
  }
  if (artifact.availability !== "available" || artifact.kind !== "file" || !TEXT_ROLES[artifact.role]) {
    return { ok: false, reply: failure("unsupported-artifact", "Build artifact is not supported text evidence") };
  }
  if (!artifact.encoding || !/^utf-?8$/i.test(artifact.encoding)) {
    return { ok: false, reply: failure("unsupported-encoding", "Build artifact encoding is not supported") };
  }
  const frozen = admission.frozen.available.get(artifactId);
  if (!frozen) return { ok: false, reply: failure("artifact-unavailable", "Build artifact is unavailable") };
  let bytes: Buffer;
  try {
    bytes = await readFile(frozen.path);
  } catch {
    return { ok: false, reply: failure("artifact-unavailable", "Frozen build artifact could not be read") };
  }
  if (bytes.length !== artifact.content.sizeBytes || digest(bytes) !== artifact.content.sha256) {
    return { ok: false, reply: failure("snapshot-mismatch", "Frozen build artifact changed after admission") };
  }
  try {
    return { ok: true, artifact, text: utf8.decode(bytes) };
  } catch {
    return { ok: false, reply: failure("unsupported-encoding", "Build artifact is not valid UTF-8") };
  }
}

type MapScan =
  | { ok: true; maps: BuildArtifactMap[]; diagnostics: BuildArtifactMapDiagnostic[] }
  | { ok: false; reply: Failure };

/**
 * Validates every exporter-recorded mapping that touches this artifact against the exact text of both ends.
 * An invalid or unverifiable mapping is dropped with a counted reason and never authorizes a line anchor;
 * file-level lineage is unaffected. A counterpart that is unreadable now (withheld by the refreshed policy,
 * unsupported encoding, unavailable) only degrades its own maps; a changed counterpart fails the read.
 */
async function scanMaps(admission: Admitted, artifact: TextArtifact, model: LineModel, policy: SecretPolicy): Promise<MapScan> {
  const counterparts = new Map<string, LineModel | null>();
  const counts = new Map<string, number>();
  const maps: BuildArtifactMap[] = [];
  for (const [position, transformation] of admission.manifest.transformations.entries()) {
    if (transformation.basis !== "exporter-recorded") continue;
    for (const [index, location] of transformation.locations.entries()) {
      for (const side of ["input", "output"] as const) {
        const own = side === "input" ? location.inputArtifactId : location.outputArtifactId;
        if (own !== artifact.id) continue;
        const otherId = side === "input" ? location.outputArtifactId : location.inputArtifactId;
        const thisRange = side === "input" ? location.inputRange : location.outputRange;
        const otherRange = side === "input" ? location.outputRange : location.inputRange;
        if (otherId !== artifact.id && !counterparts.has(otherId)) {
          const loaded = await loadText(admission, otherId);
          if (loaded.ok) counterparts.set(otherId, screenText(loaded.text, policy).state === "available" ? lineModel(loaded.text) : null);
          else if (loaded.reply.error.code === "snapshot-mismatch") return { ok: false, reply: loaded.reply };
          else counterparts.set(otherId, null);
        }
        const other = otherId === artifact.id ? model : counterparts.get(otherId);
        const otherArtifact = admission.manifest.artifacts.find((item) => item.id === otherId);
        const reason = !other || !otherArtifact ? "counterpart-unavailable"
          : rangeProblem(model, thisRange) === "range-reversed" || rangeProblem(other, otherRange) === "range-reversed" ? "range-reversed"
          : rangeProblem(model, thisRange) !== null || rangeProblem(other, otherRange) !== null ? "range-out-of-bounds"
          : null;
        if (reason !== null || !other || !otherArtifact) {
          const key = `${position}:${MAP_REASONS.indexOf(reason ?? "counterpart-unavailable")}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          continue;
        }
        maps.push({
          transformationId: transformation.id, index, side, range: copyRange(thisRange),
          precision: coversWholeLines(model, thisRange) && coversWholeLines(other, otherRange) ? "lines" : "span",
          counterpart: {
            artifactId: otherId, origin: otherArtifact.origin, repositoryPath: otherArtifact.repositoryPath, range: copyRange(otherRange),
          },
        });
      }
    }
  }
  const diagnostics = [...counts].map(([key, count]) => {
    const [position, reason] = key.split(":").map(Number);
    return { position: position!, reason: reason!, count };
  }).sort((a, b) => a.position - b.position || a.reason - b.reason).map(({ position, reason, count }) => ({
    transformationId: admission.manifest.transformations[position]!.id, reason: MAP_REASONS[reason]!, count,
  }));
  return { ok: true, maps, diagnostics };
}

function responseBytes(result: BuildArtifactReadResult): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, result }), "utf8");
}

const jsonContentBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), "utf8") - 2;

/** Reads only frozen, screened text bytes from one admitted manifest; paths never come from the caller. */
export async function readBuildArtifact(
  admission: BuildEvidenceAdmission, request: BuildArtifactReadRequest, policy: SecretPolicy,
): Promise<BuildArtifactReadReply> {
  if (!request || typeof request !== "object" || typeof request.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.manifestSha256) || typeof request.artifactId !== "string" || request.artifactId.length === 0 ||
    !validInteger(request.byteBudget, 1) || request.byteBudget > MAX_BUDGET ||
    (request.range !== null && (!request.range || typeof request.range !== "object" ||
      !validInteger(request.range.startLine, 1) || !validInteger(request.range.endLine, 1) || request.range.startLine > request.range.endLine)) ||
    (request.cursor !== undefined && typeof request.cursor !== "string")) {
    return failure("invalid-input", "Invalid build artifact read request");
  }
  if (admission.outcome !== "admitted") return failure("artifact-unavailable", "Build evidence is not admitted for this side");
  if (request.manifestSha256 !== admission.manifestSha256) return failure("snapshot-mismatch", "Build artifact manifest differs from the admitted snapshot");
  const loaded = await loadText(admission, request.artifactId);
  if (!loaded.ok) return loaded.reply;
  const { artifact, text } = loaded;
  await refreshSecretPolicy(policy);
  const exposure = screenText(text, policy);
  if (exposure.state === "withheld") return failure(exposure.reason, "Build artifact is withheld by the secret policy");

  const model = lineModel(text);
  const scan = await scanMaps(admission, artifact, model, policy);
  if (!scan.ok) return scan.reply;
  const provenance = provenanceIndex(admission)(artifact);
  const history = lineage(admission, artifact.id);
  const exposedMetadata = [
    admission.manifestSha256, artifact.id, artifact.role, artifact.origin, provenance,
    ...(artifact.repositoryPath === null ? [] : [artifact.repositoryPath]),
    ...history.flatMap((item) => [item.transformationId, item.kind, item.basis, item.direction, ...item.relatedArtifactIds]),
    ...scan.maps.flatMap((map) => [
      map.transformationId, map.side, map.precision, map.counterpart.artifactId, map.counterpart.origin,
      ...(map.counterpart.repositoryPath === null ? [] : [map.counterpart.repositoryPath]),
    ]),
    ...scan.diagnostics.flatMap((item) => [item.transformationId, item.reason]),
  ];
  const metadataExposure = exposedMetadata.map((value) => screenText(value, policy))
    .find((decision) => decision.state === "withheld");
  if (metadataExposure?.state === "withheld") {
    return failure(metadataExposure.reason, "Build artifact metadata is withheld by the secret policy");
  }

  const total = model.lines.length;
  const requestedStart = request.range?.startLine ?? 1;
  const requestedEnd = Math.min(request.range?.endLine ?? total, total);
  if (requestedStart > total) return failure("invalid-input", "Requested line range is outside the build artifact");
  const key = cursorKey(admission, artifact, request, policy);
  const start = request.cursor === undefined ? requestedStart : decodeCursor(request.cursor, key);
  if (start === null || start < requestedStart || start > requestedEnd) return failure("invalid-cursor", "Build artifact cursor does not match this read");

  // A map is delivered with the page that carries any of its lines; the page's byte budget counts it.
  const located = scan.maps.map((map) => ({
    map, first: Math.min(map.range.start.line, total), last: Math.min(lastLine(map.range), total),
    bytes: Buffer.byteLength(JSON.stringify(map), "utf8"),
  })).filter((item) => item.last >= start);
  const mapsThrough = (end: number): BuildArtifactMap[] => located.filter((item) => item.first <= end).map((item) => item.map);
  const build = (end: number, chunk: string, complete: boolean, pageMaps: BuildArtifactMap[]): BuildArtifactReadResult => ({
    citation: { manifestSha256: admission.manifestSha256, artifactId: artifact.id, range: { startLine: start, endLine: end } },
    origin: artifact.origin, role: artifact.role, repositoryPath: artifact.repositoryPath, provenance,
    text: chunk, range: { startLine: start, endLine: end }, lineCount: total, lineage: history, maps: pageMaps,
    mapDiagnostics: scan.diagnostics,
    delivery: { complete, truncated: !complete, nextCursor: complete ? null : encodeCursor(key, end + 1) },
  });

  // Sizes add up exactly: JSON string escapes are per character, so each whole line contributes its own escaped
  // length and the only line-dependent metadata is the digit count of the range and cursor numbers.
  const metaCache = new Map<string, number>();
  const metaBytes = (line: number, complete: boolean): number => {
    const shape = `${String(line).length}:${String(line + 1).length}:${complete}`;
    let bytes = metaCache.get(shape);
    if (bytes === undefined) {
      bytes = responseBytes(build(line, "", complete, []));
      metaCache.set(shape, bytes);
    }
    return bytes;
  };
  const byFirst = [...located].sort((a, b) => a.first - b.first);
  let included = 0;
  let mapBytes = 0;
  let textBytes = 0;
  let end = start - 1;
  let firstPage: { exact: number; headerOnly: boolean } | undefined;
  for (let line = start; line <= requestedEnd; line++) {
    while (included < byFirst.length && byFirst[included]!.first <= line) mapBytes += byFirst[included++]!.bytes;
    const complete = line === requestedEnd;
    const lineBytes = jsonContentBytes(model.lines[line - 1]!);
    const required = metaBytes(line, complete) + textBytes + lineBytes + (included > 0 ? mapBytes + included - 1 : 0);
    if (required > request.byteBudget) {
      if (end < start) {
        firstPage = {
          exact: responseBytes(build(line, model.lines[line - 1]!, complete, mapsThrough(line))),
          headerOnly: metaBytes(line, complete) > request.byteBudget,
        };
      }
      break;
    }
    textBytes += lineBytes;
    end = line;
  }
  const finish = (last: number): BuildArtifactReadResult =>
    build(last, model.lines.slice(start - 1, last).join(""), last === requestedEnd, mapsThrough(last));
  /**
   * Size of the reply that delivers every requested line, or null once a lower bound already exceeds `limit`. Completing drops
   * the cursor, so this can cost less than a shorter incomplete page: cost is not monotonic in the number of lines.
   */
  const completeBytes = (limit: number): number | null => {
    let bound = metaBytes(requestedEnd, true);
    let count = 0;
    let mapSum = 0;
    for (const item of located) if (item.first <= requestedEnd) { mapSum += item.bytes; count += 1; }
    bound += count > 0 ? mapSum + count - 1 : 0;
    for (let line = start; line <= requestedEnd; line++) {
      bound += jsonContentBytes(model.lines[line - 1]!);
      if (bound > limit) return null;
    }
    return responseBytes(finish(requestedEnd));
  };
  if (end < requestedEnd) {
    const whole = completeBytes(request.byteBudget);
    if (whole !== null && whole <= request.byteBudget) return { ok: true, result: finish(requestedEnd) };
  }
  if (end < start) {
    // Nothing fits as an incomplete page and the whole range does not fit either: report the true minimum of the two.
    const first = firstPage!;
    const whole = completeBytes(first.exact);
    return failure(
      "budget-too-small", first.headerOnly ? "Response header exceeds byte budget" : "Next build artifact line exceeds byte budget",
      whole === null ? first.exact : Math.min(first.exact, whole),
    );
  }
  let result = finish(end);
  while (responseBytes(result) > request.byteBudget) {
    if (end <= start) return failure("budget-too-small", "Next build artifact line exceeds byte budget", responseBytes(result));
    end -= 1;
    result = finish(end);
  }
  return { ok: true, result };
}

// ── paged inventory ────────────────────────────────────────────────────────────────────────────

export type BuildArtifactListRequest = { side: "base" | "head"; manifestSha256: string; byteBudget: number; cursor?: string };
export type BuildArtifactListResult = {
  side: "base" | "head";
  manifestSha256: string;
  /** Listed artifacts across all pages; screened-out descriptors are counted in `withheld`, never listed. */
  total: number;
  withheld: number;
  artifacts: readonly BuildArtifactDescriptor[];
  delivery: { complete: boolean; truncated: boolean; nextCursor: string | null };
};
export type BuildArtifactListReply =
  | { ok: true; result: BuildArtifactListResult }
  | { ok: false; error: BuildArtifactReadError };

/**
 * Read-only inventory of every retrievable text artifact of one admitted manifest, in manifest order, paged by bytes with
 * a cursor bound to the manifest, the policy and the inventory size. Descriptors are identifiers and labels only (never
 * content), re-screened against the refreshed policy on every call; a withheld descriptor is counted, not listed. A list
 * reply is never citable evidence. No count limit applies: every admitted ID is reachable by following the cursor.
 */
export async function listBuildArtifacts(
  admission: BuildEvidenceAdmission, request: BuildArtifactListRequest, policy: SecretPolicy,
): Promise<BuildArtifactListReply> {
  if (!request || typeof request !== "object" || (request.side !== "base" && request.side !== "head") ||
    typeof request.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(request.manifestSha256) ||
    !validInteger(request.byteBudget, 1) || request.byteBudget > MAX_BUDGET || (request.cursor !== undefined && typeof request.cursor !== "string")) {
    return failure("invalid-input", "Invalid build artifact list request");
  }
  if (admission.outcome !== "admitted") return failure("artifact-unavailable", "Build evidence is not admitted for this side");
  if (request.manifestSha256 !== admission.manifestSha256) return failure("snapshot-mismatch", "Build artifact manifest differs from the admitted snapshot");
  await refreshSecretPolicy(policy);
  const manifestDecision = screenText(admission.manifestSha256, policy);
  if (manifestDecision.state === "withheld") return failure(manifestDecision.reason, "Build artifact listing is withheld by the secret policy");
  const listed: BuildArtifactDescriptor[] = [];
  let withheld = 0;
  for (const item of describeBuildArtifacts(admission).artifacts) {
    const scalars = [item.id, item.role, item.origin, item.state, item.provenance, ...(item.repositoryPath === null ? [] : [item.repositoryPath])];
    if (scalars.some((value) => screenText(value, policy).state === "withheld")) withheld += 1;
    else listed.push(item);
  }
  const key = digest(JSON.stringify({ schema: 1, list: true, side: request.side, manifestSha256: admission.manifestSha256, policyId: policy.id, total: listed.length, withheld }));
  const decoded = request.cursor === undefined ? 0 : decodeCursor(request.cursor, key);
  if (decoded === null || decoded - 1 > listed.length) return failure("invalid-cursor", "Build artifact listing cursor does not match this listing");
  const from = request.cursor === undefined ? 0 : decoded - 1;
  const reply = (end: number, complete: boolean): BuildArtifactListResult => ({
    side: request.side, manifestSha256: admission.manifestSha256, total: listed.length, withheld, artifacts: listed.slice(from, end),
    delivery: { complete, truncated: !complete, nextCursor: complete ? null : encodeCursor(key, end + 1) },
  });
  const bytes = (end: number, complete: boolean): number => Buffer.byteLength(JSON.stringify({ ok: true, result: reply(end, complete) }), "utf8");
  const itemBytes = (index: number): number => Buffer.byteLength(JSON.stringify(listed[index]), "utf8");

  // Completing drops the cursor, so try the complete remainder before pricing any incomplete prefix. Its additive size is exact;
  // stop as soon as the bound exceeds the relevant limit, without slicing or serializing a large remaining inventory.
  const completeBytes = (limit: number): number | null => {
    let total = bytes(from, true);
    if (total > limit) return null;
    for (let index = from; index < listed.length; index++) {
      total += itemBytes(index) + (index > from ? 1 : 0);
      if (total > limit) return null;
    }
    return total;
  };
  const complete = completeBytes(request.byteBudget);
  if (complete !== null) return { ok: true, result: reply(listed.length, true) };
  if (from === listed.length) {
    return failure("budget-too-small", "Build artifact listing page exceeds byte budget", bytes(from, true));
  }
  const header = bytes(from, false);
  let sum = 0;
  let end = from;
  while (end < listed.length - 1 && header + sum + itemBytes(end) + (end > from ? 1 : 0) <= request.byteBudget) {
    sum += itemBytes(end) + (end > from ? 1 : 0);
    end += 1;
  }
  // Cursor lengths can change as the end index grows: validate the final encoded reply, shrinking deterministically if needed.
  while (end > from && bytes(end, false) > request.byteBudget) end -= 1;
  if (end > from) return { ok: true, result: reply(end, false) };
  const firstExact = bytes(from + 1, listed.length === from + 1);
  const whole = completeBytes(firstExact);
  return failure("budget-too-small", "Build artifact listing page exceeds byte budget",
    whole === null ? firstExact : Math.min(firstExact, whole));
}
