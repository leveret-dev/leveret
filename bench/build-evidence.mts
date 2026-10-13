#!/usr/bin/env node
// End-to-end evaluation of the optional build-evidence contract against the real client-export fixture command, the
// installed analysis worker and (review mode only) the real Leveret reviewer with a real configured model.
//
//   tsx bench/build-evidence.mts --mode deterministic|review --config <template.json> --config-sha256 <sha> --output <new-dir>
//
// The client export runs as its own process, outside the analysis worker, exactly as a client pipeline stage would.
// Cases the five exporter modes cannot produce are derived by republishing the real head export with one documented
// mutation and a fresh pin; they are labelled with that derivation in the report.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ArtifactState } from "../src/build-evidence.js";
import type { BuildEvidencePin } from "../src/build-evidence-contract.js";
import { spanInExcerpt } from "../src/build-artifact-reader.js";
import { buildCitationSchema } from "../src/build-citations.js";
import { buildChangeManifest, type ChangeManifest } from "../src/change-evidence.js";
import { InspectJavaError, openInspectJava, type InspectJavaBridge } from "../src/inspect-java.js";
import { referenceReplySchema } from "../src/inspect-java-contract.js";
import { pathIsInside } from "../src/path.js";
import {
  FIXTURE_REPOSITORY_ID, FIXTURE_SECRET_MARKER, createBuildFixture, fixtureSelectedArtifacts,
  type BuildFixture, type BuildFixtureMode,
} from "../test/build-evidence-fixture.js";
import {
  citingRecords, eventPayload, evaluationArguments, hashFile, pinnedConfig, readRunnerEvents, runPiReview, submittedPayloads,
  templateSchema, toolReply, type OperatorTemplate, type ReviewOutput, type RunnerEvent,
} from "./review-evidence.mjs";

// ── consumption verification: what the real reviewer actually retrieved and then submitted ──────────────────────

export interface BuildConsumptionExpectation {
  side: "base" | "head";
  manifestSha256: string;
  originalArtifactId: string;
  generatedArtifactId: string;
  originalPath: string;
  /** The scenario carries a generation/lineage gap the reviewer must disclose (and the tool replies must actually show). */
  requireGap: boolean;
}

export interface BuildConsumptionVerdict {
  status: "verified" | "unverified";
  originalRetrieved: boolean;
  generatedRetrieved: boolean;
  submittedUse: boolean;
  gapDisclosed: boolean;
  toolCallIds: string[];
}

const BUILD_TOOL = "leveret_build_artifact";
const buildReadCall = z.looseObject({
  tool: z.literal(BUILD_TOOL),
  args: z.looseObject({ side: z.string(), manifestSha256: z.string(), artifactId: z.string() }),
});
const readSuccess = z.looseObject({
  ok: z.literal(true),
  result: z.looseObject({
    citation: z.looseObject({ manifestSha256: z.string(), artifactId: z.string() }),
    origin: z.string(), repositoryPath: z.string().nullable(), provenance: z.string(), text: z.string(),
    range: z.object({ startLine: z.number().int(), endLine: z.number().int() }), lineCount: z.number().int(),
    mapDiagnostics: z.array(z.looseObject({ reason: z.string() })),
  }),
});
type ReadResult = z.infer<typeof readSuccess>["result"];
const readRefusal = z.looseObject({ ok: z.literal(false), error: z.looseObject({ code: z.string() }) });
const citedRecord = z.looseObject({
  file: z.string().optional(), evidence_ids: z.array(z.string()).default([]), build_citations: z.array(buildCitationSchema).default([]),
});

/** One tool call: a successful excerpt read, or a typed refusal. Reads of other manifests, sides or artifacts are not tracked. */
type Read = { id: string; end: number; session: string | undefined; artifactId: string } &
  ({ result: ReadResult; refusal: null } | { result: null; refusal: string });

const toolEnd = (events: readonly RunnerEvent[], started: RunnerEvent): RunnerEvent | undefined =>
  events.find((event) => event.category === "tools" && event.event === "execution_end" && event.tool_call_id === started.tool_call_id && event.sequence > started.sequence);

async function collectReads(trace: string, events: readonly RunnerEvent[], expected: BuildConsumptionExpectation): Promise<Read[]> {
  const reads: Read[] = [];
  for (const started of events) {
    if (started.category !== "tools" || started.event !== "execution_start" || !started.tool_call_id) continue;
    const call = buildReadCall.safeParse(await eventPayload(trace, started));
    if (!call.success) continue; // another tool, or a list request: an inventory is never a retrieval
    const { side, manifestSha256, artifactId } = call.data.args;
    if (side !== expected.side || manifestSha256 !== expected.manifestSha256 ||
      (artifactId !== expected.originalArtifactId && artifactId !== expected.generatedArtifactId)) continue;
    const ended = toolEnd(events, started);
    if (!ended) continue;
    const reply = await eventPayload(trace, ended);
    if (reply.is_error === true) continue;
    const base = { id: started.tool_call_id, end: ended.sequence, session: started.session_id, artifactId };
    const parsed = toolReply(reply);
    const success = readSuccess.safeParse(parsed);
    const refusal = readRefusal.safeParse(parsed);
    if (success.success) {
      // The reply states the identity it served; a call whose answer names another manifest or artifact retrieved nothing asked for.
      const { result } = success.data;
      if (result.citation.manifestSha256 === expected.manifestSha256 && result.citation.artifactId === artifactId) reads.push({ ...base, result, refusal: null });
    } else if (refusal.success) {
      reads.push({ ...base, result: null, refusal: refusal.data.error.code });
    }
  }
  return reads;
}

/** Objects anywhere in a submission that carry citations: a finding, concern or coverage entry is one record. */
function citingObjects(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) citingObjects(item, found);
  } else if (value && typeof value === "object") {
    const fields = z.record(z.string(), z.unknown()).parse(value);
    if ("evidence_ids" in fields || "build_citations" in fields) found.push(fields);
    for (const child of Object.values(fields)) citingObjects(child, found);
  }
  return found;
}

const proseOf = (record: Record<string, unknown>): string => Object.entries(record)
  .filter(([key]) => !["file", "id", "evidence_ids", "build_citations", "lead_ids"].includes(key))
  .flatMap(([, value]) => typeof value === "string" ? [value] : Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [])
  .join("\n");

