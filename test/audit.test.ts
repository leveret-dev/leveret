import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditConfig, createAuditRun, openRunnerAudit, verifyChecksums } from "../src/audit.js";
import { inspectAudit } from "../src/audit-inspect.js";
import { classifyToolOutcome, runPhase } from "../src/runner/pi.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const created: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "leveret-audit-test-"));
  created.push(path);
  return path;
}

describe("owner audit policy", () => {
  it("defaults to full private capture, metadata operational logs, and verified archives", () => {
    const config = auditConfig("/host-data", {});
    expect(config.enabled).toBe(true);
    expect(config.root).toBe("/host-data/runs");
    expect(config.policies.operational).toBe("metadata");
    expect(config.policies.tools).toBe("full");
    expect(config.sinks).toEqual(["private", "operational", "archive"]);
    expect(config.categorySinks.tools).toEqual(config.sinks);
    expect(config.failurePolicy).toBe("fail");
  });

  it("validates category policy instead of accepting checkout-shaped keys", () => {
    expect(() => auditConfig("/data", { LEVERET_TRACE_POLICY: '{"tools":"hash","bogus":"off"}' })).toThrow(/unknown audit category/);
    expect(auditConfig("/data", { LEVERET_TRACE_POLICY: '{"tools":"hash","assistant":"off"}' }).policies).toMatchObject({ tools: "hash", assistant: "off" });
  });
});

