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

  it("shows each sampled finding's signals and the reason for its label", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mine-audit-"));
    const rows = [row(1), row(2, { label_source: "judge", disposition: "rejected", signals: ["replied"] })];
    await writeFile(join(dir, "reasons.jsonl"), `${JSON.stringify({ url: rows[0]!.url, reason: "Mechanical rule: x" })}\n${JSON.stringify({ url: rows[1]!.url, reason: "Author said no change was needed." })}\n`);
    const entries = await runAudit(rows, { cacheRoot: dir, seed: 1 });
    expect(entries.find((e) => e.url === rows[1]!.url)).toMatchObject({ auto: "rejected", signals: ["replied"], reason: "Author said no change was needed.", hand: null });
    expect(entries.find((e) => e.url === rows[0]!.url)).toMatchObject({ signals: ["fixed", "resolved"], reason: "Mechanical rule: x" });
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
    row(8, { bot: "chatgpt-codex-connector[bot]", kind: "conversation", path: null, line: null, head_sha: null, signals: ["unknown"], url: "https://github.com/o/r/pull/1#issuecomment-8" }),
    // Four lines from Codex's line 90: outside the window, so Codex's finding stays unique.
    row(9, { bot: "kilo-code-bot[bot]", line: 94, disposition: "rejected", label_source: "judge" }),
    // Codex alone on a later revision: counts per PR, but not as a shared revision.
    row(10, { bot: "chatgpt-codex-connector[bot]", head_sha: "d".repeat(40), line: 200 }),
    // Copilot: a clean review of revision c (reviewed, zero findings) and a quota failure on revision d (not a review).
    row(11, { bot: "copilot-pull-request-reviewer[bot]", kind: "review", path: null, line: null, disposition: "notice", category: null, judge: null, signals: ["notice", "unknown"] }),
    row(12, { bot: "copilot-pull-request-reviewer[bot]", kind: "review", path: null, line: null, head_sha: "d".repeat(40), disposition: "no-review", category: null, judge: null, signals: ["notice", "unknown"] }),
  ];
  const comparisons: Comparison[] = [
    { repository: "o/r", pull_request: 1, replay_head: SHA, targets: [rows[0]!.url, rows[3]!.url], matched: [rows[0]!.url], status: "complete" },
    { repository: "o/r", pull_request: 2, replay_head: SHA, targets: [], matched: [], status: "invalid", reason: "missing-commit" },
  ];
  const audit: AuditEntry[] = [
    { url: rows[0]!.url, auto: "accepted", label_source: "mechanical", signals: [], reason: null, hand: "accepted" },
    { url: rows[1]!.url, auto: "rejected", label_source: "judge", signals: [], reason: null, hand: "accepted" },
    { url: rows[2]!.url, auto: "accepted", label_source: "mechanical", signals: [], reason: null, hand: null },
  ];
  const report = renderReport(rows, audit, comparisons, "2026-11-06", { "o/r": "TypeScript" });

  it("reports per-bot counts, per-PR rates and noise without counting duplicates", () => {
    expect(report).toContain("| coderabbitai[bot] | 1 | 3 | 3.00 | 1 | 1.00 | 1 | 1 | 0.50 | 1 | 0 |");
    expect(report).toContain("| chatgpt-codex-connector[bot] | 1 | 4 | 4.00 | 4 | 4.00 | 0 | 0 | 0.00 | 0 | 0 |");
    expect(report).toContain("| copilot-pull-request-reviewer[bot] | 1 | 0 | 0.00 | 0 | 0.00 | 0 | 0 | - | 1 | 1 |");
  });

  it("compares bots only on revisions two or more of them reviewed", () => {
    expect(report).toContain("Revisions reviewed by two or more bots: 1.");
    expect(report).toContain("Findings with no reviewed commit, left out of this section: 1.");
    // Revision c: CodeRabbit, Codex, Kilo, and Copilot's clean review. Revision d had Codex only.
    expect(report).toContain("| coderabbitai[bot] | 1 | 3 | 3.00 | 1 | 1.00 | 0 |");
    // r1 (line 10) and r3 (line 12) overlap; r4 (line 90) is unique to Codex.
    expect(report).toContain("| chatgpt-codex-connector[bot] | 1 | 2 | 2.00 | 2 | 2.00 | 1 |");
    expect(report).toContain("| copilot-pull-request-reviewer[bot] | 1 | 0 | 0.00 | 0 | 0.00 | 0 |");
    expect(report).toContain("| kilo-code-bot[bot] | 1 | 1 | 1.00 | 0 | 0.00 | 0 |");
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