/**
 * What an honest disclosure must say, by the state the generated read ACTUALLY reported. A record counts only if it carries a topic
 * word and a word describing that state. Equivalent wording for the same state is accepted ("inferred", or an explicit lack of a
 * validated or exporter-recorded map); a different state is not ("unknown" does not describe a lineage the read called inferred).
 */
const NEGATED = "(?:no|not|without|lacks?|lacking)\\s+(?:an?\\s+|any\\s+|the\\s+)?";
const LINEAGE_TOPIC = /\b(?:lineage|provenance|transformation|maps?|mapping|attribution)\b/i;
const GAP_STATES = {
  inferred: { topic: LINEAGE_TOPIC, state: new RegExp(`\\b(?:inferred|unvalidated)\\b|\\b${NEGATED}(?:validated|exporter[- ]recorded)\\b`, "i") },
  unknown: { topic: LINEAGE_TOPIC, state: new RegExp(`\\b(?:unknown|unrecorded)\\b|\\b${NEGATED}(?:exporter[- ])?recorded\\b`, "i") },
  maps: {
    topic: LINEAGE_TOPIC,
    state: /\b(?:invalid|out[- ]of[- ]bounds|reversed|dropped|rejected|unvalidated|counterpart[- ]unavailable)\b|\bfailed (?:validation|to validate)\b|\bnot validated\b/i,
  },
  unavailable: {
    topic: /\b(?:generated|output|generation)\b/i,
    state: /\b(?:unavailable|not produced|not generated|missing|absent|failed|could not|denied|withheld)\b/i,
  },
} as const;
type GapKind = keyof typeof GAP_STATES;

/**
 * Verifies actual consumption from the private audit trace. Within ONE accepted submission there must be a use record: the
 * original's path, citing BOTH views, each backed by a successful earlier read of the expected manifest in the same session (the
 * record lists that read's evidence ID and cites lines it returned; a span must lie inside the returned text, as the host requires
 * of an independent read). A citation that no such read backs invalidates its record. An unavailable generated view is excused
 * only by a typed denial plus a stated gap. When the reads show a lineage or availability gap, the same submission must describe
 * that state in the use record or in a record that itself cites the backed generated read. Titles, thinking, other submissions,
 * sessions or sides never count.
 */
export async function verifyBuildEvidenceConsumption(traceDir: string, expected: BuildConsumptionExpectation): Promise<BuildConsumptionVerdict> {
  const events = await readRunnerEvents(traceDir);
  const reads = await collectReads(traceDir, events, expected);
  const succeeded = reads.flatMap((read) => read.result === null ? [] : [{ ...read, result: read.result }]);
  const { originalArtifactId: original, generatedArtifactId: generated } = expected;
  const originalRetrieved = succeeded.some((read) => read.artifactId === original && read.result.origin === "authored" && read.result.repositoryPath === expected.originalPath);
  const generatedRetrieved = succeeded.some((read) => read.artifactId === generated && read.result.origin !== "authored");
  const generatedRefused = reads.some((read) => read.artifactId === generated && read.refusal !== null);
  const excused = expected.requireGap && !generatedRetrieved && generatedRefused;

  let submittedUse = false;
  let gapDisclosed = false;
  for await (const { event, args } of submittedPayloads(traceDir, events, 0)) {
    const phaseReads = succeeded.filter((read) => read.session === event.session_id && read.end < event.sequence);
    const kinds = new Set<GapKind>();
    for (const read of phaseReads) {
      if (read.artifactId === generated && read.result.provenance === "inferred") kinds.add("inferred");
      if (read.artifactId === generated && read.result.provenance === "unknown") kinds.add("unknown");
      if (read.result.mapDiagnostics.length > 0) kinds.add("maps");
    }
    if (!generatedRetrieved && generatedRefused) kinds.add("unavailable");

    let used = false;
    const candidates: string[] = [];
    for (const fields of citingObjects(args)) {
      const parsed = citedRecord.safeParse(fields);
      if (!parsed.success) continue;
      const { evidence_ids: ids, build_citations: citations } = parsed.data;
      const backed = new Set<string>();
      let fabricated = false;
      for (const citation of citations) {
        if (citation.manifestSha256 !== expected.manifestSha256 || (citation.artifactId !== original && citation.artifactId !== generated)) continue;
        const supports = phaseReads.filter((read) => read.artifactId === citation.artifactId && ids.includes(read.id) &&
          (citation.range === null ? read.result.range.startLine === 1 && read.result.range.endLine >= read.result.lineCount
            : citation.range.startLine >= read.result.range.startLine && citation.range.endLine <= read.result.range.endLine));
        const span = citation.span;
        if (!supports.some((read) => span === undefined || spanInExcerpt(read.result.text, read.result.range.startLine, span))) { fabricated = true; break; }
        backed.add(citation.artifactId);
      }
      if (fabricated) continue;
      const isUse = parsed.data.file === expected.originalPath && backed.has(original) && (backed.has(generated) || excused);
      if (isUse) used = true;
      if (isUse || backed.has(generated)) candidates.push(proseOf(fields));
    }
    if (!used) continue;
    submittedUse = true;
    const described = [...kinds].every((kind) => candidates.some((prose) => GAP_STATES[kind].topic.test(prose) && GAP_STATES[kind].state.test(prose)));
    if ((!expected.requireGap || kinds.size > 0) && described) gapDisclosed = true;
  }
  return {
    status: originalRetrieved && (generatedRetrieved || excused) && submittedUse && gapDisclosed ? "verified" : "unverified",
    originalRetrieved, generatedRetrieved, submittedUse, gapDisclosed,
    toolCallIds: succeeded.map((read) => read.id),
  };
}

export interface CallerExpectation {
  side: "base" | "head";
  manifestSha256: string;
  generatedArtifactId: string;
  /** Authored Git paths of the callers the generated target is known to have. */
  callerPaths: string[];
}
export interface CallerVerdict { status: "verified" | "unverified"; evidenceReturned: boolean; subsequentUse: boolean; toolCallIds: string[] }

