import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents, type EventRecord } from "../src/audit-inspect.js";
import { verifyChecksums } from "../src/audit.js";
import { loadCorpus, type LoadedCorpus } from "./replay.mjs";

interface ToolCall { phase?: string; toolName?: string; isError?: boolean; outcome?: string; nonzero_exit?: boolean; output_bytes?: number }
interface FindingSummary { id: string; tier: string; file: string; line: number; title: string }
export interface CacheMetric { artifact: string; outcome: string; key: string; duration_ms: number; bytes: number | null; reason: string }
export interface TimingMetrics { preparation_ms: number | null; discovery_ms: number | null; model_ms: number | null; verification_ms: number | null; publication_ms: number | null; wall_ms: number | null; summed_worker_compute_ms: number | null }
export interface RunSummary {
  name: string; model: string; thinking: string; prompt: string; discovery: string; findings: FindingSummary[]; grades: Record<string, number>; coverage: Record<string, number>; toolCalls: number; toolErrors: number; timeouts: number | null; nonzeroExits: number | null; diffCalls: number; diffBytes: number | null; toolDetailComplete: boolean; schemaCorrection: boolean; timings: TimingMetrics; cache: CacheMetric[];
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function resultRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

/** Backward-compatible reducer for direct runner JSON. */
export function summarizeResult(name: string, input: unknown): RunSummary {
  const result = record(input, name);
  const configuration = record(result.run_configuration, `${name}.run_configuration`);
  const prompt = record(configuration.system_prompt, `${name}.run_configuration.system_prompt`);
  const findings = array(result.report, `${name}.report`).map((item, index) => { const finding = record(item, `${name}.report[${index}]`); return { id: String(finding.id ?? ""), tier: String(finding.tier ?? ""), file: String(finding.file ?? ""), line: Number(finding.line ?? 0), title: String(finding.title ?? "") }; });
  const grades: Record<string, number> = {};
  for (const item of array(result.verdicts, `${name}.verdicts`)) { const grade = String(record(item, `${name}.verdicts[]`).grade ?? "unknown"); grades[grade] = (grades[grade] ?? 0) + 1; }
  const coverage: Record<string, number> = {};
  for (const item of array(record(result.coverage, `${name}.coverage`).files, `${name}.coverage.files`)) { const verdict = String(record(item, `${name}.coverage.files[]`).verdict ?? "unknown"); coverage[verdict] = (coverage[verdict] ?? 0) + 1; }
  const toolCalls = array(configuration.tool_calls, `${name}.run_configuration.tool_calls`) as ToolCall[];
  const aggregate = configuration.tools ? record(configuration.tools, `${name}.run_configuration.tools`) : {};
  let aggregateCalls = 0, aggregateErrors = 0, aggregateDiffCalls = 0, aggregateNonzeroExits = 0;
  let aggregateNonzeroComplete = true;
  for (const [phaseName, phaseValue] of Object.entries(aggregate)) for (const [toolName, toolValue] of Object.entries(record(phaseValue, `${name}.run_configuration.tools.${phaseName}`))) {
    const tool = record(toolValue, `${name}.run_configuration.tools.${phaseName}.${toolName}`);
    const calls = Number(tool.calls ?? 0);
    aggregateCalls += calls;
    aggregateErrors += Number(tool.errors ?? 0);
    if (typeof tool.nonzero_exits === "number") aggregateNonzeroExits += tool.nonzero_exits; else aggregateNonzeroComplete = false;
    if (toolName === "leveret_diff") aggregateDiffCalls += calls;
  }
  const detailComplete = aggregateCalls === 0 || aggregateCalls === toolCalls.length;
  const detailedDiffCalls = toolCalls.filter((call) => call.toolName === "leveret_diff");
  const detailedNonzeroComplete = toolCalls.every((call) => typeof call.nonzero_exit === "boolean");
  const discovery = configuration.discovery && typeof configuration.discovery === "object" && !Array.isArray(configuration.discovery) ? configuration.discovery as Record<string, unknown> : {};
  const timings = configuration.timings && typeof configuration.timings === "object" && !Array.isArray(configuration.timings) ? configuration.timings as Record<string, unknown> : {};
  const cacheRun = configuration.cache && typeof configuration.cache === "object" && !Array.isArray(configuration.cache) ? configuration.cache as Record<string, unknown> : {};
  const cache = Array.isArray(cacheRun.artifacts) ? cacheRun.artifacts.map((value): CacheMetric => {
    const item = record(value, `${name}.run_configuration.cache.artifacts[]`);
    return { artifact: String(item.artifact ?? "unknown"), outcome: String(item.outcome ?? "unknown"), key: String(item.key ?? ""), duration_ms: nullableNumber(item.duration_ms) ?? 0, bytes: nullableNumber(item.bytes), reason: String(item.reason ?? "unspecified") };
  }) : [];
  return {
    name, model: String(configuration.model ?? "unknown"), thinking: String(configuration.thinking ?? "unknown"), prompt: `${String(prompt.version ?? "unknown")} / ${String(prompt.sha256 ?? "unknown")}`, discovery: String(discovery.mode ?? "single"), findings, grades, coverage,
    toolCalls: aggregateCalls || toolCalls.length,
    toolErrors: aggregateCalls ? aggregateErrors : toolCalls.filter((call) => call.isError === true).length,
    timeouts: detailComplete ? toolCalls.filter((call) => call.outcome === "timeout").length : null,
    nonzeroExits: aggregateCalls ? aggregateNonzeroComplete ? aggregateNonzeroExits : null : detailedNonzeroComplete ? toolCalls.filter((call) => call.nonzero_exit === true).length : null,
    diffCalls: aggregateCalls ? aggregateDiffCalls : detailedDiffCalls.length,
    diffBytes: detailComplete ? detailedDiffCalls.reduce((total, call) => total + (call.output_bytes ?? 0), 0) : null,
    toolDetailComplete: detailComplete,
    schemaCorrection: "verify-correction" in aggregate || toolCalls.some((call) => call.phase === "verify-correction"),
    timings: {
      preparation_ms: nullableNumber(timings.preparation_ms),
      discovery_ms: nullableNumber(timings.discovery_ms),
      model_ms: nullableNumber(timings.model_ms),
      verification_ms: nullableNumber(timings.verification_ms),
      publication_ms: nullableNumber(timings.publication_ms),
      wall_ms: nullableNumber(timings.wall_ms),
      summed_worker_compute_ms: nullableNumber(timings.summed_worker_compute_ms),
    },
    cache,
  };
}

const cell = (value: unknown) => String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
const metric = (value: number | null) => value ?? "unknown";
export function renderBenchmarkReport(runs: RunSummary[]): string {
  const lines = ["# Leveret replay summary", "", "Generated mechanically from runner JSON. Semantic finding overlap and defect validity are intentionally not inferred.", "", "| run | findings | actionable | priced-noise | false-positive | dropped | tool calls | errors | nonzero exits | timeouts | diff calls | diff bytes | cache hits | misses | fallbacks | preparation ms | model ms | verification ms | publication ms | wall ms | worker compute ms | detail | correction |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"];
  for (const run of runs) lines.push(`| ${cell(run.name)} | ${run.findings.length} | ${run.grades.actionable ?? 0} | ${run.grades["priced-noise"] ?? 0} | ${run.grades["false-positive"] ?? 0} | ${run.grades.dropped ?? 0} | ${run.toolCalls} | ${run.toolErrors} | ${metric(run.nonzeroExits)} | ${metric(run.timeouts)} | ${run.diffCalls} | ${metric(run.diffBytes)} | ${run.cache.filter((item) => item.outcome === "hit").length} | ${run.cache.filter((item) => item.outcome === "miss").length} | ${run.cache.filter((item) => item.outcome === "fallback" || item.outcome === "invalidated" || item.outcome === "corrupt-recovered").length} | ${metric(run.timings.preparation_ms)} | ${metric(run.timings.model_ms)} | ${metric(run.timings.verification_ms)} | ${metric(run.timings.publication_ms)} | ${metric(run.timings.wall_ms)} | ${metric(run.timings.summed_worker_compute_ms)} | ${run.toolDetailComplete ? "complete" : "aggregate-only"} | ${run.schemaCorrection ? "yes" : "no"} |`);
  for (const run of runs) {
    lines.push("", `## ${cell(run.name)}`, "", `- Model: \`${cell(run.model)}\` (${cell(run.thinking)})`, `- System prompt: \`${cell(run.prompt)}\``, `- Discovery: \`${cell(run.discovery)}\``, `- Coverage: ${Object.entries(run.coverage).map(([verdict, count]) => `${verdict}=${count}`).join(", ") || "none"}`, "", "### Published findings", "");
    if (run.findings.length === 0) lines.push("- None"); else for (const finding of run.findings) lines.push(`- **[${cell(finding.tier)}]** \`${cell(finding.file)}:${finding.line}\` — ${cell(finding.title)} (${cell(finding.id)})`);
  }
  return `${lines.join("\n")}\n`;
}

export const REPLAY_REPORT_SCHEMA = "leveret.replay-report/v1" as const;
export const TARGET_STATES = ["not-examined", "tool-failure", "generated", "refuted", "unverifiable", "context-exhausted", "verified", "published"] as const;
export type TargetState = typeof TARGET_STATES[number];
export interface AdjudicationRecord {
  schema: "leveret.replay-adjudication/v1";
  run_id: string;
  target_id: string;
  state: TargetState;
  concern_ids: string[];
  finding_ids: string[];
  note: string | null;
}
export interface ReplayTargetRecord {
  id: string; disposition: "accepted" | "rejected"; external_id: string; external_url: string; source: { file: string; lines: { start: number; end: number }; mechanism: string }; state: TargetState; state_reason: string; concern_ids: string[]; finding_ids: string[];
}
export interface ReplayRunRecord {
  run_id: string;
  audit_path: string;
  validity: { status: "valid" | "invalid"; reasons: string[] };
  context_mode: "diff-only" | "review-context" | "unknown";
  exact_range: { base: string; head: string; range: string } | null;
  experiment: { schema: string; configuration_id: string; configuration_sha256: string; trial_id: string; cache_state: "cold" | "warm"; reference_hardware: string } | null;
  configuration: unknown;
  capabilities: unknown;
  generation: { concerns: unknown[] | null; attempt_events: EventRecord[] };
  verification: { verdicts: unknown[] | null; attempts: EventRecord[]; correction_attempted: boolean | null };
  final_report: unknown[] | null;
  publication: { attempted: boolean; events: EventRecord[] };
  post_walk_leads: {
    metrics: Record<string, number | null> | null;
    overflow: { count: number; bytes: number; ids: string[] } | null;
    extra_real_count: number | null;
    beyond_diff_count: number | null;
  };
  metrics: { timings: TimingMetrics | null; cache: CacheMetric[]; cache_hit_rate: number | null; tokens: { input: number; output: number; total: number } | null; cost_usd: number | null };
  failures: { tool: EventRecord[]; schema: EventRecord[]; gaps: string[]; error: string | null };
  coverage: unknown;
  targets: ReplayTargetRecord[];
}
export interface ReplayReportRecord {
  schema: typeof REPLAY_REPORT_SCHEMA;
  corpus: { schema: string; name: string; sha256: string; accepted: number; rejected_controls: number; ranges: string[] };
  scoring: { recall_denominator: number; rejected_controls_excluded: number; invalid_runs_excluded: true; semantic_overlap_source: "explicit-adjudication-only" };
  experiment_groups: Array<{ configuration_id: string; configuration_sha256: string; run_ids: string[] }>;
  runs: ReplayRunRecord[];
}

function optionalArray(value: unknown): unknown[] | null { return Array.isArray(value) ? value : null; }
function payload(event: EventRecord): Record<string, unknown> | null { return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : null; }
function eventCopy(event: EventRecord): EventRecord { return { ...event }; }
function parseAdjudications(input: unknown): AdjudicationRecord[] {
  if (!Array.isArray(input)) throw new Error("adjudication file must be an array");
  const keys = new Set<string>();
  return input.map((value, index) => {
    const item = record(value, `adjudication[${index}]`);
    if (item.schema !== "leveret.replay-adjudication/v1" || typeof item.run_id !== "string" || typeof item.target_id !== "string" || !TARGET_STATES.includes(item.state as TargetState) || !Array.isArray(item.concern_ids) || !Array.isArray(item.finding_ids) || !(item.note === null || typeof item.note === "string")) throw new Error(`invalid adjudication[${index}]`);
    const parsed = item as unknown as AdjudicationRecord;
    const key = `${parsed.run_id}:${parsed.target_id}`;
    if (keys.has(key)) throw new Error(`duplicate adjudication: ${key}`);
    keys.add(key);
    return parsed;
  });
}

async function readJsonIfPresent(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function legacyAssistantJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) throw new Error("assistant returned no JSON object");
  return JSON.parse(trimmed);
}

