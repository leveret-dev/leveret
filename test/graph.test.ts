import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGraph } from "../src/app/graph.js";

// Every checkout leveret makes gets a code graph generated INTO it (owner ruling):
// the graph is derived, buildable anywhere — agents query structure, not re-derive
// it per grep.

describe("ensureGraph", () => {
  it("indexes a fresh checkout so the graph is queryable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-graph-"));
    execFileSync("git", ["init", "-qb", "main"], { cwd: repo });
    writeFileSync(join(repo, "a.py"), "def f():\n    return g()\n\ndef g():\n    return 1\n");
    const status = await ensureGraph(repo);
    expect(status.ok).toBe(true);
    expect(status.binarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(repo, ".codegraph"))).toBe(true);
  });

  it("reports unavailable instead of throwing when the binary is absent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-nograph-"));
    execFileSync("git", ["init", "-qb", "main"], { cwd: repo });
    const status = await ensureGraph(repo, "definitely-not-codegraph-bin");
    expect(status.ok).toBe(false);
    expect(status.detail).toBeTruthy();
  });
});
