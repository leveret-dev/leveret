import { describe, expect, it } from "vitest";
import {
  botName,
  isBot,
  isNotice,
  labelRowSchema,
  markDuplicates,
  mechanicalDisposition,
  parseHunks,
  signalList,
  touchesWindow,
  type LabelRow,
} from "../bench/mine-labels.mjs";

const validRow: LabelRow = {
  url: "https://github.com/o/r/pull/1#discussion_r1",
  repository: "o/r",
  pull_request: 1,
  bot: "coderabbitai[bot]",
  kind: "inline",
  path: "src/x.ts",
  line: 42,
  head_sha: "a".repeat(40),
  category: "bug",
  disposition: "accepted",
  signals: ["fixed", "resolved"],
  label_source: "mechanical",
  judge: { model: "google/gemini-flash", prompt_sha256: "b".repeat(64) },
  duplicate_of: null,
};

const row = (repository: string, id: number): LabelRow => ({ ...validRow, repository, url: `https://github.com/${repository}/pull/1#discussion_r${id}` });

describe("line window", () => {
  it("windows ±3 around the commented range", () => {
    const hunks = parseHunks("@@ -20,2 +20,3 @@\n ctx\n-old\n+new\n+more");
    expect(touchesWindow(hunks, 24, 24)).toBe(true);
    expect(touchesWindow(hunks, 25, 25)).toBe(false);
    expect(touchesWindow(parseHunks("@@ -10,0 +11,2 @@\n+a\n+b"), 13, 13)).toBe(true);
    expect(touchesWindow(parseHunks("@@ -10 +10 @@\n-a\n+b"), 14, 14)).toBe(false);
  });

  it("counts only changed lines, not hunk context", () => {
    const hunks = parseHunks("@@ -10,7 +10,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g");
    expect(touchesWindow(hunks, 16, 16)).toBe(true);
    expect(touchesWindow(hunks, 17, 17)).toBe(false);
    expect(touchesWindow(hunks, 9, 9)).toBe(false);
  });
});

describe("bot detection", () => {
  it("detects bots by type, suffix, and the known list", () => {
    expect(isBot({ login: "coderabbitai[bot]", type: "Bot" })).toBe(true);
    expect(isBot({ login: "new-reviewer[bot]", type: "User" })).toBe(true);
    for (const login of ["openwrt-ai", "roboomp", "kilo-code-bot"]) expect(isBot({ login, type: "User" })).toBe(true);
    expect(isBot({ login: "andrebrait", type: "User" })).toBe(false);
  });
});

describe("bot names", () => {
  it("reports Copilot's inline and review accounts as one bot", () => {
    expect(botName("Copilot")).toBe("copilot-pull-request-reviewer[bot]");
    expect(botName("copilot-pull-request-reviewer[bot]")).toBe("copilot-pull-request-reviewer[bot]");
    expect(botName("coderabbitai[bot]")).toBe("coderabbitai[bot]");
  });
});

