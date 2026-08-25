import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, runStreaming } from "../src/exec.js";
import { prefetchSerena } from "../src/runner/prefetch-serena.js";
import { buildPiSystemPrompt } from "../src/runner/pi-system.js";
import {
  buildPiResourceLoader,
  classifyAuth,
  createPiRuntimeDirectory,
  parseAssistantJson,
  parseDuration,
  piRuntimeConfig,
  toolMetricsSummary,
  withDeadline,
} from "../src/runner/pi.js";
import { mergeVerificationCoverage, verifySchemaGaps } from "../src/runner/verify-output.js";
import {
  buildSerenaArgs,
  createSerenaRuntimeHome,
  createSerenaShadowProject,
  prepareSerenaProject,
  prefetchEnvironment,
  safeToolEnvironment,
  serenaBundleProblem,
  serenaPrefetchFixtures,
} from "../src/runner/serena.js";
import { buildPiTools } from "../src/runner/pi-tools.js";

const toolOptions = (repo: string, sandboxed = false) => ({
  repo,
  base: "HEAD",
  profilePath: `${repo}/.trusted-profile.yml`,
  rulesRoot: repo,
  memoryRepo: repo,
  graphLive: false,
  sandboxed,
});
function toolPayload(result: { content: readonly { type: string; text?: string }[] }): Record<string, unknown> {
  const content = result.content.find((item) => item.type === "text" && item.text?.startsWith("{"));
  if (!content?.text) throw new Error("tool returned no JSON payload");
  return JSON.parse(content.text) as Record<string, unknown>;
}


