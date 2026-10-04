import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { ChangeManifest } from "../src/change-evidence.js";
import type { EvidencePack } from "../src/evidence-pack.js";
import type { GuidanceResult } from "../src/semantic-checks.js";
import {
  SPECIALIZED_DISCOVERY,
  SPECIALIZED_LEG_DEFINITIONS,
  TARGETED_VERIFIER_TOOLS,
  assignDiscoveryFiles,
  buildDiscoveryLegPlans,
  discoveryMode,
  parseDiscoveryLegOutput,
  runSpecializedDiscovery,
  phaseToolIdentity,
  selectPhaseTools,
  validateDiscoveryEvidence,
  type DiscoveryLegPlan,
  specializedReviewOutput,
} from "../src/runner/discovery-legs.js";
import { piRuntimeConfig, singleDiscoveryInput } from "../src/runner/pi.js";
import { MECHANISM_CHECKLISTS } from "../src/runner/mechanism-checklists.js";
import { parseReviewOutput, verifySchemaGaps } from "../src/runner/verify-output.js";

const manifest: ChangeManifest = {
  schema: 1, base: "0".repeat(40), head: "1".repeat(40), range: `${"0".repeat(40)}...${"1".repeat(40)}`, truncated: false, errors: [],
  files: [
    ["src/core.ts", "Shell"], ["test/core.test.ts", "Python"], [".github/workflows/ci.yml", "YAML"], ["docs/contract.md", "Shell"], ["unknown.txt", "Text"],
  ].map(([path, language]) => ({
    path, oldPath: path, newPath: path, status: "modify" as const, similarity: null, language, binary: false, lines: { added: 1, deleted: 1 },
    old: { exists: true, oid: "2".repeat(40), mode: "100644", bytes: 10, type: "text" as const },
    new: { exists: true, oid: "3".repeat(40), mode: "100644", bytes: 10, type: "text" as const },
    truncated: false, hunks: [{ index: 1, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }], errors: [],
  })),
};

