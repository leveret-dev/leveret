import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ToolCall {
  phase?: string;
  toolName?: string;
  isError?: boolean;
  outcome?: string;
  output_bytes?: number;
}

interface FindingSummary {
  id: string;
  tier: string;
  file: string;
  line: number;
  title: string;
}

export interface RunSummary {
  name: string;
  model: string;
  thinking: string;
  prompt: string;
  findings: FindingSummary[];
  grades: Record<string, number>;
  coverage: Record<string, number>;
  toolCalls: number;
  toolErrors: number;
  timeouts: number | null;
  diffCalls: number;
  diffBytes: number | null;
  toolDetailComplete: boolean;
  schemaCorrection: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

/** Reduce one full runner JSON result to deterministic benchmark metrics. */
export function summarizeResult(name: string, input: unknown): RunSummary {
  const result = record(input, name);
  const configuration = record(result.run_configuration, `${name}.run_configuration`);
  const prompt = record(configuration.system_prompt, `${name}.run_configuration.system_prompt`);
  const findings = array(result.report, `${name}.report`).map((item, index) => {
    const finding = record(item, `${name}.report[${index}]`);
    return {
      id: String(finding.id ?? ""),
      tier: String(finding.tier ?? ""),
      file: String(finding.file ?? ""),
      line: Number(finding.line ?? 0),
      title: String(finding.title ?? ""),
    };
  });
  const grades: Record<string, number> = {};
  for (const item of array(result.verdicts, `${name}.verdicts`)) {
    const grade = String(record(item, `${name}.verdicts[]`).grade ?? "unknown");
    grades[grade] = (grades[grade] ?? 0) + 1;
  }
  const coverage: Record<string, number> = {};
  const coverageValue = record(result.coverage, `${name}.coverage`);
  for (const item of array(coverageValue.files, `${name}.coverage.files`)) {
    const verdict = String(record(item, `${name}.coverage.files[]`).verdict ?? "unknown");
    coverage[verdict] = (coverage[verdict] ?? 0) + 1;
  }
  const toolCalls = array(configuration.tool_calls, `${name}.run_configuration.tool_calls`) as ToolCall[];
  const aggregate = configuration.tools ? record(configuration.tools, `${name}.run_configuration.tools`) : {};
  let aggregateCalls = 0;
  let aggregateErrors = 0;
  let aggregateDiffCalls = 0;
  for (const [phaseName, phaseValue] of Object.entries(aggregate)) {
    const phase = record(phaseValue, `${name}.run_configuration.tools.${phaseName}`);
    for (const [toolName, toolValue] of Object.entries(phase)) {
      const tool = record(toolValue, `${name}.run_configuration.tools.${phaseName}.${toolName}`);
      const calls = Number(tool.calls ?? 0);
      aggregateCalls += calls;
      aggregateErrors += Number(tool.errors ?? 0);
      if (toolName === "leveret_diff") aggregateDiffCalls += calls;
    }
  }
  const detailComplete = aggregateCalls === 0 || aggregateCalls === toolCalls.length;
  const detailedDiffCalls = toolCalls.filter((call) => call.toolName === "leveret_diff");
  return {
    name,
    model: String(configuration.model ?? "unknown"),
    thinking: String(configuration.thinking ?? "unknown"),
    prompt: `${String(prompt.version ?? "unknown")} / ${String(prompt.sha256 ?? "unknown")}`,
    findings,
    grades,
    coverage,
    toolCalls: aggregateCalls || toolCalls.length,
    toolErrors: aggregateCalls ? aggregateErrors : toolCalls.filter((call) => call.isError === true).length,
    timeouts: detailComplete ? toolCalls.filter((call) => call.outcome === "timeout").length : null,
    diffCalls: aggregateCalls ? aggregateDiffCalls : detailedDiffCalls.length,
    diffBytes: detailComplete ? detailedDiffCalls.reduce((total, call) => total + (call.output_bytes ?? 0), 0) : null,
    toolDetailComplete: detailComplete,
    schemaCorrection: Object.hasOwn(aggregate, "verify-correction") || toolCalls.some((call) => call.phase === "verify-correction"),
  };
}

const cell = (value: unknown) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
const metric = (value: number | null) => value ?? "unknown";


/** Render only facts derivable from runner JSON; semantic overlap stays adjudicated. */
export function renderBenchmarkReport(runs: RunSummary[]): string {
  const lines = [
    "# Leveret replay summary",
    "",
    "Generated mechanically from runner JSON. Semantic finding overlap and defect validity are intentionally not inferred.",
    "",
    "| run | findings | actionable | priced-noise | false-positive | dropped | tool calls | errors | timeouts | diff calls | diff bytes | detail | correction |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const run of runs) {
    lines.push(`| ${cell(run.name)} | ${run.findings.length} | ${run.grades.actionable ?? 0} | ${run.grades["priced-noise"] ?? 0} | ${run.grades["false-positive"] ?? 0} | ${run.grades.dropped ?? 0} | ${run.toolCalls} | ${run.toolErrors} | ${metric(run.timeouts)} | ${run.diffCalls} | ${metric(run.diffBytes)} | ${run.toolDetailComplete ? "complete" : "aggregate-only"} | ${run.schemaCorrection ? "yes" : "no"} |`);
  }
  for (const run of runs) {
    lines.push("", `## ${cell(run.name)}`, "", `- Model: \`${cell(run.model)}\` (${cell(run.thinking)})`, `- System prompt: \`${cell(run.prompt)}\``, `- Coverage: ${Object.entries(run.coverage).map(([verdict, count]) => `${verdict}=${count}`).join(", ") || "none"}`, "", "### Published findings", "");
    if (run.findings.length === 0) lines.push("- None");
    else for (const finding of run.findings) lines.push(`- **[${cell(finding.tier)}]** \`${cell(finding.file)}:${finding.line}\` — ${cell(finding.title)} (${cell(finding.id)})`);
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const output = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const inputs = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
  if (inputs.length === 0 || (outIndex >= 0 && !output)) throw new Error("usage: bench/report.mts [--out report.md] result.json...");
  const runs = inputs.map((path) => summarizeResult(basename(path, ".json"), JSON.parse(readFileSync(path, "utf8"))));
  const report = renderBenchmarkReport(runs);
  if (output) writeFileSync(output, report);
  else process.stdout.write(report);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
