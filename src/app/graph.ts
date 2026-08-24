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
  return { ok: true, ...identity };
}