const kinds = { "src/core.ts": "source", "test/core.test.ts": "test", ".github/workflows/ci.yml": "workflow", "docs/contract.md": "publisher", "unknown.txt": "unknown" } as const;
const evidencePack = {
  schema: "leveret.evidence-pack/v1", version: 1, base: manifest.base, head: manifest.head, range: manifest.range,
  provenance: { changeManifestSha256: "a", projectFactsSha256: "b", profileConfigSha256: "c", profileSourceSha256: null, engineRegistrySha256: "d", scanResultSha256: "e" },
  files: manifest.files.map((file, index) => ({ path: file.path, status: file.status, disposition: "selected", reason: "fixture", language: file.language ?? "Text", kind: kinds[file.path as keyof typeof kinds], evidenceId: `F${index + 1}`, facts: { sourceRoot: file.path.startsWith("src/") ? "src" : null, testRoot: file.path.startsWith("test/") ? "test" : null, buildSystems: ["Node package"], frameworks: [], workflowEvidenceId: file.path.includes("workflows") ? "W1" : null } })),
  project: { trackedFiles: 5, languages: [{ language: "TypeScript", files: 2 }, { language: "YAML", files: 1 }], buildSystems: [{ name: "Node package", evidence: ["package.json"] }], frameworks: [], sourceRoots: ["src"], testRoots: ["test"], manifests: [], manifestErrors: [], truncated: { manifests: false, roots: false }, omitted: { languages: 0, buildSystems: 0, frameworks: 0, sourceRoots: 0, testRoots: 0, manifests: 0, manifestErrors: 0 } },
  workflows: { files: [{ path: ".github/workflows/ci.yml", name: "CI", status: "completed", jobs: [{ id: "test", name: "test", runsOn: "ubuntu-latest", shell: "bash", shellSource: "runner-default", steps: [{ index: 1, id: null, name: "locale", kind: "run", shell: "bash", shellSource: "runner-default", commandNames: ["locale", "udevadm"], uses: null, text: "locale -a\nudevadm trigger", truncated: false, evidenceId: "WS1" }], omittedStepIds: [], omittedStepCount: 0, evidenceId: "WJ1" }], omittedJobIds: [], omittedJobCount: 0, errors: [], evidenceId: "W1" }], omittedFileIds: [], omittedFileCount: 0, errors: [] },
  analyzers: [{ id: "secret-analyzer", applicability: "applicable", lifecycle: "completed", reason: "SECRET_ANALYZER_TARGET", definitionSha256: "x", configSha256: "x", profileSourceSha256: null, ruleSources: [], executable: null, selectedFiles: [], omittedSelectedFileIds: [], omittedSelectedFileCount: 0, counts: { found: 1, surviving: 1, reminders: 0, suppressed: 0 }, durationMs: 1, cache: "unknown", evidenceIds: [], semanticCoverage: false, staticResult: "completed", detail: null }],
  leads: { items: [{ id: "L1", evidenceId: "scan-1", engine: "fixture", rule: "fixture", severity: "warning", file: "src/core.ts", range: { start: 1, end: 1 }, message: "SECRET_SCAN_TARGET", provenance: "introduced", source: "finding" }], totalAfterSuppression: 1, deduplicated: 0, omittedIds: [], omittedIdCount: 0, omittedIdsTruncated: 0 },
  suppression: { entries: [], preExisting: 0 }, completeness: { manifestTruncated: false, errors: [], staticCleanIsSemanticCoverage: false },
  limits: { maxPackBytes: 1, contextBytes: 1, maxLeads: 1, maxWorkflowFiles: 1, maxWorkflowJobs: 1, maxWorkflowSteps: 1, maxStepTextBytes: 1, maxSelectedFilesPerAnalyzer: 1 },
} as unknown as EvidencePack;
const guidance = {
  schema: "leveret.guidance-result/v1", version: 1, base: manifest.base, head: manifest.head,
  provenance: { evidencePackSha256: "a", changeManifestSha256: "b", cardSetSha256: "c", ruleSetSha256: "d", dataSha256: "e" }, selectedCards: [],
  ruleLeads: [{ id: "G1", ruleId: "workflow-prerequisite-same-job", selectedFacts: ["SECRET_RULE_TARGET"], evidence: { path: "x", startLine: 1, endLine: 1, excerpt: "x", sha256: "x" }, command: null, message: "x", limitations: "x", applicability: "x", provenance: { kind: "host-packaged-rule", evidencePackSha256: "a" } }],
  mutationLeads: [{ id: "M1", mutationId: "last-list-entry-removal", selectedFacts: ["SECRET_MUTATION_TARGET"], evidence: { path: "x", evidenceId: "x" }, command: null, limitations: "x", applicability: "x", provenance: { kind: "host-packaged-mutation", evidencePackSha256: "a" } }],
  residualQuestions: [{ cardId: "x", question: "SECRET_RESIDUAL_TARGET" }], omissions: [], budgets: { selectedCards: 0, cardBytes: 0, maxCards: 6, maxCardBytes: 1024, totalBytes: 0, maxTotalBytes: 8192 }, coverage: [], rejectedControls: [],
} as unknown as GuidanceResult;

const coverageFor = (files: string[], unexamined = new Set<string>()) => files.map((file) => ({ file, state: unexamined.has(file) ? "unexamined" as const : "examined" as const, ...(unexamined.has(file) ? { note: "fixture omission" } : {}), evidence_ids: [] }));
const disclosureFor = (
  plan: DiscoveryLegPlan,
  unexamined = new Set<string>(),
) => ({
  files: coverageFor(plan.assignedFiles, unexamined),
  checklists: plan.checklistIds.map((id) => ({ id, state: "examined" as const })),
  stopping: { rule: plan.definition.stoppingRule, reason: "complete" },
});
const tools = ["leveret_diff", "leveret_read", "leveret_grep", "leveret_find", "leveret_ast_search", "leveret_probe", "leveret_scan", "leveret_context", "leveret_memory", "leveret_java_references", "leveret_build_artifact", "codegraph_explore", "graphify_query", "graphify_path", "graphify_explain", "lsp_find_declaration", "lsp_find_referencing_symbols"].map((name) => ({ name, label: name, description: name, parameters: {}, execute: vi.fn() })) as unknown as ToolDefinition[];

