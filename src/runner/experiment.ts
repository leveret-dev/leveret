import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { pathIsInside } from "../path.js";

export const DISCOVERY_SCHEDULERS = ["serial/v1", "bounded-concurrent/v1"] as const;
export type DiscoverySchedulerId = typeof DISCOVERY_SCHEDULERS[number];
export interface DiscoveryScheduler { id: DiscoverySchedulerId; concurrency_bound: number }

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const effort = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const routeSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), effort }).strict();
const routingSchema = z.discriminatedUnion("mode", [
  z.object({ schema: z.literal("leveret.model-routing/v1"), mode: z.literal("fixed"), route: routeSchema }).strict(),
  z.object({
    schema: z.literal("leveret.model-routing/v1"),
    mode: z.literal("routed"),
    routes: z.object({ correctness: routeSchema, "test-honesty": routeSchema, "contract-operability": routeSchema, verifier: routeSchema }).strict(),
  }).strict(),
]);
export type ModelRoute = z.infer<typeof routeSchema>;
export type ModelRoutingConfig = z.infer<typeof routingSchema>;
export type RoutedPhase = "correctness" | "test-honesty" | "contract-operability" | "verifier";

export function discoveryScheduler(value: string | undefined, boundValue: string | undefined): DiscoveryScheduler {
  const id = value ?? "serial/v1";
  if (!DISCOVERY_SCHEDULERS.includes(id as DiscoverySchedulerId)) throw new Error(`invalid discovery scheduler: ${id}`);
  const bound = id === "serial/v1" ? 1 : Number(boundValue ?? "3");
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 3) throw new Error("discovery concurrency bound must be an integer from 1 through 3");
  return { id: id as DiscoverySchedulerId, concurrency_bound: bound };
}

export interface ScheduledResult<T> { outputs: T[]; worker_duration_ms: number[]; wall_duration_ms: number; summed_worker_compute_ms: number }

/** Runs the fixed input list once, returns in input order, and signals in-flight work after the first failure. */
export async function runScheduled<T, R>(inputs: readonly T[], scheduler: DiscoveryScheduler, invoke: (input: T, index: number, signal: AbortSignal) => Promise<R>): Promise<ScheduledResult<R>> {
  const started = performance.now();
  const outputs = new Array<R>(inputs.length);
  const durations = new Array<number>(inputs.length).fill(0);
  const controller = new AbortController();
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (!controller.signal.aborted) {
      const index = next++;
      if (index >= inputs.length) return;
      const workerStarted = performance.now();
      try {
        outputs[index] = await invoke(inputs[index]!, index, controller.signal);
      } catch (error) {
        failure ??= error;
        controller.abort(error);
      } finally {
        durations[index] = Math.max(0, performance.now() - workerStarted);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(inputs.length, scheduler.concurrency_bound) }, worker));
  if (failure) throw failure;
  return {
    outputs,
    worker_duration_ms: durations,
    wall_duration_ms: Math.max(0, performance.now() - started),
    summed_worker_compute_ms: durations.reduce((sum, duration) => sum + duration, 0),
  };
}

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function stableSha256(value: unknown): string { return digest(stable(value)); }

export interface LoadedRouting {
  config: ModelRoutingConfig;
  sha256: string;
  source: "runner-default" | "host-file";
  routes: Record<RoutedPhase, ModelRoute>;
  models: Record<RoutedPhase, NonNullable<ReturnType<ModelRuntime["getModel"]>>>;
}

