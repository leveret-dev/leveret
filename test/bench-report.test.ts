import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReplayReport, renderBenchmarkReport, renderReplayReport, summarizeResult, type ReplayReportRecord } from "../bench/report.mjs";
import { loadCorpus } from "../bench/replay.mjs";

const result = {
  report: [
    { id: "R1", file: "src/a.ts", line: 4, title: "real defect", tier: "major" },
  ],
  verdicts: [
    { id: "R1", grade: "actionable" },
    { id: "L1", grade: "priced-noise", reason: "repo ruling" },
  ],
  coverage: {
    lenses: [],
    files: [
      { file: "src/a.ts", verdict: "findings" },
      { file: "test/a.test.ts", verdict: "considered-fine" },
    ],
  },
  run_configuration: {
    model: "openai-codex/gpt-5.6-sol",
    thinking: "high",
    system_prompt: { version: "2", sha256: "abc" },
    tool_calls: [
      { phase: "review", toolName: "leveret_diff", isError: false, outcome: "success", nonzero_exit: false, output_bytes: 1000 },
      { phase: "verify-correction", toolName: "leveret_probe", isError: true, outcome: "timeout", nonzero_exit: false, output_bytes: 10 },
      { phase: "verify", toolName: "leveret_probe", isError: false, outcome: "success", nonzero_exit: true, output_bytes: 20 },
    ],
  },
};

describe("benchmark report", () => {
  it("derives metrics and Markdown entirely from runner JSON", () => {
    const summary = summarizeResult("fixture", result);
    expect(summary).toMatchObject({
      findings: [{ id: "R1", title: "real defect" }],
      grades: { actionable: 1, "priced-noise": 1 },
      coverage: { findings: 1, "considered-fine": 1 },
      toolCalls: 3,
      toolErrors: 1,
      nonzeroExits: 1,
      timeouts: 1,
      diffCalls: 1,
      diffBytes: 1000,
      toolDetailComplete: true,
      schemaCorrection: true,
    });
    const markdown = renderBenchmarkReport([summary]);
    expect(markdown).toContain("Generated mechanically from runner JSON");
    expect(markdown).toContain("| fixture | 1 | 1 | 1 | 0 | 0 | 3 | 1 | 1 | 1 | 1 | 1000 | complete | yes |");
    expect(markdown).toContain("`src/a.ts:4` — real defect (R1)");
    expect(markdown).toContain("Semantic finding overlap and defect validity are intentionally not inferred");
  });

  it("marks missing detailed metrics instead of rendering false zeroes", () => {
    const summary = summarizeResult("aggregate", {
      ...result,
      run_configuration: {
        ...result.run_configuration,
        tools: {
          review: {
            leveret_diff: { calls: 2, errors: 0, duration_ms: 10 },
            leveret_probe: { calls: 3, errors: 1, duration_ms: 20 },
          },
        },
        tool_calls: [],
      },
    });
    expect(summary).toMatchObject({
      toolCalls: 5,
      toolErrors: 1,
      nonzeroExits: null,
      timeouts: null,
      diffCalls: 2,
      diffBytes: null,
      toolDetailComplete: false,
    });
    expect(renderBenchmarkReport([summary])).toContain("| aggregate | 1 | 1 | 1 | 0 | 0 | 5 | 1 | unknown | unknown | 2 | unknown | aggregate-only | no |");
  });

  it("keeps generation and actual publication separate and renders absent detail as unknown", () => {
    const source: ReplayReportRecord = {
      schema: "leveret.replay-report/v1",
      corpus: { schema: "leveret.replay-corpus/v1", name: "fixture", sha256: "a".repeat(64), accepted: 12, rejected_controls: 1, ranges: [] },
      scoring: { recall_denominator: 12, rejected_controls_excluded: 1, invalid_runs_excluded: true, semantic_overlap_source: "explicit-adjudication-only" },
      runs: [{
        run_id: "run-1",
        audit_path: "/private/run-1",
        validity: { status: "valid", reasons: [] },
        context_mode: "diff-only",
        exact_range: null,
        configuration: null,
        capabilities: null,
        generation: { concerns: [{ id: "C1" }], attempt_events: [] },
        verification: { verdicts: null, attempts: [], correction_attempted: null },
        final_report: [{ id: "R1" }],
        publication: { attempted: false, events: [] },
        failures: { tool: [], schema: [], gaps: [], error: null },
        coverage: null,
        targets: [],
      }],
    };
    const markdown = renderReplayReport(source);
    expect(markdown).toContain("| run-1 | valid | diff-only | unknown | 1 | unknown | 1 | no | 0 | 0 |");
    expect(markdown).toContain("- Configuration: unknown");
    expect(markdown).toContain("- Capabilities: unknown");
  });

  it("excludes the rejected GNU-tar control from the recall denominator", async () => {
    const corpus = await loadCorpus(join(dirname(fileURLToPath(import.meta.url)), "../bench/corpus.v1.json"));
    const source = await buildReplayReport(corpus, []);
    expect(source.corpus).toMatchObject({ accepted: 12, rejected_controls: 1 });
    expect(source.scoring).toMatchObject({ recall_denominator: 12, rejected_controls_excluded: 1 });
  });
});