const referenceCall = z.looseObject({
  tool: z.literal("leveret_java_references"),
  args: z.looseObject({ side: z.string(), target: z.looseObject({ artifactId: z.string().optional() }) }),
});

/** A head query targeting the generated artifact returned checked original callers, and a later accepted record in that session names one. */
export async function verifyCallerConsumption(traceDir: string, expected: CallerExpectation): Promise<CallerVerdict> {
  const events = await readRunnerEvents(traceDir);
  const returned: { id: string; end: RunnerEvent; paths: string[] }[] = [];
  for (const started of events) {
    if (started.category !== "tools" || started.event !== "execution_start" || !started.tool_call_id) continue;
    const call = referenceCall.safeParse(await eventPayload(traceDir, started));
    if (!call.success || call.data.args.side !== expected.side || call.data.args.target.artifactId !== expected.generatedArtifactId) continue;
    const ended = toolEnd(events, started);
    if (!ended) continue;
    const reply = referenceReplySchema.safeParse(toolReply(await eventPayload(traceDir, ended)));
    if (!reply.success || !reply.data.ok) continue;
    const { result } = reply.data;
    const origin = result.target.location.buildArtifact;
    if (result.side !== expected.side || !origin || origin.manifestSha256 !== expected.manifestSha256 || origin.artifactId !== expected.generatedArtifactId) continue;
    // A caller is a checked reference in an authored original: null when its scope used the fallback, otherwise the authored artifact
    // of THIS export. Generated, external or another manifest's bytes are not callers of this review's pinned inputs.
    const authoredHere = (owner: { manifestSha256: string; origin: string } | null) =>
      owner === null || (owner.origin === "authored" && owner.manifestSha256 === expected.manifestSha256);
    const paths = result.items.flatMap((item) => item.reference && item.reference.basis === "checked" &&
      authoredHere(item.reference.location.buildArtifact) && expected.callerPaths.includes(item.reference.location.path) ? [item.reference.location.path] : []);
    if (paths.length > 0) returned.push({ id: started.tool_call_id, end: ended, paths });
  }
  let subsequentUse = false;
  for (const call of returned) {
    for await (const { event, args } of submittedPayloads(traceDir, events, call.end.sequence)) {
      if (event.session_id !== call.end.session_id) continue;
      if (citingRecords(args, call.id).some((record) => call.paths.some((path) => record.includes(path)))) subsequentUse = true;
    }
  }
  return { status: returned.length > 0 && subsequentUse ? "verified" : "unverified", evidenceReturned: returned.length > 0, subsequentUse, toolCallIds: returned.map((call) => call.id) };
}

// ── deterministic case scoring ─────────────────────────────────────────────────────────────────────────────

export type BuildCaseName = "valid-generation" | "in-place-preserved" | "template-defect" | "missing-output"
  | "unsupported-compiler" | "hostile-source-map" | "secret-resource" | "rejected-export";

export interface ExportSummary {
  outcome: "unconfigured" | "rejected" | "admitted";
  reason: string | null;
  scopes: readonly { role: "production" | "test"; outcome: "prepared" | "fallback" | "unavailable"; reason: string | null }[];
}

/** An export is complete only when it was admitted and every requested Java scope uses the exported environment. */
export function exportComplete(summary: ExportSummary): boolean {
  return summary.outcome === "admitted" && summary.scopes.length > 0 && summary.scopes.every((scope) => scope.outcome === "prepared");
}

export interface ViewResult {
  state: "retrieved" | "unavailable";
  /** Typed reader refusal when unavailable. */
  error: string | null;
  /** SHA-256 of the returned text; null when nothing was returned. Never the hash of a withheld or unproduced body. */
  sha256: string | null;
  /** The hash frozen before the run (pinned Git blob / manifest payload digest) the returned bytes must equal. */
  frozenSha256: string | null;
  /**
   * The artifact's availability in the bridge's canonical consumer inventory (`buildArtifacts`): the authority for WHY a view
   * is or is not served. The reader answers a statically withheld artifact with a generic `artifact-unavailable` refusal, so the
   * refusal code alone cannot tell withheld from missing or rejected. `unlisted` means the inventory does not describe it.
   */
  consumerState: ArtifactState | "unlisted";
  origin: "authored" | "materialized" | "external" | null;
  provenance: string | null;
  maps: number;
  mapDiagnostics: string[];
}

export interface BuildCaseResult {
  name: BuildCaseName;
  mode: BuildFixtureMode;
  /** The single mutation applied to the real head export before pinning, or null for the exporter's own output. */
  derivation: string | null;
  frozen: { base: { revision: string; manifestSha256: string }; head: { revision: string; manifestSha256: string } };
  export: ExportSummary & { complete: boolean; artifacts: Readonly<Record<ArtifactState, number>> | null };
  original: ViewResult | null;
  generated: ViewResult | null;
  callers: { attempted: boolean; resolved: boolean; error: string | null; paths: string[] };
  coverage: { complete: boolean } & Record<string, unknown>;
  facts: Record<string, boolean>;
  markerExposed: boolean;
  /** The manifest digest of a withheld artifact's body appeared in bytes the consumer or reviewer could see. */
  withheldDigestExposed: boolean;
}

