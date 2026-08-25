// Replay historical PRs through the deterministic layer (DESIGN.md "Replay mechanics").
// Usage: npx tsx bench/replay-scan.mts <repo> <profile|-> <pr...>
// Writes bench/results/pr<N>.json: {pr, head, base, files, result}.
// Read-only against <repo> except fetch + throwaway detached worktrees under /tmp.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, changedFiles } from "../src/scan.js";

const [repo, profileArg, ...prs] = process.argv.slice(2);
if (!repo || !profileArg || prs.length === 0) {
  console.error("usage: replay-scan.mts <repo> <profile|-> <pr...>");
  process.exit(2);
}
const profilePath = profileArg === "-" ? undefined : profileArg;
const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

git(repo, "worktree", "prune"); // clear stale registrations from crashed runs

for (const pr of prs) {
  const wt = `/tmp/leveret-bench-${pr}`;
  git(repo, "fetch", "-q", "origin", `pull/${pr}/head`);
  const head = git(repo, "rev-parse", "FETCH_HEAD");
  const base = git(repo, "merge-base", head, "origin/devel");
  // A leftover worktree must be unregistered through git; rmSync alone orphans
  // the registration and the next add fails "missing but already registered".
  try {
    git(repo, "worktree", "remove", "--force", wt);
  } catch {
    rmSync(wt, { recursive: true, force: true });
    git(repo, "worktree", "prune");
  }
  git(repo, "worktree", "add", "-q", "--detach", wt, head);
  try {
    // every bench checkout gets its graph — agents query structure, never handicapped
    const { ensureGraph } = await import("../src/app/graph.js");
    const graph = await ensureGraph(wt);
    if (!graph.ok) console.error(`PR#${pr}: ${graph.detail}`);
    const files = await changedFiles(wt, base);
    const result = await scan({ repo: wt, base, profilePath });
    writeFileSync(join(outDir, `pr${pr}.json`), JSON.stringify({ pr, head, base, files, result }, null, 1));
    console.log(
      `PR#${pr} head=${head.slice(0, 9)} files=${files.length} findings=${result.findings.length} ` +
        `suppressed=${result.suppressed.reduce((n, s) => n + s.count, 0)} ` +
        result.engines.map((e) => `${e.engine}:${e.status}`).join(" "),
    );
  } finally {
    git(repo, "worktree", "remove", "--force", wt);
  }
}
