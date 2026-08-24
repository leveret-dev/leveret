import { redactAuditText } from "../audit.js";

// Cloud-ready structured logging: one JSON object per line. Every review run gets
// a UUID bound into its logger; app-mode runs also bind the PR URL — any
// aggregator slices by run without parsing prose.

export type Level = "info" | "warn" | "error";

function plain(v: unknown): unknown {
  return v instanceof Error ? redactAuditText(v.stack ?? String(v)) : typeof v === "string" ? redactAuditText(v) : v;
}

export function formatLine(
  level: Level,
  msg: string,
  bound: Record<string, unknown>,
  extra?: Record<string, unknown>,
): string {
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...bound };
  for (const [k, v] of Object.entries(extra ?? {})) rec[k] = plain(v);
  return JSON.stringify(rec);
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function makeLogger(
  bound: Record<string, unknown>,
  sink: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  capture?: (record: Record<string, unknown>) => void,
): Logger {
  const at =
    (level: Level) =>
    (msg: string, extra?: Record<string, unknown>): void => {
      const line = formatLine(level, msg, bound, extra);
      sink(line);
      capture?.(JSON.parse(line) as Record<string, unknown>);
    };
  return { info: at("info"), warn: at("warn"), error: at("error") };
}
