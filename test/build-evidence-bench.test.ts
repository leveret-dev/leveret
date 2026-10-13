import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  exportComplete, scoreBuildCase, verifyBuildEvidenceConsumption, verifyCallerConsumption,
  type BuildCaseResult, type BuildConsumptionExpectation,
} from "../bench/build-evidence.mjs";
import { citingRecords, eventPayload, evaluationArguments, readRunnerEvents, submittedPayloads } from "../bench/review-evidence.mjs";

const HEAD = "a".repeat(64);
const BASE = "b".repeat(64);
const ORIGINAL = "pricing-template";
const GENERATED = "pricing-output";
const PATH = "templates/Pricing.java.tpl";
const CALLER = "src/test/java/example/PricingTest.java";
const SESSION = "session-1";
const expectation: BuildConsumptionExpectation = {
  side: "head", manifestSha256: HEAD, originalArtifactId: ORIGINAL, generatedArtifactId: GENERATED, originalPath: PATH, requireGap: false,
};
const at = (line: number, start: number, end: number) => ({ start: { line, column: start }, end: { line, column: end } });
const templateText = "package example;\n\npublic final class Pricing {\n    public static int price(int quantity) { return quantity / ${factor}; }\n}\n";

let home: string;
let serial = 0;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "leveret-build-bench-")); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface ReadOptions {
  id: string; artifactId: string; side?: "base" | "head"; manifestSha256?: string; session?: string; origin?: "authored" | "materialized";
  provenance?: string; path?: string | null; maps?: unknown[]; mapDiagnostics?: unknown[]; failure?: string; accepted?: boolean;
}
type Event = Record<string, unknown>;

function reply(options: ReadOptions) {
  if (options.failure) return { ok: false, error: { code: options.failure, message: "typed refusal" } };
  const authored = options.origin === "authored" || options.artifactId === ORIGINAL;
  return { ok: true, result: {
    citation: { manifestSha256: options.manifestSha256 ?? HEAD, artifactId: options.artifactId, range: { startLine: 1, endLine: 5 } },
    origin: authored ? "authored" : "materialized", role: authored ? "template" : "source",
    repositoryPath: options.path === undefined ? (authored ? PATH : "build/generated/example/Pricing.java") : options.path,
    provenance: options.provenance ?? (authored ? "authored" : "exporter-recorded"),
    text: templateText, range: { startLine: 1, endLine: 5 }, lineCount: 5, lineage: [], maps: options.maps ?? [],
    mapDiagnostics: options.mapDiagnostics ?? [], delivery: { complete: true, truncated: false, nextCursor: null },
  } };
}

/** A real-shaped build artifact tool call: execution_start with the model's arguments, execution_end with the typed reply. */
function read(sequence: number, options: ReadOptions): Event[] {
  const session = options.session ?? SESSION;
  const base = { category: "tools", tool_call_id: options.id, phase: "review", attempt: 1, session_id: session };
  return [
    { ...base, sequence, event: "execution_start", payload: { tool: "leveret_build_artifact", args: {
      side: options.side ?? "head", manifestSha256: options.manifestSha256 ?? HEAD, artifactId: options.artifactId, range: null, byteBudget: 65_536 } } },
    { ...base, sequence: sequence + 1, event: "execution_end", payload: { tool: "leveret_build_artifact", is_error: false, timed_out: false,
      result: { content: [{ type: "text", text: `evidence_id: ${options.id}` }, { type: "text", text: JSON.stringify(reply(options)) }] } } },
  ];
}

function submit(sequence: number, args: unknown, options: { accepted?: boolean; session?: string; id?: string; tool?: string } = {}): Event[] {
  const id = options.id ?? `submit-${sequence}`;
  const base = { category: "tools", tool_call_id: id, phase: "review", attempt: 1, session_id: options.session ?? SESSION };
  const tool = options.tool ?? "leveret_submit_phase";
  return [
    { ...base, sequence, event: "execution_start", payload: { tool, args } },
    { ...base, sequence: sequence + 1, event: "execution_end", payload: { tool, is_error: options.accepted === false,
      result: { content: [{ type: "text", text: options.accepted === false ? "Validation failed" : "Phase result accepted." }] } } },
  ];
}

const citation = (artifactId: string, manifestSha256 = HEAD, extra: object = {}) =>
  ({ manifestSha256, artifactId, range: { startLine: 4, endLine: 4 }, ...extra });
function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "R1", file: PATH, line: 4, title: "Template divides where the contract multiplies", claim: "The factor is divided, not multiplied.",
    impact: "Prices shrink.", evidence_hint: "template line 4 and generated line 4", scope: "in-diff",
    evidence_ids: ["call-original", "call-generated"], build_citations: [citation(ORIGINAL), citation(GENERATED)], lead_ids: [],
    ...overrides,
  };
}
const phase = (...records: unknown[]) => ({ concerns: records, coverage: { files: [] } });

function writeTrace(events: Event[], extra: { blobs?: Record<string, unknown> } = {}): string {
  const dir = join(home, `trace-${++serial}`);
  mkdirSync(join(dir, "blobs/sha256"), { recursive: true });
  const lines = events.map((event, index) => JSON.stringify({ schema: 1, run_id: "run", producer: "runner", completeness: "complete", content_policy: "full", ...event, sequence: event.sequence ?? index + 1 }));
  writeFileSync(join(dir, "runner.ndjson"), `${lines.join("\n")}\n`);
  for (const [sha, value] of Object.entries(extra.blobs ?? {})) writeFileSync(join(dir, "blobs/sha256", sha), JSON.stringify(value));
  return dir;
}