describe("specialized discovery", () => {
  it("keeps discovery and scheduling host-owned and separate", () => {
    expect(discoveryMode(undefined)).toBe("single");
    expect(piRuntimeConfig({}, {})).toMatchObject({ discoveryMode: "single", discoveryScheduler: { id: "serial/v1", concurrency_bound: 1 } });
    expect(piRuntimeConfig({ discoveryMode: "specialized/v1", discoveryScheduler: "bounded-concurrent/v1", discoveryConcurrency: "2" }, {})).toMatchObject({ discoveryMode: "specialized/v1", discoveryScheduler: { id: "bounded-concurrent/v1", concurrency_bound: 2 } });
    expect(SPECIALIZED_DISCOVERY).toMatchObject({ requiredLegs: ["correctness", "test-honesty", "contract-operability"], verifier: { count: 1 } });
    expect(() => discoveryMode("from-pr")).toThrow(/invalid discovery mode/);
  });

  it("packages distinct definitions, deterministic assignments, bounded inputs, and exact tool identities", () => {
    expect(new Set(SPECIALIZED_LEG_DEFINITIONS.map((leg) => leg.systemPrompt)).size).toBe(3);
    expect(new Set(SPECIALIZED_LEG_DEFINITIONS.map((leg) => leg.definitionSha256)).size).toBe(3);
    const assignments = assignDiscoveryFiles(manifest, evidencePack);
    expect(assignments.find((item) => item.file === "src/core.ts")?.assignedLegs).toEqual(["correctness", "contract-operability"]);
    expect(assignments.find((item) => item.file === "test/core.test.ts")?.assignedLegs).toEqual(["test-honesty"]);
    expect(assignments.find((item) => item.file === ".github/workflows/ci.yml")?.assignedLegs).toEqual(["correctness", "test-honesty", "contract-operability"]);
    expect(assignments.find((item) => item.file === "unknown.txt")?.assignedLegs).toEqual(["contract-operability"]);
    const plans = buildDiscoveryLegPlans(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" });
    expect(JSON.stringify(plans)).not.toMatch(/SECRET_(SCAN|RULE|MUTATION|RESIDUAL|ANALYZER)_TARGET/);
    expect(new Set(plans.map((plan) => plan.inputSha256)).size).toBe(3);
    expect(new Set(plans.map((plan) => JSON.stringify(phaseToolIdentity(selectPhaseTools(tools, plan.definition.requiredTools, plan.definition.optionalTools)).names))).size).toBe(3);
    expect(JSON.stringify(plans.map((plan) => plan.input))).not.toMatch(/pfblockerng-(2444|2521)-r/);
    expect(new Set(plans.flatMap((plan) => plan.checklistIds))).toEqual(new Set(MECHANISM_CHECKLISTS.map((checklist) => checklist.id)));
    for (const plan of plans) {
      const selected = selectPhaseTools(tools, plan.definition.requiredTools, plan.definition.optionalTools);
      expect(phaseToolIdentity(selected).names).toEqual([...plan.definition.requiredTools, ...plan.definition.optionalTools]);
      for (const forbidden of ["leveret_scan", "leveret_context"]) {
        expect(selected.map((tool) => tool.name)).not.toContain(forbidden);
      }
    }
  });

  it("routes applicable mechanism checklists into default single discovery", () => {
    const input = singleDiscoveryInput(evidencePack, guidance) as { mechanism_checklists?: { items?: Array<{ id?: string }> } };
    const ids = input.mechanism_checklists?.items?.map((item) => item.id) ?? [];

    expect(ids).toEqual(expect.arrayContaining([
      "parsed-package-command-equivalence",
      "executable-locale-assertion",
      "udev-event-settling",
      "workflow-job-local-proof",
      "managed-environment-command",
    ]));
  });

  it("runs required legs serially, namespaces and conservatively dedupes provenance, and reports unexamined files", async () => {
    const order: string[] = [];
    const result = await runSpecializedDiscovery(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" }, async (plan) => {
      order.push(`start:${plan.definition.id}`); await Promise.resolve(); order.push(`end:${plan.definition.id}`);
      const duplicate = plan.definition.id === "correctness" || plan.definition.id === "contract-operability";
      return { leg_id: plan.definition.id, concerns: duplicate ? [{ id: "R1", file: "src/core.ts", range: { start: 4, end: 5 }, title: "same", claim: "same exact failure mechanism", impact: "breaks", evidence_hint: "read", scope: "in-diff", evidence_ids: [`e-${plan.definition.id}`] }] : [], coverage: disclosureFor(plan, new Set(plan.definition.id === "contract-operability" ? ["unknown.txt"] : [])) };
    });
    expect(order).toEqual(["start:correctness", "end:correctness", "start:test-honesty", "end:test-honesty", "start:contract-operability", "end:contract-operability"]);
    const firstPlan = buildDiscoveryLegPlans(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" })[0]!;
    expect(() => parseDiscoveryLegOutput(firstPlan, { leg_id: "foreign", concerns: [], coverage: disclosureFor(firstPlan) })).toThrow(/foreign leg ID/);
    expect(parseDiscoveryLegOutput(firstPlan, {
      leg_id: `${firstPlan.definition.id}/v${firstPlan.definition.version}`,
      concerns: [],
      coverage: disclosureFor(firstPlan),
    }).leg_id).toBe(firstPlan.definition.id);
    const mechanicallyCompleted = parseDiscoveryLegOutput(firstPlan, {
      leg_id: firstPlan.definition.id,
      concerns: [],
      coverage: {
        files: [],
        checklists: [],
        stopping: { rule: firstPlan.definition.stoppingRule, reason: "budget exhausted" },
      },
    });
    expect(mechanicallyCompleted.coverage.files).toContainEqual({
      file: firstPlan.assignedFiles[0],
      state: "unexamined",
      note: "model omitted assigned file; mechanically accounted",
      evidence_ids: [],
    });
    expect(mechanicallyCompleted.coverage.checklists).toContainEqual({
      id: firstPlan.checklistIds[0],
      state: "unresolved",
      note: "model omitted checklist; mechanically accounted",
    });
    expect(() => parseDiscoveryLegOutput(firstPlan, { leg_id: firstPlan.definition.id, concerns: [{ id: "R1", file: firstPlan.assignedFiles[0], range: { start: 1, end: 1 }, title: "x", claim: "x", impact: "x", evidence_hint: "x", scope: "in-diff", evidence_ids: [] }, { id: "R1", file: firstPlan.assignedFiles[0], range: { start: 2, end: 2 }, title: "y", claim: "y", impact: "y", evidence_hint: "y", scope: "in-diff", evidence_ids: [] }], coverage: disclosureFor(firstPlan) })).toThrow(/duplicate local concern IDs/);
    expect(result.concerns).toEqual([expect.objectContaining({ id: "correctness:R1", raising_leg_ids: ["correctness", "contract-operability"], local_concern_ids: ["correctness:R1", "contract-operability:R1"], evidence_ids: ["e-correctness", "e-contract-operability"] })]);
    expect(() => validateDiscoveryEvidence(result, { correctness: ["e-correctness"], "contract-operability": [] })).toThrow(/foreign evidence ID e-contract-operability/);
    expect(() => validateDiscoveryEvidence(result, { correctness: ["e-correctness"], "contract-operability": ["e-contract-operability"] })).not.toThrow();
    expect(specializedReviewOutput(result).coverage.files.find((file) => file.file === "unknown.txt")).toMatchObject({ verdict: "not-examined", note: "fixture omission" });
  });

  it("fails closed before later legs and gives one verifier only targeted bounded tools with exact accounting", async () => {
    const called: string[] = [];
    await expect(runSpecializedDiscovery(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" }, async (plan) => {
      called.push(plan.definition.id);
      if (plan.definition.id === "test-honesty") throw new Error("required leg failed");
      return { leg_id: plan.definition.id, concerns: [], coverage: disclosureFor(plan) };
    })).rejects.toThrow("required leg failed");
    expect(called).toEqual(["correctness", "test-honesty"]);
    const verifierTools = selectPhaseTools(tools, TARGETED_VERIFIER_TOOLS.required, TARGETED_VERIFIER_TOOLS.optional, true);
    expect(verifierTools.map((tool) => tool.name)).toEqual([...TARGETED_VERIFIER_TOOLS.required, ...TARGETED_VERIFIER_TOOLS.optional]);
    for (const forbidden of ["leveret_scan", "leveret_context", "leveret_memory", "codegraph_explore"]) {
      expect(verifierTools.map((tool) => tool.name)).not.toContain(forbidden);
    }
    const verifierDiff = verifierTools.find((tool) => tool.name === "leveret_diff")!;
    expect(Value.Check(verifierDiff.parameters, { kind: "manifest" })).toBe(false);
    expect(Value.Check(verifierDiff.parameters, { kind: "patch", paths: ["src/core.ts"] })).toBe(true);
    expect(Value.Check(verifierDiff.parameters, { kind: "patch", paths: [] })).toBe(false);
    const gaps = verifySchemaGaps({ report: [], verdicts: [{ id: "correctness:R1", grade: "dropped", reason: "not grounded" }], coverage: { lenses: ["correctness-hostile-inputs", "contract-conformance", "test-honesty", "blast-radius", "leads-triage"].map((lens) => ({ lens, outcome: "checked" })), files: manifest.files.map((file) => ({ file: file.path, verdict: file.path === "src/core.ts" ? "findings" : "considered-fine" })) }, resolutions: [] }, { concerns: [{ id: "correctness:R1", file: "src/core.ts" }], leads: [], changedFiles: manifest.files.map((file) => file.path), priorThreadIds: ["prior-1"] });
    expect(gaps).toContain("resolutions:missing:prior-1");
  });
});

