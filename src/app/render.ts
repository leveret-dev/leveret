import { renderResolutions } from "./incremental.js";
import type { Finding, ScanResult } from "../findings.js";
import type { GraphStatus } from "./graph.js";
import type { PostWalkLeadAccounting } from "../runner/post-walk-leads.js";

// Rendering the verify output + scan result into the published review: tier-grouped
// inline comments and the what-was-checked walkthrough. Pure functions — the App's
// GitHub calls stay thin and untestworthy.

export type Tier = "critical" | "major" | "minor" | "nit";

export interface ReportItem {
  id: string;
  file: string;
  line: number;
  title: string;
  tier: Tier;
  severity: string;
  scope?: "in-diff" | "out-of-diff";
  correlation?: string;
  evidence: string;
  suggested_fix?: string;
  extra_real?: boolean | null;
  beyond_diff?: boolean | null;
}

export interface VerifyOutput {
  report: ReportItem[];
  verdicts: { id: string; grade: string; reason?: string }[];
  resolutions?: { threadId: string; status: "resolved" | "still-open"; note: string }[];
  coverage: {
    lenses: { lens: string; outcome: string }[];
    files: { file: string; verdict: string; note?: string }[];
  };
  run_configuration?: {
    capabilities?: {
      lsp?: boolean;
      probe?: boolean;
      lsp_error?: string;
      serena_version?: string;
    };
    discovery?: { mode?: string };
  };
  post_walk_leads?: {
    stream: { overflow: { count: number; bytes: number; ids: string[] } };
    accounting: PostWalkLeadAccounting;
    stop_gate_inputs?: Record<string, unknown>;
  };
}

const TIER_ORDER: Record<Tier, number> = { critical: 0, major: 1, minor: 2, nit: 3 };
const byTier = (a: ReportItem, b: ReportItem) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier];

