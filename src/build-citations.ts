import { z } from "zod";
import {
  lastLine, positionBefore, spanInExcerpt,
  type BuildArtifactMap, type BuildArtifactReadResult, type SourceRange,
} from "./build-artifact-reader.js";

/**
 * Content citations for findings: `{ manifestSha256, artifactId, range, span? }`, with a null range for whole-file
 * evidence. A bare logical path cannot say whether original or transformed bytes were meant, so a citation binds
 * the exact admitted artifact. The optional `span` is an exact UTF-16 claim inside the line-range envelope: it
 * restates the cited lines and narrows them, nothing more. The model supplies citations; the host resolves each
 * against what the phase actually retrieved, and only the host's resolution may place a finding at a Git position.
 */

const lineRange = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict();
const position = z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative() }).strict();
const sourceRange = z.object({ start: position, end: position }).strict().refine((range) => !positionBefore(range.end, range.start), {
  message: "span end precedes start",
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const buildCitationSchema = z.object({
  manifestSha256: sha256, artifactId: z.string().min(1), range: lineRange.nullable(), span: sourceRange.optional(),
}).strict().refine((citation) => citation.range === null || citation.range.endLine >= citation.range.startLine, {
  message: "range end precedes start", path: ["range"],
}).refine((citation) => citation.span === undefined || (citation.range !== null
  && citation.range.startLine === citation.span.start.line && citation.range.endLine === lastLine(citation.span)), {
  message: "span must restate the cited lines", path: ["span"],
});

/** What the host knows after resolution: the artifact's own identity and why the citation holds. */
export const resolvedBuildCitationSchema = z.object({
  manifestSha256: sha256, artifactId: z.string().min(1), side: z.enum(["base", "head"]), range: lineRange, span: sourceRange.optional(),
  origin: z.enum(["authored", "materialized", "external"]), repositoryPath: z.string().nullable(),
  basis: z.enum(["retrieved", "validated-map"]),
}).strict();

export const buildAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original"), basis: z.enum(["independent-read", "validated-map"]) }).strict(),
  z.object({ kind: z.literal("output-only") }).strict(),
  z.object({ kind: z.literal("base-only") }).strict(),
  z.object({ kind: z.literal("unanchored") }).strict(),
]);

export type BuildCitation = z.infer<typeof buildCitationSchema>;
export type ResolvedBuildCitation = z.infer<typeof resolvedBuildCitationSchema>;
export type BuildAnchor = z.infer<typeof buildAnchorSchema>;
export type BuildCitable = { file: string; line: number; build_citations?: readonly BuildCitation[] };
export type BuildResolution =
  | { ok: true; citations: ResolvedBuildCitation[]; anchor: BuildAnchor | null }
  | { ok: false; reason: string };
export type BuildCitationResolver = (finding: BuildCitable) => BuildResolution;

type LineSpan = { startLine: number; endLine: number };
type Receipt = {
  evidenceId: string;
  /** Which revision's export the read came from, taken from the successful tool call, never from a citation. */
  side: "base" | "head";
  manifestSha256: string;
  artifactId: string;
  origin: ResolvedBuildCitation["origin"];
  repositoryPath: string | null;
  lineCount: number;
  /** The lines this read actually returned, with their exact text. */
  range: LineSpan;
  text: string;
  maps: readonly BuildArtifactMap[];
};

const withinSpan = (outer: LineSpan, inner: LineSpan): boolean => outer.startLine <= inner.startLine && inner.endLine <= outer.endLine;
const mapLines = (range: SourceRange): LineSpan => ({ startLine: range.start.line, endLine: lastLine(range) });
const sameRange = (a: SourceRange, b: SourceRange): boolean =>
  a.start.line === b.start.line && a.start.column === b.start.column && a.end.line === b.end.line && a.end.column === b.end.column;
const copySpan = (range: SourceRange): SourceRange => ({
  start: { line: range.start.line, column: range.start.column }, end: { line: range.end.line, column: range.end.column },
});

/** Whether the union of `available` spans contains every line of `wanted`. */
function covered(wanted: LineSpan, available: readonly LineSpan[]): boolean {
  let next = wanted.startLine;
  for (const span of [...available].sort((a, b) => a.startLine - b.startLine)) {
    if (span.startLine > next) return false;
    next = Math.max(next, span.endLine + 1);
    if (next > wanted.endLine) return true;
  }
  return next > wanted.endLine;
}

/**
 * Receipts of successful artifact reads, keyed by the tool's evidence ID. A citation resolves only against the
 * receipts of the phase that makes it, so a verifier cannot lean on a discovery leg's read and a citation can
 * never name bytes nobody retrieved. Failed reads leave no receipt.
 */
export class BuildEvidenceLedger {
  readonly #receipts: Receipt[] = [];