const bothReads = (overrides: Partial<ReadOptions> = {}) => [
  ...read(1, { id: "call-original", artifactId: ORIGINAL, ...overrides }),
  ...read(3, { id: "call-generated", artifactId: GENERATED, ...overrides }),
];
const consume = (events: Event[], expected: Partial<BuildConsumptionExpectation> = {}) =>
  verifyBuildEvidenceConsumption(writeTrace(events), { ...expectation, ...expected });

describe("verifyBuildEvidenceConsumption", () => {
  it("verifies actual reads of both views cited by one later submitted record", async () => {
    expect(await consume([...bothReads(), ...submit(10, phase(finding()))])).toEqual({
      status: "verified", originalRetrieved: true, generatedRetrieved: true, submittedUse: true, gapDisclosed: true,
      toolCallIds: ["call-original", "call-generated"],
    });
  });

  it("accepts the independent-read citations a real review made: operator spans beside a declared token map, and base-export citations", async () => {
    // Observed shape (provider-fixed template-defect run): the model cites the operator before the placeholder, not the map's span.
    const map = (owner: string, other: string, own: object, theirs: object) => ({ transformationId: "pricing-generate", index: 0,
      side: owner === ORIGINAL ? "input" : "output", range: own, precision: "span",
      counterpart: { artifactId: other, origin: other === ORIGINAL ? "authored" : "materialized", repositoryPath: null, range: theirs } });
    const reads = [
      ...read(1, { id: "call-original", artifactId: ORIGINAL, maps: [map(ORIGINAL, GENERATED, at(4, 62, 71), at(4, 62, 64))] }),
      ...read(3, { id: "call-generated", artifactId: GENERATED, maps: [map(GENERATED, ORIGINAL, at(4, 62, 64), at(4, 62, 71))] }),
    ];
    const operator = finding({ build_citations: [
      citation(ORIGINAL, HEAD, { span: at(4, 60, 61) }), citation(GENERATED, HEAD, { span: at(4, 60, 64) }),
      citation(ORIGINAL, BASE, { span: at(4, 60, 61) }), citation(GENERATED, BASE, { span: at(4, 60, 64) }),
    ] });
    expect(await consume([...reads, ...submit(10, phase(operator))])).toEqual({
      status: "verified", originalRetrieved: true, generatedRetrieved: true, submittedUse: true, gapDisclosed: true,
      toolCallIds: ["call-original", "call-generated"],
    });
  });

  it("rejects reads of the swapped side or manifest, and an expectation naming the other side", async () => {
    const swapped = [...bothReads({ side: "base", manifestSha256: BASE }), ...submit(10, phase(finding({
      build_citations: [citation(ORIGINAL, BASE), citation(GENERATED, BASE)] })))];
    expect(await consume(swapped)).toMatchObject({ status: "unverified", originalRetrieved: false, generatedRetrieved: false, submittedUse: false });
    expect(await consume([...bothReads(), ...submit(10, phase(finding()))], { manifestSha256: BASE }))
      .toMatchObject({ status: "unverified", originalRetrieved: false, submittedUse: false });
    expect(await consume([...bothReads(), ...submit(10, phase(finding()))], { side: "base" }))
      .toMatchObject({ status: "unverified", originalRetrieved: false });
    // A head-side call whose typed reply refused the (wrong) manifest is not a retrieval.
    const refused = [...read(1, { id: "call-original", artifactId: ORIGINAL, manifestSha256: BASE, failure: "snapshot-mismatch" }),
      ...read(3, { id: "call-generated", artifactId: GENERATED, manifestSha256: BASE, failure: "snapshot-mismatch" }),
      ...submit(10, phase(finding()))];
    expect(await consume(refused)).toMatchObject({ status: "unverified", originalRetrieved: false, generatedRetrieved: false });
  });

  it("requires both views to be retrieved and cited, not just one", async () => {
    const originalOnly = [...read(1, { id: "call-original", artifactId: ORIGINAL }), ...submit(10, phase(finding({
      evidence_ids: ["call-original"], build_citations: [citation(ORIGINAL)] })))];
    expect(await consume(originalOnly)).toMatchObject({ status: "unverified", originalRetrieved: true, generatedRetrieved: false, submittedUse: false });
    const generatedOnly = [...read(1, { id: "call-generated", artifactId: GENERATED }), ...submit(10, phase(finding({
      evidence_ids: ["call-generated"], build_citations: [citation(GENERATED)] })))];
    expect(await consume(generatedOnly)).toMatchObject({ status: "unverified", originalRetrieved: false, generatedRetrieved: true });
    // Both were read, but the submission cites only one of them: content citation and evidence ID must both name each view.
    for (const cited of [
      finding({ build_citations: [citation(ORIGINAL)] }),
      finding({ build_citations: [citation(GENERATED)] }),
      finding({ evidence_ids: ["call-original"] }),
      finding({ evidence_ids: ["call-generated"] }),
    ]) {
      expect(await consume([...bothReads(), ...submit(10, phase(cited))])).toMatchObject({ status: "unverified", originalRetrieved: true, generatedRetrieved: true, submittedUse: false });
    }
    // A list-only inventory is never a retrieval.
    const listed = [{ category: "tools", event: "execution_start", tool_call_id: "call-list", session_id: SESSION,
      payload: { tool: "leveret_build_artifact", args: { action: "list", side: "head", manifestSha256: HEAD } } },
    { category: "tools", event: "execution_end", tool_call_id: "call-list", session_id: SESSION, payload: { tool: "leveret_build_artifact", is_error: false,
      result: { content: [{ type: "text", text: JSON.stringify({ ok: true, result: { artifacts: [{ id: ORIGINAL }, { id: GENERATED }] } }) }] } } }];
    expect(await consume([...listed.map((event, index) => ({ ...event, sequence: index + 1 })), ...submit(10, phase(finding()))]))
      .toMatchObject({ status: "unverified", originalRetrieved: false, generatedRetrieved: false });
  });

  it("does not count a citation in an unrelated record, a sibling record, thinking, or another tool's arguments", async () => {
    const reads = bothReads();
    const elsewhere = finding({ id: "R2", file: "src/main/java/example/Consumer.java" });
    const bare = finding({ evidence_ids: [], build_citations: [] });
    expect(await consume([...reads, ...submit(10, phase(elsewhere, bare))])).toMatchObject({ status: "unverified", submittedUse: false });
    // Evidence IDs in one record and content citations in a sibling do not combine.
    const split = [finding({ build_citations: [] }), finding({ id: "R2", evidence_ids: [] })];
    expect(await consume([...reads, ...submit(10, phase(...split))])).toMatchObject({ status: "unverified", submittedUse: false });
    const thinking = [{ sequence: 20, category: "assistant", event: "message_end", session_id: SESSION, payload: { thinking: JSON.stringify(phase(finding())) } }];
    expect(await consume([...reads, ...thinking])).toMatchObject({ status: "unverified", submittedUse: false });
    expect(await consume([...reads, ...submit(10, phase(finding()), { tool: "leveret_read" })])).toMatchObject({ status: "unverified", submittedUse: false });
  });

  it("requires an accepted, later submission from the same session as the reads", async () => {
    const reads = bothReads();
    expect(await consume([...reads, ...submit(10, phase(finding()), { accepted: false })])).toMatchObject({ status: "unverified", submittedUse: false });
    expect(await consume([...reads, ...submit(10, phase(finding()), { session: "other-session" })])).toMatchObject({ status: "unverified", submittedUse: false });
    const early = [...submit(1, phase(finding())), ...read(3, { id: "call-original", artifactId: ORIGINAL }), ...read(5, { id: "call-generated", artifactId: GENERATED })];
    expect(await consume(early)).toMatchObject({ status: "unverified", submittedUse: false });
    // A citation outside the lines the read actually returned is not backed by that read.
    const outside = finding({ build_citations: [citation(ORIGINAL), citation(GENERATED, HEAD, { range: { startLine: 40, endLine: 41 } })] });
    expect(await consume([...reads, ...submit(10, phase(outside))])).toMatchObject({ status: "unverified", submittedUse: false });
  });

  it("does not present unknown lineage as precise and still requires an honest disclosure", async () => {
    const reads = [...read(1, { id: "call-original", artifactId: ORIGINAL }), ...read(3, { id: "call-generated", artifactId: GENERATED, provenance: "unknown" })];
    const required = { requireGap: true };
    const silent = finding({ claim: "The template divides by the factor; the generated output proves it exactly." });
    expect(await consume([...reads, ...submit(10, phase(silent))], required))
      .toMatchObject({ status: "unverified", originalRetrieved: true, generatedRetrieved: true, submittedUse: true, gapDisclosed: false });
    // An exact sub-line span on a view the phase itself read is the host's independent-read case (basis "retrieved"): it only has to
    // lie inside the excerpt that read returned. A map is needed only to REACH a view that was not read.
    const operator = finding({ impact: "Lineage of the generated output is unknown, so this operator span rests on the original read alone.",
      build_citations: [citation(ORIGINAL, HEAD, { span: at(4, 60, 61) }), citation(GENERATED, HEAD, { span: at(4, 60, 64) })] });
    expect(await consume([...reads, ...submit(10, phase(operator))], required))
      .toMatchObject({ status: "verified", submittedUse: true, gapDisclosed: true });
    // A span outside what the read returned (past the line end, or reversed) is invented precision, whatever the lineage says.
    for (const span of [at(4, 70, 90), at(4, 0, 200), { start: { line: 4, column: 61 }, end: { line: 4, column: 60 } }]) {
      const invented = finding({ impact: "Lineage of the generated output is unknown.", build_citations: [citation(ORIGINAL, HEAD, { span }), citation(GENERATED)] });
      expect(await consume([...reads, ...submit(10, phase(invented))], required)).toMatchObject({ status: "unverified", submittedUse: false });
    }
    // A mapped claim (the original reached through the generated view, never read) cannot stand: unknown lineage offers no map to reach it.
    const mapped = finding({ impact: "Lineage of the generated output is unknown.", evidence_ids: ["call-generated"],
      build_citations: [citation(ORIGINAL, HEAD, { span: at(4, 60, 61) }), citation(GENERATED, HEAD, { span: at(4, 60, 61) })] });
    expect(await consume([...read(3, { id: "call-generated", artifactId: GENERATED, provenance: "unknown" }), ...submit(10, phase(mapped))], required))
      .toMatchObject({ status: "unverified", originalRetrieved: false, submittedUse: false });
    const honest = finding({ impact: "Lineage of the generated output is unknown (no recorded transformation), so attribution to this template is uncertain." });
    expect(await consume([...reads, ...submit(10, phase(honest))], required)).toEqual({
      status: "verified", originalRetrieved: true, generatedRetrieved: true, submittedUse: true, gapDisclosed: true,
      toolCallIds: ["call-original", "call-generated"],
    });
    // Wording alone cannot create a gap: the replies show recorded lineage, so a required gap was not exercised.
    expect(await consume([...bothReads(), ...submit(10, phase(honest))], required)).toMatchObject({ status: "unverified", gapDisclosed: false });
  });

  it("takes the lineage disclosure from a record that cites the generated read, in the submission that used the evidence", async () => {
    const reads = [...read(1, { id: "call-original", artifactId: ORIGINAL }), ...read(3, { id: "call-generated", artifactId: GENERATED, provenance: "inferred" })];
    const required = { requireGap: true };
    // The record about the original is silent; the finding about the generated file cites the generated read and states the gap.
    const use = finding({ claim: "The template divides by the factor." });
    const disclosure = finding({ id: "R2", file: "build/generated/example/Pricing.java", title: "Generated lineage degraded",
      impact: "The head generated output lineage is 'inferred', not exporter-recorded, and no validated map ties it to the template.",
      evidence_ids: ["call-generated"], build_citations: [citation(GENERATED)] });
    expect(await consume([...reads, ...submit(10, phase(use, disclosure))], required)).toEqual({
      status: "verified", originalRetrieved: true, generatedRetrieved: true, submittedUse: true, gapDisclosed: true,
      toolCallIds: ["call-original", "call-generated"],
    });
    const unverified = (events: Event[]) => consume(events, required);
    // The sibling must itself cite the generated read: wording in an unrelated record does not count.
    expect(await unverified([...reads, ...submit(10, phase(use, { ...disclosure, evidence_ids: [], build_citations: [] }))]))
      .toMatchObject({ status: "unverified", submittedUse: true, gapDisclosed: false });
    // A fabricated citation (outside the returned lines) disqualifies that record as a disclosure.
    const outside = { ...disclosure, build_citations: [citation(GENERATED, HEAD, { range: { startLine: 40, endLine: 41 } })] };
    expect(await unverified([...reads, ...submit(10, phase(use, outside))])).toMatchObject({ status: "unverified", gapDisclosed: false });
    // It must sit in the same accepted submission as the use: a later submission, or a rejected one, is not that submission.
    expect(await unverified([...reads, ...submit(10, phase(use)), ...submit(12, phase(disclosure))]))
      .toMatchObject({ status: "unverified", submittedUse: true, gapDisclosed: false });
    expect(await unverified([...reads, ...submit(10, phase(use)), ...submit(12, phase(use, disclosure), { accepted: false })]))
      .toMatchObject({ status: "unverified", gapDisclosed: false });
    // Topic words alone are not a disclosure, and a state word about something else is not either.
    for (const impact of [
      "Reviewed the lineage, provenance and attribution of the generated output.",
      "The head generated output lineage is exporter-recorded and validated.",
      "The test framework is unknown.",
    ]) {
      expect(await unverified([...reads, ...submit(10, phase(use, { ...disclosure, title: "Generated file note", impact }))]))
        .toMatchObject({ status: "unverified", gapDisclosed: false });
    }
    // The wording must describe the state the read reported ("unknown" is not "inferred" and the reverse), but any honest wording of the
    // same state counts: the lack of a validated map IS the inferred state, not an extra phrase to be quoted.
    const note = (impact: string) => ({ ...disclosure, title: "Generated file note", impact });
    expect(await unverified([...reads, ...submit(10, phase(use, note("The head generated output lineage is unknown.")))]))
      .toMatchObject({ status: "unverified", gapDisclosed: false });
    expect(await unverified([...reads, ...submit(10, phase(use, note("The head generated output has no validated map and its lineage is not exporter-recorded.")))]))
      .toMatchObject({ status: "verified", gapDisclosed: true });
    const unknownReads = [...read(1, { id: "call-original", artifactId: ORIGINAL }), ...read(3, { id: "call-generated", artifactId: GENERATED, provenance: "unknown" })];
    expect(await unverified([...unknownReads, ...submit(10, phase(use, note("The head generated output lineage is inferred.")))]))
      .toMatchObject({ status: "unverified", gapDisclosed: false });
    expect(await unverified([...unknownReads, ...submit(10, phase(use, note("The head generated output has no recorded transformation.")))]))
      .toMatchObject({ status: "verified", gapDisclosed: true });
    // Dropped maps are their own observed state: the generated read reported a diagnostic, so the lineage must be described as invalid.
    const hostile = [...read(1, { id: "call-original", artifactId: ORIGINAL }),
      ...read(3, { id: "call-generated", artifactId: GENERATED, mapDiagnostics: [{ transformationId: "pricing-generate", reason: "range-out-of-bounds", count: 1 }] })];
    expect(await unverified([...hostile, ...submit(10, phase(use))])).toMatchObject({ status: "unverified", gapDisclosed: false });
    expect(await unverified([...hostile, ...submit(10, phase(use, note("Some source maps of the generated output were dropped as out-of-bounds, so no precise mapping is claimed.")))]))
      .toMatchObject({ status: "verified", gapDisclosed: true });
  });

  it("accepts an unavailable generated view only as typed denial plus an explicit gap, never as fabricated retrieval", async () => {
    const reads = [...read(1, { id: "call-original", artifactId: ORIGINAL }), ...read(3, { id: "call-generated", artifactId: GENERATED, failure: "artifact-unavailable" })];
    const original = { evidence_ids: ["call-original"], build_citations: [citation(ORIGINAL)] };
    const disclosed = finding({ ...original, impact: "The generated output was not produced (generation failed), so only the authored template could be reviewed." });
    expect(await consume([...reads, ...submit(10, phase(disclosed))], { requireGap: true })).toEqual({
      status: "verified", originalRetrieved: true, generatedRetrieved: false, submittedUse: true, gapDisclosed: true, toolCallIds: ["call-original"],
    });
    expect(await consume([...reads, ...submit(10, phase(finding({ ...original, impact: "Reviewed the template." })))], { requireGap: true }))
      .toMatchObject({ status: "unverified", generatedRetrieved: false, gapDisclosed: false });
    const fabricated = finding({ impact: "The generated output was not produced.", evidence_ids: ["call-original", "call-generated"], build_citations: [citation(ORIGINAL), citation(GENERATED)] });
    expect(await consume([...reads, ...submit(10, phase(fabricated))], { requireGap: true })).toMatchObject({ status: "unverified", submittedUse: false });
    // Without a typed denial for the missing view there is nothing to excuse it.
    expect(await consume([...read(1, { id: "call-original", artifactId: ORIGINAL }), ...submit(10, phase(disclosed))], { requireGap: true }))
      .toMatchObject({ status: "unverified", generatedRetrieved: false });
  });

  it("reads checksum-verified blob payloads", async () => {
    const body = { tool: "leveret_build_artifact", is_error: false, result: { content: [{ type: "text", text: JSON.stringify(reply({ id: "x", artifactId: ORIGINAL })) }] } };
    const encoded = JSON.stringify(body);
    const sha = createHash("sha256").update(encoded).digest("hex");
    const events = [...bothReads(), ...submit(10, phase(finding()))];
    const blobbed = events.map((event) => event.tool_call_id === "call-original" && event.event === "execution_end"
      ? { ...event, payload: undefined, payload_ref: { sha256: sha, bytes: encoded.length, media_type: "application/json", encoding: "json" } } : event);
    expect(await verifyBuildEvidenceConsumption(writeTrace(blobbed, { blobs: { [sha]: body } }), expectation)).toMatchObject({ originalRetrieved: true, status: "verified" });
    await expect(verifyBuildEvidenceConsumption(writeTrace(blobbed, { blobs: { [sha]: { ...body, tampered: true } } }), expectation))
      .rejects.toThrow(/checksum/);
  });
});