describe("run trace", () => {
  it("keeps a secure partial run, redacts credentials, blobs large payloads, and finalizes checksums", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_BLOB_BYTES: "20",
    });
    const app = (await createAuditRun(config, "run-1"))!;
    expect(app.partialDir).toMatch(/run-1\.partial$/);
    expect((await stat(app.partialDir)).mode & 0o777).toBe(0o700);
    await app.record("app", "input", {
      authorization: "Bearer raw",
      body: "Bearer visible-secret-value-123456789",
      argv: ["runner", "--token", "opaque-split-secret"],
      runner: "runner --api-key opaque-command-secret",
      error: new Error("Bearer opaque-error-secret"),
      output_tokens_estimate: 42,
    });
    await app.record("tools", "execution_start", { args: { path: "a.ts" } }, { phase: "review", toolCallId: "e-1", evidenceId: "e-1" });
    await app.record("tools", "execution_end", { result: "done" }, { phase: "review", toolCallId: "e-1", evidenceId: "e-1" });
    const { mkdir } = await import("node:fs/promises");
    const repo = join(data, "reviewed");
    await mkdir(repo);
    const runner = (await openRunnerAudit(config, { LEVERET_TRACE_DIR: app.partialDir, LEVERET_RUN_ID: "run-1" }, repo))!;
    await runner.record("assistant", "message_end", { text: "x".repeat(100) }, { phase: "review", sessionId: "s-1" });
    await runner.writeCapabilities({ provider_request_payload: "unavailable" });
    const finalized = await app.finalize("complete");
    expect(finalized.runDir).toBeTruthy();
    const runDir = finalized.runDir!;
    await verifyChecksums(runDir);
    expect((await stat(join(runDir, "manifest.json"))).mode & 0o777).toBe(0o600);
    const appStream = await readFile(join(runDir, "app.ndjson"), "utf8");
    expect(appStream).not.toContain("visible-secret-value");
    expect(appStream).not.toContain("Bearer raw");
    const appEvent = JSON.parse(appStream.split("\n")[0]!);
    const redactedBlob = await readFile(join(runDir, "blobs", "sha256", appEvent.payload_ref.sha256), "utf8");
    expect(redactedBlob).toContain("[REDACTED]");
    expect(redactedBlob).not.toContain("visible-secret-value");
    expect(redactedBlob).not.toContain("opaque-split-secret");
    expect(redactedBlob).not.toContain("opaque-command-secret");
    expect(redactedBlob).not.toContain("opaque-error-secret");
    expect(redactedBlob).toContain('"output_tokens_estimate":42');
    const runnerEvent = JSON.parse((await readFile(join(runDir, "runner.ndjson"), "utf8")).trim());
    expect(runnerEvent.payload_ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(runDir, "blobs", "sha256", runnerEvent.payload_ref.sha256), "utf8")).toContain("x".repeat(50));
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.status).toBe("complete");
    expect(manifest.capabilities.runner.capabilities.provider_request_payload).toBe("unavailable");
    expect(manifest.redacted_fields.length).toBeGreaterThan(0);
    expect(manifest.redacted_fields).toContain("payload.error");

    const validation: string[] = [];
    await inspectAudit(["validate", runDir], (line) => validation.push(line));
    expect(JSON.parse(validation[0]!).checksums).toBe("valid");
    const evidence: string[] = [];
    await inspectAudit(["extract", runDir, "e-1"], (line) => evidence.push(line));
    expect(evidence).toHaveLength(2);
  });

  it("creates and verifies the configured gzip archive", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private,archive,export",
      LEVERET_TRACE_ARCHIVE_CODEC: "gzip",
    });
    const audit = (await createAuditRun(config, "run-archive"))!;
    await audit.record("result", "done", { ok: true });
    const finalized = await audit.finalize("complete");
    expect(finalized.archive?.path).toMatch(/\.tar\.gz$/);
    expect(finalized.archive?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.archive?.bytes).toBeGreaterThan(0);
  });

  it("filters archive contents by category sink", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_CATEGORY_SINKS: '{"tools":["archive"]}',
      LEVERET_TRACE_ARCHIVE_CODEC: "gzip",
    });
    const audit = (await createAuditRun(config, "run-filtered-archive"))!;
    await audit.record("app", "job", { body: "private-only" });
    await audit.record("tools", "execution_end", { body: "archive-only" });
    const finalized = await audit.finalize("complete");
    const { access } = await import("node:fs/promises");
    await expect(access(join(finalized.runDir!, "app.archive.ndjson"))).rejects.toThrow();
    expect(await readFile(join(finalized.runDir!, "app.ndjson"), "utf8")).not.toContain("archive-only");
    const extracted = join(data, "extracted");
    const { mkdir } = await import("node:fs/promises");
    const { execFileSync } = await import("node:child_process");
    await mkdir(extracted);
    execFileSync("tar", ["-xf", finalized.archive!.path, "-C", extracted]);
    const stream = await readFile(join(extracted, "run-filtered-archive", "app.ndjson"), "utf8");
    expect(stream).toContain("archive-only");
    expect(stream).not.toContain("private-only");
    const manifest = JSON.parse(await readFile(join(extracted, "run-filtered-archive", "manifest.json"), "utf8"));
    expect(manifest.categories.app.state).toBe("disabled");
    await verifyChecksums(join(extracted, "run-filtered-archive"));
  });

  it("applies hash/off policies and disables unfiltered native sessions", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_POLICY: '{"tools":"hash","assistant":"off"}',
    });
    const audit = (await createAuditRun(config, "run-policy"))!;
    expect(audit.nativeSessionsEnabled()).toBe(false);
    await audit.record("assistant", "message_end", { text: "private" });
    await audit.record("tools", "execution_end", { result: "private" });
    const runDir = (await audit.finalize("complete")).runDir!;
    const records = (await readFile(join(runDir, "app.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ category: "tools", content_policy: "hash" });
    expect(records[0].payload).toBeUndefined();
    expect(records[0].metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.categories.assistant.state).toBe("disabled");
  });

  it("keeps raw content out of an operational-only sink", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "operational",
    });
    const audit = (await createAuditRun(config, "run-operational"))!;
    await audit.record("result", "done", { source: "private source body" });
    await audit.writeResult({ source: "private source body" });
    const runDir = (await audit.finalize("complete")).runDir!;
    const { access } = await import("node:fs/promises");
    await expect(access(join(runDir, "app.ndjson"))).rejects.toThrow();
    expect(await readFile(join(runDir, "operational.ndjson"), "utf8")).not.toContain("private source body");
    expect(await readFile(join(runDir, "result.json"), "utf8")).not.toContain("private source body");
    const validation: string[] = [];
    await inspectAudit(["validate", runDir], (line) => validation.push(line));
    expect(JSON.parse(validation[0]!).events).toBe(1);
  });

  it("routes categories to independent owner-selected sinks", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_CATEGORY_SINKS: '{"tools":["operational"]}',
    });
    const audit = (await createAuditRun(config, "run-routing"))!;
    await audit.record("app", "job", { body: "app-private" });
    const { mkdir } = await import("node:fs/promises");
    const repo = join(data, "repo-routing");
    await mkdir(repo);
    const runner = (await openRunnerAudit(config, { LEVERET_TRACE_DIR: audit.partialDir, LEVERET_RUN_ID: "run-routing" }, repo))!;
    await runner.record("tools", "execution_end", { body: "tool-private" });
    const runDir = (await audit.finalize("complete")).runDir!;
    expect(await readFile(join(runDir, "app.ndjson"), "utf8")).toContain("app-private");
    expect(await readFile(join(runDir, "app.ndjson"), "utf8")).not.toContain("tool-private");
    const operational = await readFile(join(runDir, "runner.operational.ndjson"), "utf8");
    expect(operational).not.toContain("tool-private");
    expect(operational).toContain('"category":"tools"');
  });

  it("expires private category payloads independently and rebuilds integrity metadata", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_CATEGORY_RETENTION_DAYS: '{"tools":0.000000000001}',
    });
    const audit = (await createAuditRun(config, "run-category-retention"))!;
    await audit.record("app", "job", { body: "keep-app" });
    await audit.record("tools", "execution_end", { body: "expire-tool" });
    const runDir = (await audit.finalize("complete")).runDir!;
    const { access } = await import("node:fs/promises");
    await expect(access(join(runDir, "categories", "tools"))).rejects.toThrow();
    const stream = await readFile(join(runDir, "app.ndjson"), "utf8");
    expect(stream).toContain("keep-app");
    expect(stream).not.toContain("expire-tool");
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.categories.tools.state).toBe("expired");
    await verifyChecksums(runDir);
    expect(await readFile(join(config.root, "retention.ndjson"), "utf8")).toContain("category-retention-delete");
  });

  it("deduplicates index and retained category sidecars in inspector output", async () => {
    const data = await root();
    const audit = (await createAuditRun(auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"),
      LEVERET_TRACE_SINKS: "private",
      LEVERET_TRACE_CATEGORY_RETENTION_DAYS: '{"tools":1}',
    }), "run-inspector-sidecar"))!;
    await audit.record("tools", "execution_end", { body: "retained" }, { toolCallId: "e-retained", evidenceId: "e-retained" });
    const runDir = (await audit.finalize("complete")).runDir!;
    const summary: string[] = [];
    await inspectAudit(["summary", runDir], (line) => summary.push(line));
    expect(summary.filter((line) => line.includes("execution_end"))).toHaveLength(1);
    const extracted: string[] = [];
    await inspectAudit(["extract", runDir, "e-retained"], (line) => extracted.push(line));
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toContain("retained");
  });

  it("rejects finite category retention for immutable archive sinks", () => {
    expect(() => auditConfig("/data", {
      LEVERET_TRACE_CATEGORY_RETENTION_DAYS: '{"tools":1}',
    })).toThrow(/immutable archive/);
  });

  it("rejects files added after final checksums", async () => {
    const data = await root();
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" });
    const audit = (await createAuditRun(config, "run-tamper"))!;
    await audit.record("result", "done", { ok: true });
    const runDir = (await audit.finalize("complete")).runDir!;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(runDir, "late-file"), "tamper");
    await expect(verifyChecksums(runDir)).rejects.toThrow(/inventory/);
  });

  it("rejects late writes after the finalization barrier", async () => {
    const data = await root();
    const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" }), "run-finalized"))!;
    await audit.record("app", "before", {});
    const runDir = (await audit.finalize("complete")).runDir!;
    await expect(audit.record("app", "late", {})).rejects.toThrow(/closed/);
    await verifyChecksums(runDir);
  });

  it("fails closed by default and permits an explicit recorded-gap policy", async () => {
    const data = await root();
    const { rm } = await import("node:fs/promises");
    const fail = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "fail"), LEVERET_TRACE_SINKS: "private" }), "run-fail"))!;
    await rm(fail.partialDir, { recursive: true });
    await expect(fail.record("app", "event", {})).rejects.toThrow();
    await expect(fail.flush()).rejects.toThrow();

    const proceed = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "continue"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_FAILURE: "continue" }), "run-continue"))!;
    await rm(proceed.partialDir, { recursive: true });
    await expect(proceed.record("app", "event", {})).resolves.toBeUndefined();
    await expect(proceed.flush()).resolves.toBeUndefined();
  });

  it("reports successful reviews with capture gaps as incomplete", async () => {
    const data = await root();
    const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_FAILURE: "continue" }), "run-gap"))!;
    audit.gap("native session unavailable");
    const finalized = await audit.finalize("complete");
    expect(finalized.completeness).toBe("incomplete");
    const manifest = JSON.parse(await readFile(join(finalized.runDir!, "manifest.json"), "utf8"));
    expect(manifest.completeness).toBe("incomplete");
  });

  it("fails closed on malformed custom protocol unless the owner permits gaps", async () => {
    const data = await root();
    const { appendFile } = await import("node:fs/promises");
    const closed = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "closed"), LEVERET_TRACE_SINKS: "private" }), "run-custom-closed"))!;
    await appendFile(join(closed.partialDir, "runner.ndjson"), '{"schema":1,"producer":"runner"}\n');
    await expect(closed.validateCapturedEvents()).rejects.toThrow(/validation/);

    const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "continue"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_FAILURE: "continue" }), "run-custom-invalid"))!;
    await appendFile(join(audit.partialDir, "runner.ndjson"), '{"schema":1,"producer":"runner"}\n');
    await expect(audit.validateCapturedEvents()).resolves.toBeUndefined();
    const finalized = await audit.finalize("complete");
    expect(finalized.completeness).toBe("incomplete");
    const manifest = JSON.parse(await readFile(join(finalized.runDir!, "manifest.json"), "utf8"));
    expect(manifest.gaps).toContain("runner.ndjson contains an incomplete event");
  });

  it("rejects symlinks before checksumming or archiving a custom harness trace", async () => {
    const data = await root();
    const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" }), "run-link"))!;
    const { symlink, writeFile } = await import("node:fs/promises");
    const outside = join(data, "outside");
    await writeFile(outside, "private");
    await symlink(outside, join(audit.partialDir, "custom-link"));
    await expect(audit.finalize("complete")).rejects.toThrow(/symbolic link/);
  });

  it("preserves validated traces across backup, restore, upgrade, and uninstall", async () => {
    const data = await root();
    const traceRoot = join(data, "traces");
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: traceRoot, LEVERET_TRACE_SINKS: "private" });
    const first = (await createAuditRun(config, "run-before-upgrade"))!;
    await first.record("result", "done", { version: 1 });
    const firstDir = (await first.finalize("complete")).runDir!;
    const { cp, mkdir, rm } = await import("node:fs/promises");
    const backup = join(data, "backup");
    await cp(firstDir, backup, { recursive: true });
    await verifyChecksums(backup);

    const second = (await createAuditRun(config, "run-after-upgrade"))!;
    await second.record("result", "done", { version: 1 });
    await second.finalize("complete");
    await verifyChecksums(firstDir);

    const install = join(data, "install");
    await mkdir(install);
    await rm(install, { recursive: true });
    await verifyChecksums(firstDir);

    const restored = join(data, "restored");
    await cp(backup, restored, { recursive: true });
    const validation: string[] = [];
    await inspectAudit(["validate", restored], (line) => validation.push(line));
    expect(JSON.parse(validation[0]!).checksums).toBe("valid");
  });

  it("rejects a runner trace directory inside the reviewed checkout", async () => {
    const data = await root();
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces") });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(data, "repo", "trace"), { recursive: true });
    await expect(openRunnerAudit(config, { LEVERET_TRACE_DIR: join(data, "repo", "trace"), LEVERET_RUN_ID: "r" }, join(data, "repo"))).rejects.toThrow(/outside/);
  });

  it("keeps exact malformed assistant output for every Pi attempt", async () => {
    const data = await root();
    const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" }), "run-malformed"))!;
    let attempt = 0;
    const createSession = (async (options: { sessionManager?: SessionManager }) => {
      const manager = options.sessionManager!;
      const current = ++attempt;
      let listener: (event: never) => void = () => {};
      return {
        session: {
          get sessionId() { return manager.getSessionId(); },
          get sessionFile() { return manager.getSessionFile(); },
          subscribe(callback: (event: never) => void) { listener = callback; return () => {}; },
          async prompt() {
            manager.appendMessage({ role: "user", content: "review" } as never);
            const message = { role: "assistant", content: [{ type: "text", text: `malformed-${current} Bearer ghp_abcdefghijklmnopqrstuvwxyz` }], provider: "test", model: "test", api: "openai-responses", stopReason: "stop" };
            manager.appendMessage(message as never);
            listener({ type: "message_end", message } as never);
          },
          async abort() {},
          dispose() {},
        },
        extensionsResult: { extensions: [], errors: [], runtime: {} },
      };
    }) as never;
    await expect(runPhase({
      phase: "review",
      prompt: "review",
      repo: data,
      runtimeDir: data,
      runtime: { model: "test", provider: "test", thinking: "off", deadlineMs: 10_000 },
      modelRuntime: {} as never,
      model: { provider: "test", id: "test", api: "openai-responses" } as never,
      systemPrompt: "system",
      tools: [],
      metrics: [],
      toolOutcomes: new Map(),
      audit,
      createSession,
    })).rejects.toThrow(/no JSON/);
    const finalized = await audit.finalize("failed", new Error("malformed fixture"));
    expect(finalized.completeness).toBe("complete");
    const runDir = finalized.runDir!;
    for (const current of [1, 2]) {
      const session = await readFile(join(runDir, "sessions", `review-attempt-${current}.jsonl`), "utf8");
      expect(session).toContain(`malformed-${current}`);
      expect(session).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    }
    const events = await readFile(join(runDir, "app.ndjson"), "utf8");
    expect(events).toContain("attempt_parse_failed");
    expect(events).toContain("malformed-1");
    expect(events).toContain("malformed-2");
  });
});

it("classifies timeout only from execution metadata, never result text", () => {
  expect(classifyToolOutcome(false, false)).toBe("success");
  expect(classifyToolOutcome(true, false)).toBe("error");
  expect(classifyToolOutcome(true, true)).toBe("timeout");
});