/** Every reason the observed case does not meet its required outcome; empty means the case holds. */
export function scoreBuildCase(result: BuildCaseResult): string[] {
  const failures: string[] = [];
  const need = (condition: boolean, message: string): void => { if (!condition) failures.push(`${result.name}: ${message}`); };
  const { original, generated, callers, coverage } = result;
  const production = result.export.scopes.find((scope) => scope.role === "production");
  need(result.export.complete === exportComplete(result.export), "reported export completeness does not follow the admitted scopes (a rejected or degraded export was scored as complete)");
  need(!result.markerExposed, "a secret marker reached model-visible bytes");
  need(!result.withheldDigestExposed, "the digest of a withheld artifact body reached consumer-visible bytes");
  for (const view of [original, generated]) {
    if (!view) continue;
    if (view.state === "retrieved") {
      need(view.consumerState === "available" || view.consumerState === "unlisted", "a returned view is not available in the canonical inventory");
      need(view.frozenSha256 !== null && view.sha256 === view.frozenSha256, "returned bytes differ from the hash frozen before the run");
    } else {
      need(view.error !== null && view.sha256 === null && view.frozenSha256 === null, "a denied view lacks a typed refusal or carries a body hash");
    }
  }
  if (original?.state === "retrieved") need(original.origin === "authored", "the original view is not an authored artifact");
  if (generated?.state === "retrieved") need(generated.origin !== "authored", "the generated view is an authored artifact");
  if (original?.state === "retrieved" && generated?.state === "retrieved") need(original.sha256 !== generated.sha256, "original and generated views are the same bytes");

  switch (result.name) {
    case "valid-generation":
    case "in-place-preserved":
    case "template-defect":
    case "hostile-source-map": {
      need(result.export.outcome === "admitted" && result.export.complete, "the supported export was not fully used");
      need(original?.state === "retrieved" && generated?.state === "retrieved", "original and generated views were not both retrieved");
      need(callers.resolved && coverage.complete && ["src/main/java/example/Consumer.java", "src/test/java/example/PricingTest.java"].every((path) => callers.paths.includes(path)),
        "the generated target did not resolve with both checked original callers and complete coverage");
      if (result.name === "hostile-source-map") {
        need(generated?.maps === 0 && ["range-out-of-bounds", "range-reversed"].every((reason) => generated?.mapDiagnostics.includes(reason)),
          "hostile maps were not dropped with diagnostics (a degraded lineage must not yield precise maps)");
      } else {
        need(generated?.provenance === "exporter-recorded" && (generated?.maps ?? 0) > 0 && generated?.mapDiagnostics.length === 0, "recorded lineage did not yield validated maps");
      }
      if (result.name === "in-place-preserved") need(result.facts.workspaceOverwritten === true && result.facts.originalKeepsPlaceholder === true, "the in-place original was not preserved apart from the overwritten workspace path");
      if (result.name === "template-defect") need(result.facts.defectIntroduced === true, "the template defect is not visible in the base, head original and generated views");
      break;
    }
    case "missing-output":
      need(result.export.outcome === "admitted" && !result.export.complete && production !== undefined && production.outcome !== "prepared" && production.reason !== null,
        "the production scope did not degrade with a reason for the missing generated output");
      need((result.export.artifacts?.["not-produced"] ?? 0) >= 1, "the unproduced output is not counted");
      need(original?.state === "retrieved", "the authored original is not retrievable");
      need(generated?.state === "unavailable" && generated.consumerState === "not-produced" && generated.sha256 === null && generated.error !== null,
        "the missing output was not a typed unavailable view the inventory calls not-produced");
      need(!callers.resolved && callers.error !== null, "callers resolved against an output that was never produced");
      need(coverage.complete === false, "coverage was reported complete without the generated source");
      break;
    case "unsupported-compiler":
      need(result.export.outcome === "admitted" && !result.export.complete && production?.outcome === "fallback" && production.reason?.startsWith("unsupported-") === true,
        "the unsupported compiler context did not fall back with an explicit unsupported reason");
      need(original?.state === "retrieved" && generated?.state === "retrieved", "clean artifact reads should stay available beside an unsupported semantic environment");
      need(!callers.resolved && callers.error !== null, "callers resolved through an unsupported exported environment");
      break;
    case "secret-resource":
      need(result.export.outcome === "admitted" && !result.export.complete && production?.outcome === "fallback" && production.reason === "artifact-withheld",
        "the secret-bearing resource did not degrade the production scope as withheld");
      need((result.export.artifacts?.withheld ?? 0) >= 1, "the withheld artifact is not counted");
      need(original?.state === "retrieved", "the authored resource original is not retrievable");
      need(original?.maps === 0 && original.mapDiagnostics.includes("counterpart-unavailable"), "the withheld counterpart did not invalidate the original's maps");
      // The reader refuses a statically withheld artifact with its generic unavailable code; the inventory is what names the cause.
      need(generated?.state === "unavailable" && generated.consumerState === "withheld" && generated.error !== null && generated.sha256 === null && generated.frozenSha256 === null,
        "the secret-bearing output was not a typed denial that the inventory calls withheld, without a body hash");
      break;
    case "rejected-export":
      need(result.export.outcome === "rejected" && result.export.reason !== null, "the stale pin did not reject the whole export with a reason");
      need([original, generated].every((view) => view === null || view.state === "unavailable"), "an unadmitted export served artifact bytes");
      need(!callers.resolved, "callers resolved through a rejected export");
      need(coverage.complete === false, "independent fallback coverage was reported complete without the generated source");
      break;
  }
  return failures;
}

// ── deterministic cases ──────────────────────────────────────────────────────────────────────────────────────

interface Wire {
  compilations: { id: string; compiler: { preview: boolean } }[];
  transformations: { id: string; basis: string; locations: unknown[] }[];
}
type Pins = { base: BuildEvidencePin; head: BuildEvidencePin };
interface CaseSpec {
  name: BuildCaseName;
  mode: BuildFixtureMode;
  derivation: string | null;
  derive?: (wire: Wire) => void;
  /** Keep the original pin hash over changed manifest bytes: a stale or tampered export. */
  stale?: boolean;
}

