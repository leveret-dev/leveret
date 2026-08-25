import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ChangeManifest } from "../src/change-evidence.js";
import type { EvidencePack } from "../src/evidence-pack.js";
import type { GuidanceResult } from "../src/semantic-checks.js";
import {
  SPECIALIZED_SCHEDULER,
  SPECIALIZED_LEG_DEFINITIONS,
  TARGETED_VERIFIER_TOOLS,
  assignDiscoveryFiles,
  buildDiscoveryLegPlans,
  discoveryMode,
  phaseToolIdentity,
  parseDiscoveryLegOutput,
  runSpecializedDiscovery,
  selectPhaseTools,
  validateDiscoveryEvidence,
  specializedReviewOutput,
} from "../src/runner/discovery-legs.js";
import { piRuntimeConfig } from "../src/runner/pi.js";
import { verifySchemaGaps } from "../src/runner/verify-output.js";

const manifest: ChangeManifest = {
  schema: 1, base: "0".repeat(40), head: "1".repeat(40), range: `${"0".repeat(40)}...${"1".repeat(40)}`, truncated: false, errors: [],
  files: [
    ["src/core.ts", "TypeScript"], ["test/core.test.ts", "TypeScript"], [".github/workflows/ci.yml", "YAML"], ["docs/contract.md", "Markdown"], ["unknown.txt", "Text"],
  ].map(([path, language]) => ({
    path, oldPath: path, newPath: path, status: "modify" as const, similarity: null, language, binary: false, lines: { added: 1, deleted: 1 },
    old: { exists: true, oid: "2".repeat(40), mode: "100644", bytes: 10, type: "text" as const },
    new: { exists: true, oid: "3".repeat(40), mode: "100644", bytes: 10, type: "text" as const },
    truncated: false, hunks: [{ index: 1, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }], errors: [],
  })),
};

