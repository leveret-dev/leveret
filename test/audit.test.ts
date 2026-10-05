import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditConfig, createAuditRun, openRunnerAudit, sanitizeAuditValue, verifyChecksums, withAuditTrace } from "../src/audit.js";
import { inspectAudit, readAuditEvents } from "../src/audit-inspect.js";
import { refreshSecretPolicy, withSecretPolicy } from "../src/secret-screening.js";
import { classifyToolOutcome, runPhase } from "../src/runner/pi.js";
import * as piRunner from "../src/runner/pi.js";
import { buildPiTools } from "../src/runner/pi-tools.js";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import type { ChangeEvidence } from "../src/change-evidence.js";
import type { PiToolsBundle } from "../src/runner/pi-tools.js";
import { runStreaming } from "../src/exec.js";
import { Type } from "typebox";

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
    const records = await readAuditEvents(runDir);
    expect(records.filter((event) => event.event === "execution_end")).toHaveLength(1);
    await expect(readAuditEvents(runDir, { maxEvents: 0 })).rejects.toThrow(/positive safe integers/);
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

  it("keeps exact assistant output when every Pi attempt omits submission", async () => {
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
      runtime: { model: "test", provider: "test", thinking: "off", deadlineMs: 10_000, discoveryMode: "single" },
      modelRuntime: {} as never,
      model: { provider: "test", id: "test", api: "openai-responses" } as never,
      systemPrompt: "system",
      tools: [],
      submission: { parameters: Type.Object({}), parse: (value) => value },
      metrics: [],
      toolOutcomes: new Map(),
      audit,
      createSession,
    })).rejects.toThrow(/without calling leveret_submit_phase/);
    const finalized = await audit.finalize("failed", new Error("malformed fixture"));
    expect(finalized.completeness).toBe("complete");
    const runDir = finalized.runDir!;
    for (const current of [1, 2]) {
      const session = await readFile(join(runDir, "sessions", `review-attempt-${current}.jsonl`), "utf8");
      expect(session).toContain(`malformed-${current}`);
      expect(session).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    }
    const events = await readFile(join(runDir, "app.ndjson"), "utf8");
    expect(events).toContain("attempt_submission_missing");
    expect(events).toContain("malformed-1");
    expect(events).toContain("malformed-2");
  });
});

