import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents, type EventRecord } from "../src/audit-inspect.js";
import { verifyChecksums } from "../src/audit.js";
import { loadCorpus, type LoadedCorpus } from "./replay.mjs";
import { parseAssistantJson } from "../src/runner/pi.js";

interface ToolCall { phase?: string; toolName?: string; isError?: boolean; outcome?: string; nonzero_exit?: boolean; output_bytes?: number }
interface FindingSummary { id: string; tier: string; file: string; line: number; title: string }
export interface RunSummary {
  name: string; model: string; thinking: string; prompt: string; findings: FindingSummary[]; grades: Record<string, number>; coverage: Record<string, number>; toolCalls: number; toolErrors: number; timeouts: number | null; nonzeroExits: number | null; diffCalls: number; diffBytes: number | null; toolDetailComplete: boolean; schemaCorrection: boolean;
}
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array`); return value; }

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
  return {
    name, model: String(configuration.model ?? "unknown"), thinking: String(configuration.thinking ?? "unknown"), prompt: `${String(prompt.version ?? "unknown")} / ${String(prompt.sha256 ?? "unknown")}`, findings, grades, coverage,
    toolCalls: aggregateCalls || toolCalls.length,
    toolErrors: aggregateCalls ? aggregateErrors : toolCalls.filter((call) => call.isError === true).length,
    timeouts: detailComplete ? toolCalls.filter((call) => call.outcome === "timeout").length : null,
    nonzeroExits: aggregateCalls ? aggregateNonzeroComplete ? aggregateNonzeroExits : null : detailedNonzeroComplete ? toolCalls.filter((call) => call.nonzero_exit === true).length : null,
    diffCalls: aggregateCalls ? aggregateDiffCalls : detailedDiffCalls.length,
    diffBytes: detailComplete ? detailedDiffCalls.reduce((total, call) => total + (call.output_bytes ?? 0), 0) : null,
    toolDetailComplete: detailComplete,
    schemaCorrection: Object.hasOwn(aggregate, "verify-correction") || toolCalls.some((call) => call.phase === "verify-correction"),
  };
}

const cell = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const metric = (value: number | null) => value ?? "unknown";
export function renderBenchmarkReport(runs: RunSummary[]): string {
  const lines = ["# Leveret replay summary", "", "Generated mechanically from runner JSON. Semantic finding overlap and defect validity are intentionally not inferred.", "", "| run | findings | actionable | priced-noise | false-positive | dropped | tool calls | errors | nonzero exits | timeouts | diff calls | diff bytes | detail | correction |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |"];
  for (const run of runs) lines.push(`| ${cell(run.name)} | ${run.findings.length} | ${run.grades.actionable ?? 0} | ${run.grades["priced-noise"] ?? 0} | ${run.grades["false-positive"] ?? 0} | ${run.grades.dropped ?? 0} | ${run.toolCalls} | ${run.toolErrors} | ${metric(run.nonzeroExits)} | ${metric(run.timeouts)} | ${run.diffCalls} | ${metric(run.diffBytes)} | ${run.toolDetailComplete ? "complete" : "aggregate-only"} | ${run.schemaCorrection ? "yes" : "no"} |`);
  for (const run of runs) {
    lines.push("", `## ${cell(run.name)}`, "", `- Model: \`${cell(run.model)}\` (${cell(run.thinking)})`, `- System prompt: \`${cell(run.prompt)}\``, `- Coverage: ${Object.entries(run.coverage).map(([verdict, count]) => `${verdict}=${count}`).join(", ") || "none"}`, "", "### Published findings", "");
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
  run_id: string; audit_path: string; validity: { status: "valid" | "invalid"; reasons: string[] }; context_mode: "diff-only" | "review-context" | "unknown"; exact_range: { base: string; head: string; range: string } | null; configuration: unknown; capabilities: unknown; generation: { concerns: unknown[] | null; attempt_events: EventRecord[] }; verification: { verdicts: unknown[] | null; attempts: EventRecord[]; correction_attempted: boolean | null }; final_report: unknown[] | null; publication: { attempted: boolean; events: EventRecord[] }; failures: { tool: EventRecord[]; schema: EventRecord[]; gaps: string[]; error: string | null }; coverage: unknown; targets: ReplayTargetRecord[];
}
export interface ReplayReportRecord {
  schema: typeof REPLAY_REPORT_SCHEMA;
  corpus: { schema: string; name: string; sha256: string; accepted: number; rejected_controls: number; ranges: string[] };
  scoring: { recall_denominator: number; rejected_controls_excluded: number; invalid_runs_excluded: true; semantic_overlap_source: "explicit-adjudication-only" };
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
function parsedPhaseOutput(events: EventRecord[], phase: string): Record<string, unknown> | null {
  const parsed = events.filter((event) => event.event === "attempt_parsed" && event.phase === phase);
  const text = payload(parsed.at(-1) ?? {} as EventRecord)?.assistant_text;
  if (typeof text !== "string") return null;
  try {
    const value = parseAssistantJson(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
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
  const reviewOutput = parsedPhaseOutput(events, "review");
  const reasons: string[] = [];
  if (manifest.status !== "complete") reasons.push(`manifest status is ${String(manifest.status ?? "unknown")}`);
  if (manifest.completeness !== "complete") reasons.push(`manifest completeness is ${String(manifest.completeness ?? "unknown")}`);
  if (!result) reasons.push("result is absent");
  else if (!Array.isArray(result.verdicts) || !Array.isArray(result.report) || !result.coverage || !result.run_configuration) reasons.push("result is incomplete");
  if (!Array.isArray(reviewOutput?.concerns)) reasons.push("generation output is absent");
  if (rows.length === 0) reasons.push("audit run has no matching frozen corpus range");
  const valid = reasons.length === 0;
  const adjudicationByTarget = new Map(adjudications.filter((item) => item.run_id === runId).map((item) => [item.target_id, item]));
  const targets = rows.map((row): ReplayTargetRecord => {
    const adjudication = adjudicationByTarget.get(row.id);
    return { id: row.id, disposition: row.disposition, external_id: row.external_id, external_url: row.external_url, source: row.source, state: valid ? adjudication?.state ?? "not-examined" : "tool-failure", state_reason: valid ? adjudication?.note ?? "no explicit semantic adjudication supplied" : reasons.join("; "), concern_ids: adjudication?.concern_ids ?? [], finding_ids: adjudication?.finding_ids ?? [] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const generationAttempts = events.filter((event) => event.event === "attempt_started" && event.phase === "review").map(eventCopy);
  const verificationAttempts = events.filter((event) => event.event === "attempt_started" && (event.phase === "verify" || event.phase === "verify-correction")).map(eventCopy);
  const publicationEvents = events.filter((event) => event.event === "publication_started" || event.event === "publication_completed" || event.event === "publication_failed").map(eventCopy);
  const capabilities = manifest.capabilities ?? null;
  return {
    run_id: runId, audit_path: basename(resolve(runDir)), validity: { status: valid ? "valid" : "invalid", reasons }, context_mode: contextMode,
    exact_range: rows[0] ? { base: rows[0].frozen.base, head: rows[0].frozen.head, range: rows[0].frozen.range } : null,
    configuration: result?.run_configuration ?? null, capabilities,
    generation: { concerns: optionalArray(reviewOutput?.concerns), attempt_events: generationAttempts },
    verification: { verdicts: optionalArray(result?.verdicts), attempts: verificationAttempts, correction_attempted: result ? verificationAttempts.some((event) => event.phase === "verify-correction") : null },
    final_report: optionalArray(result?.report), publication: { attempted: publicationEvents.some((event) => event.event === "publication_started"), events: publicationEvents },
    failures: { tool: events.filter((event) => event.event === "execution_end" && payload(event)?.is_error === true).map(eventCopy), schema: events.filter((event) => event.event === "attempt_parse_failed").map(eventCopy), gaps: Array.isArray(manifest.gaps) ? manifest.gaps.map(String) : [], error: typeof manifest.error === "string" ? manifest.error : null },
    coverage: result?.coverage ?? null, targets,
  };
}

export async function buildReplayReport(loaded: LoadedCorpus, runDirs: string[], adjudications: AdjudicationRecord[] = []): Promise<ReplayReportRecord> {
  const accepted = loaded.corpus.rows.filter((row) => row.disposition === "accepted").length;
  const rejected = loaded.corpus.rows.length - accepted;
  const runs: ReplayRunRecord[] = [];
  for (const path of runDirs) runs.push(await finalizedRun(resolve(path), loaded, adjudications));
  runs.sort((a, b) => a.run_id.localeCompare(b.run_id));
  return {
    schema: REPLAY_REPORT_SCHEMA,
    corpus: { schema: loaded.corpus.schema, name: loaded.corpus.identity.name, sha256: loaded.corpus.identity.sha256, accepted, rejected_controls: rejected, ranges: [...new Set(loaded.corpus.rows.map((row) => row.frozen.range))].sort() },
    scoring: { recall_denominator: accepted, rejected_controls_excluded: rejected, invalid_runs_excluded: true, semantic_overlap_source: "explicit-adjudication-only" },
    runs,
  };
}

export function renderReplayReport(report: ReplayReportRecord): string {
  const lines = ["# Leveret frozen replay report", "", `Corpus: \`${report.corpus.name}\` (\`${report.corpus.sha256}\`)`, "", `Accepted recall denominator: ${report.scoring.recall_denominator}; rejected controls excluded: ${report.scoring.rejected_controls_excluded}.`, "", "| run | validity | mode | range | generated | verified | final report | published | tool failures | schema failures |", "| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |"]; 
  for (const run of report.runs) lines.push(`| ${cell(run.run_id)} | ${run.validity.status} | ${run.context_mode} | ${cell(run.exact_range?.range ?? "unknown")} | ${metric(run.generation.concerns?.length ?? null)} | ${metric(run.verification.verdicts?.length ?? null)} | ${metric(run.final_report?.length ?? null)} | ${run.publication.attempted ? "yes" : "no"} | ${run.failures.tool.length} | ${run.failures.schema.length} |`);
  for (const run of report.runs) {
    lines.push("", `## ${cell(run.run_id)}`, "", `- Validity: ${run.validity.status}${run.validity.reasons.length ? ` — ${run.validity.reasons.map(cell).join("; ")}` : ""}`, `- Context: ${run.context_mode}`, `- Configuration: ${run.configuration === null ? "unknown" : `\`${cell(JSON.stringify(run.configuration))}\``}`, `- Capabilities: ${run.capabilities === null ? "unknown" : `\`${cell(JSON.stringify(run.capabilities))}\``}`, "", "### Target states", "");
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
