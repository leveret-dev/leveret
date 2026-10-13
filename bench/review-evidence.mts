// Shared review-evidence harness for the Java and build-evidence evaluation drivers: operator configuration pinning,
// the real reviewer process, and checksum-verified reading of its private audit trace.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runStreaming } from "../src/exec.js";
import { InspectJavaError, loadInspectJavaConfig, type InspectJavaConfig } from "../src/inspect-java.js";

export interface EvaluationOptions { mode: "deterministic" | "review"; config: string; configSha256: string; output: string }

/** The shared `--mode deterministic|review --config <file> --config-sha256 <sha> --output <dir>` convention. */
export function evaluationArguments(args: string[]): EvaluationOptions {
  const raw: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!name?.startsWith("--") || !args[i + 1] || raw[name]) throw new Error("Expected distinct --mode, --config, --config-sha256, and --output values");
    raw[name] = args[i + 1]!;
  }
  if (Object.keys(raw).sort().join(",") !== ["--config", "--config-sha256", "--mode", "--output"].join(",") ||
    !["deterministic", "review"].includes(raw["--mode"] ?? "") || !/^[a-f0-9]{64}$/.test(raw["--config-sha256"] ?? "")) {
    throw new Error("Invalid evaluation arguments");
  }
  return { mode: raw["--mode"] as EvaluationOptions["mode"], config: raw["--config"]!, configSha256: raw["--config-sha256"]!, output: raw["--output"]! };
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const limitsSchema = z.object({ heapBytes: z.number().int().positive(), addressSpaceBytes: z.number().int().positive(), deadlineMs: z.number().int().positive(), maxOutputBytes: z.number().int().positive() }).strict();
export const templateSchema = z.object({
  schema: z.literal(1), distribution: z.string().min(1), jdkHome: z.string().min(1), cache: z.string().min(1),
  limits: limitsSchema, distributionFiles: z.record(z.string(), z.string()).optional(),
  jdkFiles: z.record(z.string(), z.string()).optional(),
}).passthrough();
export type OperatorTemplate = z.infer<typeof templateSchema>;

/** Pins the installed worker and JDK files by digest into a per-run configuration, then loads it through the product loader. */
export async function pinnedConfig(template: OperatorTemplate, output: string, repo: string,
  label: string, overrides: Record<string, unknown>): Promise<{ config: InspectJavaConfig; path: string; sha256: string }> {
  const bin = ["bin/leveret-inspect", ...(await readdir(join(template.distribution, "lib"))).map((name) => `lib/${name}`)];
  const distributionFiles = Object.fromEntries(await Promise.all(bin.map(async (name) => [name, await hashFile(join(template.distribution, name))])));
  const jdkFiles = Object.fromEntries(await Promise.all(["bin/java", "release", "lib/modules", "lib/server/libjvm.so"]
    .map(async (name) => [name, await hashFile(join(template.jdkHome, name))])));
  if (template.distributionFiles && JSON.stringify(Object.entries(template.distributionFiles).sort()) !== JSON.stringify(Object.entries(distributionFiles).sort())) {
    throw new InspectJavaError("configuration-mismatch", "Operator-pinned distribution changed");
  }
  if (template.jdkFiles && JSON.stringify(Object.entries(template.jdkFiles).sort()) !== JSON.stringify(Object.entries(jdkFiles).sort())) {
    throw new InspectJavaError("configuration-mismatch", "Operator-pinned JDK changed");
  }
  const payload = JSON.stringify({ schema: 1, distribution: template.distribution, distributionFiles,
    jdkHome: template.jdkHome, jdkFiles, cache: template.cache, limits: template.limits, ...overrides });
  const path = join(output, `${label}-config.json`);
  await writeFile(path, payload, { mode: 0o600 });
  const sha256 = createHash("sha256").update(payload).digest("hex");
  return { config: await loadInspectJavaConfig(repo, path, sha256), path, sha256 };
}