describe("run trace with an active secret policy", () => {
  const KNOWN = "corp-vault-credential-7f3a91"; // no built-in pattern recognizes it

  async function bytesUnder(dir: string): Promise<string> {
    const parts: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      parts.push(entry.isDirectory() ? await bytesUnder(join(dir, entry.name)) : await readFile(join(dir, entry.name), "latin1"));
    }
    return parts.join("\n");
  }

  it("removes exact known values from events, blobs, native sessions, capabilities, results and the manifest", async () => {
    const policy = { id: "policy-audit", available: true, knownValues: new Set([KNOWN]), refreshKnownValues: async () => [], additionalRules: [], nonSecretValues: new Set<string>() };
    const data = await root();
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_BLOB_BYTES: "40" });
    const audit = (await createAuditRun(config, "run-known-values"))!;
    const runDir = await withSecretPolicy(policy, async () => {
      await audit.record("tools", "execution_end", {
        stdout: `connected with ${KNOWN} ok`,
        argv: ["tool", "--endpoint", `https://host.example/${KNOWN}`],
        error: new Error(`failed ${KNOWN}`),
        nested: { items: [{ text: KNOWN }], big: `${KNOWN} ${"x".repeat(200)}` },
        output_tokens_estimate: 7,
      });
      await audit.persistNativeSession([{ role: "user", content: `use ${KNOWN}` }], "review-attempt-1.jsonl");
      await audit.writeCapabilities({ note: `seen ${KNOWN}` });
      await audit.writeResult({ summary: `done ${KNOWN}` });
      return (await audit.finalize("failed", new Error(`stopped near ${KNOWN}`))).runDir!;
    });
    const bytes = await bytesUnder(runDir);
    expect(bytes).not.toContain(KNOWN);
    expect(bytes).toContain("[REDACTED]");
    expect(bytes).toContain('"output_tokens_estimate":7');
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(manifest.redacted_fields).toEqual(expect.arrayContaining(["payload.stdout", "payload.error", "manifest.error"]));
    expect(manifest.categories.tools.state).toBe("redacted");
  });

  it("reports a category as redacted from what sanitation did, whether the payload is inline, blobbed or hash-only", async () => {
    const data = await root();
    const config = auditConfig(data, {
      LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_BLOB_BYTES: "40",
      LEVERET_TRACE_POLICY: '{"subprocess":"hash"}',
    });
    const audit = (await createAuditRun(config, "run-redaction-state"))!;
    const filler = "x".repeat(200);
    await audit.record("tools", "execution_end", { stdout: `Bearer ghp_abcdefghijklmnopqrstuvwxyz ${filler}` }); // blobbed, redacted
    await audit.record("assistant", "message_end", { text: `plain text ${filler}` }); // blobbed, nothing to redact
    await audit.record("prompts", "prompt", { text: "a Bearer ghp_abcdefghijklmnopqrstuvwxyz" }); // inline, redacted
    await audit.record("subprocess", "exit", { stderr: "Bearer ghp_abcdefghijklmnopqrstuvwxyz" }); // hash only, redacted
    const runDir = (await audit.finalize("complete")).runDir!;
    const { categories } = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
    expect(categories.tools.state).toBe("redacted");
    expect(categories.assistant.state).toBe("captured");
    expect(categories.prompts.state).toBe("redacted");
    expect(categories.subprocess.state).toBe("redacted");
  });

  describe("object keys", () => {
    const SECOND = "corp-vault-credential-b81c04";
    const policyOf = (...values: string[]) => ({
      id: "policy-keys", available: true, knownValues: new Set(values), refreshKnownValues: async () => [], additionalRules: [], nonSecretValues: new Set<string>(),
    });

    it("removes known values from keys wherever a payload is persisted and never lists a raw key in redacted_fields", async () => {
      const data = await root();
      const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" });
      const audit = (await createAuditRun(config, "run-secret-keys"))!;
      const runDir = await withSecretPolicy(policyOf(KNOWN, SECOND), async () => {
        await audit.record("tools", "execution_end", {
          [`env-${KNOWN}`]: "value-one",
          nested: { [KNOWN]: { [`deep-${SECOND}`]: "value-two" } },
          list: [{ [`item-${KNOWN}`]: "value-three" }],
          output_tokens_estimate: 7,
        });
        await audit.persistNativeSession([{ [`role-${KNOWN}`]: "value-four" }], "review-attempt-1.jsonl");
        await audit.writeCapabilities({ [`cap-${KNOWN}`]: "value-five" });
        await audit.writeResult({ [`res-${SECOND}`]: "value-six" });
        return (await audit.finalize("complete")).runDir!;
      });
      const bytes = await bytesUnder(runDir);
      expect(bytes).not.toContain(KNOWN);
      expect(bytes).not.toContain(SECOND);
      for (const kept of ["value-one", "value-two", "value-three", "value-four", "value-five", "value-six", '"output_tokens_estimate":7']) expect(bytes).toContain(kept);
      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      expect(manifest.redacted_fields).toEqual(expect.arrayContaining([
        "payload.env-[REDACTED]", "payload.nested.[REDACTED]", "payload.nested.[REDACTED].deep-[REDACTED]", "payload.list[0].item-[REDACTED]",
        "payload.role-[REDACTED]", "payload.cap-[REDACTED]", "payload.res-[REDACTED]",
      ]));
      expect(manifest.categories.tools.state).toBe("redacted");
    });

    it("keeps every entry when several secret keys collapse to the same text", async () => {
      const data = await root();
      const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" });
      const audit = (await createAuditRun(config, "run-colliding-keys"))!;
      const runDir = await withSecretPolicy(policyOf(KNOWN, SECOND), async () => {
        await audit.record("tools", "execution_end", { [KNOWN]: "first-value", [SECOND]: "second-value", plain: "third-value" });
        return (await audit.finalize("complete")).runDir!;
      });
      const event = JSON.parse((await readFile(join(runDir, "app.ndjson"), "utf8")).split("\n")[0]!);
      expect(Object.values(event.payload).sort()).toEqual(["first-value", "second-value", "third-value"]);
      expect(Object.keys(event.payload)).toHaveLength(3);
      expect(event.payload.plain).toBe("third-value");
      expect(event.redacted).toBe(true);
      expect(await bytesUnder(runDir)).not.toContain(KNOWN);
    });

    it("removes a built-in credential shape from a key outside any policy scope", async () => {
      const data = await root();
      const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" });
      const audit = (await createAuditRun(config, "run-builtin-key"))!;
      await audit.record("tools", "execution_end", { "Bearer ghp_abcdefghijklmnopqrstuvwxyz": "kept-value" });
      const runDir = (await audit.finalize("complete")).runDir!;
      const bytes = await bytesUnder(runDir);
      expect(bytes).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
      expect(bytes).toContain("kept-value");
      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      expect(manifest.redacted_fields).toContain("payload.[REDACTED]");
    });
  });

  it("leaves a run outside any policy scope with built-in redaction only", async () => {
    const data = await root();
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private" });
    const audit = (await createAuditRun(config, "run-no-policy"))!;
    await audit.record("tools", "execution_end", { stdout: `connected with ${KNOWN}`, token: "Bearer ghp_abcdefghijklmnopqrstuvwxyz" });
    const runDir = (await audit.finalize("complete")).runDir!;
    const bytes = await bytesUnder(runDir);
    expect(bytes).toContain(KNOWN);
    expect(bytes).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});

