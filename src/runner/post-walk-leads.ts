import type { EvidenceLead, EvidencePack, FileKind } from "../evidence-pack.js";
import type { GuidanceLead, GuidanceResult, MutationId, MutationLead, SemanticRuleId } from "../semantic-checks.js";

export const POST_WALK_LEADS_SCHEMA = "leveret.post-walk-leads/v1" as const;
export const POST_WALK_ACCOUNTING_SCHEMA = "leveret.post-walk-lead-accounting/v1" as const;
export const DEFAULT_POST_WALK_MAX_LEADS = 100;
export const DEFAULT_POST_WALK_MAX_BYTES = 64 * 1024;

export type LeadMission = "correctness" | "test-honesty" | "contract-operability";
export type LeadDisposition = "adopted/verified" | "priced" | "refuted" | "ignored";

export interface PostWalkLead {
  id: string;
  source_id: string;
  source: "scan" | "guidance-rule" | "guidance-mutation";
  mechanism: string;
  mission: LeadMission;
  priority: number;
  file: string;
  range: { start: number | null; end: number | null };
  message: string;
  evidence: { ids: string[]; sha256: string | null; excerpt: string | null };
  provenance: Record<string, unknown>;
  selected_facts: string[];
  limitations: string | null;
  applicability: string;
  reachability: {
    state: "reachable" | "no_path" | "unknown" | "not_applicable";
    path_evidence_ids: string[];
    graph_sha256: string | null;
    freshness: string | null;
    limitations: string;
  };
  lifecycle: { generated_order: number; routed_order: number | null };
}

export interface PostWalkLeadStream {
  schema: typeof POST_WALK_LEADS_SCHEMA;
  version: 1;
  walk: { completed: true; completed_order: 1 };
  source_hashes: {
    evidence_pack_sha256: string;
    scan_result_sha256: string;
    guidance_sha256: string;
    rule_set_sha256: string;
    card_set_sha256: string;
  };
  omissions: {
    residual_questions: { count: number; card_ids: string[]; reason: "no stable bounded file/evidence target" };
  };
  limits: { max_leads: number; max_bytes: number };
  deduplication: { exact_mechanism_location_count: number; removed_ids: string[] };
  pre_cap: { count: number; bytes: number; ids: string[]; items: PostWalkLead[] };
  supplied: { count: number; bytes: number; items: PostWalkLead[] };
  overflow: { count: number; bytes: number; ids: string[] };
}

export interface LeadAccountingEntry {
  id: string;
  source_id: string;
  mission: LeadMission;
  file: string;
  generated_order: number;
  routed_order: number;
  seen_order: number;
  disposition: LeadDisposition;
  disposition_order: number;
  rationale: string | null;
  report_id: string | null;
  publication: { state: "pending" | "published" | "not-applicable" | "not-published"; order: number | null };
}

export interface PostWalkLeadAccounting {
  schema: typeof POST_WALK_ACCOUNTING_SCHEMA;
  version: 1;
  stream_schema: typeof POST_WALK_LEADS_SCHEMA;
  leads: LeadAccountingEntry[];
  metrics: {
    generated: number;
    routed: number;
    supplied: number;
    adopted: number;
    refuted: number;
    priced: number;
    ignored: number;
    verified: number;
    published: number;
    adoption_rate: number | null;
  };
}

interface CandidateLead extends Omit<PostWalkLead, "lifecycle"> {
  dedupeKey: string;
}

interface BuildOptions {
  walkCompleted: boolean;
  evidencePackSha256: string;
  guidanceSha256: string;
  maxLeads?: number;
  maxBytes?: number;
}

interface VerifyResult {
  verdicts: Array<{ id: string; grade: "actionable" | "priced-noise" | "false-positive" | "dropped"; reason?: string }>;
  report: Array<{ id: string }>;
}

const RULE_MISSIONS: Record<SemanticRuleId, LeadMission> = {
  "external-command-not-preflighted": "contract-operability",
  "udev-trigger-before-consumer": "correctness",
  "uv-sync-bare-project-command": "contract-operability",
  "workflow-prerequisite-same-job": "correctness",
};