const JAVA_TARGET = { artifactId: "pricing-output", position: { line: 4, column: 22 } };
const JAVA_SETTINGS = {
  repositoryId: FIXTURE_REPOSITORY_ID, module: ".", build: "gradle", mainRoots: ["src/main/java"], testRoots: ["src/test/java"], javaLevel: "21",
  screening: { rules: [], nonSecretValues: [] },
};
const at = (line: number, column: number) => ({ line, column });
function generateTransformation(wire: Wire): Wire["transformations"][number] {
  const found = wire.transformations.find((item) => item.id === "pricing-generate");
  if (!found) throw new Error("The template export has no pricing-generate transformation");
  return found;
}
const CASES: CaseSpec[] = [
  { name: "valid-generation", mode: "valid", derivation: null },
  { name: "in-place-preserved", mode: "in-place", derivation: null },
  { name: "template-defect", mode: "template-defect", derivation: null },
  { name: "missing-output", mode: "generation-failed", derivation: null },
  { name: "unsupported-compiler", mode: "valid", derivation: "preview-enabled-production-compiler", derive: (wire) => {
    const production = wire.compilations.find((item) => item.id === "prod");
    if (!production) throw new Error("The export has no production compilation");
    production.compiler.preview = true;
  } },
  { name: "hostile-source-map", mode: "template-defect", derivation: "out-of-bounds-and-reversed-map-ranges", derive: (wire) => {
    const location = (input: object, output: object) => ({ inputArtifactId: "pricing-template", outputArtifactId: "pricing-output", inputRange: input, outputRange: output });
    generateTransformation(wire).locations = [
      location({ start: at(1, 0), end: at(1, 7) }, { start: at(9999, 0), end: at(9999, 7) }),
      location({ start: at(4, 40), end: at(4, 30) }, { start: at(4, 40), end: at(4, 42) }),
    ];
  } },
  { name: "secret-resource", mode: "secret-resource", derivation: null },
  { name: "rejected-export", mode: "valid", derivation: "stale-manifest-pin", stale: true },
];

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Republishes a head export with one mutation (or stale bytes) into a new directory and returns the new host pin. */
async function republish(pin: BuildEvidencePin, dir: string, spec: Pick<CaseSpec, "derive" | "stale">): Promise<BuildEvidencePin> {
  const wire: Wire = JSON.parse(await readFile(pin.manifestPath, "utf8"));
  spec.derive?.(wire);
  const bytes = `${JSON.stringify(wire)}\n${spec.stale ? "\n" : ""}`;
  await mkdir(dir);
  await cp(pin.payloadRoot, join(dir, "payload"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), bytes, { flag: "wx" });
  return { ...pin, manifestPath: join(dir, "manifest.json"), payloadRoot: join(dir, "payload"), manifestSha256: spec.stale ? pin.manifestSha256 : sha256(bytes) };
}

const manifestArtifacts = z.looseObject({ artifacts: z.array(z.looseObject({
  id: z.string(), availability: z.string(), kind: z.string(),
  content: z.looseObject({ sha256: z.string(), location: z.looseObject({ kind: z.string(), path: z.string() }) }).optional(),
})) });

/** The materialized file's manifest digest, after proving the payload on disk still has it; null when the export lists no such bytes. */
async function payloadDigest(pin: BuildEvidencePin, artifactId: string): Promise<string | null> {
  const artifact = manifestArtifacts.parse(JSON.parse(await readFile(pin.manifestPath, "utf8"))).artifacts.find((item) => item.id === artifactId);
  if (artifact?.availability !== "available" || artifact.kind !== "file" || artifact.content?.location.kind !== "payload") return null;
  if (await hashFile(join(pin.payloadRoot, artifact.content.location.path)) !== artifact.content.sha256) throw new Error(`Payload bytes of ${artifactId} differ from the export`);
  return artifact.content.sha256;
}

interface Snapshot {
  revisions: { base: string; head: string };
  pins: { base: string; head: string };
  manifestFiles: { base: string; head: string };
  checkout: { head: string; clean: boolean };
  originalGitBlob: string;
  generated: string | null;
}

/** Every identity a run must not disturb: pinned revisions and manifests, the Git original and the generated payload digest. */
async function snapshot(fixture: BuildFixture, pins: Pins, originalPath: string, generatedId: string): Promise<Snapshot> {
  const git = (...args: string[]) => execFileSync("git", ["-C", fixture.repo, ...args], { maxBuffer: 64 << 20 });
  return {
    revisions: { base: fixture.base, head: fixture.head },
    pins: { base: pins.base.manifestSha256, head: pins.head.manifestSha256 },
    manifestFiles: { base: await hashFile(pins.base.manifestPath), head: await hashFile(pins.head.manifestPath) },
    checkout: { head: git("rev-parse", "HEAD").toString("utf8").trim(), clean: git("status", "--porcelain").length === 0 },
    originalGitBlob: sha256(git("cat-file", "blob", `${fixture.head}:${originalPath}`)),
    generated: await payloadDigest(pins.head, generatedId),
  };
}

async function assertUnchanged(before: Snapshot, fixture: BuildFixture, pins: Pins, originalPath: string, generatedId: string): Promise<void> {
  if (JSON.stringify(await snapshot(fixture, pins, originalPath, generatedId)) !== JSON.stringify(before)) {
    throw new Error("Frozen revisions, manifests or artifact bytes changed during the evaluation");
  }
}

interface AnalysisObservation {
  export: BuildCaseResult["export"];
  coverage: BuildCaseResult["coverage"];
  callers: BuildCaseResult["callers"];
  raw: string[];
}

/** What the real bridge concluded for head: export outcome per scope, analysis coverage, and callers of the generated Java target. */
async function observeAnalysis(bridge: InspectJavaBridge, change: ChangeManifest): Promise<AnalysisObservation> {
  const evidence = bridge.buildEvidence.head;
  const summary = { outcome: evidence.outcome, reason: evidence.reason,
    scopes: evidence.javaScopes.map(({ role, outcome, reason }) => ({ role, outcome, reason })) };
  const analysis = bridge.summaries.head;
  const raw = [JSON.stringify(evidence)];
  let callers: BuildCaseResult["callers"];
  try {
    const page = await bridge.references({ analysisId: analysis.analysisId, configurationSha256: analysis.configurationSha256, manifest: change,
      side: "head", target: JAVA_TARGET, referenceScope: "all" });
    raw.push(JSON.stringify(page));
    const paths = page.items.flatMap((item) => item.reference?.basis === "checked" ? [item.reference.location.path] : []);
    callers = { attempted: true, resolved: page.target.location.buildArtifact?.artifactId === JAVA_TARGET.artifactId, error: null, paths: [...new Set(paths)].sort() };
  } catch (error) {
    callers = { attempted: true, resolved: false, error: error instanceof InspectJavaError ? error.code : "worker-failed", paths: [] };
  }
  return { export: { ...summary, complete: exportComplete(summary), artifacts: evidence.artifacts }, coverage: analysis.coverage, callers, raw };
}

/** The artifact's state in the bridge's canonical consumer inventory for one side. */
function inventoryState(bridge: InspectJavaBridge, side: "base" | "head", artifactId: string): ViewResult["consumerState"] {
  return bridge.buildArtifacts[side].artifacts.find((item) => item.id === artifactId)?.state ?? "unlisted";
}

