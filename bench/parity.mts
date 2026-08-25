#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { corpusSchema } from "./replay.mjs";
import { experimentManifestSchema, type ExperimentConfiguration } from "../src/runner/experiment.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gateSchema = z.object({
  schema: z.literal("leveret.parity-gate/v1"),
  corpus: z.object({ schema: z.literal("leveret.replay-corpus/v1"), sha256, accepted_mechanisms: z.literal(12), rejected_controls: z.literal(1), rejected_control_ids: z.array(z.string()).length(1) }).strict(),
  trials_per_configuration: z.literal(5),
  thresholds: z.object({ generation_trials_per_mechanism: z.literal(4), publication_trials_per_mechanism: z.literal(3), publication_precision: z.literal(0.9), completed_run_reliability: z.literal(0.95), warm_cache_median_wall_ms: z.literal(600000), known_priced_noise_published: z.literal(0) }).strict(),
  frozen_baseline: z.object({ extra_real_count: z.number().int().nonnegative(), beyond_diff_count: z.number().int().nonnegative() }).strict(),
  retirement_target: z.literal("CodeRabbit"),
}).strict();
const targetState = z.enum(["not-examined", "tool-failure", "generated", "refuted", "unverifiable", "context-exhausted", "verified", "published"]);
const parityAdjudicationSchema = z.object({
  schema: z.literal("leveret.parity-adjudication/v1"),
  mechanisms: z.array(z.object({ run_id: z.string().min(1), target_id: z.string().min(1), state: targetState, method: z.string().min(1), title_only_inference: z.boolean() }).strict()),
  publications: z.array(z.object({ run_id: z.string().min(1), finding_id: z.string().min(1), classification: z.enum(["accepted-mechanism", "extra-real", "beyond-diff-real", "priced-noise", "false-positive"]), target_id: z.string().min(1).nullable(), independently_adjudicated: z.boolean(), title_only_inference: z.boolean() }).strict()),
}).strict();

type Status = "pass" | "fail" | "blocked";
export interface GateRow { gate: string; status: Status; evidence: unknown; reason: string }
export interface ConfigurationDecision { configuration_id: string; configuration_sha256: string; status: Status; gates: GateRow[] }
export interface ParityDecision { schema: "leveret.parity-decision/v1"; decision: Status; candidate_configuration_id: string; configurations: ConfigurationDecision[]; coderabbit_retirement: "allowed" | "blocked"; reason: string }
type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2; }
function decisionStatus(rows: GateRow[]): Status { return rows.some((row) => row.status === "blocked") ? "blocked" : rows.some((row) => row.status === "fail") ? "fail" : "pass"; }
function row(gate: string, evidence: unknown, passed: boolean, reason: string): GateRow { return { gate, status: passed ? "pass" : "fail", evidence, reason }; }
function blocked(gate: string, reason: string, evidence: unknown = null): GateRow { return { gate, status: "blocked", evidence, reason }; }
function ids(items: unknown[], key: string): string[] | null { const values = items.map((item) => record(item)?.[key]); return values.every((value) => typeof value === "string" && value.length > 0) ? values as string[] : null; }

