import { describe, expect, it } from "vitest";
import { renderBenchmarkReport, summarizeResult } from "../bench/report.mjs";

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
      { phase: "review", toolName: "leveret_diff", isError: false, outcome: "success", output_bytes: 1000 },
      { phase: "verify-correction", toolName: "leveret_probe", isError: true, outcome: "timeout", output_bytes: 10 },
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
      toolCalls: 2,
      toolErrors: 1,
      timeouts: 1,
      diffCalls: 1,
      diffBytes: 1000,
      toolDetailComplete: true,
      schemaCorrection: true,
    });
    const markdown = renderBenchmarkReport([summary]);
    expect(markdown).toContain("Generated mechanically from runner JSON");
    expect(markdown).toContain("| fixture | 1 | 1 | 1 | 0 | 0 | 2 | 1 | 1 | 1 | 1000 | complete | yes |");
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
      timeouts: null,
      diffCalls: 2,
      diffBytes: null,
      toolDetailComplete: false,
    });
    expect(renderBenchmarkReport([summary])).toContain("| aggregate | 1 | 1 | 1 | 0 | 0 | 5 | 1 | unknown | 2 | unknown | aggregate-only | no |");
  });
});
