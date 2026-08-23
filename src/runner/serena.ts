import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { parse, stringify } from "yaml";
import { safeChildEnvironment } from "../exec.js";

export interface SerenaFixture {
  language: string;
  files: Array<{ path: string; content: string }>;
}

const FIXTURES: SerenaFixture[] = [
  { language: "typescript", files: [{ path: "package.json", content: '{"name":"fixture"}\n' }, { path: "index.ts", content: "export const value = 1;\n" }] },
  { language: "php", files: [{ path: "composer.json", content: '{"name":"leveret/fixture"}\n' }, { path: "index.php", content: "<?php function value(): int { return 1; }\n" }] },
  { language: "bash", files: [{ path: "main.sh", content: "#!/bin/sh\nvalue=1\n" }] },
  { language: "yaml", files: [{ path: "config.yml", content: "value: 1\n" }] },
  { language: "json", files: [{ path: "config.json", content: '{"value":1}\n' }] },
];

const PACKAGED_SERVERS: Record<string, { directory: string; executable: string }> = {
  typescript: { directory: "TypeScriptLanguageServer", executable: "typescript-language-server" },
  php: { directory: "Intelephense", executable: "intelephense" },
  bash: { directory: "BashLanguageServer", executable: "bash-language-server" },
  yaml: { directory: "YamlLanguageServer", executable: "yaml-language-server" },
  json: { directory: "JsonLanguageServer", executable: "vscode-json-languageserver" },
};

export async function packagedLanguageServer(home: string, language: string): Promise<string | null> {
  const expected = PACKAGED_SERVERS[language];
  if (!expected) return null;
  const stack = [join(home, "language_servers", "static", expected.directory)];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === expected.executable || entry.name === `${expected.executable}.cmd`) return path;
    }
  }
  return null;
}

export function serenaPrefetchFixtures(): SerenaFixture[] {
  return FIXTURES.map((fixture) => ({ ...fixture, files: fixture.files.map((file) => ({ ...file })) }));
}

export function buildSerenaArgs(repo: string): string[] {
  return [
    "start-mcp-server",
    "--project",
    repo,
    "--transport",
    "stdio",
    "--enable-web-dashboard",
    "false",
    "--enable-gui-log-window",
    "false",
    "--open-web-dashboard",
    "false",
  ];
}

export function safeToolEnvironment(runtimeHome: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries({
    ...safeChildEnvironment(source),
    SERENA_HOME: runtimeHome,
    SERENA_USAGE_REPORTING: "false",
    UV_OFFLINE: "1",
    PIP_NO_INDEX: "1",
    npm_config_offline: "true",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function prefetchEnvironment(bundle: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries({
      ...safeChildEnvironment(source),
      SERENA_HOME: bundle,
      SERENA_USAGE_REPORTING: "false",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "UV_INDEX_URL", "PIP_INDEX_URL", "npm_config_registry"]) {
    if (source[key] !== undefined) env[key] = source[key]!;
  }
  return env;
}

export function serenaBundleProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const bundle = env.LEVERET_SERENA_BUNDLE;
  if (!bundle) return "LEVERET_SERENA_BUNDLE is unset; no packaged LSP bundle is available";
  if (!existsSync(join(bundle, "leveret-lsp-manifest.json"))) {
    return `no staged Leveret LSP manifest in ${bundle}`;
  }
  if (!existsSync(join(bundle, "language_servers", "static"))) {
    return `no staged Serena language_servers/static directory in ${bundle}`;
  }
  return null;
}

const LANGUAGE_EXTENSIONS: Record<string, Set<string>> = {
  typescript: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  python: new Set([".py", ".pyi"]),
  php: new Set([".php", ".phtml"]),
  bash: new Set([".sh", ".bash"]),
  yaml: new Set([".yaml", ".yml"]),
  json: new Set([".json", ".jsonc"]),
  cpp: new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".m", ".mm"]),
  go: new Set([".go"]),
  rust: new Set([".rs"]),
  java: new Set([".java"]),
};

const SKIP_DIRS = new Set([".git", ".serena", "node_modules", "vendor", "dist", "build", "target", ".venv"]);

async function sourceExtensions(repo: string): Promise<Set<string>> {
  const extensions = new Set<string>();
  const stack = [repo];
  let visited = 0;
  while (stack.length && visited < 20_000) {
    const dir = stack.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) extensions.add(extname(entry.name).toLowerCase());
    }
  }
  return extensions;
}

async function detectedLanguages(repo: string, staged: Set<string>): Promise<string[]> {
  const extensions = await sourceExtensions(repo);
  const found = new Set<string>();
  for (const language of staged) {
    if ([...LANGUAGE_EXTENSIONS[language] ?? []].some((extension) => extensions.has(extension))) found.add(language);
  }
  if (staged.has("php") && existsSync(join(repo, "composer.json")) && extensions.has(".inc")) {
    // .inc is generic; only a PHP project opts it into Intelephense.
    found.add("php");
  }
  return [...found].sort((a, b) => serenaPrefetchFixtures().findIndex((f) => f.language === a) - serenaPrefetchFixtures().findIndex((f) => f.language === b));
}