const runnerEventSchema = z.looseObject({
  sequence: z.number().int(), category: z.string(), event: z.string(),
  phase: z.string().optional(), attempt: z.number().int().optional(), session_id: z.string().optional(),
  tool_call_id: z.string().optional(), payload: z.unknown().optional(),
  payload_ref: z.looseObject({ sha256: z.string() }).optional(),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
const plainRecord = z.record(z.string(), z.unknown());

/** The runner's private audit events in sequence order. */
export async function readRunnerEvents(trace: string): Promise<RunnerEvent[]> {
  const lines = (await readFile(join(trace, "runner.ndjson"), "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => runnerEventSchema.parse(JSON.parse(line))).sort((a, b) => a.sequence - b.sequence);
}

/** An event's payload, read from its content-addressed blob when stored out of line, with the recorded checksum enforced. */
export async function eventPayload(trace: string, event: RunnerEvent): Promise<Record<string, unknown>> {
  if (event.payload_ref) {
    const bytes = await readFile(join(trace, "blobs/sha256", event.payload_ref.sha256));
    if (createHash("sha256").update(bytes).digest("hex") !== event.payload_ref.sha256) throw new Error("Audit tool evidence checksum mismatch");
    return plainRecord.catch({}).parse(JSON.parse(bytes.toString("utf8")));
  }
  return plainRecord.catch({}).parse(event.payload);
}

const toolContentSchema = z.object({ result: z.object({ content: z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() })) }) });

/** The structured JSON reply a tool returned (its first JSON text part), or null when it returned none. */
export function toolReply(payload: Record<string, unknown>): unknown {
  const text = toolContentSchema.safeParse(payload).data?.result.content
    .find((part) => part.type === "text" && part.text?.startsWith("{"))?.text;
  try { return text === undefined ? null : JSON.parse(text); } catch { return null; }
}

export interface SubmittedPayload { event: RunnerEvent; args: unknown }

/**
 * Arguments of every ACCEPTED `leveret_submit_phase` call that started after `afterSequence`: only the terminal output
 * channel counts as submitted, and a call the validator rejected (error end) or that never ended is not a record.
 */
export async function* submittedPayloads(trace: string, events: readonly RunnerEvent[], afterSequence: number): AsyncGenerator<SubmittedPayload> {
  for (const event of events) {
    if (event.sequence <= afterSequence || event.category !== "tools" || event.event !== "execution_start" || !event.tool_call_id) continue;
    const call = await eventPayload(trace, event);
    if (call.tool !== "leveret_submit_phase") continue;
    const ended = events.find((candidate) => candidate.category === "tools" && candidate.event === "execution_end" &&
      candidate.tool_call_id === event.tool_call_id && candidate.sequence > event.sequence);
    if (!ended || (await eventPayload(trace, ended)).is_error !== false) continue;
    yield { event, args: call.args };
  }
}

/** Own text of every object in `value` that directly cites `id` in a string field or string-array field. */
export function citingRecords(value: unknown, id: string, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) citingRecords(item, id, found);
  } else if (value && typeof value === "object") {
    const own: string[] = [];
    for (const field of Object.values(value)) {
      if (typeof field === "string") own.push(field);
      else if (Array.isArray(field) && field.every((item) => typeof item === "string")) own.push(...field);
      else citingRecords(field, id, found);
    }
    if (own.some((text) => text.includes(id))) found.push(own.join("\n"));
  } else if (typeof value === "string" && value.startsWith("{")) {
    try { citingRecords(JSON.parse(value), id, found); } catch { /* plain text, not a record */ }
  }
  return found;
}

const reviewOutputSchema = z.looseObject({
  run_configuration: z.looseObject({
    tool_calls: z.array(z.looseObject({ toolCallId: z.string(), toolName: z.string() })).optional(),
    model: z.string().optional(), thinking: z.string().optional(), identities: z.unknown().optional(),
    model_routing: z.looseObject({ sha256: z.string().optional(), routes: z.unknown().optional() }).optional(),
    system_prompt: z.looseObject({ sha256: z.string().optional() }).optional(),
    capabilities: z.looseObject({ build_evidence: z.unknown().optional() }).optional(),
  }).optional(),
  report: z.array(z.looseObject({ file: z.string().optional() })).optional(),
});
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export interface PiReviewRun {
  label: string;
  repo: string;
  base: string;
  config: { path: string; sha256: string };
  /** Private audit directory for this review; created here. */
  trace: string;
  data: string;
}

/** Runs the real installed reviewer (`dist/runner/pi.js`); its model, provider, effort and agent directory come from the declared environment. */
export async function runPiReview(run: PiReviewRun): Promise<{ stdout: string; output: ReviewOutput }> {
  await mkdir(run.trace, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    LEVERET_REPO: run.repo, LEVERET_BASE: run.base,
    LEVERET_INSPECT_JAVA_CONFIG: run.config.path, LEVERET_INSPECT_JAVA_CONFIG_SHA256: run.config.sha256,
    LEVERET_TRACE_DIR: run.trace, LEVERET_RUN_ID: randomUUID(), LEVERET_TRACE_ENABLED: "1",
    LEVERET_TRACE_FAILURE: "fail", LEVERET_DATA: run.data,
  };
  const result = await runStreaming(process.execPath, [join(resolve(), "dist/runner/pi.js")], resolve(),
    { env, timeoutMs: 45 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) {
    // The runner's stderr may describe provider state; keep it in the private trace directory, never in the failure text.
    await writeFile(join(run.trace, "stderr.txt"), result.stderr, { mode: 0o600 });
    throw new Error(`Real ${run.label} review failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}${result.truncated ? ", output truncated" : ""}); stderr is in the private trace directory`);
  }
  return { stdout: result.stdout, output: reviewOutputSchema.parse(JSON.parse(result.stdout)) };
}