export async function loadModelRouting(
  repo: string,
  path: string | undefined,
  expectedSha256: string | undefined,
  fallback: ModelRoute,
  runtime: ModelRuntime,
): Promise<LoadedRouting> {
  if (Boolean(path) !== Boolean(expectedSha256)) throw new Error("model routing path and SHA-256 must be supplied together");
  let config: ModelRoutingConfig;
  let actualSha256: string;
  let source: LoadedRouting["source"];
  if (path) {
    if (!sha256.safeParse(expectedSha256).success) throw new Error("model routing SHA-256 is invalid");
    const [repoPath, configPath] = await Promise.all([realpath(repo), realpath(resolve(path))]);
    if (pathIsInside(repoPath, configPath)) throw new Error("model routing config must stay outside the reviewed checkout");
    const bytes = await readFile(configPath);
    actualSha256 = digest(bytes);
    if (actualSha256 !== expectedSha256) throw new Error("model routing config SHA-256 mismatch");
    config = routingSchema.parse(JSON.parse(bytes.toString("utf8")));
    source = "host-file";
  } else {
    config = { schema: "leveret.model-routing/v1", mode: "fixed", route: fallback };
    actualSha256 = digest(stable(config));
    source = "runner-default";
  }
  const routes = config.mode === "fixed"
    ? { correctness: config.route, "test-honesty": config.route, "contract-operability": config.route, verifier: config.route }
    : config.routes;
  const models = Object.fromEntries(Object.entries(routes).map(([phase, route]) => {
    const model = runtime.getModel(route.provider, route.model);
    if (!model) throw new Error(`model routing config references unavailable model: ${route.provider}/${route.model}`);
    return [phase, model];
  })) as LoadedRouting["models"];
  return { config, sha256: actualSha256, source, routes, models };
}

const identitiesSchema = z.object({
  prompt_sha256: sha256,
  tool_sha256: sha256,
  policy_sha256: sha256,
  card_sha256: sha256,
  rule_sha256: sha256,
  cache_sha256: sha256,
}).strict();
const experimentConfigurationSchema = z.object({
  id: z.string().min(1),
  configuration_sha256: sha256,
  context_mode: z.enum(["diff-only", "review-context"]),
  discovery_mode: z.enum(["single", "specialized/v1"]),
  scheduler: z.object({ id: z.enum(DISCOVERY_SCHEDULERS), concurrency_bound: z.number().int().min(1).max(3) }).strict(),
  routing: z.object({ schema: z.literal("leveret.model-routing/v1"), sha256 }).strict(),
  identities: identitiesSchema,
  reference_hardware: z.string().min(1),
  trial_ids: z.array(z.string().min(1)).length(5),
  cold_trial_id: z.string().min(1),
}).strict().superRefine((configuration, ctx) => {
  if (new Set(configuration.trial_ids).size !== 5) ctx.addIssue({ code: "custom", path: ["trial_ids"], message: "trial IDs must be unique" });
  if (!configuration.trial_ids.includes(configuration.cold_trial_id)) ctx.addIssue({ code: "custom", path: ["cold_trial_id"], message: "cold trial ID must be one of the five trial IDs" });
  if (configuration.trial_ids[0] !== configuration.cold_trial_id) ctx.addIssue({ code: "custom", path: ["cold_trial_id"], message: "cold trial must be first so cache state is reproducible" });
  const { configuration_sha256, ...identity } = configuration;
  if (digest(stable(identity)) !== configuration_sha256) ctx.addIssue({ code: "custom", path: ["configuration_sha256"], message: "configuration hash mismatch" });
});
export const experimentManifestSchema = z.object({
  schema: z.literal("leveret.replay-experiment/v1"),
  corpus: z.object({ schema: z.literal("leveret.replay-corpus/v1"), sha256 }).strict(),
  candidate_configuration_id: z.string().min(1),
  configurations: z.array(experimentConfigurationSchema).min(1),
}).strict().superRefine((manifest, ctx) => {
  const ids = manifest.configurations.map((configuration) => configuration.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["configurations"], message: "configuration IDs must be unique" });
  const hashes = manifest.configurations.map((configuration) => configuration.configuration_sha256);
  if (new Set(hashes).size !== hashes.length) ctx.addIssue({ code: "custom", path: ["configurations"], message: "configuration hashes must be unique" });
  if (!manifest.configurations.some((configuration) => configuration.id === manifest.candidate_configuration_id)) ctx.addIssue({ code: "custom", path: ["candidate_configuration_id"], message: "candidate configuration is absent" });
});
export type ExperimentManifest = z.infer<typeof experimentManifestSchema>;
export type ExperimentConfiguration = z.infer<typeof experimentConfigurationSchema>;

export function configurationSha256(configuration: Omit<ExperimentConfiguration, "configuration_sha256">): string { return digest(stable(configuration)); }
export function experimentVariableIdentity(discoveryMode: string, scheduler: DiscoveryScheduler, routingSha256: string): string {
  return digest(stable({ discovery_mode: discoveryMode, scheduler, routing_sha256: routingSha256 }));
}
