import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { astSearch } from "../src/astsearch.js";
import { memoryList, remember } from "../src/memory.js";
import { scan } from "../src/scan.js";

// Real-tool integration test: plants one known defect per engine in a scratch git
// repo and asserts the normalized finding surfaces. Fails on regression in engine
// invocation, JSON parsing, or selection logic.

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
  repo = mkdtempSync(join(tmpdir(), "leveret-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "base.txt"), "clean\n");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  git(["branch", "base"]);

  // shellcheck: SC2086 unquoted variable
  writeFileSync(join(repo, "bad.sh"), "#!/bin/sh\nf=$1\ncat $f\n");
  // ruff: F821 undefined name
  writeFileSync(join(repo, "bad.py"), "print(undefined_name)\n");
  // gitleaks: fabricated token matching the github-pat pattern (not a real credential;
  // AWS's documented AKIA...EXAMPLE key is on gitleaks' default allowlist, so it
  // cannot serve as the plant). Assembled at runtime so the contiguous pattern never
  // exists in THIS repo's tree — GitHub push protection and gitleaks-on-leveret would
  // both flag a literal.
  writeFileSync(join(repo, "leak.txt"), ["ghp", "_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx\n"].join(""));
  // actionlint: unknown runner label
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(repo, ".github/workflows/ci.yml"),
    "on: push\njobs:\n  a:\n    runs-on: no-such-runner\n    steps:\n      - run: echo hi\n",
  );
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "planted defects"]);
});

describe("scan", () => {
  it("surfaces one normalized finding per planted defect, diff-scoped from base", async () => {
    const result = await scan({ repo, base: "base" });
    const rules = (engine: string) =>
      result.findings.filter((f) => f.engine === engine).map((f) => f.rule);

    expect(rules("shellcheck")).toContain("SC2086");
    expect(rules("ruff")).toContain("F821");
    expect(rules("gitleaks").length).toBeGreaterThan(0);
    expect(rules("actionlint").length).toBeGreaterThan(0);

    const finding = result.findings.find((f) => f.rule === "SC2086");
    expect(finding).toMatchObject({ engine: "shellcheck", file: "bad.sh", line: 3 });
  });

  it("reports not-applicable engines and never fabricates findings for them", async () => {
    const result = await scan({ repo, files: ["base.txt"] });
    // typos applies to any text file and comes back clean; everything else has
    // nothing to select on a plain text file.
    for (const r of result.engines) {
      expect(r.status).toBe(r.engine === "typos" ? "clean" : "not-applicable");
      expect(r.selectedFiles).toEqual(r.engine === "typos" ? ["base.txt"] : []);
      expect(r.durationMs).toEqual(expect.any(Number));
    }
    expect(result.findings).toEqual([]);
  });

  it("engine restriction runs only the named engine", async () => {
    const result = await scan({ repo, base: "base", engines: ["shellcheck"] });
    expect(result.engines.map((r) => r.engine)).toEqual(["shellcheck"]);
    expect(result.findings.every((f) => f.engine === "shellcheck")).toBe(true);
  });
});

describe("profile", () => {
  const profile = `
engines:
  shellcheck:
    paths: ["scripts/**"]
suppress:
  - rule: ruff/F821
    reason: fixture plants an undefined name on purpose
`;

  it("scopes engines by path and suppresses rules with a reported reason", async () => {
    writeFileSync(join(repo, ".leveret.yml"), profile);
    const result = await scan({ repo, base: "base" });
    // bad.sh sits at the repo root, outside shellcheck's scoped paths
    expect(result.findings.filter((f) => f.engine === "shellcheck")).toEqual([]);
    // ruff still ran, but F821 is suppressed and the suppression is reported
    expect(result.findings.filter((f) => f.rule === "F821")).toEqual([]);
    const sup = result.suppressed.find((s) => s.rule === "ruff/F821");
    expect(sup).toMatchObject({
      count: 1,
      reason: "fixture plants an undefined name on purpose",
    });
    // untouched engines keep their findings
    expect(result.findings.some((f) => f.engine === "gitleaks")).toBe(true);
  });

  it("explicit profilePath overrides the in-repo default", async () => {
    const alt = join(tmpdir(), `leveret-profile-${process.pid}.yml`);
    writeFileSync(alt, "suppress:\n  - rule: shellcheck/SC2086\n    reason: alt profile\n");
    const result = await scan({ repo, base: "base", profilePath: alt });
    expect(result.findings.some((f) => f.rule === "SC2086")).toBe(false);
    expect(result.suppressed.find((s) => s.rule === "shellcheck/SC2086")?.reason).toBe(
      "alt profile",
    );
  });

  it("a suppress entry without a reason is a config error, not a silent drop", async () => {
    writeFileSync(join(repo, ".leveret.yml"), "suppress:\n  - rule: ruff/F821\n");
    await expect(scan({ repo, base: "base" })).rejects.toThrow(/reason/);
  });
});

