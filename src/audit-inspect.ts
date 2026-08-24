#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { AUDIT_SCHEMA_VERSION, validateAuditEvent, verifyChecksums } from "./audit.js";

interface EventRecord {
  schema: number;
  run_id: string;
  wall_time: string;
  monotonic_ms: number;
  producer: string;
  sequence: number;
  category: string;
  event: string;
  completeness: "complete" | "truncated" | "partial";
  content_policy: "full" | "metadata" | "hash" | "off";
  phase?: string;
  attempt?: number;
  session_id?: string;
  tool_call_id?: string;
  evidence_id?: string;
  payload?: unknown;
  payload_ref?: { sha256: string };
  _stream?: string;
}

async function manifests(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name === "manifest.json") found.push(child);
    }
  }
  await walk(root);
  return found.sort();
}

async function eventStreams(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const child = join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await eventStreams(root, child));
    else if (entry.name.endsWith(".ndjson")) found.push(child);
  }
  return found.sort();
}

async function events(runDir: string, names?: string[], deduplicate = true): Promise<EventRecord[]> {
  const result: EventRecord[] = [];
  for (const name of names ?? await eventStreams(runDir)) {
    try {
      for (const line of (await readFile(join(runDir, name), "utf8")).split("\n").filter(Boolean)) result.push({ ...(JSON.parse(line) as EventRecord), _stream: name });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`invalid audit stream ${name}: ${String(error)}`);
    }
  }
  const sorted = result.sort((a, b) => a.wall_time.localeCompare(b.wall_time) || a.producer.localeCompare(b.producer) || a.sequence - b.sequence);
  if (!deduplicate) return sorted;
  const unique = new Map<string, EventRecord>();
  for (const event of sorted) {
    const key = `${event.producer}:${event.sequence}`;
    const previous = unique.get(key);
    if (!previous || (!previous.payload && !previous.payload_ref && (event.payload !== undefined || event.payload_ref))) unique.set(key, event);
  }
  return [...unique.values()].sort((a, b) => a.wall_time.localeCompare(b.wall_time) || a.producer.localeCompare(b.producer) || a.sequence - b.sequence);
}

async function validateEvents(runDir: string, runId: string): Promise<number> {
  const records = await events(runDir, undefined, false);
  const sequences = new Map<string, Set<number>>();
  const unique = new Set<string>();
  for (const event of records) {
    const stream = event._stream;
    validateAuditEvent(event, runId);
    const sequenceKey = `${event.producer}:${stream}`;
    const seen = sequences.get(sequenceKey) ?? new Set<number>();
    if (seen.has(event.sequence)) throw new Error(`duplicate ${event.producer} sequence in ${stream}: ${event.sequence}`);
    seen.add(event.sequence);
    sequences.set(sequenceKey, seen);
    unique.add(`${event.producer}:${event.sequence}`);
    if (event.payload_ref) {
      if (!/^[a-f0-9]{64}$/.test(event.payload_ref.sha256)) throw new Error(`invalid audit blob reference: ${event.payload_ref.sha256}`);
      const blob = await readFile(join(runDir, "blobs", "sha256", event.payload_ref.sha256));
      const { createHash } = await import("node:crypto");
      if (createHash("sha256").update(blob).digest("hex") !== event.payload_ref.sha256) throw new Error(`invalid audit blob: ${event.payload_ref.sha256}`);
    }
  }
  return unique.size;
}

async function validateSessions(runDir: string): Promise<number> {
  let count = 0;
  try {
    for (const file of await readdir(join(runDir, "sessions"))) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of (await readFile(join(runDir, "sessions", file), "utf8")).split("\n").filter(Boolean)) {
        JSON.parse(line);
        count++;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`invalid native session: ${String(error)}`);
  }
  return count;
}

async function sessionMatches(runDir: string, selector: string): Promise<unknown[]> {
  const result: unknown[] = [];
  try {
    for (const file of await readdir(join(runDir, "sessions"))) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of (await readFile(join(runDir, "sessions", file), "utf8")).split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const message = entry.message as Record<string, unknown> | undefined;
        if (file === selector || file.replace(/\.jsonl$/, "") === selector || file.startsWith(`${selector}-attempt-`) || entry.id === selector || message?.toolCallId === selector) {
          result.push({ session: file, entry });
        }
      }
    }
  } catch {
    // Sessions may be disabled by owner policy.
  }
  return result;
}

export async function inspectAudit(argv: string[], write: (line: string) => void = console.log): Promise<void> {
  const [command, path, selector] = argv;
  if (!command || !path) throw new Error("usage: leveret-audit <list|validate|summary|extract> <root-or-run> [phase-or-id]");
  if (command === "list") {
    for (const manifestPath of await manifests(path)) write(JSON.stringify(JSON.parse(await readFile(manifestPath, "utf8"))));
    return;
  }
  if (command === "validate") {
    await verifyChecksums(path);
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8")) as { schema: number; run_id: string; status: string; completeness?: string; gaps?: string[] };
    if (manifest.schema !== AUDIT_SCHEMA_VERSION || !manifest.run_id || !["complete", "failed"].includes(manifest.status)) throw new Error("invalid audit manifest");
    const eventCount = await validateEvents(path, manifest.run_id);
    const sessionEntries = await validateSessions(path);
    write(JSON.stringify({ run_id: manifest.run_id, status: manifest.status, checksums: "valid", events: eventCount, session_entries: sessionEntries, completeness: manifest.completeness ?? ((manifest.gaps?.length) ? "incomplete" : "complete"), gaps: manifest.gaps ?? [] }));
    return;
  }
  const records = await events(path);
  if (command === "summary") {
    for (const event of records) write([event.wall_time, event.producer, event.phase ?? "-", event.attempt ?? "-", event.category, event.event].join("\t"));
    return;
  }
  if (command === "extract" && selector) {
    if (/^[a-f0-9]{64}$/.test(selector)) {
      try {
        write(await readFile(join(path, "blobs", "sha256", selector), "utf8"));
        return;
      } catch {
        // It may be an event payload hash rather than a blob.
      }
    }
    const matched = records.filter((event) => event.phase === selector || event.session_id === selector || event.tool_call_id === selector || event.evidence_id === selector || event.payload_ref?.sha256 === selector);
    const sessions = await sessionMatches(path, selector);
    if (matched.length === 0 && sessions.length === 0) throw new Error(`audit selector not found: ${selector}`);
    for (const value of [...matched, ...sessions]) write(JSON.stringify(value, null, 2));
    return;
  }
  throw new Error(`unknown audit command: ${basename(command)}`);
}

if (process.argv[1]?.endsWith("audit-inspect.js")) {
  inspectAudit(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