describe("Pi runtime isolation", () => {
  it("ships Pi as the sole standard runner", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.bin).toMatchObject({
      "leveret-audit": "dist/audit-inspect.js",
      "leveret-runner-pi": "dist/runner/pi.js",
      "leveret-prefetch-serena": "dist/runner/prefetch-serena.js",
    });
    expect(manifest.bin).not.toHaveProperty("leveret-runner-omp");
    expect(manifest.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
  });

  it("uses a fully explicit in-memory configuration", () => {
    const cfg = piRuntimeConfig(
      { model: "gpt-5.6-sol", provider: "openai", effort: "high", maxTime: "20m" },
      {},
    );
    expect(cfg).toMatchObject({
      model: "gpt-5.6-sol",
      provider: "openai",
      thinking: "high",
      deadlineMs: 20 * 60_000,
    });
  });

  it("does not expose project resources or append prompts", async () => {
    const loader = buildPiResourceLoader("trusted prompt");
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe("trusted prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
  });

  it("registers no mutation or unrestricted shell tools", async () => {
    const tools = await buildPiTools(toolOptions("/tmp/repo"));
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("leveret_scan");
    expect(names).toContain("leveret_diff");
    expect(names).toContain("leveret_ast_search");
    expect(names).toContain("leveret_read");
    expect(names).not.toContain("read");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("find");
    expect(names).not.toContain("ls");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
    expect(names).not.toContain("leveret_probe");
    expect(names).not.toContain("leveret_remember");
    expect(names).not.toContain("leveret_learn");
    expect(tools.capabilities.tool_schema_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tools.capabilities.tool_source_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tools.capabilities.tool_inventory).toEqual([...names].sort());
    await tools.close();
  });

  it("jails direct reads and symlinks to the reviewed checkout", async () => {
    const { mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "leveret-jailed-read-"));
    writeFileSync(join(repo, "inside.txt"), "safe\n");
    symlinkSync("/etc/hosts", join(repo, "escape.txt"));
    const bundle = await buildPiTools(toolOptions(repo));
    const read = bundle.tools.find((tool) => tool.name === "leveret_read")!;
    const scan = bundle.tools.find((tool) => tool.name === "leveret_scan")!;
    try {
      await expect(read.execute("r1", { path: "/etc/hosts" }, undefined, undefined, {} as never)).rejects.toThrow(/relative/);
      await expect(read.execute("r2", { path: "escape.txt" }, undefined, undefined, {} as never)).rejects.toThrow(/escapes/);
      await expect(scan.execute("s1", { files: ["/etc/hosts"] }, undefined, undefined, {} as never)).rejects.toThrow(/relative/);
      await expect(scan.execute("s2", { engines: ["checkout-engine"] }, undefined, undefined, {} as never)).rejects.toThrow(/built-in/);
      const result = await read.execute("r3", { path: "inside.txt" }, undefined, undefined, {} as never);
      expect(result.content[1]).toMatchObject({ type: "text", text: "1: safe\n2: " });
    } finally {
      await bundle.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("only exposes probes when the caller proves sandboxing", async () => {
    const tools = await buildPiTools(toolOptions("/tmp/repo", true));
    expect(tools.tools.map((tool) => tool.name)).toContain("leveret_probe");
    await tools.close();
  });
  it("returns nonzero probe exits as structured evidence without credentials", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-probe-"));
    const priorSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-leak";
    const bundle = await buildPiTools(toolOptions(repo, true));
    const probe = bundle.tools.find((tool) => tool.name === "leveret_probe")!;
    try {
      const result = await probe.execute("p1", {
        command: "node",
        args: ["-e", "console.log(process.env.OPENAI_API_KEY ?? 'safe'); console.error('expected failure'); process.exit(1)"],
      }, undefined, undefined, {} as never);
      expect(result.content[0]).toMatchObject({ type: "text", text: "evidence_id: p1" });
      expect(toolPayload(result)).toMatchObject({
        outcome: "exited",
        code: 1,
        signal: null,
        stdout: "safe\n",
        stderr: "expected failure\n",
        timed_out: false,
        truncated: { stdout: false, stderr: false },
      });
    } finally {
      if (priorSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorSecret;
      await bundle.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("records probe timeout and signal metadata instead of output words", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-probe-outcome-"));
    const outcomes = new Map<string, boolean>();
    const bundle = await buildPiTools({
      ...toolOptions(repo, true),
      onToolOutcome: (id, outcome) => outcomes.set(id, outcome.timedOut),
    });
    const probe = bundle.tools.find((tool) => tool.name === "leveret_probe")!;
    try {
      const words = await probe.execute("words", {
        command: "node",
        args: ["-e", "console.log('timeout deadline aborted')"],
      }, undefined, undefined, {} as never);
      expect(toolPayload(words)).toMatchObject({ outcome: "exited", timed_out: false });
      expect(outcomes.get("words")).toBe(false);

      const timeout = await probe.execute("timeout", {
        command: "node",
        args: ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
        timeout_ms: 50,
      }, undefined, undefined, {} as never);
      expect(toolPayload(timeout)).toMatchObject({ outcome: "timed-out", timed_out: true });
      expect(outcomes.get("timeout")).toBe(true);

      const signaled = await probe.execute("signal", {
        command: "node",
        args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      }, undefined, undefined, {} as never);
      expect(toolPayload(signaled)).toMatchObject({ outcome: "signaled", signal: "SIGTERM", timed_out: false });
    } finally {
      await bundle.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("distinguishes probe truncation, spawn failure, and jail rejection", async () => {
    const repo = mkdtempSync(join(tmpdir(), "leveret-probe-failure-"));
    const bundle = await buildPiTools(toolOptions(repo, true));
    const probe = bundle.tools.find((tool) => tool.name === "leveret_probe")!;
    try {
      const stdout = await probe.execute("stdout-cap", {
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(131072))"],
      }, undefined, undefined, {} as never);
      expect(toolPayload(stdout)).toMatchObject({ timed_out: false, truncated: { stdout: true, stderr: false } });

      const stderr = await probe.execute("stderr-cap", {
        command: "node",
        args: ["-e", "process.stderr.write('x'.repeat(131072))"],
      }, undefined, undefined, {} as never);
      expect(toolPayload(stderr)).toMatchObject({ timed_out: false, truncated: { stdout: false, stderr: true } });

      await expect(probe.execute("spawn", { command: "leveret-command-that-does-not-exist" }, undefined, undefined, {} as never)).rejects.toThrow(/spawn failed/);
      await expect(probe.execute("jail", { command: "node", cwd: ".." }, undefined, undefined, {} as never)).rejects.toThrow(/inside/);
    } finally {
      await bundle.close();
      rmSync(repo, { recursive: true, force: true });
    }
  });


  it("pins the required provider and model catalog without a network refresh", async () => {
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, modelsPath: null });
    for (const provider of ["anthropic", "openai", "openai-codex", "github-copilot"]) {
      expect(runtime.getProvider(provider), provider).toBeDefined();
    }
    expect(runtime.getModel("openai", "gpt-5.6-sol")).toBeDefined();
    expect(runtime.getModel("openai-codex", "gpt-5.6-sol")).toBeDefined();
  });

  it("loads a local OpenAI-compatible model with only a non-secret placeholder", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-local-model-"));
    const modelsPath = join(root, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [{ id: "qwen-test" }],
        },
      },
    }));
    try {
      const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, modelsPath });
      expect(runtime.getModel("local", "qwen-test")).toMatchObject({ provider: "local", id: "qwen-test" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds routing guidance from exactly the active tools", () => {
    const prompt = buildPiSystemPrompt(["leveret_scan", "codegraph_explore"]);
    expect(prompt).toContain("leveret_scan");
    expect(prompt).toContain("codegraph_explore");
    expect(prompt).not.toContain("lsp_references");
    expect(prompt).toMatch(/read-only/i);
  });

  it("does not discover hostile checkout prompts, extensions, MCP, or executables", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "leveret-hostile-pi-"));
    const runtimeDir = await createPiRuntimeDirectory();
    mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(repo, ".pi", "SYSTEM.md"), "HOSTILE_SYSTEM_PROMPT\n");
    writeFileSync(join(repo, ".pi", "settings.json"), '{"defaultProjectTrust":"always"}\n');
    writeFileSync(join(repo, ".pi", "extensions", "hostile.ts"), "throw new Error('HOSTILE_EXTENSION')\n");
    writeFileSync(join(repo, "AGENTS.md"), "HOSTILE_CONTEXT\n");
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{"hostile":{"command":"false"}}}\n');
    writeFileSync(join(repo, "node_modules", ".bin", "intelephense"), "HOSTILE_EXECUTABLE\n");
    const bundle = await buildPiTools(toolOptions(repo));
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, modelsPath: null });
    const model = runtime.getModel("openai", "gpt-5.6-sol")!;
    const prompt = buildPiSystemPrompt(bundle.tools.map((tool) => tool.name));
    const session = await createAgentSession({
      cwd: runtimeDir,
      modelRuntime: runtime,
      model,
      customTools: bundle.tools,
      tools: bundle.tools.map((tool) => tool.name),
      resourceLoader: buildPiResourceLoader(prompt),
      sessionManager: SessionManager.inMemory(runtimeDir),
      settingsManager: SettingsManager.inMemory({ defaultProjectTrust: "never" }, { projectTrusted: false }),
    });
    try {
      expect(session.session.systemPrompt).toBe(`${prompt}\nCurrent working directory: ${runtimeDir}\n`);
      expect(session.session.systemPrompt).not.toMatch(/HOSTILE_/);
      expect(session.session.getActiveToolNames().sort()).toEqual(bundle.tools.map((tool) => tool.name).sort());
    } finally {
      session.session.dispose();
      await bundle.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("keeps provider and GitHub credentials out of child tools", async () => {
    const old = {
      sanitize: process.env.LEVERET_SANITIZE_CHILD_ENV,
      openai: process.env.OPENAI_API_KEY,
      github: process.env.GITHUB_TOKEN,
    };
    process.env.LEVERET_SANITIZE_CHILD_ENV = "1";
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.GITHUB_TOKEN = "must-not-leak";
    try {
      const result = await run("/usr/bin/env", [], "/tmp");
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("OPENAI_API_KEY");
      expect(result.stdout).not.toContain("GITHUB_TOKEN");
    } finally {
      if (old.sanitize === undefined) delete process.env.LEVERET_SANITIZE_CHILD_ENV;
      else process.env.LEVERET_SANITIZE_CHILD_ENV = old.sanitize;
      if (old.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = old.openai;
      if (old.github === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = old.github;
    }
  });
});

const lenses = [
  { lens: "correctness-hostile-inputs", outcome: "clean" },
  { lens: "contract-conformance", outcome: "clean" },
  { lens: "test-honesty", outcome: "clean" },
  { lens: "blast-radius", outcome: "clean" },
  { lens: "leads-triage", outcome: "clean" },
];

const expectations = {
  concerns: [{ id: "R1", file: "a.ts" }],
  remainingLeadIds: ["L1"],
  changedFiles: ["a.ts"],
  priorThreadIds: [] as string[],
};

const validVerification = () => ({
  report: [],
  verdicts: [
    { id: "R1", grade: "priced-noise", reason: "documented ceiling" },
    { id: "L1", grade: "false-positive", reason: "guarded" },
  ],
  coverage: { lenses, files: [{ file: "a.ts", verdict: "findings" }] },
});

describe("Pi result and metrics parsing", () => {
  it("parses runner durations", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("bogus")).toBeNull();
  });

  it("classifies live provider auth instead of the stale runtime snapshot", () => {
    expect(classifyAuth("oauth", true)).toBe("subscription-oauth");
    expect(classifyAuth("oauth", false)).toBe("oauth");
    expect(classifyAuth("api_key", false)).toBe("api-key-or-local");
  });

  it("validates nested verifier schema and exact accounting", () => {
    expect(verifySchemaGaps(validVerification(), expectations)).toEqual([]);
    expect(verifySchemaGaps({
      ...validVerification(),
      coverage: { lenses: ["correctness"], files: ["a.ts"] },
    }, expectations)).toEqual(expect.arrayContaining(["schema:coverage.lenses.0", "schema:coverage.files.0"]));
    expect(verifySchemaGaps({
      ...validVerification(),
      verdicts: [{ id: "R1", grade: "priced-noise", reason: "documented ceiling" }],
    }, expectations)).toContain("verdicts:missing:L1");
    expect(verifySchemaGaps({
      ...validVerification(),
      coverage: { lenses, files: [{ file: "a.ts", verdict: "considered-fine" }] },
    }, expectations)).toContain("coverage.files:downgraded:a.ts");
  });

  it("requires exact prior-thread resolutions", () => {
    const expected = { ...expectations, priorThreadIds: ["T1"] };
    expect(verifySchemaGaps(validVerification(), expected)).toContain("resolutions:missing:T1");
    expect(verifySchemaGaps({
      ...validVerification(),
      resolutions: [{ threadId: "T1", status: "resolved", note: "fixed" }],
    }, expected)).toEqual([]);
  });

  it("mechanically preserves concern coverage and exposes priced findings", () => {
    const review = {
      concerns: [{ id: "R1", file: "a.ts", lead_ids: [] }],
      coverage: { lenses, files: [{ file: "a.ts", verdict: "findings" }] },
    };
    expect(mergeVerificationCoverage(review, validVerification()).coverage.files).toEqual([
      { file: "a.ts", verdict: "findings-priced", note: "all review concerns were priced-noise" },
    ]);
    const refuted = {
      ...validVerification(),
      verdicts: [
        { id: "R1", grade: "false-positive", reason: "guarded" },
        { id: "L1", grade: "false-positive", reason: "guarded" },
      ],
    };
    expect(mergeVerificationCoverage(review, refuted).coverage.files[0].verdict).toBe("findings");
  });

  it("keeps mixed concerns as findings and permits verifier upgrades", () => {
    const review = {
      concerns: [
        { id: "R1", file: "a.ts", lead_ids: [] },
        { id: "R2", file: "a.ts", lead_ids: [] },
      ],
      coverage: { lenses, files: [
        { file: "a.ts", verdict: "findings" },
        { file: "b.ts", verdict: "considered-fine" },
      ] },
    };
    const verify = {
      report: [
        { id: "R1", file: "a.ts", line: 1, title: "bug", tier: "major", severity: "error", scope: "in-diff", evidence: "line 1", evidence_ids: [] },
        { id: "L1", file: "b.ts", line: 2, title: "new bug", tier: "minor", severity: "warning", scope: "in-diff", evidence: "line 2", evidence_ids: [] },
      ],
      verdicts: [
        { id: "R1", grade: "actionable" },
        { id: "R2", grade: "priced-noise", reason: "documented ceiling" },
        { id: "L1", grade: "actionable" },
      ],
      coverage: { lenses, files: [
        { file: "a.ts", verdict: "findings" },
        { file: "b.ts", verdict: "findings" },
      ] },
    };
    expect(mergeVerificationCoverage(review, verify).coverage.files.map(({ file, verdict }) => ({ file, verdict }))).toEqual([
      { file: "a.ts", verdict: "findings" },
      { file: "b.ts", verdict: "findings" },
    ]);
  });

  it("kills a wedged child at its deadline", async () => {
    const started = Date.now();
    const result = await run("sleep", ["30"], "/tmp", { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.code).not.toBe(0);
    expect(result.signal).toBeTruthy();
  });

  it("streams and marks a harness timeout from process metadata", async () => {
    const result = await runStreaming("sleep", ["30"], "/tmp", { timeoutMs: 100 });
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBeTruthy();
  });

  it("accepts fenced JSON and rejects prose", () => {
    expect(parseAssistantJson('```json\n{"concerns":[]}\n```')).toEqual({ concerns: [] });
    expect(() => parseAssistantJson("looks good")).toThrow(/JSON/i);
  });

  it("summarizes phase-attributed tool events", () => {
    const summary = toolMetricsSummary([
      { phase: "review", toolCallId: "1", toolName: "codegraph_explore", startedAt: 10, endedAt: 30, duration_ms: 20, isError: false, outcome: "success", input_bytes: 5, output_bytes: 8, output_tokens_estimate: 2, args_sha256: "a", server: "codegraph", cache: "unknown" },
      { phase: "review", toolCallId: "2", toolName: "codegraph_explore", startedAt: 40, endedAt: 55, duration_ms: 15, isError: true, outcome: "error", input_bytes: 5, output_bytes: 8, output_tokens_estimate: 2, args_sha256: "b", server: "codegraph", cache: "unknown" },
      { phase: "verify", toolCallId: "3", toolName: "lsp_references", startedAt: 60, endedAt: 70, duration_ms: 10, isError: false, outcome: "success", input_bytes: 5, output_bytes: 8, output_tokens_estimate: 2, args_sha256: "c", server: "serena", cache: "unknown" },
    ]);
    expect(summary).toEqual({
      review: { codegraph_explore: { calls: 2, errors: 1, duration_ms: 35 } },
      verify: { lsp_references: { calls: 1, errors: 0, duration_ms: 10 } },
    });
  });

  it("reports the deadline even when the abort hook wedges", async () => {
    const started = Date.now();
    await expect(
      withDeadline(new Promise<never>(() => {}), 40, () => new Promise<void>(() => {})),
    ).rejects.toThrow(/exceeded/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("Serena headless and offline staging", () => {
  it("disables dashboard, tray, GUI, and usage reporting", () => {
    expect(buildSerenaArgs("/repo")).toEqual([
      "start-mcp-server",
      "--project",
      "/repo",
      "--transport",
      "stdio",
      "--enable-web-dashboard",
      "false",
      "--enable-gui-log-window",
      "false",
      "--open-web-dashboard",
      "false",
    ]);
    const env = safeToolEnvironment("/tmp/leveret-review/serena-home", {
      PATH: "/usr/bin",
      HOME: "/home/test",
      OPENAI_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/test",
      SERENA_HOME: "/tmp/leveret-review/serena-home",
      SERENA_USAGE_REPORTING: "false",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.UV_OFFLINE).toBe("1");

    const prefetch = prefetchEnvironment("/opt/leveret/serena-bundle", {
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.test",
      OPENAI_API_KEY: "secret",
    });
    expect(prefetch.SERENA_HOME).toBe("/opt/leveret/serena-bundle");
    expect(prefetch.HTTPS_PROXY).toBe("http://proxy.test");
    expect(prefetch.UV_OFFLINE).toBeUndefined();
    expect(prefetch.npm_config_offline).toBeUndefined();
    expect(prefetch.OPENAI_API_KEY).toBeUndefined();
  });

  it("defines a small explicit fixture set for build-time prefetch", () => {
    const fixtures = serenaPrefetchFixtures();
    expect(fixtures.map((f) => f.language)).toEqual([
      "typescript",
      "php",
      "bash",
      "yaml",
      "json",
    ]);
    for (const fixture of fixtures) {
      expect(fixture.files.length).toBeGreaterThan(0);
    }
  });

  it("refuses dynamic downloads without treating checkout .serena as runtime configuration", async () => {
    const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "leveret-hostile-serena-"));
    expect(serenaBundleProblem(repo, {})).toMatch(/LEVERET_SERENA_BUNDLE/);
    expect(serenaBundleProblem(repo, { SERENA_HOME: "/ignored" })).toMatch(/LEVERET_SERENA_BUNDLE/);
    expect(serenaBundleProblem(repo, { LEVERET_SERENA_BUNDLE: "/missing" })).toMatch(/manifest/);
    mkdirSync(join(repo, ".serena"));
    writeFileSync(join(repo, ".serena", "project.yml"), "activation_command: hostile\n");
    const shadow = await createSerenaShadowProject(repo);
    try {
      expect(existsSync(join(shadow, ".serena"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(shadow, { recursive: true, force: true });
    }
  });

  it("requires the canonical Serena bundle outside the reviewed checkout", async () => {
    const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-serena-bundle-"));
    const repo = join(root, "repo");
    const external = join(root, "external");
    const inside = join(repo, "bundle");
    const makeBundle = (path: string) => {
      mkdirSync(join(path, "language_servers", "static"), { recursive: true });
      writeFileSync(join(path, "leveret-lsp-manifest.json"), "{}\n");
    };
    mkdirSync(repo);
    makeBundle(external);
    makeBundle(inside);
    symlinkSync(inside, join(root, "bundle-link"), "dir");
    try {
      expect(serenaBundleProblem(repo, { LEVERET_SERENA_BUNDLE: external })).toBeNull();
      expect(serenaBundleProblem(repo, { LEVERET_SERENA_BUNDLE: inside })).toMatch(/reviewed checkout/);
      expect(serenaBundleProblem(repo, { LEVERET_SERENA_BUNDLE: join(root, "bundle-link") })).toMatch(/reviewed checkout/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates read-only Serena config only for staged languages present in the checkout", async () => {
    const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-serena-project-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    mkdirSync(join(repo, "node_modules"));
    const phpLsp = join(home, "intelephense");
    writeFileSync(phpLsp, "fixture\n");
    writeFileSync(join(home, "leveret-lsp-manifest.json"), `${JSON.stringify({ languages: ["php", "typescript"], ls_paths: { php: phpLsp, typescript: join(home, "typescript-language-server") } })}\n`);
    writeFileSync(join(repo, "composer.json"), "{}\n");
    writeFileSync(join(repo, "plugin.inc"), "<?php function plugin() {}\n");
    writeFileSync(join(repo, "lib.rs"), "pub fn value() {}\n");
    writeFileSync(join(repo, "node_modules", "ignored.py"), "value = 1\n");
    try {
      const shadow = await createSerenaShadowProject(repo);
      expect(await prepareSerenaProject(repo, shadow, home)).toEqual(["php"]);
      expect(lstatSync(join(shadow, "plugin.inc")).isSymbolicLink()).toBe(true);
      expect(existsSync(join(repo, ".serena"))).toBe(false);
      const config = readFileSync(join(shadow, ".serena", "project.yml"), "utf8");
      expect(config).toContain("read_only: true");
      expect(config).toContain('file_filter:');
      expect(config).toContain('  - .inc');
      expect(config).toContain(`ls_path: ${phpLsp}`);
      rmSync(shadow, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages fixtures into a fixed Serena bundle without retaining project registrations", async () => {
    const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-prefetch-test-"));
    const bundle = join(root, "serena-bundle");
    const fake = join(root, "serena-fake");
    writeFileSync(fake, '#!/bin/sh\nmkdir -p "$SERENA_HOME/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin"\n: > "$SERENA_HOME/language_servers/static/TypeScriptLanguageServer/ts-lsp/node_modules/.bin/typescript-language-server"\n');
    chmodSync(fake, 0o755);
    try {
      await prefetchSerena({ bundle, languages: ["typescript"], serenaBin: fake });
      const manifest = JSON.parse(readFileSync(join(bundle, "leveret-lsp-manifest.json"), "utf8"));
      expect(manifest.languages).toEqual(["typescript"]);
      expect(manifest.ls_paths.typescript).toContain("TypeScriptLanguageServer");
      const config = readFileSync(join(bundle, "serena_config.yml"), "utf8");
      expect(config).toContain("web_dashboard: false");
      expect(config).toMatch(/projects:\s*\[\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps mutable Serena runtime state outside the staged bundle", async () => {
    const { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leveret-serena-review-"));
    const bundle = join(root, "bundle");
    const reviewRuntime = join(root, "runtime");
    mkdirSync(join(bundle, "language_servers"), { recursive: true });
    mkdirSync(reviewRuntime);
    writeFileSync(join(bundle, "serena_config.yml"), "projects:\n  - /stale/project\nls_specific_settings:\n  php:\n    ls_path: /opt/php-lsp\n");
    const runtime = await createSerenaRuntimeHome(bundle, reviewRuntime);
    try {
      expect(runtime).toBe(join(reviewRuntime, "serena-home"));
      expect(lstatSync(join(runtime, "language_servers")).isSymbolicLink()).toBe(true);
      const config = readFileSync(join(runtime, "serena_config.yml"), "utf8");
      expect(config).toMatch(/projects:\s*\[\]/);
      expect(config).toContain("ls_path: /opt/php-lsp");
      expect(readFileSync(join(bundle, "serena_config.yml"), "utf8")).toContain("/stale/project");
      expect(safeToolEnvironment(runtime, { SERENA_HOME: "/ignored" }).SERENA_HOME).toBe(runtime);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