/** Every page of the reviewer-visible artifact listing, exactly as the registered tool would return it. */
async function listingPages(bridge: InspectJavaBridge, pin: BuildEvidencePin, side: "base" | "head"): Promise<string[]> {
  const pages: string[] = [];
  let cursor: string | undefined;
  do {
    const reply = await bridge.listArtifacts(side, { manifestSha256: pin.manifestSha256, byteBudget: 65_536, ...(cursor ? { cursor } : {}) });
    pages.push(JSON.stringify(reply));
    cursor = reply.ok ? reply.result.delivery.nextCursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

/** Body digests the export declares for artifacts the inventory calls withheld. They are searched for, never reported. */
async function withheldDigests(bridge: InspectJavaBridge, pin: BuildEvidencePin, side: "base" | "head"): Promise<string[]> {
  const manifest = manifestArtifacts.parse(JSON.parse(await readFile(pin.manifestPath, "utf8")));
  return bridge.buildArtifacts[side].artifacts.flatMap((item) => {
    const digest = item.state === "withheld" ? manifest.artifacts.find((artifact) => artifact.id === item.id)?.content?.sha256 : undefined;
    return digest ? [digest] : [];
  });
}

async function readView(bridge: InspectJavaBridge, pin: BuildEvidencePin, side: "base" | "head", artifactId: string, frozen: string | null):
Promise<{ view: ViewResult; text: string | null; raw: string }> {
  const consumerState = inventoryState(bridge, side, artifactId);
  const unavailable = (error: string) => ({ view: { state: "unavailable" as const, error, sha256: null, frozenSha256: null, consumerState, origin: null, provenance: null, maps: 0, mapDiagnostics: [] }, text: null, raw: error });
  try {
    const reply = await bridge.readArtifact(side, { manifestSha256: pin.manifestSha256, artifactId, range: null, byteBudget: 262_144 });
    if (!reply.ok) return unavailable(reply.error.code);
    const { result } = reply;
    // A partial page is not the whole artifact: its text can never equal the frozen digest.
    return { view: { state: "retrieved", error: null, sha256: result.delivery.complete ? sha256(result.text) : null, frozenSha256: frozen, consumerState, origin: result.origin,
      provenance: result.provenance, maps: result.maps.length, mapDiagnostics: result.mapDiagnostics.map((item) => item.reason) }, text: result.text, raw: JSON.stringify(reply) };
  } catch (error) {
    return unavailable(error instanceof InspectJavaError ? error.code : "worker-failed");
  }
}

interface CaseContext { fixture: BuildFixture; dir: string; pins: Pins; change: ChangeManifest }

async function evaluateCase(spec: CaseSpec, out: string, template: OperatorTemplate):
Promise<{ result: BuildCaseResult; context: CaseContext; analysis: AnalysisObservation }> {
  const dir = join(out, "cases", spec.name);
  const fixture = await createBuildFixture(dir, spec.mode);
  const selected = fixtureSelectedArtifacts[spec.mode];
  const originalPath = fixture.manifests.head.artifacts.find((item) => item.id === selected.originalArtifactId)?.repositoryPath;
  if (!originalPath) throw new Error(`The ${spec.mode} export has no repository path for ${selected.originalArtifactId}`);
  const pins: Pins = { base: fixture.pins.base, head: spec.derive || spec.stale ? await republish(fixture.pins.head, join(dir, "derived"), spec) : fixture.pins.head };
  const frozen = await snapshot(fixture, pins, originalPath, selected.generatedArtifactId);
  const configured = await pinnedConfig(template, dir, fixture.repo, "case", { ...JAVA_SETTINGS, buildEvidence: pins });
  const change = await buildChangeManifest(fixture.repo, fixture.base);
  const bridge = await openInspectJava(fixture.repo, change, configured.config, join(dir, "store"));
  try {
    const analysis = await observeAnalysis(bridge, change);
    const original = await readView(bridge, pins.head, "head", selected.originalArtifactId, frozen.originalGitBlob);
    const generated = await readView(bridge, pins.head, "head", selected.generatedArtifactId, frozen.generated);
    const listing = await listingPages(bridge, pins.head, "head");
    const digests = await withheldDigests(bridge, pins.head, "head");
    const facts: Record<string, boolean> = {};
    if (spec.name === "in-place-preserved") {
      const workspace = await readFile(join(dir, "exports/head/workspace", originalPath));
      facts.workspaceOverwritten = sha256(workspace) !== frozen.originalGitBlob;
      facts.originalKeepsPlaceholder = original.text?.includes("@FACTOR@") === true && original.text.includes("quantity * 12") === false;
    }
    if (spec.name === "template-defect") {
      const base = await readView(bridge, pins.base, "base", selected.originalArtifactId, null);
      facts.defectIntroduced = base.text?.includes("quantity * ${factor}") === true && original.text?.includes("quantity / ${factor}") === true &&
        generated.text?.includes("quantity / 10") === true;
    }
    const visible = [...analysis.raw, ...listing, original.raw, generated.raw, original.text ?? "", generated.text ?? ""];
    const result: BuildCaseResult = {
      name: spec.name, mode: spec.mode, derivation: spec.derivation,
      frozen: { base: { revision: fixture.base, manifestSha256: pins.base.manifestSha256 }, head: { revision: fixture.head, manifestSha256: pins.head.manifestSha256 } },
      export: analysis.export, original: original.view, generated: generated.view, callers: analysis.callers, coverage: analysis.coverage, facts,
      markerExposed: visible.some((text) => text.includes(FIXTURE_SECRET_MARKER)),
      withheldDigestExposed: digests.some((digest) => visible.some((text) => text.includes(digest))),
    };
    await assertUnchanged(frozen, fixture, pins, originalPath, selected.generatedArtifactId);
    return { result, context: { fixture, dir, pins, change }, analysis };
  } finally {
    await bridge.close();
  }
}

/** The same frozen revisions and queries with and without the export pins: binding resolution, coverage and callers. */
async function compareWithoutExport(context: CaseContext, withExport: AnalysisObservation, template: OperatorTemplate) {
  const { fixture, dir, change } = context;
  const bare = await pinnedConfig(template, dir, fixture.repo, "without-export", JAVA_SETTINGS);
  const bridge = await openInspectJava(fixture.repo, change, bare.config, join(dir, "store-without-export"));
  try {
    const without = await observeAnalysis(bridge, change);
    const side = (observed: AnalysisObservation) => ({ export_outcome: observed.export.outcome, coverage: observed.coverage, callers: observed.callers });
    return {
      claim: "same frozen revisions and queries with and without the export; no general parity claim",
      revisions: { base: fixture.base, head: fixture.head }, models: null, prompts: null,
      scoring: "bridge coverage and artifact-targeted reference page, identical query on both sides",
      with_export: side(withExport), without_export: side(without),
    };
  } finally {
    await bridge.close();
  }
}

// ── real review scenarios ──────────────────────────────────────────────────────────────────────────────────

interface ScenarioSpec {
  name: "template-defect" | "uncertain-lineage" | "secret-resource";
  mode: BuildFixtureMode;
  derivation: string | null;
  derive?: (wire: Wire) => void;
  requireGap: boolean;
  consumption: boolean;
  callers: boolean;
}
const SCENARIOS: ScenarioSpec[] = [
  { name: "template-defect", mode: "template-defect", derivation: null, requireGap: false, consumption: true, callers: true },
  { name: "uncertain-lineage", mode: "template-defect", derivation: "inferred-lineage-without-maps", requireGap: true, consumption: true, callers: false, derive: (wire) => {
    const generate = generateTransformation(wire);
    generate.basis = "inferred";
    generate.locations = [];
  } },
  { name: "secret-resource", mode: "secret-resource", derivation: null, requireGap: false, consumption: false, callers: false },
];
const DECLARED_MODEL_ENV = ["LEVERET_RUNNER_PROVIDER", "LEVERET_RUNNER_MODEL", "LEVERET_RUNNER_EFFORT", "LEVERET_PI_AGENT_DIR"] as const;

/** Whether any needle appears in the given strings or in any file under the directories (compressed archives are not scanned). */
async function leaks(roots: string[], strings: string[], needles: string[]): Promise<{ leaked: boolean; scannedFiles: number }> {
  let leaked = strings.some((text) => needles.some((needle) => text.includes(needle)));
  let scannedFiles = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      scannedFiles++;
      const bytes = await readFile(path);
      if (needles.some((needle) => bytes.includes(needle))) leaked = true;
    }
  };
  for (const root of roots) await walk(root);
  return { leaked, scannedFiles };
}