describe("build evidence in discovery", () => {
  const citation = { manifestSha256: "a".repeat(64), artifactId: "pricing-output", range: { startLine: 4, endLine: 4 } };
  const firstLeg = () => buildDiscoveryLegPlans(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" })[0]!;
  const concern = (extra: object = {}) => ({
    id: "R1", file: "src/core.ts", range: { start: 4, end: 5 }, title: "t", claim: "same exact failure mechanism",
    impact: "i", evidence_hint: "h", scope: "in-diff", evidence_ids: ["e1"], ...extra,
  });
  const legOutput = (leg: DiscoveryLegPlan, concerns: unknown[]) => ({ leg_id: leg.definition.id, concerns, coverage: disclosureFor(leg) });

  it("offers the artifact tool to every leg and the verifier as an optional capability", () => {
    for (const leg of SPECIALIZED_LEG_DEFINITIONS) {
      expect(leg.optionalTools).toContain("leveret_build_artifact");
      expect(leg.requiredTools).not.toContain("leveret_build_artifact");
      expect(selectPhaseTools(tools, leg.requiredTools, leg.optionalTools).map((tool) => tool.name)).toContain("leveret_build_artifact");
      const unavailable = tools.filter((tool) => tool.name !== "leveret_build_artifact");
      expect(selectPhaseTools(unavailable, leg.requiredTools, leg.optionalTools).map((tool) => tool.name)).not.toContain("leveret_build_artifact");
    }
    expect(TARGETED_VERIFIER_TOOLS.optional).toContain("leveret_build_artifact");
    expect(TARGETED_VERIFIER_TOOLS.required).not.toContain("leveret_build_artifact");
    expect(selectPhaseTools(tools, TARGETED_VERIFIER_TOOLS.required, TARGETED_VERIFIER_TOOLS.optional, true).map((tool) => tool.name))
      .toContain("leveret_build_artifact");
  });

  it("resolves leg citations through the supplied resolver and carries them on the concern", () => {
    const leg = firstLeg();
    const calls: unknown[] = [];
    const parsed = parseDiscoveryLegOutput(leg, legOutput(leg, [concern({ build_citations: [citation] })]), (item) => {
      calls.push(item);
      return { ok: true, citations: [], anchor: null };
    });
    expect(parsed.concerns[0]?.build_citations).toEqual([citation]);
    expect(calls).toEqual([{ file: "src/core.ts", line: 4, build_citations: [citation] }]);
    expect(() => parseDiscoveryLegOutput(leg, legOutput(leg, [concern({ build_citations: [citation] })]),
      () => ({ ok: false, reason: "build citation 0 was not retrieved in this phase" }))).toThrow(/unresolved build citation/);
    expect(() => parseDiscoveryLegOutput(leg, legOutput(leg, [concern()]), () => { throw new Error("no citation to resolve"); })).not.toThrow();
  });

  it("rejects malformed citations before any resolution", () => {
    const leg = firstLeg();
    for (const bad of [
      { ...citation, manifestSha256: "short" },
      { ...citation, artifactId: "" },
      { ...citation, range: { startLine: 5, endLine: 4 } },
      { ...citation, path: "build/generated/example/Pricing.java" },
      { manifestSha256: citation.manifestSha256, artifactId: citation.artifactId },
      // a span restates the cited lines exactly, is ordered, and cannot ride on a whole-file citation
      { ...citation, range: null, span: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } } },
      { ...citation, range: { startLine: 4, endLine: 5 }, span: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } } },
      { ...citation, span: { start: { line: 4, column: 9 }, end: { line: 4, column: 2 } } },
      { ...citation, span: { start: { line: 4, column: -1 }, end: { line: 4, column: 2 } } },
      { ...citation, span: { start: { line: 4, column: 2 }, end: { line: 4, column: 9 }, extra: 1 } },
    ]) {
      expect(() => parseDiscoveryLegOutput(leg, legOutput(leg, [concern({ build_citations: [bad] })]))).toThrow();
    }
    expect(parseDiscoveryLegOutput(leg, legOutput(leg, [concern({ build_citations: [{ ...citation, range: null }] })])).concerns[0]?.build_citations)
      .toEqual([{ ...citation, range: null }]);
    // a span ending at column 0 of the next line still names only the cited line
    for (const span of [
      { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
      { start: { line: 4, column: 0 }, end: { line: 5, column: 0 } },
    ]) {
      expect(parseDiscoveryLegOutput(leg, legOutput(leg, [concern({ build_citations: [{ ...citation, span }] })])).concerns[0]?.build_citations)
        .toEqual([{ ...citation, span }]);
    }
  });

  it("merges repeated mechanism citations without deduplicating on shared generated evidence", async () => {
    const result = await runSpecializedDiscovery(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" }, async (leg) => {
      if (leg.definition.id === "test-honesty") return legOutput(leg, []);
      const own = { ...citation, artifactId: `pricing-output-${leg.definition.id}` };
      const concerns = [concern({ evidence_ids: [`e-${leg.definition.id}`], build_citations: [own, citation] })];
      // A second instance of the same generated mechanism at another location is a separate concern.
      if (leg.definition.id === "correctness") concerns.push(concern({ id: "R2", range: { start: 8, end: 9 }, build_citations: [citation] }));
      return legOutput(leg, concerns);
    });
    expect(result.concerns).toHaveLength(2);
    expect(result.concerns[0]).toMatchObject({
      id: "correctness:R1", raising_leg_ids: ["correctness", "contract-operability"],
      build_citations: [{ ...citation, artifactId: "pricing-output-correctness" }, citation, { ...citation, artifactId: "pricing-output-contract-operability" }],
    });
    expect(result.concerns[1]).toMatchObject({ id: "correctness:R2", range: { start: 8, end: 9 }, build_citations: [citation] });
  });

  it("resolves single-discovery concern citations the same way", () => {
    const review = {
      concerns: [{
        id: "R1", file: "src/core.ts", line: 4, title: "t", claim: "c", impact: "i", evidence_hint: "h", scope: "in-diff",
        evidence_ids: [], lead_ids: [], build_citations: [citation],
      }],
      coverage: { lenses: [], files: [] },
    };
    expect(parseReviewOutput(review).concerns[0]).toMatchObject({ build_citations: [citation] });
    expect(() => parseReviewOutput(review, () => ({ ok: false, reason: "not retrieved" }))).toThrow(/unresolved build citation/);
    expect(() => parseReviewOutput({ ...review, concerns: [{ ...review.concerns[0]!, build_citations: [{ ...citation, manifestSha256: "short" }] }] })).toThrow();
  });
});
