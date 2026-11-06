// Pure labelling logic for the bot review miner (docs/superpowers/specs/2026-11-06-bot-gap-analysis-design.md).
import { z } from "zod";

export const CATEGORIES = ["bug", "security", "concurrency", "error-handling", "test-integrity", "performance", "api-contract", "docs", "style", "other"] as const;
export const LINE_WINDOW = 3;
const SIGNALS = ["fixed", "resolved", "replied", "notice", "unknown"] as const;

const hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));

// Strict: the committed label file must never gain a field that could carry comment or code text.
export const labelRowSchema = z.object({
  url: z.url(),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  pull_request: z.number().int().positive(),
  bot: z.string().min(1),
  kind: z.enum(["inline", "review", "conversation"]),
  path: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  head_sha: hex(40).nullable(),
  category: z.enum(CATEGORIES).nullable(),
  disposition: z.enum(["accepted", "rejected", "unclear", "notice"]),
  signals: z.array(z.enum(SIGNALS)),
  label_source: z.enum(["mechanical", "judge"]),
  judge: z.object({ model: z.string().min(1), prompt_sha256: hex(64) }).strict().nullable(),
  duplicate_of: z.url().nullable(),
}).strict().refine((row) => (row.category === null) === (row.disposition === "notice"), "category is null exactly on notice rows");
export type LabelRow = z.infer<typeof labelRowSchema>;

const KNOWN_BOTS = new Set(["openwrt-ai", "roboomp", "kilo-code-bot"]);
export function isBot(user: { login: string; type: string }): boolean {
  return user.type === "Bot" || user.login.endsWith("[bot]") || KNOWN_BOTS.has(user.login);
}

// Accounts that post as the same reviewer under different logins.
const BOT_ALIASES: Record<string, string> = { Copilot: "copilot-pull-request-reviewer[bot]" };
export function botName(login: string): string {
  return BOT_ALIASES[login] ?? login;
}

type Kind = LabelRow["kind"];
// One row per known non-finding format. Review/conversation bodies that only summarize inline
// comments, report limits, or answer chat are notices; anything else a bot says is a finding.
const NOTICES: Array<{ bot: string; kinds: Kind[]; pattern: RegExp }> = [
  { bot: "coderabbitai", kinds: ["conversation"], pattern: /summarize by coderabbit\.ai|auto-generated reply by CodeRabbit/ },
  { bot: "coderabbitai", kinds: ["review"], pattern: /^(?![\s\S]*(Outside diff range comments|Nitpick comments))/ },
  { bot: "chatgpt-codex-connector", kinds: ["conversation", "review"], pattern: /usage limits have been reached|codex-review-receipt|codex-pull-request-review-summary|Codex Review|To use Codex here/ },
  // shortcut: Kilo summaries are treated as notices because their findings repeat inline; parse them if a summary-only finding shows up.
  { bot: "kilo-code-bot", kinds: ["conversation", "review"], pattern: /<!-- kilo-review -->/ },
  { bot: "roboomp", kinds: ["review"], pattern: /[\s\S]/ },
  // Copilot review bodies are overviews, verdicts, or quota notices; its findings are inline.
  { bot: "copilot-pull-request-reviewer", kinds: ["review", "conversation"], pattern: /[\s\S]/ },
  { bot: "openwrt-ai", kinds: ["conversation", "review"], pattern: /no new issues found/i },
];

export function isNotice(bot: string, kind: Kind, body: string): boolean {
  if (body.trim() === "") return true;
  const login = botName(bot).replace(/\[bot\]$/, "");
  return NOTICES.some((notice) => notice.bot === login && notice.kinds.includes(kind) && notice.pattern.test(body));
}

/** Old-side line ranges a unified diff actually changes; an insertion counts as touching the line before it. */
export interface Hunk { start: number; end: number }
export function parseHunks(patch: string): Hunk[] {
  const changed: Hunk[] = [];
  let cursor = 0;
  for (const line of patch.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (header) {
      // With a zero count, the header names the line before the hunk.
      cursor = Number(header[1]) + (header[2] === "0" ? 1 : 0);
    } else if (line.startsWith("-")) {
      changed.push({ start: cursor, end: cursor });
      cursor++;
    } else if (line.startsWith("+")) {
      changed.push({ start: Math.max(cursor - 1, 1), end: Math.max(cursor - 1, 1) });
    } else if (line.startsWith(" ")) {
      cursor++;
    }
  }
  return changed;
}

export function touchesWindow(hunks: Hunk[], start: number, end: number): boolean {
  return hunks.some((hunk) => hunk.start <= end + LINE_WINDOW && hunk.end >= start - LINE_WINDOW);
}

export interface Signals { fixed: boolean | null; resolved: boolean; replied: boolean; notice: boolean }
export function signalList(signals: Signals): LabelRow["signals"] {
  const list: LabelRow["signals"] = [];
  if (signals.fixed === true) list.push("fixed");
  if (signals.fixed === null) list.push("unknown");
  if (signals.resolved) list.push("resolved");
  if (signals.replied) list.push("replied");
  if (signals.notice) list.push("notice");
  return list.sort();
}

/** The spec's two mechanical rules; null sends the finding to the judge. */
export function mechanicalDisposition(signals: Signals, merged: boolean): "accepted" | "rejected" | null {
  if (signals.fixed === true && signals.resolved && !signals.replied) return "accepted";
  if (signals.fixed === false && signals.resolved && merged) return "rejected";
  return null;
}

/** Links a fork companion's finding to the upstream finding on the same head, bot, path, and line. */
export function markDuplicates(rows: LabelRow[], forkRepos: Set<string>): LabelRow[] {
  const groups = new Map<string, LabelRow[]>();
  for (const row of rows) {
    if (row.kind !== "inline" || !row.head_sha) continue;
    const key = [row.head_sha, row.bot, row.path, row.line].join("\0");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const canonical = new Map<string, string>();
  for (const group of groups.values()) {
    if (new Set(group.map((row) => row.repository)).size < 2) continue;
    const [first] = [...group].sort((a, b) => Number(forkRepos.has(a.repository)) - Number(forkRepos.has(b.repository)) || a.url.localeCompare(b.url));
    for (const row of group) if (row.repository !== first!.repository) canonical.set(row.url, first!.url);
  }
  return rows.map((row) => ({ ...row, duplicate_of: canonical.get(row.url) ?? null }));
}