function evaluateConfiguration(configuration: ExperimentConfiguration, reportRuns: JsonRecord[], acceptedIds: string[], rejectedIds: string[], ranges: number, mechanismAdjudications: Map<string, JsonRecord>, publicationAdjudications: Map<string, JsonRecord>, gate: z.infer<typeof gateSchema>): ConfigurationDecision {
  const rows: GateRow[] = [];
  const expectedRuns = configuration.trial_ids.length * ranges;
  const runs = reportRuns.filter((run) => record(run.experiment)?.configuration_sha256 === configuration.configuration_sha256);
  const foreign = reportRuns.filter((run) => record(run.experiment)?.configuration_id === configuration.id && record(run.experiment)?.configuration_sha256 !== configuration.configuration_sha256);
  rows.push(foreign.length ? blocked("configuration_identity", "configuration ID appears with a different hash", foreign.map((run) => run.run_id)) : row("configuration_identity", configuration.configuration_sha256, true, "all runs use the exact manifest configuration hash"));
  const observedTrials = [...new Set(runs.map((run) => record(run.experiment)?.trial_id).filter((value): value is string => typeof value === "string"))].sort();
  const runIds = ids(runs, "run_id");
  if (runs.length !== expectedRuns || observedTrials.length !== 5 || configuration.trial_ids.some((trial) => !observedTrials.includes(trial)) || !runIds || new Set(runIds).size !== runs.length) rows.push(blocked("exact_five_trials", "missing, duplicate, or unplanned run prevents aggregation", { expected_runs: expectedRuns, observed_runs: runs.length, expected_trials: configuration.trial_ids, observed_trials: observedTrials }));
  else rows.push(row("exact_five_trials", { runs: runs.length, trials: observedTrials }, true, "exactly five trial identities cover every frozen range"));

  const acceptedFrequency: Record<string, { generated: number; published: number }> = {};
  let mechanismInputBlocked = false;
  let rejectedPublished = 0;
  for (const targetId of [...acceptedIds, ...rejectedIds]) {
    let generated = 0;
    let published = 0;
    for (const trialId of configuration.trial_ids) {
      const trialRuns = runs.filter((run) => record(run.experiment)?.trial_id === trialId);
      const matches = trialRuns.flatMap((run) => Array.isArray(run.targets) ? run.targets.map((target) => ({ run, target })) : []).filter(({ target }) => record(target)?.id === targetId);
      if (matches.length !== 1) { mechanismInputBlocked = true; continue; }
      const runId = typeof matches[0]!.run.run_id === "string" ? matches[0]!.run.run_id : "";
      const adjudication = mechanismAdjudications.get(`${runId}:${targetId}`);
      const reportedState = record(matches[0]!.target)?.state;
      if (!adjudication || adjudication.state !== reportedState) { mechanismInputBlocked = true; continue; }
      const state = adjudication.state as z.infer<typeof targetState>;
      if (["generated", "refuted", "unverifiable", "verified", "published"].includes(state)) generated++;
      if (state === "published") published++;
    }
    if (acceptedIds.includes(targetId)) acceptedFrequency[targetId] = { generated, published }; else rejectedPublished += published;
  }
  if (mechanismInputBlocked) {
    rows.push(blocked("generation_frequency", "every target/trial requires matching independent non-title adjudication"));
    rows.push(blocked("publication_frequency", "every target/trial requires matching independent non-title adjudication"));
    rows.push(blocked("rejected_control", "rejected-control publication state is incomplete"));
  } else {
    const generationPassed = Object.values(acceptedFrequency).every((frequency) => frequency.generated >= gate.thresholds.generation_trials_per_mechanism);
    const publicationPassed = Object.values(acceptedFrequency).every((frequency) => frequency.published >= gate.thresholds.publication_trials_per_mechanism);
    rows.push(row("generation_frequency", acceptedFrequency, generationPassed, generationPassed ? "every accepted mechanism was generated in at least 4/5 trials" : "one or more accepted mechanisms were generated in fewer than 4/5 trials"));
    rows.push(row("publication_frequency", acceptedFrequency, publicationPassed, publicationPassed ? "every accepted mechanism was published in at least 3/5 trials" : "one or more accepted mechanisms were published in fewer than 3/5 trials"));
    rows.push(row("rejected_control", { published: rejectedPublished }, rejectedPublished === 0, rejectedPublished === 0 ? "rejected GNU-tar control was never published" : "rejected GNU-tar control was published"));
  }

  const publications: Array<{ run_id: string; finding_id: string; trial_id: string }> = [];
  let publicationInputBlocked = false;
  for (const run of runs) {
    const runId = typeof run.run_id === "string" ? run.run_id : "";
    const trialId = record(run.experiment)?.trial_id;
    if (!Array.isArray(run.final_report) || typeof trialId !== "string") { publicationInputBlocked = true; continue; }
    const findingIds = ids(run.final_report, "id");
    if (!findingIds || new Set(findingIds).size !== findingIds.length) { publicationInputBlocked = true; continue; }
    publications.push(...findingIds.map((findingId) => ({ run_id: runId, finding_id: findingId, trial_id: trialId })));
  }
  const classifications: JsonRecord[] = [];
  for (const publication of publications) { const adjudication = publicationAdjudications.get(`${publication.run_id}:${publication.finding_id}`); if (!adjudication) publicationInputBlocked = true; else classifications.push({ ...adjudication, trial_id: publication.trial_id }); }
  if (publicationInputBlocked || classifications.length !== publications.length) {
    rows.push(blocked("publication_precision", "every published finding requires independent non-title adjudication"));
    rows.push(blocked("known_priced_noise", "publication classifications are incomplete"));
    rows.push(blocked("extra_real_baseline", "extra-real publication classifications are incomplete"));
    rows.push(blocked("beyond_diff_baseline", "beyond-diff publication classifications are incomplete"));
  } else {
    const real = classifications.filter((item) => item.classification === "accepted-mechanism" || item.classification === "extra-real" || item.classification === "beyond-diff-real").length;
    const precision = classifications.length === 0 ? null : real / classifications.length;
    rows.push(precision === null ? blocked("publication_precision", "precision is unknown because no publication was adjudicated") : row("publication_precision", { real, total: classifications.length, precision }, precision >= gate.thresholds.publication_precision, precision >= gate.thresholds.publication_precision ? "independently adjudicated precision is at least 90%" : "independently adjudicated precision is below 90%"));
    const pricedNoise = classifications.filter((item) => item.classification === "priced-noise").length;
    rows.push(row("known_priced_noise", { published: pricedNoise }, pricedNoise <= gate.thresholds.known_priced_noise_published, pricedNoise === 0 ? "no known priced-noise publication" : "known priced-noise was published"));
    const perTrial = configuration.trial_ids.map((trialId) => ({ trial_id: trialId, extra_real: classifications.filter((item) => item.trial_id === trialId && item.classification === "extra-real").length, beyond_diff: classifications.filter((item) => item.trial_id === trialId && item.classification === "beyond-diff-real").length }));
    const extraPassed = perTrial.every((trial) => trial.extra_real >= gate.frozen_baseline.extra_real_count);
    const beyondPassed = perTrial.every((trial) => trial.beyond_diff >= gate.frozen_baseline.beyond_diff_count);
    rows.push(row("extra_real_baseline", { baseline: gate.frozen_baseline.extra_real_count, trials: perTrial }, extraPassed, extraPassed ? "no frozen-baseline extra-real regression" : "extra-real yield regressed from frozen baseline"));
    rows.push(row("beyond_diff_baseline", { baseline: gate.frozen_baseline.beyond_diff_count, trials: perTrial }, beyondPassed, beyondPassed ? "no frozen-baseline beyond-diff regression" : "beyond-diff yield regressed from frozen baseline"));
  }

  const validRuns = runs.filter((run) => record(run.validity)?.status === "valid").length;
  const reliability = runs.length === expectedRuns ? validRuns / expectedRuns : null;
  rows.push(reliability === null ? blocked("completed_run_reliability", "planned run set is incomplete", { valid_runs: validRuns, expected_runs: expectedRuns }) : row("completed_run_reliability", { valid_runs: validRuns, expected_runs: expectedRuns, reliability }, reliability >= gate.thresholds.completed_run_reliability, reliability >= gate.thresholds.completed_run_reliability ? "completed-run reliability is at least 95%" : "completed-run reliability is below 95%"));
  const warmRuns = runs.filter((run) => record(run.experiment)?.cache_state === "warm");
  const warmWalls = warmRuns.map((run) => finite(record(record(run.metrics)?.timings)?.wall_ms));
  if (warmRuns.length === 0 || warmWalls.some((value) => value === null)) rows.push(blocked("warm_cache_median", "warm-cache wall timing is missing"));
  else { const value = median(warmWalls as number[]); rows.push(row("warm_cache_median", { wall_ms: value, samples: warmWalls.length, reference_hardware: configuration.reference_hardware }, value <= gate.thresholds.warm_cache_median_wall_ms, value <= gate.thresholds.warm_cache_median_wall_ms ? "warm-cache median is at most 10 minutes" : "warm-cache median exceeds 10 minutes")); }
  const coldRuns = runs.filter((run) => record(run.experiment)?.cache_state === "cold");
  const coldWalls = coldRuns.map((run) => finite(record(record(run.metrics)?.timings)?.wall_ms));
  rows.push(coldRuns.length > 0 && coldWalls.every((value) => value !== null) ? row("cold_cache_time_reported", { wall_ms: coldWalls }, true, "cold-cache wall time is reported separately") : blocked("cold_cache_time_reported", "cold-cache wall time is missing"));
  const workerCompute = runs.map((run) => finite(record(record(run.metrics)?.timings)?.summed_worker_compute_ms));
  rows.push(runs.length > 0 && workerCompute.every((value) => value !== null) ? row("summed_worker_compute_reported", { worker_compute_ms: workerCompute }, true, "summed worker compute is reported separately from wall time") : blocked("summed_worker_compute_reported", "summed worker compute is missing"));
  return { configuration_id: configuration.id, configuration_sha256: configuration.configuration_sha256, status: decisionStatus(rows), gates: rows };
}

