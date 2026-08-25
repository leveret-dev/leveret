import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINES } from "../src/engines/registry.js";
import { remember } from "../src/memory.js";
import { loadContract } from "../src/prompts.js";
import { scan } from "../src/scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("memory store hardening (R9, R18)", () => {
  it("a half-specified anchor is a config error, not a silent class-wide suppression", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-anchor-"));
    writeFileSync(join(repo, "a.py"), "x = 1\n");
    await expect(
      remember({ repo, fp: "ruff/F821/a.py", grade: "false-positive", reason: "r", anchorFile: "a.py" }),
    ).rejects.toThrow(/anchor/);
    await expect(
      remember({ repo, fp: "ruff/F821/a.py", grade: "false-positive", reason: "r", anchorLine: 0, anchorFile: "a.py" }),
    ).rejects.toThrow(/anchor/);
  });

  it("a malformed memory line names the file and line number instead of a bare SyntaxError", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-badmem-"));
    writeFileSync(join(repo, "a.py"), "print(foo)\n");
    mkdirSync(join(repo, ".leveret"));
    writeFileSync(
      join(repo, ".leveret", "memory.jsonl"),
      '{"fp":"ruff/F821/**","grade":"priced-noise","reason":"ok","created":"2026-08-21"}\n<<<<<<< HEAD\n',
    );
    await expect(scan({ repo, files: ["a.py"], engines: ["ruff"] })).rejects.toThrow(
      /memory\.jsonl:2/,
    );
  });
});

describe("semgrep registry knob (R13)", () => {
  it("registry: false with no rule packs makes semgrep not-applicable instead of fetching semgrep.dev", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-sgreg-"));
    writeFileSync(join(repo, "a.py"), "x = 1\n");
    writeFileSync(join(repo, ".leveret.yml"), "engines:\n  semgrep:\n    registry: false\n");
    const r = await scan({ repo, files: ["a.py"], engines: ["semgrep"] });
    expect(r.engines).toEqual([expect.objectContaining({ engine: "semgrep", status: "not-applicable", selectedFiles: [], durationMs: expect.any(Number) })]);
  });

  it("registry: false with a local rule pack still runs the pack (offline path)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lev-sgoff-"));
    writeFileSync(join(repo, "a.py"), "y = eval('1')\n");
    writeFileSync(
      join(repo, "rules.yml"),
      "rules:\n  - id: local-no-eval\n    languages: [python]\n    severity: WARNING\n    message: eval\n    pattern: eval(...)\n",
    );
    writeFileSync(
      join(repo, ".leveret.yml"),
      'engines:\n  semgrep:\n    registry: false\n    rules: ["rules.yml"]\n',
    );
    const r = await scan({ repo, files: ["a.py"], engines: ["semgrep"] });
    expect(r.findings.some((f) => f.rule.endsWith("local-no-eval"))).toBe(true);
  });
});

describe("description drift (R16)", () => {
  it("the scan tool description names every registered engine", () => {
    const serverSource = readFileSync(join(root, "src/server.ts"), "utf8");
    const desc = serverSource.slice(0, serverSource.indexOf("ast_search"));
    for (const e of ENGINES) {
      expect(desc, `scan description omits engine ${e.id}`).toContain(e.id);
    }
  });
});

describe("verify contract: unverifiable means dropped, never remembered (R15)", () => {
  it("no false-positive-by-unverifiability path remains", async () => {
    const text = await loadContract("verify", { repo: "r", base: "b" });
    expect(text).not.toMatch(/unverifiable as stated/);
    // dropped claims are excluded from remember, and the contract says so
    expect(text).toMatch(/never persist|do not persist|not remembered/i);
    expect(text).toMatch(/"dropped"/);
  });
});

