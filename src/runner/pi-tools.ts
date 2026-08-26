import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { readFile, readdir, realpath } from "node:fs/promises";
import type { ChangeEvidence } from "../change-evidence.js";
import { astSearch } from "../astsearch.js";
import { context } from "../context.js";
import { run, runStreaming, safeChildEnvironment } from "../exec.js";
import { memoryList } from "../memory.js";
import { scan } from "../scan.js";
import { ENGINES } from "../engines/registry.js";
import type { SerenaBridge } from "./serena.js";
import { z } from "zod";
import { pathIsInside } from "../path.js";

function json(value: unknown, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }], details };
}

function text(value: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: value }], details };
}
const PROBE_PRESENTATION_MAX_BYTES = 64 * 1024;
const PROBE_AUDIT_MAX_BYTES = 64 * 1024 * 1024;

function presentProbeOutput(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  return {
    text: bytes.subarray(0, PROBE_PRESENTATION_MAX_BYTES).toString("utf8"),
    truncated: bytes.length > PROBE_PRESENTATION_MAX_BYTES,
  };
}


async function codegraph(bin: string, repo: string, args: string[]) {
  const result = await run(bin, args, repo, {
    timeoutMs: 120_000,
    env: safeChildEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.code !== 0) throw new ToolExecutionError(`${bin} ${args[0]} rc=${result.code}: ${result.stderr.slice(0, 500)}`, result.timedOut);
  return text(result.stdout, { command: args[0] });
}

async function graphify(bin: string, repo: string, graphPath: string, args: string[]) {
  const result = await run(bin, [...args, "--graph", graphPath], repo, {
    timeoutMs: 120_000,
    env: safeChildEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.code !== 0) throw new ToolExecutionError(`${bin} ${args[0]} rc=${result.code}: ${result.stderr.slice(0, 500)}`, result.timedOut);
  const bytes = Buffer.from(result.stdout);
  const limit = 128 * 1024;
  return text(bytes.subarray(0, limit).toString("utf8"), {
    command: args[0],
    bytes: bytes.length,
    truncated: bytes.length > limit,
  });
}

async function jailedPath(root: string, requested = "."): Promise<string> {
  if (isAbsolute(requested)) throw new Error("tool paths must be relative to the reviewed checkout");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(resolve(root, requested));
  if (!pathIsInside(canonicalRoot, canonical)) throw new Error("tool path escapes the reviewed checkout");
  return canonical;
}

export interface PiToolOutcome {
  timedOut: boolean;
  nonzeroExit: boolean;
}

class ToolExecutionError extends Error {
  constructor(message: string, readonly timedOut = false) {
    super(message);
  }
}
export const PHASE_SUBMISSION_TOOL = "leveret_submit_phase";

export interface PhaseSubmission<T = unknown> {
  parameters: TSchema;
  parse(value: unknown): T;
}

export function zodPhaseSubmission<T>(schema: z.ZodType<T>): PhaseSubmission<T>;
export function zodPhaseSubmission<Input, Output>(
  schema: z.ZodType<Input>,
  parse: (value: unknown) => Output,
): PhaseSubmission<Output>;
export function zodPhaseSubmission(
  schema: z.ZodType,
  parse: (value: unknown) => unknown = (value) => schema.parse(value),
): PhaseSubmission {
  return {
    parameters: z.toJSONSchema(schema, { target: "draft-07", io: "input" }) as TSchema,
    parse,
  };
}

export function createPhaseSubmissionTool<T>(
  submission: PhaseSubmission<T>,
  accept: (value: T) => void,
): ToolDefinition {
  return defineTool({
    name: PHASE_SUBMISSION_TOOL,
    label: "Submit phase result",
    description: "Submit the completed phase result. This is the terminal output channel; call it once after all required evidence and accounting are complete.",
    parameters: submission.parameters,
    async execute(_id, params) {
      accept(submission.parse(params));
      return text("Phase result accepted.");
    },
  });
}

function annotateEvidence(tool: ToolDefinition, onOutcome?: (toolCallId: string, outcome: PiToolOutcome) => void): ToolDefinition {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, context) {
      try {
        const result = await execute(toolCallId, params as never, signal, onUpdate, context);
        const details = result.details as { timedOut?: unknown; nonzeroExit?: unknown } | undefined;
        const timedOut = details?.timedOut === true;
        onOutcome?.(toolCallId, { timedOut, nonzeroExit: details?.nonzeroExit === true });
        return {
          ...result,
          content: [{ type: "text" as const, text: `evidence_id: ${toolCallId}` }, ...result.content],
        };
      } catch (error) {
        onOutcome?.(toolCallId, { timedOut: error instanceof ToolExecutionError && error.timedOut, nonzeroExit: false });
        throw error;
      }
    },
  };
}