describe("verifyCallerConsumption", () => {
  const caller = { side: "head" as const, manifestSha256: HEAD, generatedArtifactId: GENERATED, callerPaths: [CALLER] };
  /** `owner` is how the caller's own file is identified: the real exported environment names it by its authored artifact; a fallback scope names nothing. */
  function references(options: { artifactId?: string; paths?: string[]; side?: "base" | "head"; ok?: boolean;
    owner?: { manifestSha256: string; origin: "authored" | "materialized" | "external" } | null } = {}) {
    const artifactId = options.artifactId ?? GENERATED;
    const target = { id: "t", bindingKey: "Lexample/Pricing;.price(I)I", signature: "example.Pricing.price(int)", nameRange: at(4, 22, 27), sourceSet: "main",
      location: { path: "build/generated/example/Pricing.java", range: at(4, 4, 70), buildArtifact: { manifestSha256: HEAD, artifactId, origin: "materialized" } } };
    const result = {
      summary: { analysisId: "a", repositoryId: "fixture", revision: "h", configurationSha256: "c", coverage: {
        complete: true, mainExamined: 2, testExamined: 1, mainSkipped: 0, testSkipped: 0, mainUnresolved: 0, testUnresolved: 0, diagnosticCount: 0 } },
      target, side: options.side ?? "head", referenceScope: "all",
      items: (options.paths ?? [CALLER]).map((path, index) => ({ kind: "reference", unresolved: null, file: null, diagnostic: null, reference: {
        id: `r${index}`, targetId: "t", enclosing: null, sourceSet: "test", kind: "call", basis: "checked", diffStatus: "outside-diff",
        location: { path, range: at(3, 27, 43), buildArtifact: options.owner === null ? null
          : { manifestSha256: options.owner?.manifestSha256 ?? HEAD, artifactId: `caller-${index}`, origin: options.owner?.origin ?? "authored" } } } })),
      delivery: { complete: true, truncated: false, omittedRecords: 0, nextCursor: null },
    };
    return [
      { sequence: 1, category: "tools", event: "execution_start", tool_call_id: "call-java", session_id: SESSION, payload: { tool: "leveret_java_references",
        args: { side: options.side ?? "head", target: { artifactId: options.artifactId ?? GENERATED, position: { line: 4, column: 22 } } } } },
      { sequence: 2, category: "tools", event: "execution_end", tool_call_id: "call-java", session_id: SESSION, payload: { tool: "leveret_java_references", is_error: false,
        result: { content: [{ type: "text", text: "evidence_id: call-java" }, { type: "text", text: JSON.stringify(options.ok === false ? { ok: false, error: { code: "invalid-input", message: "x" } } : { ok: true, result }) }] } } },
    ];
  }
  const cites = (text: string) => phase(finding({ evidence_ids: ["call-java"], build_citations: [], evidence_hint: text }));

  it("requires an artifact-targeted head query whose checked callers a later accepted record names", async () => {
    const ok = await verifyCallerConsumption(writeTrace([...references(), ...submit(10, cites(`checked caller ${CALLER}:3`))]), caller);
    expect(ok).toEqual({ status: "verified", evidenceReturned: true, subsequentUse: true, toolCallIds: ["call-java"] });
    for (const events of [
      [...references({ side: "base" }), ...submit(10, cites(CALLER))],
      [...references({ artifactId: ORIGINAL }), ...submit(10, cites(CALLER))],
      [...references({ ok: false }), ...submit(10, cites(CALLER))],
      [...references({ paths: ["src/main/java/example/Other.java"] }), ...submit(10, cites(CALLER))],
      // A caller must be an authored original of the same export: another manifest or generated/external bytes are not.
      [...references({ owner: { manifestSha256: BASE, origin: "authored" } }), ...submit(10, cites(CALLER))],
      [...references({ owner: { manifestSha256: HEAD, origin: "materialized" } }), ...submit(10, cites(CALLER))],
      [...references({ owner: { manifestSha256: HEAD, origin: "external" } }), ...submit(10, cites(CALLER))],
    ]) expect(await verifyCallerConsumption(writeTrace(events), caller)).toMatchObject({ status: "unverified", evidenceReturned: false });
    expect(await verifyCallerConsumption(writeTrace([...references(), ...submit(10, cites("a caller exists"))]), caller))
      .toMatchObject({ status: "unverified", evidenceReturned: true, subsequentUse: false });
  });

  it("accepts the typed shapes a real exported review returns: authored caller identity, or none for a fallback scope", async () => {
    for (const owner of [{ manifestSha256: HEAD, origin: "authored" as const }, null]) {
      expect(await verifyCallerConsumption(writeTrace([...references({ owner }), ...submit(10, cites(`checked caller ${CALLER}`))]), caller))
        .toEqual({ status: "verified", evidenceReturned: true, subsequentUse: true, toolCallIds: ["call-java"] });
    }
  });
});