describe("memory", () => {
  // Runs after the profile suite: the last profile test left an INVALID .leveret.yml
  // in the fixture repo, so rewrite a benign one first.
  it("a remembered class grade auto-applies on the next scan, tallied with its reason", async () => {
    writeFileSync(join(repo, ".leveret.yml"), "# empty profile\n");
    const before = await scan({ repo, base: "base", engines: ["shellcheck"] });
    expect(before.findings.some((f) => f.rule === "SC2086")).toBe(true);

    await remember({
      repo,
      fp: "shellcheck/SC2086/bad.sh",
      grade: "priced-noise",
      reason: "fixture: unquoted on purpose",
    });
    const after = await scan({ repo, base: "base", engines: ["shellcheck"] });
    expect(after.findings.some((f) => f.rule === "SC2086")).toBe(false);
    expect(
      after.suppressed.find((s) => s.rule === "shellcheck/SC2086/bad.sh"),
    ).toMatchObject({ reason: "fixture: unquoted on purpose" });
  });

  it("an anchored memory dies when its line changes; grade no longer auto-applies", async () => {
    const memPath = join(repo, ".leveret", "memory.jsonl");
    rmSync(memPath, { force: true });
    const anchored = await scan({ repo, base: "base", engines: ["shellcheck"] });
    const target = anchored.findings.find((f) => f.rule === "SC2086");
    expect(target).toBeDefined();
    await remember({
      repo,
      fp: "shellcheck/SC2086/bad.sh",
      grade: "false-positive",
      reason: "anchored pricing",
      anchorFile: "bad.sh",
      anchorLine: target!.line,
    });
    // memory applies while the anchor line is untouched
    const held = await scan({ repo, base: "base", engines: ["shellcheck"] });
    expect(held.findings.some((f) => f.rule === "SC2086")).toBe(false);
    // rewrite the anchored line: same rule fires elsewhere in the file
    writeFileSync(join(repo, "bad.sh"), "#!/bin/sh\ng=$2\ncat $g\n");
    const stale = await scan({ repo, files: ["bad.sh"], engines: ["shellcheck"] });
    expect(stale.findings.some((f) => f.rule === "SC2086")).toBe(true);
  });

  it("remember rejects a grade of actionable — only drops are stored", async () => {
    await expect(
      remember({ repo, fp: "ruff/F821/bad.py", grade: "actionable" as never, reason: "x" }),
    ).rejects.toThrow(/grade/);
  });

  it("memoryList surfaces entries with lastApplied for hygiene", async () => {
    const entries = await memoryList({ repo });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty("fp");
    expect(entries[0]).toHaveProperty("reason");
  });

  it("verdict file stays append-only: lastApplied lives in the sidecar, not memory.jsonl", async () => {
    rmSync(join(repo, ".leveret"), { recursive: true, force: true });
    await remember({ repo, fp: "shellcheck/SC2086/**", grade: "priced-noise", reason: "fixture" });
    const before = readFileSync(join(repo, ".leveret", "memory.jsonl"), "utf8");
    const applied = await scan({ repo, files: ["bad.sh"], engines: ["shellcheck"] });
    expect(applied.suppressed.some((s) => s.rule === "shellcheck/SC2086/**")).toBe(true);
    // applying a memory must not rewrite the versioned verdict file
    expect(readFileSync(join(repo, ".leveret", "memory.jsonl"), "utf8")).toBe(before);
    expect(before).not.toContain("lastApplied");
    // ...but the hygiene stamp still surfaces through memoryList, from the sidecar
    const entry = (await memoryList({ repo })).find((e) => e.fp === "shellcheck/SC2086/**");
    expect(entry?.lastApplied).toBeDefined();
    expect(existsSync(join(repo, ".leveret", "applied.json"))).toBe(true);
  });

  it("the store ships its own .gitignore so the sidecar never gets committed", async () => {
    rmSync(join(repo, ".leveret"), { recursive: true, force: true });
    await remember({ repo, fp: "ruff/F821/**", grade: "priced-noise", reason: "fixture" });
    const ignore = readFileSync(join(repo, ".leveret", ".gitignore"), "utf8");
    expect(ignore).toContain("applied.json");
    expect(ignore).not.toContain("memory.jsonl");
  });
});