describe("notice detection", () => {
  const cases: Array<[string, "inline" | "review" | "conversation", string, boolean]> = [
    ["coderabbitai[bot]", "conversation", "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nwalkthrough", true],
    ["coderabbitai[bot]", "conversation", "<!-- This is an auto-generated reply by CodeRabbit -->\nReview rate limited.", true],
    ["coderabbitai[bot]", "review", "**Actionable comments posted: 6**\nsee inline", true],
    ["coderabbitai[bot]", "review", "**Actionable comments posted: 1**\n<summary>⚠️ Outside diff range comments (1)</summary> X", false],
    ["coderabbitai[bot]", "review", "**Actionable comments posted: 0**\n<summary>🧹 Nitpick comments (2)</summary> X", false],
    ["chatgpt-codex-connector[bot]", "conversation", "Codex usage limits have been reached for code reviews.", true],
    ["chatgpt-codex-connector[bot]", "conversation", "<!-- codex-review-receipt:v1 -->\nCodex Review: Didn't find any major issues. Swish!", true],
    ["chatgpt-codex-connector[bot]", "conversation", "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {} -->", true],
    ["chatgpt-codex-connector[bot]", "review", "### 💡 Codex Review\nHere are some automated review suggestions for this pull request.", true],
    ["kilo-code-bot[bot]", "conversation", "<!-- kilo-review -->\n## Code Review Summary\n**Verdict:** No Issues Found", true],
    ["roboomp", "review", "P2 — scoped change.\nShould-fix: changelog lacks attribution", true],
    ["openwrt-ai", "conversation", "Reviewed 1 new commit; no new issues found.", true],
    ["openwrt-ai", "conversation", "## Commit checks\n- dac45982: the hardware section has no power input", false],
    ["coderabbitai[bot]", "inline", "", true],
    ["coderabbitai[bot]", "inline", "_🎯 Functional Correctness_ | _🟡 Minor_\n**Set the hook mode.**", false],
    ["chatgpt-codex-connector[bot]", "inline", "**<sub><sub>![P1 Badge]</sub></sub> Guard the null path**", false],
    ["kilo-code-bot[bot]", "inline", "**CRITICAL:** unchecked index", false],
    ["roboomp", "inline", "**should-fix:** missing attribution", false],
    ["openwrt-ai", "inline", "The device is recorded even when qdisc add failed", false],
    ["copilot-pull-request-reviewer[bot]", "review", "<!-- ccr-overview-v2 -->\n## Copilot review overview", true],
    ["copilot-pull-request-reviewer[bot]", "review", "### 🟢 Approval recommended\nNo unresolved review issues remain.", true],
    ["Copilot", "inline", "This guard skips the null path.", false],
  ];
  it.each(cases)("%s %s #%#", (bot, kind, body, expected) => {
    expect(isNotice(bot, kind, body)).toBe(expected);
  });
});

describe("mechanical disposition", () => {
  const base = { fixed: false, resolved: false, replied: false, notice: false } as const;
  it("labels mechanically only on the spec's two rules", () => {
    expect(mechanicalDisposition({ ...base, fixed: true, resolved: true }, true)).toBe("accepted");
    expect(mechanicalDisposition({ ...base, fixed: true, resolved: true, replied: true }, true)).toBeNull();
    expect(mechanicalDisposition({ ...base, resolved: true }, true)).toBe("rejected");
    expect(mechanicalDisposition({ ...base, resolved: true }, false)).toBeNull();
    expect(mechanicalDisposition({ ...base, fixed: true }, true)).toBeNull();
  });
  it("never rejects when the fix signal is unknown", () => {
    expect(mechanicalDisposition({ ...base, fixed: null, resolved: true }, true)).toBeNull();
    expect(signalList({ ...base, fixed: null, resolved: true })).toEqual(["resolved", "unknown"]);
  });
});

describe("label row schema", () => {
  it("accepts a valid row", () => {
    expect(labelRowSchema.parse(validRow)).toEqual(validRow);
  });
  it("rejects rows carrying text or inconsistent categories", () => {
    expect(() => labelRowSchema.parse({ ...validRow, body: "x" })).toThrow();
    expect(() => labelRowSchema.parse({ ...validRow, disposition: "notice", category: "bug" })).toThrow();
    expect(() => labelRowSchema.parse({ ...validRow, category: null })).toThrow();
  });
});

describe("duplicates", () => {
  it("points fork companion findings at the upstream finding", () => {
    const [fork, up] = markDuplicates([row("me/repo", 7), row("org/repo", 1)], new Set(["me/repo"]));
    expect(up!.duplicate_of).toBeNull();
    expect(fork!.duplicate_of).toBe(up!.url);
  });
  it("leaves findings on different lines or reviewed commits alone", () => {
    for (const other of [{ line: 43 }, { head_sha: "e".repeat(40) }]) {
      const [a, b] = markDuplicates([row("me/repo", 7), { ...row("org/repo", 1), ...other }], new Set(["me/repo"]));
      expect(a!.duplicate_of).toBeNull();
      expect(b!.duplicate_of).toBeNull();
    }
  });
});