it("classifies timeout only from execution metadata, never result text", () => {
  expect(classifyToolOutcome(false, false)).toBe("success");
  expect(classifyToolOutcome(true, false)).toBe("error");
  expect(classifyToolOutcome(true, true)).toBe("timeout");
});

it("refreshes active SDK credentials before real probe capture and native-session persistence", async () => {
  const data = await root();
  const runtimeDir = join(data, "runtime");
  const agentDir = join(data, "agent");
  await mkdir(runtimeDir);
  await mkdir(agentDir);
  const marker = "rotated-native-opaque-value";
  const requests: string[] = [];
  let calls = 0;
  let runtime: ModelRuntime;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    const call = ++calls;
    if (call === 1) await runtime.setRuntimeApiKey("fixture", marker);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = call === 1
      ? { tool_calls: [{ index: 0, id: "probe-rotated", type: "function", function: { name: "leveret_probe",
          arguments: JSON.stringify({ command: "node", args: ["-e", `process.stdout.write('${marker}')`] }) } }] }
      : call === 2
        ? { tool_calls: [{ index: 0, id: "submit-native", type: "function", function: { name: "leveret_submit_phase", arguments: '{"concerns":[]}' } }] }
        : { content: marker };
    const chunk = (delta: unknown, finish_reason: string | null) => JSON.stringify({
      id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.end(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, call <= 2 ? "tool_calls" : "stop")}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const oldAgent = process.env.LEVERET_PI_AGENT_DIR;
  let tools: PiToolsBundle | undefined;
  try {
  if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "initial-native-opaque-value", models: [{ id: "fixture" }],
  } } }));
  runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false });
  const model = runtime.getModel("fixture", "fixture")!;
  const policy = await piRunner.createPiSecretPolicy(runtime, [model], undefined, {});
  const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_SINKS: "private" }), "sdk-native"))!;
  const evidence: ChangeEvidence = {
    manifest: { schema: 1, base: "0".repeat(40), head: "1".repeat(40), range: "fixture", files: [], errors: [], truncated: false },
    async retrieve() { throw new Error("unused fixture evidence"); }, async auditPatch() { throw new Error("unused fixture evidence"); },
  };
  process.env.LEVERET_PI_AGENT_DIR = agentDir;
  tools = await buildPiTools({ repo: runtimeDir, base: "HEAD", graphLive: false, sandboxed: true,
    profilePath: join(data, "profile.yml"), rulesRoot: data, memoryRepo: data, evidence });
    const runDir = await withSecretPolicy(policy, () => withAuditTrace(audit, async () => {
      const result = await runPhase({
        phase: "review", prompt: "fixture", repo: runtimeDir, runtimeDir,
        runtime: { model: "fixture", provider: "fixture", thinking: "off", deadlineMs: 30_000, discoveryMode: "single",
          discoveryScheduler: { id: "serial/v1", concurrency_bound: 1 } },
        modelRuntime: runtime, model, systemPrompt: "fixture", tools: tools!.tools,
        submission: { parameters: Type.Object({ concerns: Type.Array(Type.Unknown()) }), parse: (value) => value },
        metrics: [], toolOutcomes: new Map(), audit,
      });
      expect(result).toEqual({ concerns: [] });
      await refreshSecretPolicy(policy);
      return (await audit.finalize("complete")).runDir!;
    }));
    const allBytes = async (dir: string): Promise<string> => {
      const chunks: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) chunks.push(entry.isDirectory()
        ? await allBytes(join(dir, entry.name)) : await readFile(join(dir, entry.name), "utf8"));
      return chunks.join("\n");
    };
    expect(await allBytes(runDir)).not.toContain(marker);
    expect(await allBytes(runDir)).toContain("[REDACTED]");
    expect(requests).toHaveLength(3);
    const second = JSON.parse(requests[1]!);
    const probeReply = second.messages.find((message: { role: string }) => message.role === "tool");
    expect(probeReply.content).not.toContain(marker);
    expect(probeReply.content).toContain("[REDACTED]");
    const native = await readFile(join(runDir, "sessions", "review-attempt-1.jsonl"), "utf8");
    expect(native).not.toContain(marker);
    expect(native).toContain("probe-rotated");
  } finally {
    if (oldAgent === undefined) delete process.env.LEVERET_PI_AGENT_DIR;
    else process.env.LEVERET_PI_AGENT_DIR = oldAgent;
    await tools?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 60_000);