describe("P4 engines", () => {
  it("zizmor flags the unpinned-credentials checkout in the workflow", async () => {
    writeFileSync(join(repo, ".leveret.yml"), "# empty profile\n");
    rmSync(join(repo, ".leveret"), { recursive: true, force: true });
    writeFileSync(
      join(repo, ".github/workflows/ci.yml"),
      "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo hi\n",
    );
    const result = await scan({ repo, files: [".github/workflows/ci.yml"], engines: ["zizmor"] });
    const finding = result.findings.find((f) => f.rule === "artipacked");
    expect(finding).toMatchObject({ engine: "zizmor", file: ".github/workflows/ci.yml", line: 6 });
  });

  it("osv-scanner reports known CVEs from a lockfile", async () => {
    writeFileSync(
      join(repo, "package-lock.json"),
      JSON.stringify({
        name: "x",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "x", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
          "node_modules/lodash": { version: "4.17.15" },
        },
      }),
    );
    const result = await scan({ repo, files: ["package-lock.json"], engines: ["osv-scanner"] });
    expect(result.findings.some((f) => f.engine === "osv-scanner" && /GHSA-|CVE-/.test(f.rule))).toBe(
      true,
    );
    expect(result.findings[0]!.message).toMatch(/lodash@4\.17\.15/);
  });

  it("profile-declared custom semgrep rules surface with their own rule id", async () => {
    mkdirSync(join(repo, "rules"), { recursive: true });
    writeFileSync(
      join(repo, "rules/no-eval.yml"),
      "rules:\n  - id: leveret-no-eval\n    languages: [python]\n    severity: WARNING\n    message: eval is dangerous\n    pattern: eval(...)\n",
    );
    writeFileSync(join(repo, "bad2.py"), "y = eval('2+2')\n");
    writeFileSync(join(repo, ".leveret.yml"), 'engines:\n  semgrep:\n    rules: ["rules/no-eval.yml"]\n');
    const result = await scan({ repo, files: ["bad2.py"], engines: ["semgrep"] });
    expect(result.findings.some((f) => f.rule.endsWith("leveret-no-eval"))).toBe(true);
  });

  it("profile-declared ast-grep rule packs run as their own engine", async () => {
    mkdirSync(join(repo, "sgrules"), { recursive: true });
    writeFileSync(
      join(repo, "sgrules/no-eval.yml"),
      "id: sg-no-eval\nlanguage: python\nseverity: warning\nmessage: eval is dangerous\nrule:\n  pattern: eval($X)\n",
    );
    writeFileSync(join(repo, "sgconfig.yml"), 'ruleDirs: ["sgrules"]\n');
    writeFileSync(join(repo, ".leveret.yml"), 'engines:\n  ast-grep:\n    rules: ["sgconfig.yml"]\n');
    const result = await scan({ repo, files: ["bad2.py"], engines: ["ast-grep"] });
    const finding = result.findings.find((f) => f.rule === "sg-no-eval");
    expect(finding).toMatchObject({ engine: "ast-grep", file: "bad2.py", severity: "warning" });
  });

  it("without a rule pack the ast-grep engine is not applicable", async () => {
    writeFileSync(join(repo, ".leveret.yml"), "# empty profile\n");
    const result = await scan({ repo, files: ["bad2.py"], engines: ["ast-grep"] });
    expect(result.engines).toEqual([expect.objectContaining({ engine: "ast-grep", status: "not-applicable", selectedFiles: [], durationMs: expect.any(Number) })]);
  });
});

describe("ast_search", () => {
  it("matches structurally, 1-based lines", async () => {
    const matches = await astSearch({ repo, pattern: "cat $F", lang: "bash", paths: ["bad.sh"] });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ file: "bad.sh", line: 3 });
  });
});