  record(evidenceId: string, side: "base" | "head", result: BuildArtifactReadResult): void {
    this.#receipts.push({
      evidenceId, side, manifestSha256: result.citation.manifestSha256, artifactId: result.citation.artifactId, origin: result.origin,
      repositoryPath: result.repositoryPath, lineCount: result.lineCount, range: result.range, text: result.text, maps: result.maps,
    });
  }

  /**
   * A citation holds in one of two ways. (retrieved) The phase's own reads returned its lines, and a cited span lies
   * inside one returned excerpt: an independent read. (validated-map) The cited artifact is the counterpart of an
   * exporter-recorded map from a phase read whose returned excerpt covers the whole mapped range, and the finding also
   * cites that mapped range of the read artifact, itself retrieved by the phase (never through another map, so maps
   * cannot vouch for each other). A line-level citation rides only on a whole-line map and must be fully contained in
   * its lines on both ends; a span citation must EQUAL the declared map spans on both ends, because a map relates two
   * declared spans and implies no offsets inside them. The anchor is `original` only when a resolved authored
   * citation is the finding's own file and line; whether the original is the root cause is never decided here.
   */
  resolve(finding: BuildCitable, evidenceIds: ReadonlySet<string>): BuildResolution {
    const cited = finding.build_citations ?? [];
    if (cited.length === 0) return { ok: true, citations: [], anchor: null };
    const receipts = this.#receipts.filter((item) => evidenceIds.has(item.evidenceId));
    const fail = (index: number, why: string): BuildResolution => ({ ok: false, reason: `build citation ${index} ${why}` });
    const seen = new Set<string>();
    for (const [index, citation] of cited.entries()) {
      const identity = JSON.stringify([citation.manifestSha256, citation.artifactId, citation.range, citation.span ?? null]);
      if (seen.has(identity)) return fail(index, "repeats an earlier citation");
      seen.add(identity);
    }

    const resolved: (ResolvedBuildCitation | undefined)[] = cited.map(() => undefined);
    for (const [index, citation] of cited.entries()) {
      const known = receipts.filter((item) => item.manifestSha256 === citation.manifestSha256 && item.artifactId === citation.artifactId);
      const first = known[0];
      const wanted: LineSpan | null = citation.range ?? (first ? { startLine: 1, endLine: first.lineCount } : null);
      if (first && wanted && wanted.endLine > first.lineCount) return fail(index, "is outside the artifact");
      if (!first || !wanted || !covered(wanted, known.map((item) => item.range))) continue;
      const span = citation.span;
      if (span && !known.some((item) => withinSpan(item.range, wanted) && spanInExcerpt(item.text, item.range.startLine, span))) {
        return fail(index, "has a span outside the retrieved text");
      }
      resolved[index] = {
        manifestSha256: citation.manifestSha256, artifactId: citation.artifactId, side: known.some((item) => item.side === "head") ? "head" : first.side,
        range: { ...wanted }, ...(span ? { span: copySpan(span) } : {}), origin: first.origin, repositoryPath: first.repositoryPath,
        basis: "retrieved",
      };
    }
    for (const [index, citation] of cited.entries()) {
      if (resolved[index]) continue;
      const counterpart = citation.range ? this.#mapped(citation, citation.range, cited, resolved, receipts) : null;
      if (!citation.range || !counterpart) return fail(index, "was neither retrieved in this phase nor reached by a validated map");
      resolved[index] = {
        manifestSha256: citation.manifestSha256, artifactId: citation.artifactId, side: counterpart.side, range: { ...citation.range },
        ...(citation.span ? { span: copySpan(citation.span) } : {}),
        origin: counterpart.origin, repositoryPath: counterpart.repositoryPath, basis: "validated-map",
      };
    }

    const citations = resolved as ResolvedBuildCitation[];
    // Review comments publish on the head revision, so only a head-side authored citation may anchor inline; evidence read from
    // the base revision (whose bytes at the same path and line may differ) stays supporting until a head read verifies it.
    const at = (item: ResolvedBuildCitation) => item.origin === "authored" && item.repositoryPath === finding.file
      && item.range.startLine <= finding.line && finding.line <= item.range.endLine;
    // An independent read of the same location outranks a mapped citation, whatever order the model listed them in.
    const original = citations.find((item) => item.side === "head" && item.basis === "retrieved" && at(item))
      ?? citations.find((item) => item.side === "head" && at(item));
    const anchor: BuildAnchor | null = original
      ? { kind: "original", basis: original.basis === "retrieved" ? "independent-read" : "validated-map" }
      : citations.some((item) => item.side === "base" && at(item))
        ? { kind: "base-only" }
        : citations.some((item) => item.origin === "materialized" && (item.repositoryPath === null || item.repositoryPath === finding.file))
          ? { kind: "output-only" }
          : { kind: "unanchored" }; // citations that do not verify the claimed file and line never fall back to a legacy inline
    return { ok: true, citations, anchor };
  }

  #mapped(
    citation: BuildCitation, wanted: LineSpan, cited: readonly BuildCitation[], resolved: readonly (ResolvedBuildCitation | undefined)[],
    receipts: readonly Receipt[],
  ): { side: "base" | "head"; origin: ResolvedBuildCitation["origin"]; repositoryPath: string | null } | null {
    for (const receipt of receipts) {
      if (receipt.manifestSha256 !== citation.manifestSha256) continue;
      for (const map of receipt.maps) {
        if (map.counterpart.artifactId !== citation.artifactId) continue;
        const mappedLines = mapLines(map.range);
        if (!withinSpan(receipt.range, mappedLines)) continue; // the returned excerpt must cover the whole declared range
        if (citation.span) {
          if (!sameRange(citation.span, map.counterpart.range)) continue;
        } else if (map.precision !== "lines" || !withinSpan(mapLines(map.counterpart.range), wanted)) {
          continue;
        }
        const paired = cited.some((other, position) => {
          const done = resolved[position];
          if (!done || done.basis !== "retrieved" || other.manifestSha256 !== receipt.manifestSha256 || other.artifactId !== receipt.artifactId) return false;
          return citation.span
            ? done.span !== undefined && sameRange(done.span, map.range)
            : map.precision === "lines" && withinSpan(mappedLines, done.range);
        });
        if (paired) return { side: receipt.side, origin: map.counterpart.origin, repositoryPath: map.counterpart.repositoryPath };
      }
    }
    return null;
  }
}