describe("shared review evidence reader", () => {
  it("reads events and refuses a payload whose bytes do not match its recorded checksum", async () => {
    const events = [...bothReads(), ...submit(10, phase(finding()))];
    const dir = writeTrace(events);
    const parsed = await readRunnerEvents(dir);
    expect(parsed.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 10, 11]);
    expect(await eventPayload(dir, parsed[0]!)).toMatchObject({ tool: "leveret_build_artifact" });
    const sha = "c".repeat(64);
    writeFileSync(join(dir, "blobs/sha256", sha), JSON.stringify({ tool: "x" }));
    await expect(eventPayload(dir, { sequence: 99, category: "tools", event: "execution_end", payload_ref: { sha256: sha } })).rejects.toThrow(/checksum/);
  });

  it("yields only accepted leveret_submit_phase arguments after the given sequence", async () => {
    const events = [...submit(1, { first: true }, { id: "s1" }), ...submit(5, { rejected: true }, { accepted: false, id: "s2" }),
      ...submit(8, { third: true }, { id: "s3" }), ...submit(12, { other: true }, { tool: "leveret_read", id: "s4" })];
    const dir = writeTrace(events);
    const seen: unknown[] = [];
    for await (const { args } of submittedPayloads(dir, await readRunnerEvents(dir), 2)) seen.push(args);
    expect(seen).toEqual([{ third: true }]);
  });

  it("finds only the objects that directly cite an evidence ID", () => {
    const records = citingRecords({ findings: [{ evidence_ids: ["c1"], note: "own" }, { evidence_ids: ["c2"], note: "neighbour" }] }, "c1");
    expect(records).toEqual(["c1\nown"]);
  });

  it("parses the shared evaluation flags exactly once each", () => {
    const ok = ["--mode", "deterministic", "--config", "/c.json", "--config-sha256", "a".repeat(64), "--output", "/o"];
    expect(evaluationArguments(ok)).toEqual({ mode: "deterministic", config: "/c.json", configSha256: "a".repeat(64), output: "/o" });
    expect(() => evaluationArguments(ok.slice(2))).toThrow(/Invalid evaluation arguments/);
    expect(() => evaluationArguments(["--mode", "other", ...ok.slice(2)])).toThrow(/Invalid evaluation arguments/);
    expect(() => evaluationArguments([...ok, "--mode", "review"])).toThrow(/Expected distinct/);
  });
});

