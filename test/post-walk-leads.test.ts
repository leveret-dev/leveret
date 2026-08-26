import { describe, expect, it } from "vitest";
import type { EvidencePack } from "../src/evidence-pack.js";
import type { GuidanceResult } from "../src/semantic-checks.js";
import { singleDiscoveryInput } from "../src/runner/pi.js";
import {
  accountPostWalkLeads,
  buildPostWalkLeadStream,
  markPostWalkLeadPublication,
  postWalkLeadHandoff,
} from "../src/runner/post-walk-leads.js";

const pack = {
  schema: "leveret.evidence-pack/v1", version: 1, base: "base", head: "head", range: "base..head",
  provenance: { changeManifestSha256: "m", projectFactsSha256: "p", profileConfigSha256: "c", profileSourceSha256: null, engineRegistrySha256: "e", scanResultSha256: "scan-hash" },
  files: [{ path: "tests/a.test.ts", status: "M", disposition: "selected", reason: "reviewable", language: "TypeScript", kind: "test", evidenceId: "file-1", facts: { sourceRoot: null, testRoot: "tests", buildSystems: [], frameworks: [], workflowEvidenceId: null } }],
  project: { languages: [], buildSystems: [], frameworks: [], sourceRoots: [], testRoots: [], manifests: [], errors: [], omitted: { languages: 0, buildSystems: 0, frameworks: 0, sourceRoots: 0, testRoots: 0, manifests: 0, manifestErrors: 0 } },
  workflows: { files: [], omittedFileIds: [], omittedFileCount: 0, errors: [] },
  analyzers: [],
  leads: {
    items: [
      { id: "L-underlying-a", evidenceId: "evidence-a", engine: "fixture", rule: "same-rule", severity: "warning", file: "tests/a.test.ts", range: { start: 3, end: 3 }, message: "SECRET_SCAN_LEAD", provenance: "introduced", source: "finding" },
      { id: "L-underlying-b", evidenceId: "evidence-b", engine: "fixture", rule: "same-rule", severity: "warning", file: "tests/a.test.ts", range: { start: 3, end: 3 }, message: "duplicate text", provenance: "introduced", source: "finding" },
      { id: "L-underlying-c", evidenceId: "evidence-c", engine: "fixture", rule: "other-rule", severity: "info", file: "src/b.ts", range: { start: 8, end: 8 }, message: "overflow text", provenance: "unknown", source: "reminder" },
    ],
    totalAfterSuppression: 3, deduplicated: 0, omittedIds: [], omittedIdCount: 0, omittedIdsTruncated: 0,
  },
  suppression: { entries: [], preExisting: 0 }, completeness: { manifestTruncated: false, errors: [], staticCleanIsSemanticCoverage: false },
  limits: { maxPackBytes: 1, contextBytes: 1, maxLeads: 200, maxWorkflowFiles: 1, maxWorkflowJobs: 1, maxWorkflowSteps: 1, maxStepTextBytes: 1, maxSelectedFilesPerAnalyzer: 1 },
} as unknown as EvidencePack;

const guidance = {
  schema: "leveret.guidance-result/v1", version: 1, base: "base", head: "head",
  provenance: { evidencePackSha256: "pack-hash", changeManifestSha256: "m", cardSetSha256: "cards-hash", ruleSetSha256: "rules-hash", dataSha256: "data-hash" },
  selectedCards: [{ id: "card-1", schema: "leveret.caveat-card/v1", version: 1, selector: {}, source: { url: "https://example.test", retrievedAt: "2026-01-01", upstreamVersion: "1", excerpt: "source", sha256: "card-source-hash" }, invariant: "SAFE_CARD_REFERENCE", limitations: "bounded", ruleId: null, residualQuestion: "SECRET_RESIDUAL", retirement: { revalidateAfter: "2027-01-01", condition: "change" } }],
  ruleLeads: [{ id: "semantic-underlying", ruleId: "workflow-prerequisite-same-job", selectedFacts: ["workflow-evidence"], evidence: { path: ".github/workflows/ci.yml", startLine: 5, endLine: 7, excerpt: "SECRET_RULE_LEAD", sha256: "rule-evidence-hash" }, command: null, message: "rule message", limitations: "literal jobs only", applicability: "selected workflow fact", provenance: { kind: "host-packaged-rule", evidencePackSha256: "pack-hash" } }],
  mutationLeads: [{ id: "mutation-underlying", mutationId: "last-list-entry-removal", selectedFacts: ["list-evidence"], evidence: { path: "tests/a.test.ts", evidenceId: "list-evidence" }, command: null, limitations: "authoritative lists only", applicability: "machine-readable list", provenance: { kind: "host-packaged-mutation", evidencePackSha256: "pack-hash" } }],
  residualQuestions: [{ cardId: "card-1", question: "SECRET_RESIDUAL" }], omissions: [], budgets: { selectedCards: 1, cardBytes: 1, maxCards: 6, maxCardBytes: 1024, totalBytes: 1, maxTotalBytes: 8192 }, coverage: [], rejectedControls: [], impact: { basis: "frozen-promoted-rule-fixtures", withoutGuidance: { targetFindings: 0, controlFindings: 0 }, withGuidance: { targetFindings: 1, controlFindings: 0 }, added: { targetFindings: 1, controlFindings: 0 }, removed: { targetFindings: 0, controlFindings: 0 } },
} as unknown as GuidanceResult;

