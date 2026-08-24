import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathIsInside } from "./path.js";

export const AUDIT_SCHEMA_VERSION = 1;
export const AUDIT_CATEGORIES = [
  "app",
  "repository",
  "prompts",
  "assistant",
  "tools",
  "subprocess",
  "provider",
  "lifecycle",
  "operational",
  "result",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditContentPolicy = "full" | "metadata" | "hash" | "off";
export type AuditSink = "private" | "operational" | "archive" | "export";
export type AuditFailurePolicy = "fail" | "continue";

export interface AuditConfig {
  enabled: boolean;
  root: string;
  policies: Record<AuditCategory, AuditContentPolicy>;
  sinks: AuditSink[];
  categorySinks: Record<AuditCategory, AuditSink[]>;
  categoryRetentionDays: Record<AuditCategory, number>;
  failurePolicy: AuditFailurePolicy;
  archiveCodec: "auto" | "zstd" | "gzip";
  compressionLevel: number;
  keepUnpacked: boolean;
  archiveIncomplete: boolean;
  retentionDays: number;
  retentionCount: number;
  retentionBytes: number;
  minimumFreeBytes: number;
  blobThresholdBytes: number;
}

export interface AuditContext {
  phase?: string;
  attempt?: number;
  sessionId?: string;
  turn?: number;
  toolCallId?: string;
  evidenceId?: string;
  completeness?: "complete" | "truncated" | "partial";
}

export interface AuditArchive {
  path: string;
  sha256: string;
  bytes: number;
  mediaType: "application/zstd" | "application/gzip";
}

export interface AuditFinalization {
  runDir?: string;
  archive?: AuditArchive;
  degradation?: string;
  status: "disabled" | "complete" | "failed";
  completeness: "complete" | "incomplete" | "disabled";
}

export interface AuditEvent {
  schema: number;
  run_id: string;
  producer: "app" | "runner";
  sequence: number;
  wall_time: string;
  monotonic_ms: number;
  category: AuditCategory;
  event: string;
  phase?: string;
  attempt?: number;
  session_id?: string;
  turn?: number;
  tool_call_id?: string;
  evidence_id?: string;
  completeness: "complete" | "truncated" | "partial";
  content_policy: AuditContentPolicy;
  payload?: unknown;
  payload_ref?: { sha256: string; bytes: number; media_type: string; encoding: "json" };
  metadata?: { sha256: string; bytes: number; kind: string };
}

export function validateAuditEvent(value: unknown, runId: string): asserts value is AuditEvent {
  const event = value as Partial<AuditEvent>;
  if (event.schema !== AUDIT_SCHEMA_VERSION || event.run_id !== runId
    || (event.producer !== "app" && event.producer !== "runner")
    || !Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) < 1
    || typeof event.wall_time !== "string" || Number.isNaN(Date.parse(event.wall_time))
    || typeof event.monotonic_ms !== "number" || event.monotonic_ms < 0
    || !AUDIT_CATEGORIES.includes(event.category as AuditCategory)
    || typeof event.event !== "string" || !event.event
    || !(["complete", "truncated", "partial"] as unknown[]).includes(event.completeness)
    || !(["full", "metadata", "hash", "off"] as unknown[]).includes(event.content_policy)) {
    throw new Error("invalid audit event envelope");
  }
  if (event.payload_ref && (!/^[a-f0-9]{64}$/.test(event.payload_ref.sha256) || !Number.isSafeInteger(event.payload_ref.bytes) || event.payload_ref.bytes < 0)) {
    throw new Error("invalid audit blob reference");
  }
}

interface Manifest {
  schema: number;
  run_id: string;
  status: "partial" | "complete" | "failed";
  completeness: "partial" | "complete" | "incomplete";
  started_at: string;
  completed_at?: string;
  host: { hostname: string; pid: number };
  policy: AuditConfig;
  categories: Record<AuditCategory, {
    policy: AuditContentPolicy;
    state: "captured" | "disabled" | "unavailable" | "redacted" | "incomplete" | "expired";
    events: number;
  }>;
  redacted_fields: string[];
  gaps: string[];
  capabilities?: unknown;
  error?: string;
}

const exec = promisify(execFile);
const storage = new AsyncLocalStorage<AuditWriter>();
const SECRET_FIELD = /^(?:api.?key|authorization|credentials?|password|private.?keys?|secret|signature|token|access.?token|refresh.?token|webhook.?secret|cookie|set.?cookie)$/i;
const SECRET_ARGUMENT = /^--?(?:api[-_]?key|token|secret|password|authorization)$/i;
const SECRET_TEXT = [
  /\bBearer\s+[^\s"']+/gi,
  /(--?(?:api[-_]?key|token|secret|password|authorization)=)[^\s]+/gi,
  /(--?(?:api[-_]?key|token|secret|password|authorization)\s+)[^\s]+/gi,
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`invalid boolean audit setting: ${value}`);
}