function caseResult(overrides: Partial<BuildCaseResult> = {}): BuildCaseResult {
  const view = (state: "retrieved" | "unavailable", extra: object = {}) => ({
    state, error: state === "retrieved" ? null : "artifact-unavailable", sha256: state === "retrieved" ? "1".repeat(64) : null, frozenSha256: "1".repeat(64),
    consumerState: state === "retrieved" ? "available" as const : "not-produced" as const,
    origin: "authored" as const, provenance: "authored", maps: 0, mapDiagnostics: [] as string[], ...extra,
  });
  return {
    name: "valid-generation", mode: "valid", derivation: null,
    frozen: { base: { revision: "r".repeat(40), manifestSha256: BASE }, head: { revision: "s".repeat(40), manifestSha256: HEAD } },
    export: { outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "prepared", reason: null }, { role: "test", outcome: "prepared", reason: null }],
      complete: true, artifacts: { available: 9, missing: 0, "not-produced": 0, withheld: 0, rejected: 0 } },
    original: view("retrieved"),
    generated: view("retrieved", { origin: "materialized", provenance: "exporter-recorded", maps: 2, sha256: "2".repeat(64), frozenSha256: "2".repeat(64) }),
    callers: { attempted: true, resolved: true, error: null, paths: ["src/main/java/example/Consumer.java", CALLER] },
    coverage: { complete: true }, facts: {}, markerExposed: false, withheldDigestExposed: false,
    ...overrides,
  };
}