export function evaluateParity(corpusInput: unknown, reportInput: unknown, adjudicationInput: unknown, experimentInput: unknown, gateInput: unknown): ParityDecision {
  const corpus = corpusSchema.parse(corpusInput);
  const experiment = experimentManifestSchema.parse(experimentInput);
  const adjudication = parityAdjudicationSchema.parse(adjudicationInput);
  const gate = gateSchema.parse(gateInput);
  const report = record(reportInput);
  if (!report || report.schema !== "leveret.replay-report/v1" || !Array.isArray(report.runs)) throw new Error("invalid replay report");
  if (corpus.identity.sha256 !== gate.corpus.sha256 || experiment.corpus.sha256 !== gate.corpus.sha256 || record(report.corpus)?.sha256 !== gate.corpus.sha256) throw new Error("corpus/report/experiment/gate identity mismatch");
  const acceptedIds = corpus.rows.filter((item) => item.disposition === "accepted").map((item) => item.id).sort();
  const rejectedIds = corpus.rows.filter((item) => item.disposition === "rejected").map((item) => item.id).sort();
  if (acceptedIds.length !== gate.corpus.accepted_mechanisms || JSON.stringify(rejectedIds) !== JSON.stringify([...gate.corpus.rejected_control_ids].sort())) throw new Error("frozen corpus membership differs from parity gate");
  const mechanismAdjudications = new Map<string, JsonRecord>();
  for (const item of adjudication.mechanisms) { const key = `${item.run_id}:${item.target_id}`; if (mechanismAdjudications.has(key)) throw new Error(`duplicate mechanism adjudication: ${key}`); if (item.method === "independent-mechanism-adjudication" && item.title_only_inference === false) mechanismAdjudications.set(key, item); }
  const publicationAdjudications = new Map<string, JsonRecord>();
  for (const item of adjudication.publications) {
    const key = `${item.run_id}:${item.finding_id}`;
    if (publicationAdjudications.has(key)) throw new Error(`duplicate publication adjudication: ${key}`);
    if (!item.independently_adjudicated || item.title_only_inference) continue;
    if (item.classification === "accepted-mechanism" && (!item.target_id || !acceptedIds.includes(item.target_id))) throw new Error(`accepted publication adjudication has invalid target: ${key}`);
    if (item.classification !== "accepted-mechanism" && item.target_id !== null) throw new Error(`non-corpus publication adjudication names a target: ${key}`);
    publicationAdjudications.set(key, item);
  }
  const ranges = new Set(corpus.rows.map((item) => item.frozen.range_id)).size;
  const runs = report.runs.map((run, index) => record(run) ?? (() => { throw new Error(`report run ${index} is invalid`); })());
  const configurations = experiment.configurations.map((configuration) => evaluateConfiguration(configuration, runs, acceptedIds, rejectedIds, ranges, mechanismAdjudications, publicationAdjudications, gate));
  const candidate = configurations.find((configuration) => configuration.configuration_id === experiment.candidate_configuration_id)!;
  const blockedExperiment = configurations.some((configuration) => configuration.status === "blocked");
  const decision: Status = blockedExperiment ? "blocked" : candidate.status;
  return { schema: "leveret.parity-decision/v1", decision, candidate_configuration_id: experiment.candidate_configuration_id, configurations, coderabbit_retirement: decision === "pass" ? "allowed" : "blocked", reason: decision === "pass" ? "all frozen parity gates passed for the declared candidate" : `CodeRabbit retirement: blocked; parity decision is ${decision}` };
}

