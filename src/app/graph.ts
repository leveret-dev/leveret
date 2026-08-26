import { executableIdentity, run } from "../exec.js";

// Every checkout leveret makes gets a code graph generated into it: the graph is
// derived from the code, buildable anywhere, and the review agent should query
// structure (callers, dependents, dispatch) instead of re-deriving it grep by grep.
// Same init+index sequence as pfBlockerNG's ensure-codegraph.sh.

export interface GraphStatus {
  ok: boolean;
  detail?: string;
  version?: string;
  binarySha256?: string;
  indexedFiles?: number;
  indexedNodes?: number;
  indexedEdges?: number;
  indexState?: string;
}

export async function ensureGraph(repo: string, bin = "codegraph"): Promise<GraphStatus> {
  const executable = await executableIdentity(bin, repo);
  if (!executable.available) {
    return { ok: false, detail: `${bin} not on PATH: agents fall back to ast_search/grep` };
  }
  const identity = {
    ...(executable.version ? { version: executable.version } : {}),
    ...(executable.sha256 ? { binarySha256: executable.sha256 } : {}),
  };
  const init = await run(bin, ["init", repo], repo);
  if (init.code !== 0) {
    return { ok: false, detail: `${bin} init rc=${init.code}: ${init.stderr.slice(0, 200)}`, ...identity };
  }
  const index = await run(bin, ["index", repo], repo);
  if (index.code !== 0) {
    return { ok: false, detail: `${bin} index rc=${index.code}: ${index.stderr.slice(0, 200)}`, ...identity };
  }
  const probe = await run(bin, ["status", "--json", repo], repo);
  if (probe.code !== 0) {
    return { ok: false, detail: `${bin} status rc=${probe.code}: ${probe.stderr.slice(0, 200)}`, ...identity };
  }
  try {
    const status = JSON.parse(probe.stdout) as {
      initialized?: unknown;
      fileCount?: unknown;
      nodeCount?: unknown;
      edgeCount?: unknown;
      index?: { state?: unknown };
    };
    if (status.initialized !== true || typeof status.fileCount !== "number" || status.fileCount < 1
      || typeof status.nodeCount !== "number" || status.nodeCount < 1 || status.index?.state !== "complete") {
      return { ok: false, detail: `${bin} status did not prove a complete non-empty index`, ...identity };
    }
    return {
      ok: true,
      ...identity,
      indexedFiles: status.fileCount,
      indexedNodes: status.nodeCount,
      ...(typeof status.edgeCount === "number" ? { indexedEdges: status.edgeCount } : {}),
      indexState: status.index.state,
    };
  } catch (error) {
    return { ok: false, detail: `${bin} status returned invalid JSON: ${String(error).slice(0, 200)}`, ...identity };
  }
}