describe("build case scoring", () => {
  it("accepts a supported generation whose views match their frozen hashes", () => {
    expect(scoreBuildCase(caseResult())).toEqual([]);
  });

  it("never scores a rejected or degraded export as complete", () => {
    expect(exportComplete({ outcome: "rejected", reason: "manifest-hash-mismatch", scopes: [] })).toBe(false);
    expect(exportComplete({ outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "fallback", reason: "unsupported-preview" }, { role: "test", outcome: "prepared", reason: null }] })).toBe(false);
    expect(exportComplete({ outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "prepared", reason: null }, { role: "test", outcome: "prepared", reason: null }] })).toBe(true);
    const rejected = caseResult({
      name: "rejected-export", mode: "valid", derivation: "stale-manifest-pin",
      export: { outcome: "rejected", reason: "manifest-hash-mismatch", scopes: [], complete: true, artifacts: null },
      original: null, generated: null, callers: { attempted: true, resolved: false, error: "invalid-input", paths: [] }, coverage: { complete: false },
    });
    expect(scoreBuildCase(rejected)).toEqual([expect.stringMatching(/complete/)]);
    expect(scoreBuildCase({ ...rejected, export: { ...rejected.export, complete: false } })).toEqual([]);
    expect(scoreBuildCase({ ...rejected, export: { ...rejected.export, complete: false }, coverage: { complete: true } })).not.toEqual([]);
  });

  it("scores unavailable generated bytes only as unavailable, never as a retrieved success", () => {
    const missing = caseResult({
      name: "missing-output", mode: "generation-failed",
      export: { outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "fallback", reason: "artifact-unavailable" }, { role: "test", outcome: "fallback", reason: "artifact-unavailable" }],
        complete: false, artifacts: { available: 8, missing: 0, "not-produced": 1, withheld: 0, rejected: 0 } },
      generated: { state: "unavailable", error: "artifact-unavailable", sha256: null, frozenSha256: null, consumerState: "not-produced", origin: null, provenance: null, maps: 0, mapDiagnostics: [] },
      callers: { attempted: true, resolved: false, error: "invalid-input", paths: [] }, coverage: { complete: false },
    });
    expect(scoreBuildCase(missing)).toEqual([]);
    expect(scoreBuildCase({ ...missing, generated: caseResult().generated })).not.toEqual([]);
    expect(scoreBuildCase({ ...missing, callers: { attempted: true, resolved: true, error: null, paths: [CALLER] } })).not.toEqual([]);
    // The canonical inventory state of the missing output is `not-produced`; any other reason is a different gap.
    expect(scoreBuildCase({ ...missing, generated: { ...missing.generated!, consumerState: "withheld" } })).not.toEqual([]);
    expect(scoreBuildCase({ ...missing, generated: { ...missing.generated!, consumerState: "available" } })).not.toEqual([]);
  });

  it("scores a withheld secret-bearing output by its own canonical inventory state, not by a code or an aggregate count", () => {
    const secret = caseResult({
      name: "secret-resource", mode: "secret-resource",
      export: { outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "fallback", reason: "artifact-withheld" }, { role: "test", outcome: "fallback", reason: "artifact-withheld" }],
        complete: false, artifacts: { available: 8, missing: 0, "not-produced": 0, withheld: 1, rejected: 0 } },
      original: { ...caseResult().original!, mapDiagnostics: ["counterpart-unavailable"] },
      generated: { state: "unavailable", error: "artifact-unavailable", sha256: null, frozenSha256: null, consumerState: "withheld", origin: null, provenance: null, maps: 0, mapDiagnostics: [] },
      callers: { attempted: true, resolved: false, error: "invalid-input", paths: [] }, coverage: { complete: false },
    });
    // The reader legitimately reports a statically withheld artifact as unavailable; it need not echo a secret-detected code.
    expect(scoreBuildCase(secret)).toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: { ...secret.generated!, error: "secret-detected" } })).toEqual([]);
    const wrongGap = (consumerState: "available" | "missing" | "not-produced" | "rejected") =>
      scoreBuildCase({ ...secret, generated: { ...secret.generated!, consumerState } });
    // An unrelated withheld artifact in the aggregate count cannot excuse a denial that the inventory does not call withheld.
    for (const state of ["available", "missing", "not-produced", "rejected"] as const) expect(wrongGap(state)).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: { ...secret.generated!, error: null } })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: { ...secret.generated!, sha256: "7".repeat(64) } })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: { ...secret.generated!, frozenSha256: "7".repeat(64) } })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, withheldDigestExposed: true })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, markerExposed: true })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: caseResult().generated })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, export: { ...secret.export, artifacts: { ...secret.export.artifacts!, withheld: 0 } } })).not.toEqual([]);
    // A withheld counterpart must invalidate the original's maps rather than leave precise ones behind.
    expect(scoreBuildCase({ ...secret, original: { ...secret.original!, mapDiagnostics: [] } })).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, original: { ...secret.original!, maps: 1 } })).not.toEqual([]);
    // A returned view can never be one the inventory calls withheld, missing, not-produced or rejected: that would be fabricated success.
    for (const state of ["withheld", "missing", "not-produced", "rejected"] as const) {
      expect(scoreBuildCase(caseResult({ generated: { ...caseResult().generated!, consumerState: state } }))).not.toEqual([]);
      expect(scoreBuildCase({ ...secret, original: { ...secret.original!, consumerState: state } })).not.toEqual([]);
    }
    // An authored original the inventory does not describe (unlisted) may legitimately be read.
    expect(scoreBuildCase(caseResult({ original: { ...caseResult().original!, consumerState: "unlisted" } }))).toEqual([]);
    // An inventory-available artifact can be denied for a dynamic reason (unsupported encoding, a rotated policy). That is not a withheld
    // denial, and it never lets a case that requires both views pass.
    const dynamicDenial = { state: "unavailable" as const, error: "unsupported-encoding", sha256: null, frozenSha256: null, consumerState: "available" as const, origin: null, provenance: null, maps: 0, mapDiagnostics: [] };
    expect(scoreBuildCase(caseResult({ generated: dynamicDenial }))).not.toEqual([]);
    expect(scoreBuildCase({ ...secret, generated: dynamicDenial })).not.toEqual([]);
  });

  it("does not let a hostile or unknown lineage yield precise maps, and rejects drifted or leaked bytes", () => {
    const hostile = caseResult({
      name: "hostile-source-map", mode: "template-defect", derivation: "out-of-bounds-and-reversed-map-ranges",
      generated: { ...caseResult().generated!, maps: 0, mapDiagnostics: ["range-out-of-bounds", "range-reversed"] },
    });
    expect(scoreBuildCase(hostile)).toEqual([]);
    expect(scoreBuildCase({ ...hostile, generated: { ...hostile.generated!, maps: 1 } })).not.toEqual([]);
    expect(scoreBuildCase(caseResult({ generated: { ...caseResult().generated!, sha256: "9".repeat(64) } }))).not.toEqual([]);
    expect(scoreBuildCase(caseResult({ markerExposed: true }))).not.toEqual([]);
    const unsupported = caseResult({
      name: "unsupported-compiler", mode: "valid", derivation: "preview-enabled-production-compiler",
      export: { outcome: "admitted", reason: null, scopes: [{ role: "production", outcome: "fallback", reason: "unsupported-preview" }, { role: "test", outcome: "prepared", reason: null }],
        complete: false, artifacts: { available: 9, missing: 0, "not-produced": 0, withheld: 0, rejected: 0 } },
      callers: { attempted: true, resolved: false, error: "invalid-input", paths: [] },
    });
    expect(scoreBuildCase(unsupported)).toEqual([]);
    expect(scoreBuildCase({ ...unsupported, export: { ...unsupported.export, scopes: [{ role: "production", outcome: "prepared", reason: null }, { role: "test", outcome: "prepared", reason: null }], complete: true } })).not.toEqual([]);
  });
});

