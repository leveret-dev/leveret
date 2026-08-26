import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { executableIdentity, run } from "../exec.js";

export interface GraphifyStatus {
  ok: boolean;
  graphPath?: string;
  detail?: string;
  version?: string;
  binarySha256?: string;
  indexedNodes?: number;
  indexedEdges?: number;
}

/** Build a code-only graph outside the checkout before any review model starts. */
export async function ensureGraphify(
  repo: string,
  outputRoot: string,
  bin = "graphify",
): Promise<GraphifyStatus> {
  const executable = await executableIdentity(bin, repo);
  if (!executable.available) {
    return { ok: false, detail: `${bin} not on PATH: Graphify tools unavailable` };
  }
  const identity = {
    ...(executable.version ? { version: executable.version } : {}),
    ...(executable.sha256 ? { binarySha256: executable.sha256 } : {}),
  };
  const output = join(outputRoot, "graphify-code");
  await rm(output, { recursive: true, force: true });
  const extracted = await run(bin, [
    "extract",
    repo,
    "--code-only",
    "--no-cluster",
    "--out",
    output,
  ], outputRoot, { timeoutMs: 5 * 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (extracted.code !== 0 || extracted.timedOut) {
    return { ok: false, detail: `${bin} code-only extraction failed: ${extracted.stderr.slice(0, 500)}`, ...identity };
  }
  const graphPath = join(output, "graphify-out", "graph.json");
  try {
    const graph = JSON.parse(await readFile(graphPath, "utf8")) as { nodes?: unknown; links?: unknown; edges?: unknown };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    const edges = Array.isArray(graph.links) ? graph.links.length : Array.isArray(graph.edges) ? graph.edges.length : 0;
    if (nodes < 1) return { ok: false, detail: `${bin} produced an empty code graph`, ...identity };
    return { ok: true, graphPath, indexedNodes: nodes, indexedEdges: edges, ...identity };
  } catch (error) {
    return { ok: false, detail: `${bin} graph validation failed: ${String(error).slice(0, 300)}`, ...identity };
  }
}