export function renderWalkthrough(
  v: VerifyOutput,
  scan: ScanResult,
  graph?: GraphStatus,
): string {
  const all = [...v.report].sort(byTier);
  const outOfDiff = all.filter((r) => r.scope === "out-of-diff");
  const s: string[] = ["## Leveret review", ""];

  if (all.length === 0) {
    s.push("No actionable findings.", "");
  } else {
    s.push("### Findings", "");
    for (const r of all) {
      const marker = r.scope === "out-of-diff" ? " *(out-of-diff)*" : "";
      s.push(`- **[${r.tier}]** \`${r.file}:${r.line}\` — ${r.title}${marker}`);
    }
    s.push("");
  }

  if (outOfDiff.length > 0) {
    s.push(
      "### Out-of-diff findings",
      "",
      "Correlated defects in code this change does not touch (GitHub cannot attach these inline):",
      "",
    );
    for (const r of outOfDiff) {
      s.push(`- **[${r.tier}]** \`${r.file}:${r.line}\` — ${r.title}`);
      s.push(`  - correlation: ${r.correlation ?? "unstated"}`);
      s.push(`  - evidence: ${r.evidence}`);
    }
    s.push("");
  }

  if (scan.reminders.length > 0) {
    s.push(
      "### Reminders (pre-existing, adjacent to this change)",
      "",
      ...scan.reminders.map(
        (f: Finding) => `- \`${f.file}:${f.line}\` ${f.engine}/${f.rule} — ${f.message}`,
      ),
      "",
    );
  }

  s.push("### What was checked", "", "| lens | outcome |", "| --- | --- |");
  for (const l of v.coverage.lenses) s.push(`| ${l.lens} | ${l.outcome} |`);
  s.push("", "| file | verdict |", "| --- | --- |");
  for (const f of v.coverage.files) {
    s.push(`| \`${f.file}\` | ${f.verdict}${f.note ? ` — ${f.note}` : ""} |`);
  }

  if (graph) {
    // The graph is leveret's own capability, generated per-checkout at the exact
    // reviewed commit — its absence is a reviewer deficiency worth reporting, never
    // a property of the reviewed repo.
    s.push(
      "",
      graph.ok
        ? "Code graph: live (structural blast radius queried, not greped)."
        : `Code graph: unavailable — ${graph.detail ?? "unknown"}; blast radius fell back to ast_search/grep.`,
    );
  }
  const capabilities = v.run_configuration?.capabilities;
  const discoveryMode = v.run_configuration?.discovery?.mode;
  if (discoveryMode) s.push("", `Discovery: ${discoveryMode}.`);
  const postWalk = v.post_walk_leads;
  if (postWalk) {
    const metrics = postWalk.accounting.metrics;
    s.push(
      "",
      `Post-walk leads: ${metrics.generated} generated, ${metrics.routed} routed, ${metrics.supplied} supplied; ${metrics.adopted} adopted, ${metrics.verified} verified, ${metrics.refuted} refuted, ${metrics.priced} priced, ${metrics.ignored} ignored; adoption ${metrics.adoption_rate === null ? "unknown" : `${(metrics.adoption_rate * 100).toFixed(1)}%`}; ${postWalk.stream.overflow.count} overflow (${postWalk.stream.overflow.bytes} bytes).`,
    );
  }
  if (capabilities) {
    s.push(
      "",
      capabilities.lsp
        ? `LSP: live${capabilities.serena_version ? ` (Serena ${capabilities.serena_version})` : ""}.`
        : capabilities.lsp_error
          ? "LSP: unavailable — startup failed; details are retained in the private run artifact."
          : "LSP: unavailable — no staged server for this checkout.",
      capabilities.probe
        ? "Behavioral probe: available inside the declared review sandbox."
        : "Behavioral probe: unavailable — no review sandbox was declared.",
    );
  }
  {
    const ledger = renderResolutions(v.resolutions ?? []);
    if (ledger) s.push("", ledger);
  }
  s.push("", "### Engines", "", "| engine | status | found | kept |", "| --- | --- | --- | --- |");
  for (const e of scan.engines) {
    s.push(`| ${e.engine} | ${e.status} | ${e.found ?? "—"} | ${e.kept ?? "—"} |`);
  }

  const drops: string[] = [];
  for (const sup of scan.suppressed) drops.push(`- ${sup.rule}: ${sup.count} (${sup.reason})`);
  if (scan.preExisting > 0) drops.push(`- ${scan.preExisting} pre-existing (delta)`);
  for (const verdict of v.verdicts) {
    if (verdict.grade === "actionable") continue;
    drops.push(`- ${verdict.id}: ${verdict.grade}${verdict.reason ? ` (${verdict.reason})` : ""}`);
  }
  if (drops.length > 0) {
    s.push("", "### Examined and dropped (nothing is silent)", "", ...drops);
  }
  if (scan.baseErrors.length > 0) {
    s.push(
      "",
      "### Base-pass warnings",
      "",
      ...scan.baseErrors.map((e) => `- ${e.engine}: ${e.status}${e.detail ? ` — ${e.detail}` : ""}`),
    );
  }
  return s.join("\n");
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/** In-diff findings become inline review comments; out-of-diff cannot anchor to
 * the diff and live in the walkthrough instead. */
export function renderInline(v: VerifyOutput): InlineComment[] {
  return v.report
    .filter((r) => r.scope !== "out-of-diff")
    .sort(byTier)
    .map((r) => ({
      path: r.file,
      line: r.line,
      body: [
        `**[${r.tier}]** ${r.title}`,
        "",
        `evidence: ${r.evidence}`,
        ...(r.suggested_fix ? ["", `suggested fix: ${r.suggested_fix}`] : []),
      ].join("\n"),
    }));
}

// ── Acknowledgement comment ─────────────────────────────────────────────────
// Posted the moment a review job starts, then EDITED to the outcome — so the PR
// never shows a silent bot or an eternal "working on it".

export function ackMessage(headSha: string, model: string): string {
  return [
    `🐇 **Leveret is on it.**`,
    "",
    `Checking out \`${headSha.slice(0, 7)}\`, running the engines, then handing the`,
    `leads to the reviewing agent (${model}). Findings arrive as inline comments`,
    `plus a walkthrough — give it a few minutes.`,
  ].join("\n");
}

export function doneMessage(v: VerifyOutput): string {
  const counts = new Map<Tier, number>();
  for (const r of v.report) counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);
  const tiers = (["critical", "major", "minor", "nit"] as Tier[])
    .filter((t) => counts.has(t))
    .map((t) => `${counts.get(t)} ${t}`)
    .join(", ");
  const summary = v.report.length === 0 ? "no findings to report" : tiers;
  return [
    `🐇 **Review posted** — ${summary}; ${v.verdicts.length} items examined in total`,
    `(everything judged is accounted for in the walkthrough, including what was`,
    `dropped and why).`,
  ].join("\n");
}

export function failMessage(err: unknown, runId?: string): string {
  return [
    `🐇 **Review failed** before it could post: \`${String(err).slice(0, 300)}\``,
    "",
    `Run \`${runId ?? "unknown"}\` — the server logs carry that id on every line;`,
    `push a new commit or re-open to retry.`,
  ].join("\n");
}

export function skipMessage(reason: string): string {
  return [
    `🐇 Noticed this pull request — but the repository's configuration asked me to`,
    `sit this one out (${reason}). Not reviewing; ping me by changing the config if`,
    `that's not what you wanted.`,
  ].join("\n");
}