const kinds = { "src/core.ts": "source", "test/core.test.ts": "test", ".github/workflows/ci.yml": "workflow", "docs/contract.md": "documentation", "unknown.txt": "unknown" } as const;
const evidencePack = {
  schema: "leveret.evidence-pack/v1", version: 1, base: manifest.base, head: manifest.head, range: manifest.range,
  provenance: { changeManifestSha256: "a", projectFactsSha256: "b", profileConfigSha256: "c", profileSourceSha256: null, engineRegistrySha256: "d", scanResultSha256: "e" },
  files: manifest.files.map((file, index) => ({ path: file.path, status: file.status, disposition: "selected", reason: "fixture", language: file.language ?? "Text", kind: kinds[file.path as keyof typeof kinds], evidenceId: `F${index + 1}`, facts: { sourceRoot: file.path.startsWith("src/") ? "src" : null, testRoot: file.path.startsWith("test/") ? "test" : null, buildSystems: ["Node package"], frameworks: [], workflowEvidenceId: file.path.includes("workflows") ? "W1" : null } })),
  project: { trackedFiles: 5, languages: [{ language: "TypeScript", files: 2 }, { language: "YAML", files: 1 }], buildSystems: [{ name: "Node package", evidence: ["package.json"] }], frameworks: [], sourceRoots: ["src"], testRoots: ["test"], manifests: [], manifestErrors: [], truncated: { manifests: false, roots: false }, omitted: { languages: 0, buildSystems: 0, frameworks: 0, sourceRoots: 0, testRoots: 0, manifests: 0, manifestErrors: 0 } },
  workflows: { files: [{ path: ".github/workflows/ci.yml", name: "CI", status: "completed", jobs: [], omittedJobIds: [], omittedJobCount: 0, errors: [], evidenceId: "W1" }], omittedFileIds: [], omittedFileCount: 0, errors: [] },
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
const tools = ["leveret_diff", "leveret_read", "leveret_grep", "leveret_find", "leveret_ast_search", "leveret_probe", "leveret_scan", "leveret_context", "leveret_memory", "codegraph_explore", "lsp_find_declaration", "lsp_find_referencing_symbols"].map((name) => ({ name, label: name, description: name, parameters: {}, execute: vi.fn() })) as unknown as ToolDefinition[];

describe("specialized serial discovery", () => {
  it("keeps host-owned mode selection on single unless explicitly selected", () => {
    expect(discoveryMode(undefined)).toBe("single");
    expect(piRuntimeConfig({}, {}).discoveryMode).toBe("single");
    expect(piRuntimeConfig({ discoveryMode: "specialized-serial/v1" }, {}).discoveryMode).toBe("specialized-serial/v1");
    expect(SPECIALIZED_SCHEDULER).toMatchObject({ strategy: "serial", requiredLegs: ["correctness", "test-honesty", "contract-operability"], verifier: { count: 1 } });
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
    expect(new Set(plans.map((plan) => plan.inputSha256)).size).toBe(3);
    expect(JSON.stringify(plans)).not.toMatch(/SECRET_(SCAN|RULE|MUTATION|RESIDUAL|ANALYZER)_TARGET/);
    expect(new Set(plans.map((plan) => JSON.stringify(phaseToolIdentity(selectPhaseTools(tools, plan.definition.requiredTools, plan.definition.optionalTools)).names))).size).toBe(3);
    for (const plan of plans) {
      const selected = selectPhaseTools(tools, plan.definition.requiredTools, plan.definition.optionalTools);
      expect(phaseToolIdentity(selected).names).toEqual([...plan.definition.requiredTools, ...plan.definition.optionalTools]);
      expect(selected.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["leveret_scan", "leveret_context"]));
    }
  });

  it("runs required legs serially, namespaces and conservatively dedupes provenance, and reports unexamined files", async () => {
    const order: string[] = [];
    const result = await runSpecializedDiscovery(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" }, async (plan) => {
      order.push(`start:${plan.definition.id}`); await Promise.resolve(); order.push(`end:${plan.definition.id}`);
      const duplicate = plan.definition.id === "correctness" || plan.definition.id === "contract-operability";
      return { leg_id: plan.definition.id, concerns: duplicate ? [{ id: "R1", file: "src/core.ts", range: { start: 4, end: 5 }, title: "same", claim: "same exact failure mechanism", impact: "breaks", evidence_hint: "read", scope: "in-diff", evidence_ids: [`e-${plan.definition.id}`] }] : [], coverage: { files: coverageFor(plan.assignedFiles, new Set(plan.definition.id === "contract-operability" ? ["unknown.txt"] : [])), stopping: { rule: plan.definition.stoppingRule, reason: "complete" } } };
    });
    expect(order).toEqual(["start:correctness", "end:correctness", "start:test-honesty", "end:test-honesty", "start:contract-operability", "end:contract-operability"]);
    const firstPlan = buildDiscoveryLegPlans(manifest, evidencePack, guidance, { mode: "diff-only", availability: "unavailable" })[0]!;
    expect(() => parseDiscoveryLegOutput(firstPlan, { leg_id: "foreign", concerns: [], coverage: { files: coverageFor(firstPlan.assignedFiles), stopping: { rule: firstPlan.definition.stoppingRule, reason: "complete" } } })).toThrow(/foreign leg ID/);
    expect(() => parseDiscoveryLegOutput(firstPlan, { leg_id: firstPlan.definition.id, concerns: [{ id: "R1", file: firstPlan.assignedFiles[0], range: { start: 1, end: 1 }, title: "x", claim: "x", impact: "x", evidence_hint: "x", scope: "in-diff", evidence_ids: [] }, { id: "R1", file: firstPlan.assignedFiles[0], range: { start: 2, end: 2 }, title: "y", claim: "y", impact: "y", evidence_hint: "y", scope: "in-diff", evidence_ids: [] }], coverage: { files: coverageFor(firstPlan.assignedFiles), stopping: { rule: firstPlan.definition.stoppingRule, reason: "complete" } } })).toThrow(/duplicate local concern IDs/);
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
      return { leg_id: plan.definition.id, concerns: [], coverage: { files: coverageFor(plan.assignedFiles), stopping: { rule: plan.definition.stoppingRule, reason: "complete" } } };
    })).rejects.toThrow("required leg failed");
    expect(called).toEqual(["correctness", "test-honesty"]);
    const verifierTools = selectPhaseTools(tools, TARGETED_VERIFIER_TOOLS.required, TARGETED_VERIFIER_TOOLS.optional, true);
    expect(verifierTools.map((tool) => tool.name)).toEqual([...TARGETED_VERIFIER_TOOLS.required, ...TARGETED_VERIFIER_TOOLS.optional]);
    expect(verifierTools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["leveret_scan", "leveret_context", "leveret_memory", "codegraph_explore"]));
    const diffSchema = JSON.stringify(verifierTools.find((tool) => tool.name === "leveret_diff")?.parameters);
    expect(diffSchema).toContain('"const":"patch"'); expect(diffSchema).not.toContain('"const":"manifest"'); expect(diffSchema).toContain('"required":["kind","paths"]');
    const gaps = verifySchemaGaps({ report: [], verdicts: [{ id: "correctness:R1", grade: "dropped", reason: "not grounded" }], coverage: { lenses: ["correctness-hostile-inputs", "contract-conformance", "test-honesty", "blast-radius", "leads-triage"].map((lens) => ({ lens, outcome: "checked" })), files: manifest.files.map((file) => ({ file: file.path, verdict: file.path === "src/core.ts" ? "findings" : "considered-fine" })) }, resolutions: [] }, { concerns: [{ id: "correctness:R1", file: "src/core.ts" }], leads: [], changedFiles: manifest.files.map((file) => file.path), priorThreadIds: ["prior-1"] });
    expect(gaps).toContain("resolutions:missing:prior-1");
  });
});