describe("post-walk deterministic lead handoff", () => {
  it("keeps discovery unconstrained and refuses routing before the walk completes", () => {
    const discovery = JSON.stringify(singleDiscoveryInput(pack, guidance));
    expect(discovery).toContain("SAFE_CARD_REFERENCE");
    expect(discovery).not.toContain("L-underlying-a");
    expect(discovery).not.toContain("SECRET_SCAN_LEAD");
    expect(discovery).not.toContain("SECRET_RULE_LEAD");
    expect(discovery).not.toContain("SECRET_RESIDUAL");
    expect(() => buildPostWalkLeadStream(pack, guidance, { walkCompleted: false, evidencePackSha256: "pack-hash", guidanceSha256: "guidance-hash" })).toThrow("completed discovery");
  });

  it("namespaces stable IDs, deduplicates exact mechanisms, and reports stable cap overflow", () => {
    const first = buildPostWalkLeadStream(pack, guidance, { walkCompleted: true, evidencePackSha256: "pack-hash", guidanceSha256: "guidance-hash", maxLeads: 2, maxBytes: 1_000_000 });
    const second = buildPostWalkLeadStream(pack, guidance, { walkCompleted: true, evidencePackSha256: "pack-hash", guidanceSha256: "guidance-hash", maxLeads: 2, maxBytes: 1_000_000 });
    expect(first).toEqual(second);
    expect(first.walk).toEqual({ completed: true, completed_order: 1 });
    expect(first.deduplication).toEqual({ exact_mechanism_location_count: 1, removed_ids: ["scan:L-underlying-b"] });
    expect(first.pre_cap.count).toBe(3);
    expect(first.omissions.residual_questions).toEqual({ count: 1, card_ids: ["card-1"], reason: "no stable bounded file/evidence target" });
    expect(first.omissions.mutation_profiles).toEqual({ count: 1, ids: ["mutation-underlying"], reason: "profile is not observed defect evidence" });
    expect(first.supplied.items.map((lead) => lead.id)).toEqual(["rule:semantic-underlying", "scan:L-underlying-a"]);
    expect(first.supplied.items.find((lead) => lead.id === "scan:L-underlying-a")).toMatchObject({ source_id: "L-underlying-a", mission: "test-honesty", reachability: { state: "unknown", graph_sha256: null } });
    expect(first.overflow.ids).toEqual(["scan:L-underlying-c"]);
    expect(first.overflow.count).toBe(1);
    expect(first.overflow.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(postWalkLeadHandoff(first))).not.toContain("overflow text");
  });

  it("accounts every supplied lead once and carries publication separately", () => {
    const stream = buildPostWalkLeadStream(pack, guidance, { walkCompleted: true, evidencePackSha256: "pack-hash", guidanceSha256: "guidance-hash", maxLeads: 3, maxBytes: 1_000_000 });
    const ids = stream.supplied.items.map((lead) => lead.id);
    const accounting = accountPostWalkLeads(stream, {
      report: [{ id: ids[0]! }],
      verdicts: [
        { id: ids[0]!, grade: "actionable" },
        { id: ids[1]!, grade: "priced-noise", reason: "priced" },
        { id: ids[2]!, grade: "false-positive", reason: "refuted" },
      ],
    });
    expect(accounting.leads.map(({ disposition }) => disposition)).toEqual(["adopted/verified", "priced", "refuted"]);
    expect(accounting.leads.every((lead) => lead.generated_order < lead.routed_order && lead.routed_order < lead.seen_order && lead.seen_order < lead.disposition_order)).toBe(true);
    expect(accounting.metrics).toMatchObject({ generated: 3, routed: 3, supplied: 3, adopted: 1, refuted: 1, priced: 1, ignored: 0, verified: 1, published: 0, adoption_rate: 1 / 3 });
    const published = markPostWalkLeadPublication(accounting, [ids[0]!], true);
    expect(published.leads[0]?.publication.state).toBe("published");
    expect(published.metrics.published).toBe(1);
  });
});
