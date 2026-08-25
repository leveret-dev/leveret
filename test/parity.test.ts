import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateParity } from "../bench/parity.mjs";
import { configurationSha256 } from "../src/runner/experiment.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "bench/corpus.v1.json"), "utf8"));
const gate = JSON.parse(readFileSync(join(root, "bench/parity-gate.v1.json"), "utf8"));
const hash = (digit: string) => digit.repeat(64);

function fixture() {
  const baseConfiguration = {
    id: "candidate",
    context_mode: "diff-only" as const,
    discovery_mode: "specialized/v1" as const,
    scheduler: { id: "bounded-concurrent/v1" as const, concurrency_bound: 3 },
    routing: { schema: "leveret.model-routing/v1" as const, sha256: hash("1") },
    identities: { prompt_sha256: hash("2"), tool_sha256: hash("3"), policy_sha256: hash("4"), card_sha256: hash("5"), rule_sha256: hash("6"), cache_sha256: hash("7") },
    reference_hardware: "fixture-host",
    trial_ids: ["t1", "t2", "t3", "t4", "t5"],
    cold_trial_id: "t1",
  };
  const configuration = { ...baseConfiguration, configuration_sha256: configurationSha256(baseConfiguration) };
  const experiment = { schema: "leveret.replay-experiment/v1", corpus: { schema: "leveret.replay-corpus/v1", sha256: corpus.identity.sha256 }, candidate_configuration_id: configuration.id, configurations: [configuration] };
  const groups = new Map<string, typeof corpus.rows>();
  for (const target of corpus.rows) groups.set(target.frozen.range_id, [...(groups.get(target.frozen.range_id) ?? []), target]);
  const runs: Record<string, unknown>[] = [];
  const mechanisms: Record<string, unknown>[] = [];
  const publications: Record<string, unknown>[] = [];
  for (const [trialIndex, trialId] of configuration.trial_ids.entries()) for (const [rangeIndex, targets] of [...groups.values()].entries()) {
    const runId = `run-${trialIndex + 1}-${rangeIndex + 1}`;
    const targetRows = targets.map((target: typeof corpus.rows[number]) => {
      const state = target.disposition === "accepted" ? "published" : "generated";
      mechanisms.push({ run_id: runId, target_id: target.id, state, method: "independent-mechanism-adjudication", title_only_inference: false });
      return { id: target.id, disposition: target.disposition, state };
    });
    const finalReport = targets.filter((target: typeof corpus.rows[number]) => target.disposition === "accepted").map((target: typeof corpus.rows[number]) => {
      const findingId = `finding-${trialId}-${target.id}`;
      publications.push({ run_id: runId, finding_id: findingId, classification: "accepted-mechanism", target_id: target.id, independently_adjudicated: true, title_only_inference: false });
      return { id: findingId };
    });
    if (rangeIndex === 0) {
      for (let index = 1; index <= gate.frozen_baseline.extra_real_count; index++) {
        const findingId = `extra-${trialId}-${index}`;
        publications.push({ run_id: runId, finding_id: findingId, classification: "extra-real", target_id: null, independently_adjudicated: true, title_only_inference: false });
        finalReport.push({ id: findingId });
      }
    }
    runs.push({
      run_id: runId,
      validity: { status: "valid", reasons: [] },
      experiment: { schema: "leveret.replay-experiment-run/v1", configuration_id: configuration.id, configuration_sha256: configuration.configuration_sha256, trial_id: trialId, cache_state: trialId === configuration.cold_trial_id ? "cold" : "warm", reference_hardware: configuration.reference_hardware },
      targets: targetRows,
      final_report: finalReport,
      metrics: { timings: { wall_ms: 600_000, summed_worker_compute_ms: 900_000 } },
    });
  }
  const report = { schema: "leveret.replay-report/v1", corpus: { sha256: corpus.identity.sha256 }, runs };
  const adjudication = { schema: "leveret.parity-adjudication/v1", mechanisms, publications };
  return { experiment, report, adjudication };
}

function mechanismState(data: ReturnType<typeof fixture>, targetId: string, trial: number, state: string) {
  const runIds = (data.report.runs as Record<string, unknown>[]).filter((run) => (run.experiment as Record<string, unknown>).trial_id === `t${trial}`).map((run) => run.run_id);
  const item = data.adjudication.mechanisms.find((candidate) => runIds.includes(candidate.run_id) && candidate.target_id === targetId)!;
  item.state = state;
  const run = data.report.runs.find((candidate) => candidate.run_id === item.run_id)!;
  const target = (run.targets as Record<string, unknown>[]).find((candidate) => candidate.id === targetId)!;
  target.state = state;
}