it("screens a credential split across real worker stdout chunks before any raw chunk audit", async () => {
  const data = await root();
  const credential = "worker-split-opaque-credential-b45e";
  const keyPath = join(data, "credential.fixture");
  const worker = join(data, "split-worker.mjs");
  await writeFile(keyPath, credential);
  // Real OS pipe/timed writes: fake timers cannot drive another Node process's pipe delivery.
  await writeFile(worker, [
    "import {readFileSync,writeSync} from 'node:fs';",
    "const value=readFileSync(process.argv[2],'utf8');const half=Math.floor(value.length/2);",
    "writeSync(2,'READY\\n');writeSync(1,value.slice(0,half));",
    "setTimeout(()=>{writeSync(1,value.slice(half));},200);",
  ].join("\n"));
  const policy = { id: "split-worker-policy", available: true, knownValues: new Set([credential]),
    refreshKnownValues: async () => [credential], additionalRules: [], nonSecretValues: new Set<string>() };
  const audit = (await createAuditRun(auditConfig(data, { LEVERET_TRACE_SINKS: "private" }), "split-worker"))!;
  const callbacks: string[] = [];
  const pending: Promise<void>[] = [];
  const runDir = await withSecretPolicy(policy, () => withAuditTrace(audit, async () => {
    const result = await runStreaming(process.execPath, [worker, keyPath], data, {
      timeoutMs: 5000,
      onStdout(chunk) {
        const text = chunk.toString("utf8");
        callbacks.push(text);
        pending.push(audit.record("subprocess", "stdout_chunk", { text }));
      },
    });
    expect(result.code).toBe(0);
    await Promise.all(pending);
    return (await audit.finalize("complete")).runDir!;
  }));
  const events = (await readFile(join(runDir, "app.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const reconstructed = events.filter((event) => event.event === "stdout_chunk").map((event) => event.payload.text).join("");
  expect(reconstructed).not.toContain(credential);
  expect(callbacks.join("")).not.toContain(credential);
  expect(callbacks.join("")).toContain("[REDACTED]");
  const completed = events.find((event) => event.event === "completed");
  expect(completed.payload.stdout).toBe("[REDACTED]");
  expect(JSON.stringify(completed.payload.argv)).not.toContain(credential);
});

describe("canonical sanitizer preserves clean operational strings byte for byte", () => {
  const layouts = [
    '{"n":12345678901234567890,"p":10.50,"d":1,"d":2}\n',
    '{\n   "spaced" : [ 1,  2 ]\n}\n\n',
    "[1e3, 0.10, -0]",
  ];
  for (const clean of layouts) {
    it(`keeps ${JSON.stringify(clean.slice(0, 24))} unchanged in process results and text packets`, () => {
      const redacted = new Set<string>();
      expect(sanitizeAuditValue({ code: 0, stdout: clean, stderr: clean }, redacted)).toEqual({ code: 0, stdout: clean, stderr: clean });
      expect(sanitizeAuditValue({ type: "text", text: clean }, redacted)).toEqual({ type: "text", text: clean });
      expect(redacted.size).toBe(0);
    });
  }

  it("still decodes, redacts and keeps valid JSON when a known value occurs, including in a collapsed duplicate key", async () => {
    const known = "dup-key-opaque-credential";
    const policy = { id: "sanitize-exact", available: true, knownValues: new Set([known]), refreshKnownValues: async () => [known],
      additionalRules: [], nonSecretValues: new Set<string>() };
    await withSecretPolicy(policy, async () => {
      for (const stdout of [`{"a":"${known}","b":10.5}\n`, `{"a":"${known}","a":"clean"}\n`]) {
        const result = sanitizeAuditValue({ code: 0, stdout, stderr: "" });
        expect(result.stdout).not.toContain(known);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
    });
  });
});