function nonNegative(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function parsePolicies(raw: string | undefined): Record<AuditCategory, AuditContentPolicy> {
  const policies = Object.fromEntries(AUDIT_CATEGORIES.map((category) => [category, category === "operational" ? "metadata" : "full"])) as Record<AuditCategory, AuditContentPolicy>;
  if (!raw) return policies;
  const input = JSON.parse(raw) as Record<string, unknown>;
  for (const [category, policy] of Object.entries(input)) {
    if (!AUDIT_CATEGORIES.includes(category as AuditCategory)) throw new Error(`unknown audit category: ${category}`);
    if (!(["full", "metadata", "hash", "off"] as unknown[]).includes(policy)) throw new Error(`invalid audit policy for ${category}`);
    policies[category as AuditCategory] = policy as AuditContentPolicy;
  }
  return policies;
}

function validateSinks(values: string[]): AuditSink[] {
  const sinks = values.map((value) => value.trim()).filter(Boolean);
  if (sinks.length === 0) throw new Error("at least one audit sink is required when capture is enabled");
  for (const sink of sinks) {
    if (!(["private", "operational", "archive", "export"] as string[]).includes(sink)) throw new Error(`invalid audit sink: ${sink}`);
  }
  return [...new Set(sinks)] as AuditSink[];
}

function parseSinks(raw: string | undefined): AuditSink[] {
  return validateSinks((raw ?? "private,operational,archive").split(","));
}

function parseCategorySinks(raw: string | undefined, defaults: AuditSink[]): Record<AuditCategory, AuditSink[]> {
  const result = Object.fromEntries(AUDIT_CATEGORIES.map((category) => [category, [...defaults]])) as Record<AuditCategory, AuditSink[]>;
  if (!raw) return result;
  const input = JSON.parse(raw) as Record<string, unknown>;
  for (const [category, value] of Object.entries(input)) {
    if (!AUDIT_CATEGORIES.includes(category as AuditCategory)) throw new Error(`unknown audit category sink: ${category}`);
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    if (!values.every((sink) => typeof sink === "string")) throw new Error(`invalid audit sinks for ${category}`);
    result[category as AuditCategory] = validateSinks(values as string[]);
  }
  return result;
}

function parseCategoryRetention(raw: string | undefined): Record<AuditCategory, number> {
  const result = Object.fromEntries(AUDIT_CATEGORIES.map((category) => [category, 0])) as Record<AuditCategory, number>;
  if (!raw) return result;
  const input = JSON.parse(raw) as Record<string, unknown>;
  for (const [category, value] of Object.entries(input)) {
    if (!AUDIT_CATEGORIES.includes(category as AuditCategory)) throw new Error(`unknown audit category retention: ${category}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`invalid audit retention for ${category}`);
    result[category as AuditCategory] = value;
  }
  return result;
}

export function auditConfig(dataDir: string, env: NodeJS.ProcessEnv = process.env): AuditConfig {
  const codec = env.LEVERET_TRACE_ARCHIVE_CODEC ?? "auto";
  if (!(["auto", "zstd", "gzip"] as string[]).includes(codec)) throw new Error(`invalid archive codec: ${codec}`);
  const failurePolicy = env.LEVERET_TRACE_FAILURE ?? "fail";
  if (failurePolicy !== "fail" && failurePolicy !== "continue") throw new Error(`invalid trace failure policy: ${failurePolicy}`);
  const sinks = parseSinks(env.LEVERET_TRACE_SINKS);
  const categorySinks = parseCategorySinks(env.LEVERET_TRACE_CATEGORY_SINKS, sinks);
  const categoryRetentionDays = parseCategoryRetention(env.LEVERET_TRACE_CATEGORY_RETENTION_DAYS);
  for (const category of AUDIT_CATEGORIES) {
    if (categoryRetentionDays[category] > 0 && categorySinks[category].some((sink) => sink === "archive" || sink === "export")) {
      throw new Error(`${category} cannot use finite category retention with an immutable archive/export sink`);
    }
  }
  return {
    enabled: bool(env.LEVERET_TRACE_ENABLED, true),
    root: resolve(env.LEVERET_TRACE_ROOT ?? join(dataDir, "runs")),
    policies: parsePolicies(env.LEVERET_TRACE_POLICY),
    sinks,
    categorySinks,
    categoryRetentionDays,
    failurePolicy,
    archiveCodec: codec as AuditConfig["archiveCodec"],
    compressionLevel: nonNegative(env.LEVERET_TRACE_COMPRESSION_LEVEL, 6, "LEVERET_TRACE_COMPRESSION_LEVEL"),
    keepUnpacked: bool(env.LEVERET_TRACE_KEEP_UNPACKED, true),
    archiveIncomplete: bool(env.LEVERET_TRACE_ARCHIVE_INCOMPLETE, true),
    retentionDays: nonNegative(env.LEVERET_TRACE_RETENTION_DAYS, 0, "LEVERET_TRACE_RETENTION_DAYS"),
    retentionCount: nonNegative(env.LEVERET_TRACE_RETENTION_COUNT, 0, "LEVERET_TRACE_RETENTION_COUNT"),
    retentionBytes: nonNegative(env.LEVERET_TRACE_RETENTION_BYTES, 0, "LEVERET_TRACE_RETENTION_BYTES"),
    minimumFreeBytes: nonNegative(env.LEVERET_TRACE_MIN_FREE_BYTES, 0, "LEVERET_TRACE_MIN_FREE_BYTES"),
    blobThresholdBytes: nonNegative(env.LEVERET_TRACE_BLOB_BYTES, 64 * 1024, "LEVERET_TRACE_BLOB_BYTES"),
  };
}

export function redactAuditText(value: string): string {
  let result = value;
  for (const pattern of SECRET_TEXT) result = result.replace(pattern, "[REDACTED]");
  return result;
}

function sanitize(value: unknown, redacted: Set<string>, path = "payload"): unknown {
  if (value instanceof Error) {
    const raw = value.stack ?? String(value);
    const clean = redactAuditText(raw);
    if (clean !== raw) redacted.add(path);
    return clean;
  }
  if (typeof value === "string") {
    const clean = redactAuditText(value);
    if (clean !== value) redacted.add(path);
    return clean;
  }
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map((item, index) => {
      if (redactNext) {
        redactNext = false;
        redacted.add(`${path}[${index}]`);
        return "[REDACTED]";
      }
      if (typeof item === "string" && SECRET_ARGUMENT.test(item)) redactNext = true;
      return sanitize(item, redacted, `${path}[${index}]`);
    });
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (SECRET_FIELD.test(key)) {
        result[key] = "[REDACTED]";
        redacted.add(childPath);
      } else {
        result[key] = sanitize(child, redacted, childPath);
      }
    }
    return result;
  }
  return value;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function categoryRecord(config: AuditConfig): Manifest["categories"] {
  return Object.fromEntries(AUDIT_CATEGORIES.map((category) => [category, {
    policy: config.policies[category],
    state: config.policies[category] === "off" ? "disabled" : "unavailable",
    events: 0,
  }])) as Manifest["categories"];
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function secureWrite(path: string, body: string | Buffer): Promise<void> {
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(root, rel));
    else if (entry.isSymbolicLink()) throw new Error(`audit store contains a symbolic link: ${rel}`);
    else result.push(rel);
  }
  return result;
}

async function secureTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await secureTree(path);
    else if (entry.isSymbolicLink()) throw new Error(`audit store contains a symbolic link: ${path}`);
    else await chmod(path, 0o600);
  }
}

async function writeChecksums(runDir: string): Promise<void> {
  const files = (await filesUnder(runDir)).filter((file) => file !== "checksums.sha256").sort();
  const lines: string[] = [];
  for (const file of files) lines.push(`${await digestFile(join(runDir, file))}  ${file}`);
  await secureWrite(join(runDir, "checksums.sha256"), `${lines.join("\n")}\n`);
}

export async function verifyChecksums(runDir: string): Promise<void> {
  const rows = (await readFile(join(runDir, "checksums.sha256"), "utf8")).trim().split("\n").filter(Boolean);
  const expectedFiles = (await filesUnder(runDir)).filter((file) => file !== "checksums.sha256").sort();
  const recordedFiles: string[] = [];
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  (.+)$/);
    const file = match?.[2];
    if (!file || !pathIsInside(resolve(runDir), resolve(runDir, file))) throw new Error(`invalid audit checksum path: ${file ?? row}`);
    recordedFiles.push(file);
    if (await digestFile(join(runDir, file)) !== match![1]) throw new Error(`audit checksum mismatch: ${file}`);
  }
  if (JSON.stringify(recordedFiles.sort()) !== JSON.stringify(expectedFiles)) throw new Error("audit checksum inventory does not match run files");
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await exec("/usr/bin/which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function archiveRun(config: AuditConfig, runDir: string, includeSessions: boolean, includeResult: boolean): Promise<AuditArchive> {
  const zstd = config.archiveCodec === "zstd" || (config.archiveCodec === "auto" && await commandExists("zstd"));
  if (config.archiveCodec === "zstd" && !zstd) throw new Error("zstd requested but unavailable");
  const archiveDir = join(config.root, "archives", ...new Date().toISOString().slice(0, 10).split("-"));
  await secureDirectory(archiveDir);
  const extension = zstd ? ".tar.zst" : ".tar.gz";
  const path = join(archiveDir, `${basename(runDir)}${extension}`);
  const env = { ...process.env, ...(zstd ? { ZSTD_CLEVEL: String(config.compressionLevel) } : { GZIP: `-${Math.min(9, config.compressionLevel)}` }) };
  const temporary = await mkdtemp(join(tmpdir(), "leveret-audit-archive-"));
  const staged = join(temporary, basename(runDir));
  try {
    await secureDirectory(staged);
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Manifest;
    for (const category of AUDIT_CATEGORIES) {
      if (!config.categorySinks[category].some((sink) => sink === "archive" || sink === "export")) {
        manifest.categories[category] = { ...manifest.categories[category], state: "disabled", events: 0 };
      }
    }
    await secureWrite(join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const file of ["app-capabilities.json", "runner-capabilities.json"]) {
      try { await copyFile(join(runDir, file), join(staged, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const blobs = new Set<string>();
    for (const producer of ["app", "runner"] as const) {
      try {
        const source = join(runDir, `${producer}.archive.ndjson`);
        const content = await readFile(source, "utf8");
        await secureWrite(join(staged, `${producer}.ndjson`), content);
        for (const line of content.split("\n").filter(Boolean)) {
          const ref = (JSON.parse(line) as AuditEvent).payload_ref?.sha256;
          if (ref) {
            if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error(`invalid audit blob reference: ${ref}`);
            blobs.add(ref);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (includeResult) {
      try { await copyFile(join(runDir, "result.json"), join(staged, "result.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (includeSessions) {
      try { await cp(join(runDir, "sessions"), join(staged, "sessions"), { recursive: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (blobs.size > 0) {
      await secureDirectory(join(staged, "blobs", "sha256"));
      for (const blob of blobs) await copyFile(join(runDir, "blobs", "sha256", blob), join(staged, "blobs", "sha256", blob));
    }
    await secureTree(staged);
    await writeChecksums(staged);
    await verifyChecksums(staged);
    await exec("tar", ["-caf", path, "--", basename(staged)], { cwd: dirname(staged), env, maxBuffer: 64 * 1024 * 1024 });
    await exec("tar", ["-tf", path], { maxBuffer: 64 * 1024 * 1024 });
    await chmod(path, 0o600);
    const bytes = (await stat(path)).size;
    return { path, sha256: await digestFile(path), bytes, mediaType: zstd ? "application/zstd" : "application/gzip" };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export class AuditWriter {
  readonly runId: string;
  readonly producer: "app" | "runner";
  readonly config: AuditConfig;
  readonly partialDir: string;
  readonly sessionsDir: string;
  private sequence = 0;
  private startedMono = performance.now();
  private pending = Promise.resolve();
  private failure: unknown;
  private state: "open" | "finalizing" | "closed" = "open";
  private gaps = new Set<string>();
  private redacted = new Set<string>();
  private startedAt: string;

  constructor(runId: string, producer: "app" | "runner", config: AuditConfig, partialDir: string, startedAt = new Date().toISOString()) {
    this.runId = runId;
    this.producer = producer;
    this.config = config;
    this.partialDir = resolve(partialDir);
    this.sessionsDir = join(this.partialDir, "sessions");
    this.startedAt = startedAt;
  }

  async initialize(): Promise<void> {
    if (!this.config.enabled) return;
    await secureDirectory(this.partialDir);
    if (this.config.minimumFreeBytes > 0) {
      const space = await statfs(this.partialDir);
      if (Number(space.bavail) * Number(space.bsize) < this.config.minimumFreeBytes) throw new Error("audit trace root is below LEVERET_TRACE_MIN_FREE_BYTES");
    }
    await secureDirectory(this.sessionsDir);
    await secureDirectory(join(this.partialDir, "blobs", "sha256"));
    if (this.producer === "app") await this.writeManifest("partial");
  }

  private async readEventRecords(): Promise<{ records: Array<{ event: AuditEvent; line: string }>; invalid: boolean }> {
    const records: Array<{ event: AuditEvent; line: string }> = [];
    let invalid = false;
    for (const stream of (await filesUnder(this.partialDir)).filter((file) => file.endsWith(".ndjson"))) {
      const sequences = new Set<number>();
      for (const line of (await readFile(join(this.partialDir, stream), "utf8")).split("\n").filter(Boolean)) {
        try {
          const event = JSON.parse(line) as AuditEvent;
          validateAuditEvent(event, this.runId);
          if (sequences.has(event.sequence)) throw new Error(`duplicate sequence ${event.sequence}`);
          sequences.add(event.sequence);
          records.push({ event, line });
        } catch {
          invalid = true;
          this.gaps.add(`${stream} contains an incomplete event`);
        }
      }
    }
    return { records, invalid };
  }

  private async writeManifest(status: Manifest["status"], error?: unknown, capabilities?: unknown): Promise<void> {
    const categories = categoryRecord(this.config);
    const seenEvents = new Set<string>();
    for (const { event, line } of (await this.readEventRecords()).records) {
      const key = `${event.producer}:${event.sequence}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      const category = categories[event.category];
      category.events++;
      const next = event.completeness === "complete" ? line.includes("[REDACTED]") ? "redacted" : "captured" : "incomplete";
      if (category.state !== "incomplete" && (category.state !== "redacted" || next === "incomplete")) category.state = next;
    }
    const rawError = error === undefined ? undefined : String(error);
    const errorText = rawError === undefined ? undefined : redactAuditText(rawError);
    if (rawError !== errorText) this.redacted.add("manifest.error");
    const redactedFields = new Set(this.redacted);
    const manifest: Manifest = {
      schema: AUDIT_SCHEMA_VERSION,
      run_id: this.runId,
      status,
      completeness: status === "partial" ? "partial" : this.gaps.size > 0 ? "incomplete" : "complete",
      started_at: this.startedAt,
      ...(status === "partial" ? {} : { completed_at: new Date().toISOString() }),
      host: { hostname: hostname(), pid: process.pid },
      policy: this.config,
      categories,
      redacted_fields: [...redactedFields].sort(),
      gaps: [...this.gaps].sort(),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(errorText === undefined ? {} : { error: errorText }),
    };
    await secureWrite(join(this.partialDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private queue(operation: () => Promise<void>): Promise<void> {
    if (this.failure && this.config.failurePolicy === "fail") return Promise.reject(this.failure);
    const task = this.pending.then(operation);
    this.pending = task.catch((error) => {
      this.failure = error;
      this.gaps.add(`capture failure: ${redactAuditText(String(error))}`);
    });
    return this.config.failurePolicy === "fail" ? task : this.pending;
  }

  record(category: AuditCategory, event: string, payload?: unknown, context: AuditContext = {}): Promise<void> {
    if (!this.config.enabled || this.config.policies[category] === "off") return Promise.resolve();
    if (this.state !== "open") {
      const error = new Error(`audit writer is ${this.state}`);
      this.gaps.add(`late ${category}/${event} event rejected during ${this.state}`);
      return this.config.failurePolicy === "fail" ? Promise.reject(error) : Promise.resolve();
    }
    if (context.completeness && context.completeness !== "complete") this.gaps.add(`${category}/${event} was ${context.completeness}`);
    const sequence = ++this.sequence;
    return this.queue(async () => {
      const clean = sanitize(payload ?? {}, this.redacted);
      const encoded = JSON.stringify(clean);
      const policy = this.config.policies[category];
      const envelope: AuditEvent = {
        schema: AUDIT_SCHEMA_VERSION,
        run_id: this.runId,
        producer: this.producer,
        sequence,
        wall_time: new Date().toISOString(),
        monotonic_ms: Math.max(0, performance.now() - this.startedMono),
        category,
        event,
        ...(context.phase ? { phase: context.phase } : {}),
        ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
        ...(context.turn !== undefined ? { turn: context.turn } : {}),
        ...(context.toolCallId ? { tool_call_id: context.toolCallId } : {}),
        ...(context.evidenceId ? { evidence_id: context.evidenceId } : {}),
        completeness: context.completeness ?? "complete",
        content_policy: policy,
      };
      if (policy === "full" && Buffer.byteLength(encoded) > this.config.blobThresholdBytes) {
        const sha256 = digest(encoded);
        const path = join(this.partialDir, "blobs", "sha256", sha256);
        try { await stat(path); } catch { await secureWrite(path, encoded); }
        envelope.payload_ref = { sha256, bytes: Buffer.byteLength(encoded), media_type: "application/json", encoding: "json" };
      } else if (policy === "full") {
        envelope.payload = clean;
      } else {
        envelope.metadata = { sha256: digest(encoded), bytes: Buffer.byteLength(encoded), kind: Array.isArray(clean) ? "array" : typeof clean };
      }
      const line = `${JSON.stringify(envelope)}\n`;
      const sinks = this.config.categorySinks[category];
      const finiteRetention = this.config.categoryRetentionDays[category] > 0;
      const metadata = envelope.metadata ?? { sha256: digest(encoded), bytes: Buffer.byteLength(encoded), kind: typeof clean };
      const indexLine = finiteRetention
        ? `${JSON.stringify({ ...envelope, payload: undefined, payload_ref: undefined, metadata })}\n`
        : line;
      if (sinks.includes("private")) {
        await appendFile(join(this.partialDir, `${this.producer}.ndjson`), indexLine, { mode: 0o600 });
        if (finiteRetention) {
          const categoryDir = join(this.partialDir, "categories", category);
          await secureDirectory(categoryDir);
          await appendFile(join(categoryDir, `${this.producer}.ndjson`), line, { mode: 0o600 });
        }
      }
      if (sinks.includes("archive") || sinks.includes("export")) {
        await appendFile(join(this.partialDir, `${this.producer}.archive.ndjson`), line, { mode: 0o600 });
      }
      if (sinks.includes("operational")) {
        const operational = { ...envelope, payload: undefined, payload_ref: undefined, metadata, content_policy: "metadata" as const };
        const stream = this.producer === "app" ? "operational.ndjson" : "runner.operational.ndjson";
        await appendFile(join(this.partialDir, stream), `${JSON.stringify(operational)}\n`, { mode: 0o600 });
      }
    });
  }

  gap(message: string): void {
    this.gaps.add(message);
  }

  nativeSessionsEnabled(): boolean {
    const categories = ["prompts", "assistant", "tools", "provider", "lifecycle"] as AuditCategory[];
    const rawSinks = categories.map((category) => this.config.categorySinks[category].filter((sink) => sink !== "operational").sort().join(","));
    return rawSinks[0] !== "" && rawSinks.every((sinks) => sinks === rawSinks[0])
      && categories.every((category) => this.config.policies[category] === "full" && this.config.categoryRetentionDays[category] === 0);
  }

  private nativeSessionsArchived(): boolean {
    if (!this.nativeSessionsEnabled()) return false;
    return this.config.categorySinks.prompts.some((sink) => sink === "archive" || sink === "export");
  }

  private nativeSessionsPrivate(): boolean {
    return this.nativeSessionsEnabled() && this.config.categorySinks.prompts.includes("private");
  }

  private async removeArchiveStaging(runDir: string): Promise<void> {
    const stagedRefs = new Set<string>();
    for (const producer of ["app", "runner"] as const) {
      const path = join(runDir, `${producer}.archive.ndjson`);
      try {
        for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
          const ref = (JSON.parse(line) as AuditEvent).payload_ref?.sha256;
          if (ref) stagedRefs.add(ref);
        }
        await rm(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!this.config.categorySinks.result.includes("private")) await rm(join(runDir, "result.json"), { force: true });
    if (!this.nativeSessionsPrivate()) await rm(join(runDir, "sessions"), { recursive: true, force: true });
    const remainingRefs = await blobReferences(runDir);
    for (const ref of stagedRefs) if (!remainingRefs.has(ref)) await rm(join(runDir, "blobs", "sha256", ref), { force: true });
    const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Manifest;
    for (const category of AUDIT_CATEGORIES) {
      if (!this.config.categorySinks[category].includes("private")) {
        manifest.categories[category] = { ...manifest.categories[category], state: "disabled", events: 0 };
      }
    }
    await secureWrite(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await secureTree(runDir);
    await writeChecksums(runDir);
    await verifyChecksums(runDir);
  }

  async writeCapabilities(value: unknown): Promise<void> {
    if (!this.config.enabled) return;
    await this.flush();
    const clean = sanitize(value, this.redacted);
    const path = join(this.partialDir, `${this.producer}-capabilities.json`);
    let previous: { capabilities?: unknown; redacted_fields?: string[]; gaps?: string[] } = {};
    try { previous = JSON.parse(await readFile(path, "utf8")) as typeof previous; } catch { /* first capability snapshot */ }
    const capabilities = clean && typeof clean === "object" && !Array.isArray(clean)
      ? { ...((previous.capabilities as Record<string, unknown> | undefined) ?? {}), ...(clean as Record<string, unknown>) }
      : clean;
    await secureWrite(path, `${JSON.stringify({
      capabilities,
      redacted_fields: [...new Set([...(previous.redacted_fields ?? []), ...this.redacted])].sort(),
      gaps: [...new Set([...(previous.gaps ?? []), ...this.gaps])].sort(),
    }, null, 2)}\n`);
  }

  async persistNativeSession(entries: unknown[], name: string): Promise<string> {
    if (basename(name) !== name || !name.endsWith(".jsonl")) throw new Error(`invalid native session name: ${name}`);
    await this.flush();
    const target = join(this.sessionsDir, name);
    await secureWrite(target, "");
    for (const entry of entries) await appendFile(target, `${JSON.stringify(sanitize(entry, this.redacted))}\n`, { mode: 0o600 });
    return target;
  }

  async writeResult(value: unknown): Promise<void> {
    if (!this.config.enabled || this.config.policies.result === "off") return;
    await this.flush();
    const clean = sanitize(value, this.redacted);
    const encoded = JSON.stringify(clean, null, 2);
    const hasPrivateSink = this.config.categorySinks.result.some((sink) => sink === "private" || sink === "archive" || sink === "export");
    const finiteRetention = this.config.categoryRetentionDays.result > 0;
    if (this.config.policies.result === "full" && hasPrivateSink && !finiteRetention) {
      await secureWrite(join(this.partialDir, "result.json"), `${encoded}\n`);
    } else {
      await secureWrite(join(this.partialDir, "result.json"), `${JSON.stringify({ policy: this.config.policies.result, sha256: digest(encoded), bytes: Buffer.byteLength(encoded) }, null, 2)}\n`);
    }
    if (this.config.policies.result === "full" && this.config.categorySinks.result.includes("private") && finiteRetention) {
      const categoryDir = join(this.partialDir, "categories", "result");
      await secureDirectory(categoryDir);
      await secureWrite(join(categoryDir, "result.json"), `${encoded}\n`);
    }
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure && this.config.failurePolicy === "fail") throw this.failure;
  }

  async validateCapturedEvents(): Promise<void> {
    await this.flush();
    const { invalid } = await this.readEventRecords();
    if (invalid && this.config.failurePolicy === "fail") throw new Error("audit event validation failed");
  }

  async finalize(status: "complete" | "failed", error?: unknown): Promise<AuditFinalization> {
    if (!this.config.enabled) return { status: "disabled", completeness: "disabled" };
    await this.validateCapturedEvents();
    const capabilitySidecars: Record<string, unknown> = {};
    for (const producer of ["app", "runner"] as const) {
      try {
        const sidecar = sanitize(JSON.parse(await readFile(join(this.partialDir, `${producer}-capabilities.json`), "utf8")), this.redacted) as { gaps?: unknown; redacted_fields?: unknown };
        capabilitySidecars[producer] = sidecar;
        if (Array.isArray(sidecar.gaps)) for (const gap of sidecar.gaps) if (typeof gap === "string") this.gaps.add(gap);
        if (Array.isArray(sidecar.redacted_fields)) for (const field of sidecar.redacted_fields) if (typeof field === "string") this.redacted.add(field);
      } catch {
        capabilitySidecars[producer] = producer === "runner"
          ? { capabilities: { runner_internals: "unavailable", reason: "no versioned Leveret trace protocol emitted" }, redacted_fields: [], gaps: [] }
          : { capabilities: { app_internals: "unavailable" }, redacted_fields: [], gaps: [] };
      }
    }
    try { await stat(join(this.partialDir, "result.json")); } catch { await this.writeResult({ status, error: error === undefined ? undefined : String(error) }); }
    this.state = "finalizing";
    await this.flush();
    await this.writeManifest(status, error, capabilitySidecars);
    await secureTree(this.partialDir);
    await writeChecksums(this.partialDir);
    await verifyChecksums(this.partialDir);
    const runDir = this.partialDir.replace(/\.partial$/, "");
    await rename(this.partialDir, runDir);
    let archive: AuditArchive | undefined;
    let degradation: string | undefined;
    const archiveEnabled = Object.values(this.config.categorySinks).some((sinks) => sinks.includes("archive") || sinks.includes("export"));
    if (archiveEnabled && (status === "complete" || this.config.archiveIncomplete)) {
      try {
        archive = await archiveRun(
          this.config,
          runDir,
          this.nativeSessionsArchived(),
          this.config.categorySinks.result.some((sink) => sink === "archive" || sink === "export"),
        );
        await this.removeArchiveStaging(runDir);
        if (!this.config.keepUnpacked) {
          await retentionEvent(this.config.root, { action: "remove-unpacked-run", path: runDir, archive: archive.path, archive_sha256: archive.sha256 });
          await rm(runDir, { recursive: true });
        }
      } catch (archiveError) {
        degradation = `archive failed; complete run directory preserved: ${redactAuditText(String(archiveError))}`;
        await retentionEvent(this.config.root, { action: "archive-failed", path: runDir, error: degradation });
        const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8")) as Manifest;
        manifest.completeness = "incomplete";
        manifest.gaps = [...new Set([...manifest.gaps, degradation])].sort();
        await secureWrite(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await writeChecksums(runDir);
        await verifyChecksums(runDir);
      }
    }
    await applyCategoryRetention(this.config);
    await applyRetention(this.config, [runDir, ...(archive ? [archive.path] : [])]);
    this.state = "closed";
    return {
      runDir: this.config.keepUnpacked || !archive ? runDir : undefined,
      archive,
      degradation,
      status,
      completeness: this.gaps.size > 0 || degradation ? "incomplete" : "complete",
    };
  }
}

export async function createAuditRun(config: AuditConfig, runId = randomUUID()): Promise<AuditWriter | undefined> {
  if (!config.enabled) return undefined;
  const day = new Date().toISOString().slice(0, 10).split("-");
  const writer = new AuditWriter(runId, "app", config, join(config.root, ...day, `${runId}.partial`));
  try {
    await writer.initialize();
  } catch (error) {
    if (config.failurePolicy === "fail") throw error;
    process.stdout.write(`${JSON.stringify({ schema: AUDIT_SCHEMA_VERSION, ts: new Date().toISOString(), level: "error", runId, msg: "audit capture unavailable; continuing by owner policy", error: redactAuditText(String(error)), completeness: "lost" })}\n`);
    return undefined;
  }
  return writer;
}

export async function openRunnerAudit(config: AuditConfig, env: NodeJS.ProcessEnv, repo: string): Promise<AuditWriter | undefined> {
  const partialDir = env.LEVERET_TRACE_DIR;
  const runId = env.LEVERET_RUN_ID;
  if (!config.enabled || !partialDir || !runId) return undefined;
  const canonicalRepo = await realpath(repo);
  const canonicalTrace = await realpath(partialDir);
  if (pathIsInside(canonicalRepo, canonicalTrace)) throw new Error("audit trace directory must be outside the reviewed checkout");
  const writer = new AuditWriter(runId, "runner", config, canonicalTrace);
  try {
    await writer.initialize();
  } catch (error) {
    if (config.failurePolicy === "fail") throw error;
    return undefined;
  }
  return writer;
}

export function withAuditTrace<T>(writer: AuditWriter | undefined, callback: () => T): T {
  return writer ? storage.run(writer, callback) : callback();
}

export function currentAuditTrace(): AuditWriter | undefined {
  return storage.getStore();
}

interface RetainedArtifact { path: string; modified: number; bytes: number; kind: "archive" | "run" }

async function retentionEvent(root: string, payload: Record<string, unknown>): Promise<void> {
  await secureDirectory(root);
  await appendFile(join(root, "retention.ndjson"), `${JSON.stringify({ schema: AUDIT_SCHEMA_VERSION, ts: new Date().toISOString(), ...payload })}\n`, { mode: 0o600 });
}

async function retainedArtifacts(root: string): Promise<RetainedArtifact[]> {
  const result: RetainedArtifact[] = [];
  try {
    const archiveRoot = join(root, "archives");
    const files = await filesUnder(archiveRoot);
    result.push(...await Promise.all(files.filter((file) => /\.tar\.(?:zst|gz)$/.test(file)).map(async (file) => {
      const path = join(archiveRoot, file);
      const info = await stat(path);
      return { path, modified: info.mtimeMs, bytes: info.size, kind: "archive" as const };
    })));
  } catch {
    // No archives yet.
  }
  try {
    for (const manifest of (await filesUnder(root)).filter((file) => file.endsWith("manifest.json") && !file.includes(".partial"))) {
      const path = dirname(join(root, manifest));
      const metadata = JSON.parse(await readFile(join(root, manifest), "utf8")) as Manifest;
      let bytes = 0;
      for (const file of await filesUnder(path)) bytes += (await stat(join(path, file))).size;
      result.push({ path, modified: Date.parse(metadata.completed_at ?? metadata.started_at), bytes, kind: "run" });
    }
  } catch {
    // No unpacked runs yet.
  }
  return result;
}

async function blobReferences(root: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const file of (await filesUnder(root)).filter((path) => path.endsWith(".ndjson"))) {
    for (const line of (await readFile(join(root, file), "utf8")).split("\n").filter(Boolean)) {
      const ref = (JSON.parse(line) as AuditEvent).payload_ref?.sha256;
      if (ref) {
        if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error(`invalid audit blob reference: ${ref}`);
        refs.add(ref);
      }
    }
  }
  return refs;
}

async function applyCategoryRetention(config: AuditConfig): Promise<void> {
  const manifestFiles = (await filesUnder(config.root)).filter((file) => file.endsWith("manifest.json") && !file.includes(".partial"));
  for (const manifestFile of manifestFiles) {
    const runDir = dirname(join(config.root, manifestFile));
    const manifest = JSON.parse(await readFile(join(config.root, manifestFile), "utf8")) as Manifest;
    const completed = Date.parse(manifest.completed_at ?? manifest.started_at);
    let changed = false;
    for (const category of AUDIT_CATEGORIES) {
      const days = manifest.policy.categoryRetentionDays?.[category] ?? 0;
      if (!days || Date.now() - completed < days * 86_400_000) continue;
      const categoryDir = join(runDir, "categories", category);
      try {
        const expiredRefs = await blobReferences(categoryDir);
        await rm(categoryDir, { recursive: true });
        const remainingRefs = await blobReferences(runDir);
        for (const ref of expiredRefs) if (!remainingRefs.has(ref)) await rm(join(runDir, "blobs", "sha256", ref), { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      manifest.categories[category].state = "expired";
      changed = true;
      await retentionEvent(config.root, { action: "category-retention-delete", run_id: manifest.run_id, category, run_dir: runDir });
    }
    if (changed) {
      await secureWrite(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await secureTree(runDir);
      await writeChecksums(runDir);
      await verifyChecksums(runDir);
    }
  }
}

async function applyRetention(config: AuditConfig, preserve: string[] = []): Promise<void> {
  if (!config.retentionDays && !config.retentionCount && !config.retentionBytes) return;
  const retained = await retainedArtifacts(config.root);
  for (const kind of ["archive", "run"] as const) {
    const artifacts = retained.filter((artifact) => artifact.kind === kind).sort((a, b) => b.modified - a.modified);
    let bytes = 0;
    const cutoff = config.retentionDays ? Date.now() - config.retentionDays * 86_400_000 : 0;
    for (let index = 0; index < artifacts.length; index++) {
      const artifact = artifacts[index]!;
      bytes += artifact.bytes;
      const expired = (cutoff > 0 && artifact.modified < cutoff)
        || (config.retentionCount > 0 && index >= config.retentionCount)
        || (config.retentionBytes > 0 && bytes > config.retentionBytes);
      if (expired && !preserve.includes(artifact.path)) {
        await retentionEvent(config.root, { action: "retention-delete", kind, path: artifact.path, bytes: artifact.bytes });
        await rm(artifact.path, { recursive: kind === "run" });
      }
    }
  }
}