function cell(value: unknown): string { return String(value).replace(/\|/g, "\\|").replace(/\n/g, " "); }
export function renderParityDecision(decision: ParityDecision): string {
  const lines = ["# Leveret parity decision", "", `Decision: **${decision.decision}**`, "", `CodeRabbit retirement: **${decision.coderabbit_retirement}**`, "", decision.reason, ""];
  for (const configuration of decision.configurations) {
    lines.push(`## ${cell(configuration.configuration_id)}`, "", `Configuration SHA-256: \`${configuration.configuration_sha256}\``, "", "| gate | status | reason | evidence |", "| --- | --- | --- | --- |");
    for (const gate of configuration.gates) lines.push(`| ${cell(gate.gate)} | ${gate.status} | ${cell(gate.reason)} | \`${cell(JSON.stringify(gate.evidence))}\` |`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const required = ["--corpus", "--report", "--adjudication", "--experiment", "--json"] as const;
  const values = Object.fromEntries(required.map((name) => [name, option(args, name)]));
  for (const name of required) if (!values[name]) throw new Error("usage: parity.mts --corpus corpus.json --report report.json --adjudication adjudication.json --experiment experiment.json --json decision.json [--markdown decision.md]");
  const gatePath = join(dirname(fileURLToPath(import.meta.url)), "parity-gate.v1.json");
  const [corpus, report, adjudication, experiment, gate] = await Promise.all([readFile(values["--corpus"]!, "utf8").then(JSON.parse), readFile(values["--report"]!, "utf8").then(JSON.parse), readFile(values["--adjudication"]!, "utf8").then(JSON.parse), readFile(values["--experiment"]!, "utf8").then(JSON.parse), readFile(gatePath, "utf8").then(JSON.parse)]);
  const decision = evaluateParity(corpus, report, adjudication, experiment, gate);
  await writeFile(resolve(values["--json"]!), `${JSON.stringify(decision, null, 2)}\n`);
  const markdownPath = option(args, "--markdown");
  if (markdownPath) await writeFile(resolve(markdownPath), renderParityDecision(decision)); else process.stdout.write(renderParityDecision(decision));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