describe("frozen parity decision", () => {
  it("passes only complete evidence and renders retirement allowed", () => {
    const data = fixture();
    const decision = evaluateParity(corpus, data.report, data.adjudication, data.experiment, gate);
    expect(decision.decision).toBe("pass");
    expect(decision.coderabbit_retirement).toBe("allowed");
  });

  it("accepts exact 4/5 generation and 3/5 publication edges, then fails below either edge", () => {
    const targetId = corpus.rows.find((target: typeof corpus.rows[number]) => target.disposition === "accepted").id;
    const edge = fixture();
    mechanismState(edge, targetId, 4, "generated");
    mechanismState(edge, targetId, 5, "not-examined");
    expect(evaluateParity(corpus, edge.report, edge.adjudication, edge.experiment, gate).decision).toBe("pass");
    const generationFailure = fixture();
    mechanismState(generationFailure, targetId, 4, "not-examined");
    mechanismState(generationFailure, targetId, 5, "not-examined");
    expect(evaluateParity(corpus, generationFailure.report, generationFailure.adjudication, generationFailure.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "generation_frequency")?.status).toBe("fail");
    const publicationFailure = fixture();
    mechanismState(publicationFailure, targetId, 3, "generated");
    mechanismState(publicationFailure, targetId, 4, "generated");
    mechanismState(publicationFailure, targetId, 5, "generated");
    expect(evaluateParity(corpus, publicationFailure.report, publicationFailure.adjudication, publicationFailure.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "publication_frequency")?.status).toBe("fail");
  });

  it("passes the nearest discrete precision above 90% and fails below it", () => {
    const edge = fixture();
    for (const item of edge.adjudication.publications.slice(0, 8)) { item.classification = "false-positive"; item.target_id = null; }
    expect(evaluateParity(corpus, edge.report, edge.adjudication, edge.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "publication_precision")?.status).toBe("pass");
    const failure = fixture();
    for (const item of failure.adjudication.publications.slice(0, 9)) { item.classification = "false-positive"; item.target_id = null; }
    expect(evaluateParity(corpus, failure.report, failure.adjudication, failure.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "publication_precision")?.status).toBe("fail");
  });

  it("fails reliability, warm latency, and rejected-control publication independently", () => {
    const reliability = fixture();
    (reliability.report.runs[0]!.validity as Record<string, unknown>).status = "invalid";
    expect(evaluateParity(corpus, reliability.report, reliability.adjudication, reliability.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "completed_run_reliability")?.status).toBe("fail");
    const latency = fixture();
    for (const run of latency.report.runs) if ((run.experiment as Record<string, unknown>).cache_state === "warm") ((run.metrics as Record<string, unknown>).timings as Record<string, unknown>).wall_ms = 600_001;
    expect(evaluateParity(corpus, latency.report, latency.adjudication, latency.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "warm_cache_median")?.status).toBe("fail");
    const control = fixture();
    mechanismState(control, gate.corpus.rejected_control_ids[0], 1, "published");
    expect(evaluateParity(corpus, control.report, control.adjudication, control.experiment, gate).configurations[0]!.gates.find((item) => item.gate === "rejected_control")?.status).toBe("fail");
  });

  it("blocks missing, mixed, unknown, or title-only evidence and retirement", () => {
    const missing = fixture();
    missing.report.runs.pop();
    let decision = evaluateParity(corpus, missing.report, missing.adjudication, missing.experiment, gate);
    expect(decision.decision).toBe("blocked");
    expect(decision.coderabbit_retirement).toBe("blocked");
    const mixed = fixture();
    (mixed.report.runs[0]!.experiment as Record<string, unknown>).configuration_sha256 = hash("9");
    decision = evaluateParity(corpus, mixed.report, mixed.adjudication, mixed.experiment, gate);
    expect(decision.decision).toBe("blocked");
    const unknown = fixture();
    ((unknown.report.runs[0]!.metrics as Record<string, unknown>).timings as Record<string, unknown>).summed_worker_compute_ms = null;
    decision = evaluateParity(corpus, unknown.report, unknown.adjudication, unknown.experiment, gate);
    expect(decision.decision).toBe("blocked");
    const titleOnly = fixture();
    titleOnly.adjudication.mechanisms[0]!.title_only_inference = true;
    expect(evaluateParity(corpus, titleOnly.report, titleOnly.adjudication, titleOnly.experiment, gate).decision).toBe("blocked");
  });
});