const summarizeRun = (output: ReviewOutput, trace: string, originalPath: string) => ({
  model: output.run_configuration?.model, thinking: output.run_configuration?.thinking,
  model_routing: output.run_configuration?.model_routing, system_prompt_sha256: output.run_configuration?.system_prompt?.sha256,
  identities: output.run_configuration?.identities, build_evidence_capability: output.run_configuration?.capabilities?.build_evidence,
  tool_calls: { build_artifact: output.run_configuration?.tool_calls?.filter((call) => call.toolName === BUILD_TOOL).length ?? 0,
    java_references: output.run_configuration?.tool_calls?.filter((call) => call.toolName === "leveret_java_references").length ?? 0 },
  published_findings: output.report?.length ?? 0, published_findings_on_original: output.report?.filter((row) => row.file === originalPath).length ?? 0,
  audit_directory: trace,
});

async function runScenario(spec: ScenarioSpec, out: string, template: OperatorTemplate, withExport: boolean) {
  const label = withExport ? spec.name : `${spec.name}-without-export`;
  const dir = join(out, "review", label);
  const fixture = await createBuildFixture(dir, spec.mode);
  const selected = fixtureSelectedArtifacts[spec.mode];
  const originalPath = fixture.manifests.head.artifacts.find((item) => item.id === selected.originalArtifactId)?.repositoryPath;
  if (!originalPath) throw new Error(`The ${spec.mode} export has no repository path for ${selected.originalArtifactId}`);
  const pins: Pins = { base: fixture.pins.base, head: spec.derive ? await republish(fixture.pins.head, join(dir, "derived"), spec) : fixture.pins.head };
  const frozen = await snapshot(fixture, pins, originalPath, selected.generatedArtifactId);
  const configured = await pinnedConfig(template, dir, fixture.repo, "review", withExport ? { ...JAVA_SETTINGS, buildEvidence: pins } : JAVA_SETTINGS);
  const trace = join(dir, "private-review-trace");
  const data = join(dir, "review-data");
  const { stdout, output } = await runPiReview({ label, repo: fixture.repo, base: fixture.base, config: configured, trace, data });
  await assertUnchanged(frozen, fixture, pins, originalPath, selected.generatedArtifactId);
  // Needles stay in memory: the marker, and (for the withheld resource) the withheld body's digest. Neither is ever reported.
  const needles = [FIXTURE_SECRET_MARKER, ...(spec.name === "secret-resource" && frozen.generated ? [frozen.generated] : [])];
  const exposure = await leaks([trace, data], [stdout], needles);
  const expectation: BuildConsumptionExpectation = { side: "head", manifestSha256: pins.head.manifestSha256, originalArtifactId: selected.originalArtifactId,
    generatedArtifactId: selected.generatedArtifactId, originalPath, requireGap: spec.requireGap };
  const consumption = withExport && spec.consumption ? await verifyBuildEvidenceConsumption(trace, expectation) : null;
  const callers = withExport && spec.callers
    ? await verifyCallerConsumption(trace, { side: "head", manifestSha256: pins.head.manifestSha256, generatedArtifactId: selected.generatedArtifactId,
      callerPaths: ["src/main/java/example/Consumer.java", "src/test/java/example/PricingTest.java"] })
    : null;
  const verified = !exposure.leaked && (consumption === null || consumption.status === "verified") && (callers === null || callers.status === "verified");
  return { scenario: label, mode: spec.mode, derivation: spec.derivation, with_export: withExport, status: !withExport ? "recorded" : verified ? "verified" : "unverified",
    frozen: { base: { revision: fixture.base, manifestSha256: pins.base.manifestSha256 }, head: { revision: fixture.head, manifestSha256: pins.head.manifestSha256 } },
    config_sha256: configured.sha256, expected_original: { artifact: selected.originalArtifactId, path: originalPath }, expected_generated: selected.generatedArtifactId,
    consumption, callers, exposure: { marker_and_withheld_digest_absent: !exposure.leaked, scanned_files: exposure.scannedFiles, compressed_archives_scanned: false },
    run: summarizeRun(output, trace, originalPath) };
}

