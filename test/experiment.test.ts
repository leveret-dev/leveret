import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  configurationSha256,
  discoveryScheduler,
  experimentManifestSchema,
  loadModelRouting,
  runScheduled,
} from "../src/runner/experiment.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const route = { provider: "openai", model: "gpt-5.6-sol", effort: "high" as const };
const fakeRuntime = { getModel: vi.fn((provider: string, model: string) => provider === route.provider && model === route.model ? { provider, id: model } : undefined) } as unknown as ModelRuntime;
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

describe("experiment scheduler and routing", () => {
  it("runs the same fixed inputs once with stable outputs and separate wall/worker accounting", async () => {
    const inputs = ["correctness", "test-honesty", "contract-operability"];
    const serialCalls: string[] = [];
    const serial = await runScheduled(inputs, discoveryScheduler("serial/v1", undefined), async (input) => { serialCalls.push(input); return `out:${input}`; });
    expect(serial.outputs).toEqual(inputs.map((input) => `out:${input}`));
    expect(serialCalls).toEqual(inputs);

    const gates = inputs.map(deferred);
    const concurrentCalls: string[] = [];
    let active = 0;
    let peak = 0;
    const pending = runScheduled(inputs, discoveryScheduler("bounded-concurrent/v1", "2"), async (input, index) => {
      concurrentCalls.push(input);
      active++;
      peak = Math.max(peak, active);
      await gates[index]!.promise;
      active--;
      return `out:${input}`;
    });
    await Promise.resolve();
    expect(concurrentCalls).toEqual(inputs.slice(0, 2));
    gates[0]!.resolve(); gates[1]!.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(concurrentCalls).toEqual(inputs);
    gates[2]!.resolve();
    const concurrent = await pending;
    expect(concurrent.outputs).toEqual(serial.outputs);
    expect(peak).toBe(2);
    expect(concurrent.worker_duration_ms).toHaveLength(3);
    expect(concurrent.summed_worker_compute_ms).toBe(concurrent.worker_duration_ms.reduce((sum, value) => sum + value, 0));
    expect(concurrent.wall_duration_ms).toBeGreaterThanOrEqual(Math.max(...concurrent.worker_duration_ms));
  });
  it("stops starting queued required legs after failure and signals in-flight work", async () => {
    const started: string[] = [];
    const signaled: string[] = [];
    await expect(runScheduled(["a", "b", "c"], discoveryScheduler("bounded-concurrent/v1", "2"), async (input, _index, signal) => {
      started.push(input);
      if (input === "a") throw new Error("required leg failed");
      const aborted = deferred();
      signal.addEventListener("abort", () => { signaled.push(input); aborted.resolve(); }, { once: true });
      await aborted.promise;
      return input;
    })).rejects.toThrow("required leg failed");
    expect(started).toEqual(["a", "b"]);
    expect(signaled).toEqual(["b"]);
  });

  it("loads only an outside-checkout hash-pinned host route and validates every model", async () => {
    const root = mkdtempSync(join(tmpdir(), "leveret-routing-"));
    const path = join(root, "routing.json");
    const config = { schema: "leveret.model-routing/v1", mode: "fixed", route };
    const bytes = Buffer.from(JSON.stringify(config));
    writeFileSync(path, bytes);
    try {
      const loaded = await loadModelRouting(process.cwd(), path, hash(bytes), route, fakeRuntime);
      expect(loaded).toMatchObject({ source: "host-file", routes: { correctness: route, verifier: route } });
      expect(fakeRuntime.getModel).toHaveBeenCalledTimes(4);
      await expect(loadModelRouting(process.cwd(), path, "0".repeat(64), route, fakeRuntime)).rejects.toThrow(/SHA-256 mismatch/);
      await expect(loadModelRouting(process.cwd(), path, undefined, route, fakeRuntime)).rejects.toThrow(/supplied together/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an exact five-trial, cold-first, hash-bound experiment configuration", () => {
    const withoutHash = {
      id: "candidate",
      context_mode: "diff-only" as const,
      discovery_mode: "specialized/v1" as const,
      scheduler: { id: "serial/v1" as const, concurrency_bound: 1 },
      routing: { schema: "leveret.model-routing/v1" as const, sha256: "1".repeat(64) },
      identities: { prompt_sha256: "2".repeat(64), tool_sha256: "3".repeat(64), policy_sha256: "4".repeat(64), card_sha256: "5".repeat(64), rule_sha256: "6".repeat(64), cache_sha256: "7".repeat(64) },
      reference_hardware: "fixture",
      trial_ids: ["t1", "t2", "t3", "t4", "t5"],
      cold_trial_id: "t1",
    };
    const configuration = { ...withoutHash, configuration_sha256: configurationSha256(withoutHash) };
    expect(experimentManifestSchema.parse({ schema: "leveret.replay-experiment/v1", corpus: { schema: "leveret.replay-corpus/v1", sha256: "8".repeat(64) }, candidate_configuration_id: "candidate", configurations: [configuration] }).configurations[0]?.trial_ids).toHaveLength(5);
    expect(() => experimentManifestSchema.parse({ schema: "leveret.replay-experiment/v1", corpus: { schema: "leveret.replay-corpus/v1", sha256: "8".repeat(64) }, candidate_configuration_id: "candidate", configurations: [{ ...configuration, trial_ids: ["t1", "t2", "t3", "t4"] }] })).toThrow();
  });
});
