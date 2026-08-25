import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContract, CONTRACTS } from "../src/prompts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The contracts are executable instructions for a driving agent. The failure mode
// worth testing is drift: a contract naming a tool the server no longer exposes,
// or the server renaming a tool the contracts still teach.

const serverSource = readFileSync(join(root, "src/server.ts"), "utf8");
const registered = [...serverSource.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);

describe("agent contracts", () => {
  it("both contracts exist and load with placeholders substituted", async () => {
    for (const name of ["review", "verify"] as const) {
      const text = await loadContract(name, { repo: "/tmp/x", base: "origin/main" });
      expect(text).toContain("/tmp/x");
      expect(text).toContain("origin/main");
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/); // no unsubstituted placeholders
    }
  });

  it("every MCP tool a contract instructs the agent to call actually exists", async () => {
    for (const name of ["review", "verify"] as const) {
      const text = await loadContract(name, { repo: "r", base: "b" });
      const tools = [...text.matchAll(/`leveret\.([a-z_]+)`/g)].map((m) => m[1]);
      // zero matches would make this loop assert nothing — the guard must fail
      // loudly if a rewrite de-backticks the tool references (R19)
      expect(tools.length, `${name}.md lost its backticked leveret.* references`).toBeGreaterThanOrEqual(2);
      for (const tool of tools) {
        expect(registered, `${name}.md references unknown tool ${tool}`).toContain(tool);
      }
    }
  });

  it("the review contract mandates the non-negotiables", async () => {
    const text = await loadContract("review", { repo: "r", base: "b" });
    // cross-file blast radius is the class a diff-only reviewer misses
    expect(text.toLowerCase()).toContain("outside the diff");
    expect(text).not.toContain("`leveret.scan`");
    expect(text).toContain("exclude scan, semantic-rule, mutation, and hunt");
    expect(text).toContain("`leveret.context`");
    expect(text).toContain("read-only");
  });

  it("the verify contract mandates refute-or-evidence and the three grades", async () => {
    const text = await loadContract("verify", { repo: "r", base: "b" });
    for (const grade of ["actionable", "priced-noise", "false-positive"]) {
      expect(text).toContain(grade);
    }
    expect(text).toContain("`leveret.remember`");
    expect(text.toLowerCase()).toContain("refute");
  });

  it("CONTRACTS enumerates exactly the shipped contracts", async () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(["review", "verify"]);
  });

  it("the review contract mandates a coverage report beside the concerns", async () => {
    const text = await loadContract("review", { repo: "r", base: "b" });
    expect(text).toContain('"coverage"');
    expect(text).toContain('"concerns"');
    // per-file verdict for EVERY changed file — coverage without per-file honesty is theater
    expect(text).toMatch(/every changed file/i);
    expect(text).toMatch(/considered-fine|not-examined/);
  });

  it("out-of-diff findings are a first-class category carrying their correlation", async () => {
    const review = await loadContract("review", { repo: "r", base: "b" });
    const verify = await loadContract("verify", { repo: "r", base: "b" });
    // review concerns and verified reports both mark scope...
    expect(review).toContain('"scope"');
    expect(verify).toContain('"scope"');
    expect(verify).toContain('"out-of-diff"');
    // ...and an out-of-diff item must SAY why it is connected to this change
    expect(review).toContain('"correlation"');
    expect(verify).toContain('"correlation"');
    expect(verify).not.toMatch(/outside the diff[^.]*\bskip\b/i);
  });

  it("the verify contract reports findings in importance tiers and carries coverage through", async () => {
    const text = await loadContract("verify", { repo: "r", base: "b" });
    for (const tier of ["critical", "major", "minor", "nit"]) {
      expect(text).toContain(`"${tier}"`);
    }
    expect(text).toContain('"tier"');
    expect(text).toContain('"coverage"');
    // tier is review judgment, not engine severity — both must exist distinctly
    expect(text).toContain('"severity"');
  });

  it("attributes tool-grounded concerns and findings to evidence ids", async () => {
    const review = await loadContract("review", { repo: "r", base: "b" });
    const verify = await loadContract("verify", { repo: "r", base: "b" });
    expect(review).toContain('"evidence_ids"');
    expect(verify).toContain('"evidence_ids"');
  });
});
