import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LabelRow } from "../bench/mine-labels.mjs";
import { runAudit } from "../bench/mine.mjs";
import { auditSample, renderReport, wilson, type AuditEntry, type Comparison } from "../bench/mine-report.mjs";

const SHA = "c".repeat(40);
function row(id: number, overrides: Partial<LabelRow> = {}): LabelRow {
  return {
    url: `https://github.com/o/r/pull/1#discussion_r${id}`, repository: "o/r", pull_request: 1, bot: "coderabbitai[bot]", kind: "inline",
    path: "src/x.ts", line: 10, head_sha: SHA, category: "bug", disposition: "accepted", signals: ["fixed", "resolved"],
    label_source: "mechanical", judge: { model: "m", prompt_sha256: "d".repeat(64) }, duplicate_of: null, ...overrides,
  };
}

describe("wilson", () => {
  it("bounds empty samples by [0, 1] and centres a half split", () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
    const half = wilson(30, 60);
    expect(half.low).toBeCloseTo(0.377, 3);
    expect(half.high).toBeCloseTo(0.623, 3);
  });
});

describe("auditSample", () => {
  const rows = Array.from({ length: 80 }, (_, i) => row(i, i % 10 === 0 ? { disposition: "notice", category: null, judge: null } : i % 10 === 1 ? { duplicate_of: "https://github.com/o/r/pull/1#discussion_r0" } : {}));
  it("is deterministic for a seed and skips notices and duplicates", () => {
    const first = auditSample(rows, 7).map((r) => r.url);
    expect(first).toHaveLength(50);
    expect(auditSample(rows, 7).map((r) => r.url)).toEqual(first);
    expect(auditSample(rows, 8).map((r) => r.url)).not.toEqual(first);
    expect(first.every((url) => !/r(\d*0|\d*1)$/.test(url))).toBe(true);
  });
});

describe("runAudit", () => {
  it("keeps hand labels already filled in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mine-audit-"));
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    await runAudit(rows, { cacheRoot: dir, seed: 1 });
    const path = join(dir, "audit.jsonl");
    const first = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditEntry);
    expect(first.map((entry) => entry.hand)).toEqual([null, null, null, null, null]);
    await writeFile(path, first.map((entry, i) => JSON.stringify(i === 2 ? { ...entry, hand: "rejected" } : entry)).join("\n") + "\n");
    await runAudit(rows, { cacheRoot: dir, seed: 1 });
    const second = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditEntry);
    expect(second.map((entry) => entry.url)).toEqual(first.map((entry) => entry.url));
    expect(second[2]!.hand).toBe("rejected");
  });

  it("keeps hand labels for findings that left the sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mine-audit-"));
    const rows = Array.from({ length: 5 }, (_, i) => row(i));
    await runAudit(rows, { cacheRoot: dir, seed: 1 });
    const path = join(dir, "audit.jsonl");
    const first = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditEntry);
    const labelled = first[0]!.url;
    await writeFile(path, first.map((entry) => JSON.stringify(entry.url === labelled ? { ...entry, hand: "rejected" } : entry)).join("\n") + "\n");
    await runAudit(rows.filter((r) => r.url !== labelled), { cacheRoot: dir, seed: 1 });
    const second = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditEntry);
    expect(second.find((entry) => entry.url === labelled)?.hand).toBe("rejected");
  });

  it("rejects hand labels that are not dispositions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mine-audit-"));
    const rows = [row(1)];
    await runAudit(rows, { cacheRoot: dir, seed: 1 });
    const path = join(dir, "audit.jsonl");
    const [entry] = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as AuditEntry);
    await writeFile(path, `${JSON.stringify({ ...entry, hand: "acepted" })}\n`);
    await expect(runAudit(rows, { cacheRoot: dir, seed: 1 })).rejects.toThrow();
  });
});

describe("renderReport", () => {
  const rows: LabelRow[] = [
    row(1),
    row(2, { line: 50, disposition: "rejected", category: "style", label_source: "judge" }),
    row(3, { bot: "chatgpt-codex-connector[bot]", line: 12 }),
    row(4, { bot: "chatgpt-codex-connector[bot]", line: 90, category: "security" }),
    row(5, { repository: "me/r", url: "https://github.com/me/r/pull/9#discussion_r5", duplicate_of: "https://github.com/o/r/pull/1#discussion_r1" }),
    row(6, { kind: "conversation", path: null, line: null, disposition: "notice", category: null, judge: null, signals: ["notice", "unknown"] }),
    row(7, { line: 30, disposition: "unclear", label_source: "judge", signals: ["unknown"] }),
    row(8, { bot: "chatgpt-codex-connector[bot]", kind: "conversation", path: null, line: null, signals: ["unknown"], url: "https://github.com/o/r/pull/1#issuecomment-8" }),
    // Four lines from Codex's line 90: outside the window, so Codex's finding stays unique.
    row(9, { bot: "kilo-code-bot[bot]", line: 94, disposition: "rejected", label_source: "judge" }),
  ];
  const comparisons: Comparison[] = [
    { repository: "o/r", pull_request: 1, replay_head: SHA, targets: [rows[0]!.url, rows[3]!.url], matched: [rows[0]!.url], status: "complete" },
    { repository: "o/r", pull_request: 2, replay_head: SHA, targets: [], matched: [], status: "invalid", reason: "missing-commit" },
  ];
  const audit = [
    { url: rows[0]!.url, auto: "accepted" as const, label_source: "mechanical" as const, hand: "accepted" as const },
    { url: rows[1]!.url, auto: "rejected" as const, label_source: "judge" as const, hand: "accepted" as const },
    { url: rows[2]!.url, auto: "accepted" as const, label_source: "mechanical" as const, hand: null },
  ];
  const report = renderReport(rows, audit, comparisons, "2026-11-06", { "o/r": "TypeScript" });

  it("reports per-bot counts and noise without counting duplicates", () => {
    expect(report).toContain("| coderabbitai[bot] | 3 | 1 | 1 | 1 | 0.50 | 3 | 1 |");
    expect(report).toContain("| chatgpt-codex-connector[bot] | 3 | 3 | 0 | 0 | 0.00 | 3 | 0 |");
  });

  it("counts inline accepted findings no other bot raised nearby", () => {
    // r1 (line 10) and r3 (line 12) overlap; r4 (line 90) is unique to Codex; r8 has no location.
    expect(report).toContain("| chatgpt-codex-connector[bot] | 2 | 1 |");
    expect(report).toContain("| coderabbitai[bot] | 1 | 0 |");
  });

  it("counts unknown fix signals on inline findings only", () => {
    expect(report).toContain("Inline findings with an unknown fix signal: 1.");
  });

  it("reports the Leveret match fraction over complete comparisons with its interval", () => {
    expect(report).toContain("Matched 1/2 accepted findings");
    const { low, high } = wilson(1, 2);
    expect(report).toContain(`[${low.toFixed(2)}, ${high.toFixed(2)}]`);
    expect(report).toContain("1 invalid");
    expect(report).toContain(rows[3]!.url);
  });

  it("reports hand-audit agreement per label source", () => {
    expect(report).toContain("| mechanical | 1 | 1 | 1.00 |");
    expect(report).toContain("| judge | 1 | 0 | 0.00 |");
  });
});