export async function createSerenaShadowProject(repo: string): Promise<string> {
  const shadow = await mkdtemp(join(tmpdir(), "leveret-serena-project-"));
  try {
    const stack = [{ source: repo, target: shadow }];
    while (stack.length) {
      const { source, target } = stack.pop()!;
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          const targetDir = join(target, entry.name);
          await mkdir(targetDir);
          stack.push({ source: join(source, entry.name), target: targetDir });
        } else if (entry.isFile()) {
          await symlink(join(source, entry.name), join(target, entry.name));
        }
      }
    }
    return shadow;
  } catch (error) {
    await rm(shadow, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareSerenaProject(repo: string, projectRoot: string, home: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(home, "leveret-lsp-manifest.json"), "utf8")) as { languages?: unknown; ls_paths?: unknown };
  if (!Array.isArray(manifest.languages) || !manifest.languages.every((language) => typeof language === "string")) {
    throw new Error("invalid Leveret LSP manifest");
  }
  if (!manifest.ls_paths || typeof manifest.ls_paths !== "object") {
    throw new Error("Leveret LSP manifest has no packaged ls_paths");
  }
  const languages = await detectedLanguages(repo, new Set(manifest.languages));
  const lsSettings: Record<string, Record<string, unknown>> = {};
  for (const language of languages) {
    const path = (manifest.ls_paths as Record<string, unknown>)[language];
    if (typeof path !== "string" || !existsSync(path)) {
      throw new Error(`packaged ${language} LSP is missing: ${String(path)}`);
    }
    lsSettings[language] = {
      ls_path: path,
      ...(language === "php" ? { file_filter: [".inc"] } : {}),
    };
  }
  const projectDir = join(projectRoot, ".serena");
  await mkdir(projectDir);
  await writeFile(
    join(projectDir, "project.yml"),
    stringify({
      project_name: `leveret-${basename(repo)}`,
      language_servers: languages,
      encoding: "utf-8",
      ignored_paths: [".git/**", "node_modules/**", "vendor/**", "dist/**", "build/**", "target/**", ".venv/**"],
      read_only: true,
      ls_specific_settings: lsSettings,
    }),
  );
  return languages;
}

export async function createSerenaRuntimeHome(bundle: string, runtimeRoot: string): Promise<string> {
  const runtimeHome = join(runtimeRoot, "serena-home");
  await mkdir(runtimeHome);
  const stagedConfigPath = join(bundle, "serena_config.yml");
  const stagedConfig = existsSync(stagedConfigPath)
    ? (parse(await readFile(stagedConfigPath, "utf8")) as Record<string, unknown>)
    : {};
  await symlink(join(bundle, "language_servers"), join(runtimeHome, "language_servers"), "dir");
  await writeFile(
    join(runtimeHome, "serena_config.yml"),
    stringify({
      ...stagedConfig,
      language_backend: "LSP",
      web_dashboard: false,
      web_dashboard_open_on_launch: false,
      web_dashboard_interface: "browser",
      gui_log_window: false,
      token_count_estimator: "CHAR_COUNT",
      trusted_project_path_patterns: ["**"],
      projects: [],
    }),
  );
  return runtimeHome;
}

const READ_ONLY_TOOLS = new Set([
  "find_declaration",
  "find_implementations",
  "find_referencing_symbols",
  "find_symbol",
  "get_diagnostics_for_file",
  "get_symbols_overview",
]);

function textContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((item) => {
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
      return JSON.stringify(item);
    })
    .join("\n");
}

export interface SerenaBridge {
  tools: ToolDefinition[];
  close(): Promise<void>;
  version?: string;
  pid?: number;
}

export async function connectSerena(repo: string, runtimeRoot: string, command = "serena", timeoutMs = 120_000): Promise<SerenaBridge> {
  const bundleProblem = serenaBundleProblem();
  if (bundleProblem) throw new Error(bundleProblem);
  const bundle = process.env.LEVERET_SERENA_BUNDLE!;
  const shadow = await createSerenaShadowProject(repo);
  let runtimeHome: string | undefined;
  let transport: StdioClientTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const languages = await prepareSerenaProject(repo, shadow, bundle);
    if (languages.length === 0) {
      return {
        tools: [],
        close: async () => {
          await rm(shadow, { recursive: true, force: true });
        },
      };
    }
    runtimeHome = await createSerenaRuntimeHome(bundle, runtimeRoot);
    transport = new StdioClientTransport({
      command,
      args: buildSerenaArgs(shadow),
      cwd: shadow,
      env: safeToolEnvironment(runtimeHome),
      stderr: "pipe",
      maxBufferSize: 16 * 1024 * 1024,
    });
    const client = new Client({ name: "leveret-runner-pi", version: "0.1.0" });
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Serena startup exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const listed = await client.listTools();
    const tools: ToolDefinition[] = listed.tools
      .filter((tool) => READ_ONLY_TOOLS.has(tool.name))
      .map((tool) => ({
        name: `lsp_${tool.name}`,
        label: `LSP ${tool.name}`,
        description: tool.description ?? `Serena ${tool.name}`,
        parameters: tool.inputSchema as TSchema,
        async execute(_toolCallId, params, signal) {
          const result = await client.callTool(
            { name: tool.name, arguments: params as Record<string, unknown> },
            undefined,
            { signal, timeout: 60_000, maxTotalTimeout: 60_000 },
          );
          const output = textContent(result).replaceAll(shadow, repo);
          if (result.isError === true) throw new Error(`Serena ${tool.name}: ${output.slice(0, 1000)}`);
          return {
            content: [{ type: "text" as const, text: output }],
            details: { server: "serena", tool: tool.name },
          };
        },
      }));
    return {
      tools,
      version: client.getServerVersion()?.version,
      pid: transport.pid ?? undefined,
      close: async () => {
        await client.close();
        await rm(shadow, { recursive: true, force: true });
        await rm(runtimeHome!, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await transport?.close().catch(() => {});
    await rm(shadow, { recursive: true, force: true });
    if (runtimeHome) await rm(runtimeHome, { recursive: true, force: true });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
