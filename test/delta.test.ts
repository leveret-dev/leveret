import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scan } from "../src/scan.js";

// Delta scanning: findings present at the base tree are pre-existing and dropped by
// default (tallied, never silent); only findings introduced by the change surface.

let repo: string;
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "leveret-delta-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  // base: one ruff F821 already present
  writeFileSync(join(repo, "app.py"), "print(old_undefined)\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  git(["branch", "base"]);
  // head: the old defect stays, a new one arrives
  writeFileSync(join(repo, "app.py"), "print(old_undefined)\nprint(new_undefined)\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "introduce second F821"]);
});

describe("delta scan", () => {
  it("drops pre-existing findings by default and tallies them", async () => {
    const result = await scan({ repo, base: "base", engines: ["ruff"] });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      rule: "F821",
      line: 2,
      provenance: "introduced",
    });
    expect(result.preExisting).toBe(1);
  });

  it("delta:false keeps everything, tagged by provenance", async () => {
    const result = await scan({ repo, base: "base", engines: ["ruff"], delta: false });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.provenance)).toEqual(["pre-existing", "introduced"]);
    expect(result.preExisting).toBe(0);
  });

  it("an engine whose findings were all filtered away reports 'filtered', not 'findings'", async () => {
    // base == head tree: every finding is pre-existing, delta drops them all.
    const result = await scan({ repo, files: ["app.py"], base: "HEAD", engines: ["ruff"] });
    expect(result.findings).toEqual([]);
    expect(result.preExisting).toBe(2);
    expect(result.engines).toEqual([
      expect.objectContaining({ engine: "ruff", status: "filtered", found: 2, kept: 0, selectedFiles: ["app.py"], durationMs: expect.any(Number) }),
    ]);
  });

  it("kept/found counts surface on engines that keep findings", async () => {
    const result = await scan({ repo, base: "base", engines: ["ruff"] });
    expect(result.engines).toEqual([expect.objectContaining({ engine: "ruff", status: "findings", found: 2, kept: 1, selectedFiles: ["app.py"], durationMs: expect.any(Number) })]);
  });

  it("files-mode scans have no base to compare against: everything is introduced", async () => {
    const result = await scan({ repo, files: ["app.py"], engines: ["ruff"] });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.provenance === "introduced")).toBe(true);
  });
});