export function phaseOutput(events: EventRecord[], phase: string): Record<string, unknown> | null {
  const successful = new Set(events
    .filter((event) => event.event === "execution_end" && payload(event)?.tool === "leveret_submit_phase" && payload(event)?.is_error === false)
    .flatMap((event) => event.tool_call_id ? [event.tool_call_id] : []));
  const submissions = events.filter((event) => event.event === "execution_start"
    && event.phase === phase
    && payload(event)?.tool === "leveret_submit_phase"
    && Boolean(event.tool_call_id && successful.has(event.tool_call_id)));
  const submitted = resultRecord(payload(submissions[submissions.length - 1] ?? {} as EventRecord)?.args);
  if (submitted) return submitted;
  const parsed = events.filter((event) => event.event === "attempt_parsed" && event.phase === phase);
  const text = payload(parsed[parsed.length - 1] ?? {} as EventRecord)?.assistant_text;
  if (typeof text !== "string") return null;
  try {
    return resultRecord(legacyAssistantJson(text));
  } catch {
    return null;
  }
}

function experimentRecord(configuration: Record<string, unknown> | null, plan: Record<string, unknown> | null): ReplayRunRecord["experiment"] {
  const direct = resultRecord(configuration?.experiment);
  if (direct
    && direct.schema === "leveret.replay-experiment-run/v1"
    && typeof direct.configuration_id === "string"
    && typeof direct.configuration_sha256 === "string"
    && typeof direct.trial_id === "string"
    && (direct.cache_state === "cold" || direct.cache_state === "warm")
    && typeof direct.reference_hardware === "string") return direct as unknown as NonNullable<ReplayRunRecord["experiment"]>;
  const planned = resultRecord(plan?.experiment);
  const plannedConfiguration = resultRecord(planned?.configuration);
  if (planned
    && plannedConfiguration
    && typeof plannedConfiguration.id === "string"
    && typeof plannedConfiguration.configuration_sha256 === "string"
    && typeof planned.trial_id === "string"
    && (planned.cache_state === "cold" || planned.cache_state === "warm")
    && typeof plannedConfiguration.reference_hardware === "string") {
    return {
      schema: "leveret.replay-experiment-run/v1",
      configuration_id: plannedConfiguration.id,
      configuration_sha256: plannedConfiguration.configuration_sha256,
      trial_id: planned.trial_id,
      cache_state: planned.cache_state,
      reference_hardware: plannedConfiguration.reference_hardware,
    };
  }
  return null;
}