const MUTATION_MISSIONS: Record<MutationId, LeadMission> = {
  "sibling-job-substitution": "test-honesty",
  "trigger-settle-deletion": "correctness",
  "uv-run-to-bare-command": "contract-operability",
  "last-list-entry-removal": "test-honesty",
  "pipe-to-file-substitution": "test-honesty",
  "wrong-mode-equal-byte": "correctness",
};

function missionForFile(kind: FileKind | undefined): LeadMission {
  if (kind === "test") return "test-honesty";
  if (kind === "workflow" || kind === "manifest" || kind === "publisher" || kind === "documentation") return "contract-operability";
  return "correctness";
}

function scanPriority(lead: EvidenceLead): number {
  if (lead.source === "reminder") return 50;
  return lead.severity === "error" ? 10 : lead.severity === "warning" ? 20 : 30;
}

function unknownReachability(): PostWalkLead["reachability"] {
  return {
    state: "unknown",
    path_evidence_ids: [],
    graph_sha256: null,
    freshness: null,
    limitations: "No typed reachability evidence was supplied; no discovered path must not be treated as clean.",
  };
}

function withDedupeKey(value: Omit<PostWalkLead, "lifecycle">): CandidateLead {
  return { ...value, dedupeKey: `${value.source}\0${value.mechanism}\0${value.file}\0${value.range.start ?? ""}\0${value.range.end ?? ""}` };
}

function scanLead(lead: EvidenceLead, pack: EvidencePack): CandidateLead {
  const analyzer = pack.analyzers.find((item) => item.id === lead.engine);
  const kind = pack.files.find((file) => file.path === lead.file)?.kind;
  return withDedupeKey({
    id: `scan:${lead.id}`,
    source_id: lead.id,
    source: "scan",
    mechanism: `${lead.engine}/${lead.rule}`,
    mission: missionForFile(kind),
    priority: scanPriority(lead),
    file: lead.file,
    range: lead.range,
    message: lead.message,
    evidence: { ids: [lead.evidenceId], sha256: null, excerpt: null },
    provenance: { engine: lead.engine, finding: lead.provenance, kind: lead.source },
    selected_facts: analyzer?.evidenceIds ?? [],
    limitations: analyzer?.detail ?? null,
    applicability: analyzer ? `${analyzer.applicability}/${analyzer.lifecycle}: ${analyzer.reason}` : "survived trusted scan applicability and suppression; analyzer detail unavailable",
    reachability: unknownReachability(),
  });
}

function ruleLead(lead: GuidanceLead): CandidateLead {
  return withDedupeKey({
    id: `rule:${lead.id}`,
    source_id: lead.id,
    source: "guidance-rule",
    mechanism: lead.ruleId,
    mission: RULE_MISSIONS[lead.ruleId],
    priority: 15,
    file: lead.evidence.path,
    range: { start: lead.evidence.startLine, end: lead.evidence.endLine },
    message: lead.message,
    evidence: { ids: lead.selectedFacts, sha256: lead.evidence.sha256, excerpt: lead.evidence.excerpt },
    provenance: lead.provenance,
    selected_facts: lead.selectedFacts,
    limitations: lead.limitations,
    applicability: lead.applicability,
    reachability: unknownReachability(),
  });
}

function mutationLead(lead: MutationLead): CandidateLead {
  return withDedupeKey({
    id: `mutation:${lead.id}`,
    source_id: lead.id,
    source: "guidance-mutation",
    mechanism: lead.mutationId,
    mission: MUTATION_MISSIONS[lead.mutationId],
    priority: 25,
    file: lead.evidence.path,
    range: { start: null, end: null },
    message: `Verify the bounded ${lead.mutationId} mutation mechanism at ${lead.evidence.path}.`,
    evidence: { ids: [...new Set([...lead.selectedFacts, lead.evidence.evidenceId])].sort(), sha256: null, excerpt: null },
    provenance: lead.provenance,
    selected_facts: lead.selectedFacts,
    limitations: lead.limitations,
    applicability: lead.applicability,
    reachability: unknownReachability(),
  });
}