export interface PiToolsOptions {
  repo: string;
  graphLive: boolean;
  codegraphBin?: string;
  graphify?: { bin: string; graphPath: string; indexedNodes?: number; indexedEdges?: number };
  sandboxed: boolean;
  serena?: SerenaBridge;
  hostSkills?: Array<{ name: string; filePath: string; baseDir: string }>;
  profilePath: string;
  rulesRoot: string;
  memoryRepo: string;
  base: string;
  evidence: ChangeEvidence;
  serenaBundleSha256?: string;
  onToolOutcome?: (toolCallId: string, outcome: PiToolOutcome) => void;
}

export interface PiToolsBundle {
  tools: ToolDefinition[];
  close(): Promise<void>;
  capabilities: {
    graph: boolean;
    lsp: boolean;
    probe: boolean;
    graphify: boolean;
    serena_indexed_languages?: string[];
    serena_seed_files?: Record<string, string>;
    graphify_indexed_nodes?: number;
    graphify_indexed_edges?: number;
    serena_version?: string;
    serena_bundle_sha256?: string;
    tool_schema_sha256: string;
    tool_source_sha256: string;
    tool_inventory: string[];
  };
}

export async function buildPiTools(options: PiToolsOptions): Promise<PiToolsBundle> {
  const { repo } = options;
  const hostSkills = new Map((options.hostSkills ?? []).map((skill) => [skill.name, skill]));
  const tools: ToolDefinition[] = [
    ...(hostSkills.size > 0
      ? [defineTool({
          name: "leveret_skill",
          label: "Read host skill",
          description: "Load trusted host-installed skill instructions or one of their referenced files. Use this instead of a filesystem read for skills listed in the system prompt.",
          parameters: Type.Object({
            name: Type.String(),
            path: Type.Optional(Type.String()),
          }),
          async execute(_id, params) {
            const skill = hostSkills.get(params.name);
            if (!skill) throw new Error(`unknown host skill: ${params.name}`);
            const requested = params.path ?? relative(skill.baseDir, skill.filePath);
            if (isAbsolute(requested)) throw new Error("host skill paths must be relative");
            const baseDir = await realpath(skill.baseDir);
            const path = await realpath(resolve(baseDir, requested));
            if (!pathIsInside(baseDir, path)) throw new Error("host skill path escapes its skill directory");
            const raw = await readFile(path);
            if (raw.includes(0)) throw new Error("binary skill resources are not readable");
            const limit = 100_000;
            return text(raw.subarray(0, limit).toString("utf8"), {
              skill: params.name,
              path: relative(baseDir, path),
              bytes: raw.length,
              truncated: raw.length > limit,
            });
          },
        })]
      : []),
    defineTool({
      name: "leveret_read",
      label: "Read reviewed file",
      description: "Read a UTF-8 text file contained by the reviewed checkout. Absolute paths and escaping symlinks are rejected.",
      parameters: Type.Object({
        path: Type.String(),
        line_start: Type.Optional(Type.Number({ minimum: 1 })),
        line_end: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      async execute(_id, params) {
        const path = await jailedPath(repo, params.path);
        const raw = await readFile(path);
        if (raw.includes(0)) throw new Error("binary files are not readable through leveret_read");
        const lines = raw.toString("utf8").split("\n");
        const start = params.line_start ?? 1;
        const end = Math.min(params.line_end ?? start + 399, lines.length);
        if (end < start) throw new Error("line_end must be >= line_start");
        const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
        return text(body.slice(0, 100_000), { path: relative(repo, path), line_start: start, line_end: end });
      },
    }),
    defineTool({
      name: "leveret_grep",
      label: "Search reviewed text",
      description: "Regex-search files inside the reviewed checkout with ripgrep. Symlink escapes are rejected and symlinks are not followed.",
      parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const path = await jailedPath(repo, params.path ?? ".");
        const result = await run("rg", ["--line-number", "--no-heading", "--color", "never", "--max-count", "200", "--", params.pattern, path], repo, {
          timeoutMs: 30_000,
          env: safeChildEnvironment(),
          maxBuffer: 2 * 1024 * 1024,
        });
        if (result.code !== 0 && result.code !== 1) throw new ToolExecutionError(`rg rc=${result.code}: ${result.stderr.slice(0, 500)}`, result.timedOut);
        return text(result.stdout.replaceAll(`${repo}/`, ""), { matches: result.stdout ? result.stdout.split("\n").length - 1 : 0 });
      },
    }),
    defineTool({
      name: "leveret_find",
      label: "Find reviewed files",
      description: "List files matching a glob inside the reviewed checkout. Symlinks are not followed.",
      parameters: Type.Object({ glob: Type.String(), path: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const path = await jailedPath(repo, params.path ?? ".");
        const result = await run("rg", ["--files", "--glob", params.glob, "--", path], repo, {
          timeoutMs: 30_000,
          env: safeChildEnvironment(),
          maxBuffer: 2 * 1024 * 1024,
        });
        if (result.code !== 0 && result.code !== 1) throw new ToolExecutionError(`rg --files rc=${result.code}: ${result.stderr.slice(0, 500)}`, result.timedOut);
        return text(result.stdout.replaceAll(`${repo}/`, ""));
      },
    }),
    defineTool({
      name: "leveret_ls",
      label: "List reviewed directory",
      description: "List one directory contained by the reviewed checkout. Escaping symlinks are rejected.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const path = await jailedPath(repo, params.path ?? ".");
        const entries = await readdir(path, { withFileTypes: true });
        return text(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n"));
      },
    }),
    defineTool({
      name: "leveret_scan",
      label: "Leveret scan",
      description: "Run Leveret's deterministic engines. Results are review leads, not verdicts.",
      parameters: Type.Object({
        base: Type.Optional(Type.String()),
        files: Type.Optional(Type.Array(Type.String())),
        engines: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        const files = params.files
          ? await Promise.all(params.files.map(async (file) => relative(repo, await jailedPath(repo, file))))
          : undefined;
        const engineIds = new Set(ENGINES.map((engine) => engine.id));
        if (params.engines?.some((engine) => !engineIds.has(engine))) {
          throw new Error("leveret_scan accepts built-in engines only");
        }
        return json(await scan({
          repo,
          base: options.base,
          manifest: options.evidence.manifest,
          files,
          engines: params.engines,
          profilePath: options.profilePath,
          rulesRoot: options.rulesRoot,
          memoryRepo: options.memoryRepo,
          allowCustomEngines: false,
        }));
      },
    }),
    defineTool({
      name: "leveret_diff",
      label: "Scoped change evidence",
      description: "Return the compact pinned change manifest, or bounded patches for explicit manifest paths. Patch responses are paginated and never exceed the byte budget.",
      parameters: Type.Union([
        Type.Object({ kind: Type.Literal("manifest") }),
        Type.Object({
          kind: Type.Literal("patch"),
          paths: Type.Array(Type.String(), { minItems: 1 }),
          context: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
          hunk: Type.Optional(Type.Number({ minimum: 1 })),
          range: Type.Optional(Type.Object({
            start: Type.Number({ minimum: 1 }),
            end: Type.Number({ minimum: 1 }),
          })),
          byteBudget: Type.Optional(Type.Number({ minimum: 4, maximum: 256 * 1024 })),
          cursor: Type.Optional(Type.String()),
        }),
      ]),
      async execute(_id, params) {
        return json(await options.evidence.retrieve(params));
      },
    }),
    defineTool({
      name: "leveret_context",
      label: "Leveret context",
      description: "Return complexity, churn, and recency for prioritization; never treat it as a finding.",
      parameters: Type.Object({ files: Type.Array(Type.String()) }),
      async execute(_id, params) {
        const files = await Promise.all(params.files.map(async (file) => relative(repo, await jailedPath(repo, file))));
        return json(await context({ repo, files }));
      },
    }),
    defineTool({
      name: "leveret_ast_search",
      label: "Leveret AST search",
      description: "Find syntax-shaped occurrences with ast-grep. This does not establish dependency relationships.",
      parameters: Type.Object({
        pattern: Type.String(),
        lang: Type.String(),
        paths: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        const paths = params.paths
          ? await Promise.all(params.paths.map(async (path) => relative(repo, await jailedPath(repo, path))))
          : undefined;
        return json(await astSearch({ repo, pattern: params.pattern, lang: params.lang, paths }));
      },
    }),
    defineTool({
      name: "leveret_memory",
      label: "Leveret memory",
      description: "List the reviewed repository's stored finding verdicts and human-taught conventions.",
      parameters: Type.Object({}),
      async execute() {
        return json(await memoryList({ repo: options.memoryRepo }));
      },
    }),
  ];

  if (options.graphLive) {
    tools.push(
      defineTool({
        name: "codegraph_explore",
        label: "CodeGraph explore",
        description: "Return relevant symbols, source, and call paths for an architectural question.",
        parameters: Type.Object({ query: Type.String(), max_files: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })) }),
        async execute(_id, params) {
          return codegraph(options.codegraphBin ?? "codegraph", repo, ["explore", "--path", repo, ...(params.max_files ? ["--max-files", String(params.max_files)] : []), params.query]);
        },
      }),
      defineTool({
        name: "codegraph_node",
        label: "CodeGraph node",
        description: "Return one symbol or file with its caller/callee or dependent trail.",
        parameters: Type.Object({ name: Type.String() }),
        async execute(_id, params) {
          return codegraph(options.codegraphBin ?? "codegraph", repo, ["node", "--path", repo, params.name]);
        },
      }),
      defineTool({
        name: "codegraph_impact",
        label: "CodeGraph impact",
        description: "Traverse the impact radius of changing a symbol.",
        parameters: Type.Object({ symbol: Type.String(), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
        async execute(_id, params) {
          return codegraph(options.codegraphBin ?? "codegraph", repo, ["impact", "--path", repo, "--depth", String(params.depth ?? 2), params.symbol]);
        },
      }),
      defineTool({
        name: "codegraph_affected",
        label: "CodeGraph affected tests",
        description: "Find tests affected by the supplied changed files.",
        parameters: Type.Object({ files: Type.Array(Type.String()), depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })) }),
        async execute(_id, params) {
          return codegraph(options.codegraphBin ?? "codegraph", repo, ["affected", "--path", repo, "--depth", String(params.depth ?? 5), ...params.files]);
        },
      }),
    );
  }

  if (options.graphify) {
    const { bin, graphPath } = options.graphify;
    tools.push(
      defineTool({
        name: "graphify_query",
        label: "Graphify code query",
        description: "Traverse the prebuilt code-only Graphify graph for a bounded architectural question.",
        parameters: Type.Object({ question: Type.String(), budget: Type.Optional(Type.Number({ minimum: 100, maximum: 3000 })) }),
        async execute(_id, params) {
          return graphify(bin, repo, graphPath, ["query", params.question, "--budget", String(params.budget ?? 1500)]);
        },
      }),
      defineTool({
        name: "graphify_path",
        label: "Graphify shortest path",
        description: "Find the shortest code-graph path between two named nodes.",
        parameters: Type.Object({ from: Type.String(), to: Type.String() }),
        async execute(_id, params) {
          return graphify(bin, repo, graphPath, ["path", params.from, params.to]);
        },
      }),
      defineTool({
        name: "graphify_explain",
        label: "Graphify node explanation",
        description: "Explain one code node and its indexed neighbors.",
        parameters: Type.Object({ node: Type.String() }),
        async execute(_id, params) {
          return graphify(bin, repo, graphPath, ["explain", params.node]);
        },
      }),
    );
  }

  if (options.serena) tools.push(...options.serena.tools);

  if (options.sandboxed) {
    tools.push(defineTool({
      name: "leveret_probe",
      label: "Bounded probe",
      description: "Execute one non-shell command inside the declared review sandbox. Exit, signal, timeout, stdout, and stderr are returned as structured evidence.",
      parameters: Type.Object({
        command: Type.String(),
        args: Type.Optional(Type.Array(Type.String())),
        cwd: Type.Optional(Type.String()),
        timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 120_000 })),
      }),
      async execute(_id, params) {
        const cwd = resolve(repo, params.cwd ?? ".");
        if (!pathIsInside(repo, cwd)) throw new Error("probe cwd must stay inside the reviewed checkout");
        let command = params.command;
        if (command.includes("/") || command.includes("\\")) {
          command = resolve(cwd, command);
          if (!pathIsInside(repo, command)) throw new Error("probe command path must stay inside the reviewed checkout");
        }
        const startedAt = Date.now();
        const result = await runStreaming(command, params.args ?? [], cwd, {
          timeoutMs: params.timeout_ms ?? 30_000,
          env: safeChildEnvironment(),
          maxBuffer: PROBE_AUDIT_MAX_BYTES,
        });
        if (result.spawnError) throw new ToolExecutionError(`probe spawn failed: ${result.spawnError}`);
        const timedOut = result.timedOut === true;
        const stdout = presentProbeOutput(result.stdout);
        const stderr = presentProbeOutput(result.stderr);
        return json({
          outcome: timedOut ? "timed-out" : result.signal ? "signaled" : "exited",
          code: result.code,
          signal: result.signal ?? null,
          stdout: stdout.text,
          stderr: stderr.text,
          duration_ms: Date.now() - startedAt,
          timed_out: timedOut,
          truncated: {
            stdout: stdout.truncated || result.stdoutTruncated === true,
            stderr: stderr.truncated || result.stderrTruncated === true,
          },
        }, { timedOut, nonzeroExit: !timedOut && !result.signal && result.code !== 0 });
      },
    }));
  }

  const annotatedTools = tools.map((tool) => annotateEvidence(tool, options.onToolOutcome));
  const toolSchemaSha256 = createHash("sha256").update(JSON.stringify(annotatedTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))).digest("hex");
  const toolSourceSha256 = createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex");
  return {
    tools: annotatedTools,
    capabilities: {
      graph: options.graphLive,
      lsp: Boolean(options.serena?.tools.length),
      graphify: Boolean(options.graphify),
      probe: options.sandboxed,
      ...(options.serena?.version ? { serena_version: options.serena.version } : {}),
      ...(options.serena?.indexing ? {
        serena_indexed_languages: options.serena.indexing.languages,
        serena_seed_files: options.serena.indexing.seedFiles,
      } : {}),
      ...(options.graphify?.indexedNodes !== undefined ? { graphify_indexed_nodes: options.graphify.indexedNodes } : {}),
      ...(options.graphify?.indexedEdges !== undefined ? { graphify_indexed_edges: options.graphify.indexedEdges } : {}),
      ...(options.serenaBundleSha256 ? { serena_bundle_sha256: options.serenaBundleSha256 } : {}),
      tool_schema_sha256: toolSchemaSha256,
      tool_source_sha256: toolSourceSha256,
      tool_inventory: annotatedTools.map((tool) => tool.name).sort(),
    },
    close: async () => {
      await options.serena?.close();
    },
  };
}