function usageMetrics(events: EventRecord[]): { tokens: { input: number; output: number; total: number } | null; cost_usd: number | null } {
  const usages = events.filter((event) => event.event === "response_metadata").map(payload).map((item) => resultRecord(item?.usage)).filter((item): item is Record<string, unknown> => item !== null);
  if (usages.length === 0) return { tokens: null, cost_usd: null };
  const input = usages.map((usage) => nullableNumber(usage.input ?? usage.inputTokens));
  const output = usages.map((usage) => nullableNumber(usage.output ?? usage.outputTokens));
  const tokens = input.every((value) => value !== null) && output.every((value) => value !== null)
    ? { input: input.reduce((sum, value) => sum + value!, 0), output: output.reduce((sum, value) => sum + value!, 0), total: [...input, ...output].reduce((sum, value) => sum + value!, 0) }
    : null;
  const costs = usages.map((usage) => {
    const cost = resultRecord(usage.cost);
    return nullableNumber(cost?.total ?? usage.cost_usd);
  });
  return { tokens, cost_usd: costs.every((value) => value !== null) ? costs.reduce((sum, value) => sum + value!, 0) : null };
}
async function finalizedRun(runDir: string, loaded: LoadedCorpus, adjudications: AdjudicationRecord[]): Promise<ReplayRunRecord> {
  await verifyChecksums(runDir);
  const manifest = record(await readJsonIfPresent(join(runDir, "manifest.json")), `${runDir}/manifest.json`);
  const runId = String(manifest.run_id ?? "unknown");
  const events = await readAuditEvents(runDir);
  const resultValue = await readJsonIfPresent(join(runDir, "result.json"));
  const result = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue) ? resultValue as Record<string, unknown> : null;
  const replayEvent = events.find((event) => event.event === "replay_started");
  const plan = payload(replayEvent ?? {} as EventRecord)?.plan;
  const planRecord = plan && typeof plan === "object" && !Array.isArray(plan) ? plan as Record<string, unknown> : null;
  const contextMode = planRecord?.mode === "diff-only" || planRecord?.mode === "review-context" ? planRecord.mode : "unknown";
  const rangeId = typeof planRecord?.range_id === "string" ? planRecord.range_id : null;
  const rows = rangeId ? loaded.corpus.rows.filter((row) => row.frozen.range_id === rangeId) : [];
  const reviewOutput = phaseOutput(events, "review");
  const configuration = result ? resultRecord(result.run_configuration) : null;
  const discovery = configuration ? resultRecord(configuration.discovery) : null;
  const discoveryConcerns = optionalArray(discovery?.normalized_concerns);
  const generationConcerns = discoveryConcerns ?? optionalArray(reviewOutput?.concerns);
  const reasons: string[] = [];
  if (manifest.status !== "complete") reasons.push(`manifest status is ${String(manifest.status ?? "unknown")}`);
  if (manifest.completeness !== "complete") reasons.push(`manifest completeness is ${String(manifest.completeness ?? "unknown")}`);
  if (!result) reasons.push("result is absent");
  else if (!Array.isArray(result.verdicts) || !Array.isArray(result.report) || !result.coverage || !result.run_configuration) reasons.push("result is incomplete");
  if (!generationConcerns) reasons.push("generation output is absent");
  if (rows.length === 0) reasons.push("audit run has no matching frozen corpus range");
  const valid = reasons.length === 0;
  const adjudicationByTarget = new Map(adjudications.filter((item) => item.run_id === runId).map((item) => [item.target_id, item]));
  const targets = rows.map((row): ReplayTargetRecord => {
    const adjudication = adjudicationByTarget.get(row.id);
    return { id: row.id, disposition: row.disposition, external_id: row.external_id, external_url: row.external_url, source: row.source, state: valid ? adjudication?.state ?? "not-examined" : "tool-failure", state_reason: valid ? adjudication?.note ?? "no explicit semantic adjudication supplied" : reasons.join("; "), concern_ids: adjudication?.concern_ids ?? [], finding_ids: adjudication?.finding_ids ?? [] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const generationAttempts = events.filter((event) => event.event === "attempt_started" && (event.phase === "review" || event.phase?.startsWith("discovery-"))).map(eventCopy);
  const verificationAttempts = events.filter((event) => event.event === "attempt_started" && (event.phase === "verify" || event.phase === "verify-correction")).map(eventCopy);
  const publicationEvents = events.filter((event) => event.event === "publication_started" || event.event === "publication_completed" || event.event === "publication_failed").map(eventCopy);
  const capabilities = manifest.capabilities ?? null;
  const postWalk = result ? resultRecord(result.post_walk_leads) : null;
  const postWalkAccounting = postWalk ? resultRecord(postWalk.accounting) : null;
  const postWalkStream = postWalk ? resultRecord(postWalk.stream) : null;
  const postWalkMetrics = postWalkAccounting ? resultRecord(postWalkAccounting.metrics) : null;
  const postWalkOverflow = postWalkStream ? resultRecord(postWalkStream.overflow) : null;
  const stopGate = postWalk ? resultRecord(postWalk.stop_gate_inputs) : null;
  const timingRecord = configuration ? resultRecord(configuration.timings) : null;
  const cacheRecord = configuration ? resultRecord(configuration.cache) : null;
  const cacheMetrics = optionalArray(cacheRecord?.artifacts)?.map((value): CacheMetric => {
    const item = record(value, `${runDir}.run_configuration.cache.artifacts[]`);
    return { artifact: String(item.artifact ?? "unknown"), outcome: String(item.outcome ?? "unknown"), key: String(item.key ?? ""), duration_ms: nullableNumber(item.duration_ms) ?? 0, bytes: nullableNumber(item.bytes), reason: String(item.reason ?? "unspecified") };
  }) ?? [];
  const timingMetrics: TimingMetrics | null = timingRecord ? {
    preparation_ms: nullableNumber(timingRecord.preparation_ms),
    discovery_ms: nullableNumber(timingRecord.discovery_ms),
    model_ms: nullableNumber(timingRecord.model_ms),
    verification_ms: nullableNumber(timingRecord.verification_ms),
    publication_ms: nullableNumber(timingRecord.publication_ms),
    wall_ms: nullableNumber(timingRecord.wall_ms),
    summed_worker_compute_ms: nullableNumber(timingRecord.summed_worker_compute_ms),
  } : null;
  const usage = usageMetrics(events);
  const cacheCount = cacheMetrics.length;
  const cacheHitRate = cacheCount > 0 ? cacheMetrics.filter((metric) => metric.outcome === "hit").length / cacheCount : null;
  return {
    run_id: runId, audit_path: basename(resolve(runDir)), validity: { status: valid ? "valid" : "invalid", reasons }, context_mode: contextMode,
    exact_range: rows[0] ? { base: rows[0].frozen.base, head: rows[0].frozen.head, range: rows[0].frozen.range } : null,
    experiment: experimentRecord(configuration, planRecord),
    configuration: result?.run_configuration ?? null, capabilities,
    generation: { concerns: generationConcerns, attempt_events: generationAttempts },
    verification: { verdicts: optionalArray(result?.verdicts), attempts: verificationAttempts, correction_attempted: result ? verificationAttempts.some((event) => event.phase === "verify-correction") : null },
    final_report: optionalArray(result?.report), publication: { attempted: publicationEvents.some((event) => event.event === "publication_started"), events: publicationEvents },
    post_walk_leads: {
      metrics: postWalkMetrics && Object.values(postWalkMetrics).every((value) => value === null || typeof value === "number")
        ? postWalkMetrics as Record<string, number | null>
        : null,
      overflow: postWalkOverflow
        && typeof postWalkOverflow.count === "number"
        && typeof postWalkOverflow.bytes === "number"
        && Array.isArray(postWalkOverflow.ids)
        ? { count: postWalkOverflow.count, bytes: postWalkOverflow.bytes, ids: postWalkOverflow.ids.map(String) }
        : null,
      extra_real_count: nullableNumber(stopGate?.extra_real_count),
      beyond_diff_count: nullableNumber(stopGate?.beyond_diff_count),
    },
    metrics: { timings: timingMetrics, cache: cacheMetrics, cache_hit_rate: cacheHitRate, tokens: usage.tokens, cost_usd: usage.cost_usd },
    failures: { tool: events.filter((event) => event.event === "execution_end" && payload(event)?.is_error === true).map(eventCopy), schema: events.filter((event) => event.event === "attempt_parse_failed" || event.event === "attempt_submission_missing").map(eventCopy), gaps: Array.isArray(manifest.gaps) ? manifest.gaps.map(String) : [], error: typeof manifest.error === "string" ? manifest.error : null },
    coverage: result?.coverage ?? null, targets,
  };
}

export async function buildReplayReport(loaded: LoadedCorpus, runDirs: string[], adjudications: AdjudicationRecord[] = []): Promise<ReplayReportRecord> {
  const accepted = loaded.corpus.rows.filter((row) => row.disposition === "accepted").length;
  const rejected = loaded.corpus.rows.length - accepted;
  const runs: ReplayRunRecord[] = [];
  for (const path of runDirs) runs.push(await finalizedRun(resolve(path), loaded, adjudications));
  runs.sort((a, b) => a.run_id.localeCompare(b.run_id));
  const grouped = new Map<string, { configuration_id: string; configuration_sha256: string; run_ids: string[] }>();
  for (const run of runs) if (run.experiment) {
    const group = grouped.get(run.experiment.configuration_sha256) ?? { configuration_id: run.experiment.configuration_id, configuration_sha256: run.experiment.configuration_sha256, run_ids: [] };
    group.run_ids.push(run.run_id);
    grouped.set(run.experiment.configuration_sha256, group);
  }
  const experimentGroups = [...grouped.values()].sort((a, b) => a.configuration_sha256.localeCompare(b.configuration_sha256));
  return {
    schema: REPLAY_REPORT_SCHEMA,
    corpus: { schema: loaded.corpus.schema, name: loaded.corpus.identity.name, sha256: loaded.corpus.identity.sha256, accepted, rejected_controls: rejected, ranges: [...new Set(loaded.corpus.rows.map((row) => row.frozen.range))].sort() },
    scoring: { recall_denominator: accepted, rejected_controls_excluded: rejected, invalid_runs_excluded: true, semantic_overlap_source: "explicit-adjudication-only" },
    experiment_groups: experimentGroups,
    runs,
  };
}

export function renderReplayReport(report: ReplayReportRecord): string {
  const lines = ["# Leveret frozen replay report", "", `Corpus: \`${report.corpus.name}\` (\`${report.corpus.sha256}\`)`, "", `Accepted recall denominator: ${report.scoring.recall_denominator}; rejected controls excluded: ${report.scoring.rejected_controls_excluded}.`, "", "| run | config | trial | cache | validity | mode | range | concerns | verified | final report | preparation ms | discovery ms | verification ms | publication ms | wall ms | worker compute ms | cache hit rate | tokens | cost USD | extra-real | beyond-diff | tool failures | schema failures |", "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"];
  for (const run of report.runs) {
    const timings = run.metrics.timings;
    lines.push(`| ${cell(run.run_id)} | ${cell(run.experiment?.configuration_id ?? "unknown")} | ${cell(run.experiment?.trial_id ?? "unknown")} | ${cell(run.experiment?.cache_state ?? "unknown")} | ${run.validity.status} | ${run.context_mode} | ${cell(run.exact_range?.range ?? "unknown")} | ${metric(run.generation.concerns?.length ?? null)} | ${metric(run.verification.verdicts?.length ?? null)} | ${metric(run.final_report?.length ?? null)} | ${metric(timings?.preparation_ms ?? null)} | ${metric(timings?.discovery_ms ?? null)} | ${metric(timings?.verification_ms ?? null)} | ${metric(timings?.publication_ms ?? null)} | ${metric(timings?.wall_ms ?? null)} | ${metric(timings?.summed_worker_compute_ms ?? null)} | ${metric(run.metrics.cache_hit_rate)} | ${metric(run.metrics.tokens?.total ?? null)} | ${metric(run.metrics.cost_usd)} | ${metric(run.post_walk_leads.extra_real_count)} | ${metric(run.post_walk_leads.beyond_diff_count)} | ${run.failures.tool.length} | ${run.failures.schema.length} |`);
  }
  for (const run of report.runs) {
    lines.push("", `## ${cell(run.run_id)}`, "", `- Experiment: ${run.experiment ? `\`${cell(JSON.stringify(run.experiment))}\`` : "unknown"}`, `- Validity: ${run.validity.status}${run.validity.reasons.length ? ` — ${run.validity.reasons.map(cell).join("; ")}` : ""}`, `- Context: ${run.context_mode}`, `- Configuration: ${run.configuration === null ? "unknown" : `\`${cell(JSON.stringify(run.configuration))}\``}`, `- Capabilities: ${run.capabilities === null ? "unknown" : `\`${cell(JSON.stringify(run.capabilities))}\``}`, "", "### Target states", "");
    if (run.targets.length === 0) lines.push("- unknown"); else for (const target of run.targets) lines.push(`- \`${cell(target.id)}\` (${target.disposition}): **${target.state}** — ${cell(target.state_reason)}`);
  }
  return `${lines.join("\n")}\n`;
}

function cliOption(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function cliInputs(args: string[], options: string[]): string[] { const consumed = new Set<number>(); for (const name of options) { const index = args.indexOf(name); if (index >= 0) { consumed.add(index); consumed.add(index + 1); } } return args.filter((_, index) => !consumed.has(index)); }
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const corpusPath = cliOption(args, "--corpus");
  if (!corpusPath) {
    const outIndex = args.indexOf("--out");
    const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
    const inputs = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
    if (inputs.length === 0 || (outIndex >= 0 && !output)) throw new Error("usage: bench/report.mts [--out report.md] result.json...");
    const report = renderBenchmarkReport(inputs.map((path) => summarizeResult(basename(path, ".json"), JSON.parse(readFileSync(path, "utf8")))));
    if (output) writeFileSync(output, report); else process.stdout.write(report);
    return;
  }
  const jsonPath = cliOption(args, "--json");
  const markdownPath = cliOption(args, "--markdown");
  if (!jsonPath) throw new Error("structured replay reporting requires --json source.json");
  const runDirs = cliInputs(args, ["--corpus", "--json", "--markdown", "--adjudication"]);
  if (runDirs.length === 0) throw new Error("structured replay reporting requires finalized audit run directories");
  const adjudicationPath = cliOption(args, "--adjudication");
  const adjudications = adjudicationPath ? parseAdjudications(JSON.parse(await readFile(adjudicationPath, "utf8"))) : [];
  const source = await buildReplayReport(await loadCorpus(corpusPath), runDirs, adjudications);
  await writeFile(jsonPath, `${JSON.stringify(source, null, 2)}\n`);
  if (markdownPath) await writeFile(markdownPath, renderReplayReport(JSON.parse(await readFile(jsonPath, "utf8")) as ReplayReportRecord));
  else process.stdout.write(renderReplayReport(JSON.parse(await readFile(jsonPath, "utf8")) as ReplayReportRecord));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