// ── command ──────────────────────────────────────────────────────────────────────────────────────────────

const buildTemplateSchema = templateSchema.extend({ comparison: z.boolean().optional().default(false) });

/** Exact checkout identity: HEAD plus a digest of any uncommitted change, so a run on a dirty tree is never mistaken for HEAD. */
function checkoutIdentity() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: resolve(), maxBuffer: 256 << 20 });
  const diff = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256").update(diff);
  for (const file of untracked) digest.update(`${file}\0`).update(readFileSync(join(resolve(), file)));
  return { revision: git("rev-parse", "HEAD").toString("utf8").trim(), dirty: diff.length > 0 || untracked.length > 0,
    working_tree_sha256: diff.length > 0 || untracked.length > 0 ? digest.digest("hex") : null };
}

async function main(): Promise<void> {
  const args = evaluationArguments(process.argv.slice(2));
  if (args.mode === "review") {
    if (process.env.LEVERET_PAID_MODEL_APPROVED !== "1") {
      console.log(JSON.stringify({ ok: false, error: { code: "approval-required", message: "Separate model-execution approval is required" } }));
      process.exitCode = 2;
      return;
    }
    const missing = DECLARED_MODEL_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.log(JSON.stringify({ ok: false, error: { code: "model-declaration-required", message: `Declare ${missing.join(", ")} before a real review` } }));
      process.exitCode = 2;
      return;
    }
  }
  const out = resolve(args.output);
  if (!isAbsolute(args.output)) throw new Error("Evaluation output must be an absolute path");
  const checkout = await realpath(resolve());
  const parent = await realpath(dirname(out));
  if (pathIsInside(checkout, join(parent, basename(out)))) throw new Error("Evaluation output cannot be inside Leveret's checkout");
  const original = await readFile(args.config);
  if (sha256(original) !== args.configSha256) throw new Error("Operator configuration digest mismatch");
  const template = buildTemplateSchema.parse(JSON.parse(original.toString("utf8")));
  if (pathIsInside(checkout, await realpath(args.config))) throw new Error("Operator configuration must be outside Leveret's checkout");
  if (args.mode === "review" && pathIsInside(checkout, resolve(process.env.LEVERET_PI_AGENT_DIR!))) throw new Error("The Pi agent directory must be outside Leveret's checkout");
  const existing = await realpath(out).catch(() => null);
  if (existing && pathIsInside(checkout, existing)) throw new Error("Evaluation output symlink enters Leveret's checkout");
  await mkdir(out, { recursive: true, mode: 0o700 });
  if ((await readdir(out)).length !== 0) throw new Error("Evaluation output directory must be empty");

  const contexts = new Map<BuildCaseName, { context: CaseContext; analysis: AnalysisObservation }>();
  const cases: { name: BuildCaseName; result: BuildCaseResult | null; failures: string[] }[] = [];
  for (const spec of CASES) {
    try {
      const evaluated = await evaluateCase(spec, out, template);
      contexts.set(spec.name, evaluated);
      cases.push({ name: spec.name, result: evaluated.result, failures: scoreBuildCase(evaluated.result) });
    } catch (error) {
      cases.push({ name: spec.name, result: null, failures: [`${spec.name}: evaluation failed: ${String(error).slice(0, 500)}`] });
    }
  }

  let comparison: unknown = null;
  const defect = contexts.get("template-defect");
  if (template.comparison && defect) comparison = await compareWithoutExport(defect.context, defect.analysis, template);

  let reviewer: Record<string, unknown> = { status: "not-authorized" };
  if (args.mode === "review") {
    const scenarios: Record<string, unknown>[] = [];
    for (const spec of SCENARIOS) {
      try { scenarios.push(await runScenario(spec, out, template, true)); }
      catch (error) { scenarios.push({ scenario: spec.name, status: "unverified", error: String(error).slice(0, 500) }); }
    }
    let withoutExport: unknown = null;
    if (template.comparison) {
      const spec = SCENARIOS[0]!;
      try { withoutExport = await runScenario(spec, out, template, false); }
      catch (error) { withoutExport = { scenario: `${spec.name}-without-export`, status: "unverified", error: String(error).slice(0, 500) }; }
    }
    reviewer = {
      status: scenarios.every((scenario) => scenario.status === "verified") ? "verified" : "unverified",
      declared_model: { provider: process.env.LEVERET_RUNNER_PROVIDER, model: process.env.LEVERET_RUNNER_MODEL, effort: process.env.LEVERET_RUNNER_EFFORT },
      runner_sha256: await hashFile(join(resolve(), "dist/runner/pi.js")), scenarios, comparison_without_export: withoutExport,
    };
  }
  const failures = cases.flatMap((item) => item.failures);
  const jdkRelease = /^JAVA_VERSION="([^"]+)"/m.exec(await readFile(join(template.jdkHome, "release"), "utf8"))?.[1] ?? null;
  const report = {
    schema: "leveret.build-evidence-evaluation/v1", run_date: new Date().toISOString(), mode: args.mode, operator_config_sha256: args.configSha256,
    leveret: checkoutIdentity(), runtime: { node: process.version, java: jdkRelease },
    scope: "supported subset: UTF-8 Java, one module, release unset, no preview/module options, JDK platform fingerprints equal to the installed worker; everything else falls back with a stated reason",
    cases, comparison, reviewer_consumption: reviewer,
  };
  const file = join(out, "build-evidence-evaluation.json");
  await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  const ok = failures.length === 0 && (args.mode === "deterministic" || reviewer.status === "verified");
  console.log(JSON.stringify({ ok, output: file, failing_cases: failures.length, reviewer_consumption: reviewer.status }));
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof InspectJavaError ? error.code : "evaluation-failed", message: String(error) } }));
  process.exitCode = 1;
});