describe("build-evidence command", () => {
  const tsx = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  function run(args: string[], env: Record<string, string>) {
    const { status, stdout, stderr } = spawnSync(process.execPath, [tsx, "bench/build-evidence.mts", ...args],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...env } });
    return { status, stdout, stderr };
  }
  const failure = (stderr: string) => JSON.parse(stderr.trim().split("\n").at(-1) ?? "null");
  const flags = (output: string, mode = "review") => ["--mode", mode, "--config", join(home, "missing.json"), "--config-sha256", "0".repeat(64), "--output", output];
  const declared = () => ({ LEVERET_PAID_MODEL_APPROVED: "1", LEVERET_RUNNER_PROVIDER: "zai", LEVERET_RUNNER_MODEL: "glm-5.3-flash", LEVERET_RUNNER_EFFORT: "high", LEVERET_PI_AGENT_DIR: join(home, "agent") });

  it("is exposed as the bench:build-evidence package script", () => {
    const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts["bench:build-evidence"]).toBe("tsx bench/build-evidence.mts");
  });

  it("refuses review mode before creating output without model approval or a declared model", () => {
    const output = join(home, "review-output");
    const unapproved = run(flags(output), { ...declared(), LEVERET_PAID_MODEL_APPROVED: "" });
    expect(unapproved.status).not.toBe(0);
    expect(JSON.parse(unapproved.stdout)).toMatchObject({ ok: false, error: { code: "approval-required" } });
    for (const missing of ["LEVERET_RUNNER_PROVIDER", "LEVERET_RUNNER_MODEL", "LEVERET_RUNNER_EFFORT", "LEVERET_PI_AGENT_DIR"]) {
      const result = run(flags(output), { ...declared(), [missing]: "" });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "model-declaration-required" } });
    }
    expect(existsSync(output)).toBe(false);
  });

  it("rejects missing flags, a digest mismatch and an output directory inside the checkout without creating it", () => {
    const config = join(home, "template.json");
    writeFileSync(config, "{}");
    const missingFlag = run(["--mode", "deterministic", "--config", config], {});
    expect(missingFlag.status).not.toBe(0);
    expect(failure(missingFlag.stderr)).toMatchObject({ ok: false });
    const output = join(home, "digest-output");
    const mismatch = run(["--mode", "deterministic", "--config", config, "--config-sha256", "0".repeat(64), "--output", output], {});
    expect(mismatch.status).not.toBe(0);
    expect(failure(mismatch.stderr)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/digest mismatch/) } });
    const inside = join(process.cwd(), "build-evidence-output-must-not-exist");
    const refused = run(["--mode", "deterministic", "--config", config, "--config-sha256", createHash("sha256").update("{}").digest("hex"), "--output", inside], {});
    expect(refused.status).not.toBe(0);
    expect(failure(refused.stderr)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/inside Leveret's checkout/) } });
    expect(existsSync(inside)).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
});