function itemBytes(item: PostWalkLead): number {
  return Buffer.byteLength(JSON.stringify(item));
}

/** Build the sole bounded deterministic lead handoff. Calling this before discovery is a contract error. */
export function buildPostWalkLeadStream(pack: EvidencePack, guidance: GuidanceResult, options: BuildOptions): PostWalkLeadStream {
  if (!options.walkCompleted) throw new Error("post-walk leads require completed discovery");
  const maxLeads = options.maxLeads ?? DEFAULT_POST_WALK_MAX_LEADS;
  const maxBytes = options.maxBytes ?? DEFAULT_POST_WALK_MAX_BYTES;
  if (!Number.isSafeInteger(maxLeads) || maxLeads < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("post-walk lead limits must be non-negative safe integers");

  const candidates = [
    ...pack.leads.items.map((lead) => scanLead(lead, pack)),
    ...guidance.ruleLeads.map(ruleLead),
    ...guidance.mutationLeads.map(mutationLead),
  ].sort((left, right) => left.priority - right.priority || left.mission.localeCompare(right.mission) || left.file.localeCompare(right.file) || (left.range.start ?? 0) - (right.range.start ?? 0) || left.mechanism.localeCompare(right.mechanism) || left.id.localeCompare(right.id));

  const unique = new Map<string, CandidateLead>();
  const removedIds: string[] = [];
  for (const candidate of candidates) {
    if (unique.has(candidate.dedupeKey)) removedIds.push(candidate.id);
    else unique.set(candidate.dedupeKey, candidate);
  }
  const normalized = [...unique.values()].map(({ dedupeKey: _, ...lead }, index): PostWalkLead => ({
    ...lead,
    lifecycle: { generated_order: index + 2, routed_order: null },
  }));
  const routed = normalized.map((lead, index): PostWalkLead => ({
    ...lead,
    lifecycle: { ...lead.lifecycle, routed_order: normalized.length + index + 2 },
  }));
  const sizes = routed.map(itemBytes);
  let selectedCount = 0;
  let selectedBytes = 0;
  while (selectedCount < routed.length && selectedCount < maxLeads && selectedBytes + sizes[selectedCount]! <= maxBytes) {
    selectedBytes += sizes[selectedCount]!;
    selectedCount += 1;
  }
  const items = routed.slice(0, selectedCount);
  const overflowItems = normalized.slice(selectedCount);
  const preCapSizes = normalized.map(itemBytes);
  return {
    schema: POST_WALK_LEADS_SCHEMA,
    version: 1,
    walk: { completed: true, completed_order: 1 },
    source_hashes: {
      evidence_pack_sha256: options.evidencePackSha256,
      scan_result_sha256: pack.provenance.scanResultSha256,
      guidance_sha256: options.guidanceSha256,
      rule_set_sha256: guidance.provenance.ruleSetSha256,
      card_set_sha256: guidance.provenance.cardSetSha256,
    },
    omissions: {
      residual_questions: {
        count: guidance.residualQuestions.length,
        card_ids: guidance.residualQuestions.map((question) => question.cardId),
        reason: "no stable bounded file/evidence target",
      },
    },
    limits: { max_leads: maxLeads, max_bytes: maxBytes },
    deduplication: { exact_mechanism_location_count: removedIds.length, removed_ids: removedIds },
    pre_cap: { count: normalized.length, bytes: preCapSizes.reduce((sum, bytes) => sum + bytes, 0), ids: normalized.map((lead) => lead.id), items: normalized },
    supplied: { count: items.length, bytes: selectedBytes, items },
    overflow: {
      count: overflowItems.length,
      bytes: preCapSizes.slice(selectedCount).reduce((sum, bytes) => sum + bytes, 0),
      ids: overflowItems.map((lead) => lead.id),
    },
  };
}

/** Strip private pre-cap lead bodies while retaining explicit overflow accounting. */
export function postWalkLeadHandoff(stream: PostWalkLeadStream): Omit<PostWalkLeadStream, "pre_cap"> & { pre_cap: Omit<PostWalkLeadStream["pre_cap"], "items"> } {
  const { items: _items, ...preCap } = stream.pre_cap;
  return { ...stream, pre_cap: preCap };
}

/** Join verifier grades to the routed stream with deterministic lifecycle order and metrics. */
export function accountPostWalkLeads(stream: PostWalkLeadStream, result: VerifyResult): PostWalkLeadAccounting {
  if (stream.supplied.items.some((lead) => lead.lifecycle.routed_order === null)) throw new Error("supplied post-walk lead was not routed");
  const verdicts = new Map(result.verdicts.map((verdict) => [verdict.id, verdict]));
  const reports = new Set(result.report.map((report) => report.id));
  const firstSeenOrder = Math.max(1, ...stream.supplied.items.map((lead) => lead.lifecycle.routed_order!)) + 1;
  const leads = stream.supplied.items.map((lead, index): LeadAccountingEntry => {
    const verdict = verdicts.get(lead.id);
    if (!verdict) throw new Error(`missing post-walk lead verdict ${lead.id}`);
    const disposition: LeadDisposition = verdict.grade === "actionable"
      ? "adopted/verified"
      : verdict.grade === "priced-noise"
        ? "priced"
        : verdict.grade === "false-positive"
          ? "refuted"
          : "ignored";
    const reportId = reports.has(lead.id) ? lead.id : null;
    if ((verdict.grade === "actionable") !== (reportId !== null)) throw new Error(`post-walk lead report mismatch ${lead.id}`);
    return {
      id: lead.id,
      source_id: lead.source_id,
      mission: lead.mission,
      file: lead.file,
      generated_order: lead.lifecycle.generated_order,
      routed_order: lead.lifecycle.routed_order!,
      seen_order: firstSeenOrder + index * 2,
      disposition,
      disposition_order: firstSeenOrder + index * 2 + 1,
      rationale: verdict.reason ?? null,
      report_id: reportId,
      publication: { state: reportId ? "pending" : "not-applicable", order: null },
    };
  });
  return { schema: POST_WALK_ACCOUNTING_SCHEMA, version: 1, stream_schema: stream.schema, leads, metrics: accountingMetrics(stream, leads) };
}

function accountingMetrics(stream: PostWalkLeadStream, leads: LeadAccountingEntry[]): PostWalkLeadAccounting["metrics"] {
  const adopted = leads.filter((lead) => lead.disposition === "adopted/verified").length;
  const supplied = stream.supplied.count;
  return {
    generated: stream.pre_cap.count,
    routed: supplied,
    supplied,
    adopted,
    refuted: leads.filter((lead) => lead.disposition === "refuted").length,
    priced: leads.filter((lead) => lead.disposition === "priced").length,
    ignored: leads.filter((lead) => lead.disposition === "ignored").length,
    verified: adopted,
    published: leads.filter((lead) => lead.publication.state === "published").length,
    adoption_rate: supplied === 0 ? null : adopted / supplied,
  };
}

/** Return a new accounting record reflecting the App's final publication outcome. */
export function markPostWalkLeadPublication(accounting: PostWalkLeadAccounting, publishedReportIds: Iterable<string>, published: boolean): PostWalkLeadAccounting {
  const ids = new Set(publishedReportIds);
  let order = Math.max(0, ...accounting.leads.map((lead) => lead.disposition_order)) + 1;
  const leads = accounting.leads.map((lead) => {
    if (!lead.report_id || !ids.has(lead.report_id)) return lead;
    return { ...lead, publication: { state: published ? "published" as const : "not-published" as const, order: order++ } };
  });
  return {
    ...accounting,
    leads,
    metrics: { ...accounting.metrics, published: leads.filter((lead) => lead.publication.state === "published").length },
  };
}
