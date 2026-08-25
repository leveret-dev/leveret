import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { pathIsInside } from "./path.js";

export const REVIEW_CACHE_VERSION = 1 as const;
export const CACHE_ARTIFACTS = [
  "change-manifest",
  "project-facts",
  "graph-toolchain",
  "scan-result",
  "evidence-pack",
  "guidance-selection",
  "final-result",
] as const;
export const CACHE_OUTCOMES = ["hit", "miss", "invalidated", "fallback", "corrupt-recovered"] as const;
export type CacheArtifact = typeof CACHE_ARTIFACTS[number];
export type CacheOutcome = typeof CACHE_OUTCOMES[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const jsonSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));
const findingCacheSchema = z.object({
  engine: z.string(), rule: z.string(), severity: z.enum(["error", "warning", "info"]),
  file: z.string(), line: z.number().int().positive(), endLine: z.number().int().positive().optional(),
  message: z.string(), snippet: z.string().optional(), provenance: z.enum(["introduced", "pre-existing"]).optional(),
}).strict();
const engineReportCacheSchema = z.object({
  engine: z.string(),
  status: z.enum(["findings", "clean", "filtered", "not-applicable", "missing", "error"]),
  detail: z.string().optional(), found: z.number().int().nonnegative().optional(), kept: z.number().int().nonnegative().optional(),
  selectedFiles: z.array(z.string()).optional(), durationMs: z.number().nonnegative().optional(),
}).strict();
export const scanResultCacheSchema = z.object({
  findings: z.array(findingCacheSchema),
  engines: z.array(engineReportCacheSchema),
  suppressed: z.array(z.object({ rule: z.string(), count: z.number().int().nonnegative(), reason: z.string() }).strict()),
  preExisting: z.number().int().nonnegative(),
  baseErrors: z.array(engineReportCacheSchema),
  reminders: z.array(findingCacheSchema),
}).strict();
export const projectFactsCacheSchema = z.object({
  trackedFiles: z.number().int().nonnegative(),
  languages: z.array(z.object({ language: z.string(), files: z.number().int().nonnegative() }).strict()),
  buildSystems: z.array(z.object({ name: z.string(), evidence: z.array(z.string()) }).strict()),
  frameworks: z.array(z.object({ name: z.string(), evidence: z.array(z.string()) }).strict()),
  sourceRoots: z.array(z.string()), testRoots: z.array(z.string()), manifests: z.array(z.string()),
  manifestErrors: z.array(z.string()),
  truncated: z.object({ manifests: z.boolean(), roots: z.boolean() }).strict(),
}).strict();


export const cacheKeySchema = z.object({
  schema: z.literal("leveret.review-cache-key/v1"),
  version: z.literal(REVIEW_CACHE_VERSION),
  artifact: z.enum(CACHE_ARTIFACTS),
  repository: z.object({ canonical: z.string().min(3).max(500), sha256: sha256Schema }).strict(),
  pull_request: z.number().int().nonnegative(),
  base: commitSchema,
  head: commitSchema,
  inputs: z.record(z.string(), jsonSchema),
  dependency_boundary: z.object({ schema: z.literal("leveret.dependency-boundary/v1"), sha256: sha256Schema }).strict(),
}).strict();
export type CacheKey = z.infer<typeof cacheKeySchema>;

const entrySchema = z.object({
  schema: z.literal("leveret.review-cache-entry/v1"),
  version: z.literal(REVIEW_CACHE_VERSION),
  key: cacheKeySchema,
  key_sha256: sha256Schema,
  payload_sha256: sha256Schema,
  payload_bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  payload: jsonSchema,
}).strict();

const pointerSchema = z.object({
  schema: z.literal("leveret.review-cache-pointer/v1"),
  version: z.literal(REVIEW_CACHE_VERSION),
  generation: z.string().regex(/^[a-f0-9-]{36}\.json$/),
  key_sha256: sha256Schema,
  entry_sha256: sha256Schema,
}).strict();

export const cacheDecisionSchema = z.object({
  schema: z.literal("leveret.cache-decision/v1"),
  artifact: z.enum(CACHE_ARTIFACTS),
  outcome: z.enum(CACHE_OUTCOMES),
  key: sha256Schema,
  duration_ms: z.number().nonnegative(),
  bytes: z.number().int().nonnegative().nullable(),
  reason: z.string().min(1),
}).strict();
export type CacheDecision = z.infer<typeof cacheDecisionSchema>;

export const dependencyBoundarySchema = z.object({
  schema: z.literal("leveret.dependency-boundary/v1"),
  prior_head: commitSchema.nullable(),
  head: commitSchema,
  range: z.string().nullable(),
  changed_paths: z.array(z.string()),
  affected_paths: z.array(z.object({ path: z.string(), reasons: z.array(z.string()).min(1) }).strict()),
  full_recompute: z.boolean(),
  fallback_reason: z.string().nullable(),
  reusable_artifacts: z.array(z.enum(CACHE_ARTIFACTS)),
  sha256: sha256Schema,
}).strict();
export type DependencyBoundary = z.infer<typeof dependencyBoundarySchema>;
export const cacheRunSchema = z.object({
  schema: z.literal("leveret.review-cache-run/v1"),
  enabled: z.boolean(),
  incremental: dependencyBoundarySchema,
  artifacts: z.array(cacheDecisionSchema),
  optional_dependency_sandbox: z.literal("disabled"),
}).strict();
export type CacheRun = z.infer<typeof cacheRunSchema>;


export const findingSnapshotSchema = z.object({
  schema: z.literal("leveret.finding-fingerprint/v1"),
  id: z.string().min(1),
  concern_source: z.string().min(1),
  rule: z.string().min(1),
  file: z.string().min(1),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict(),
  context_sha256: sha256Schema,
  evidence_sha256: z.array(sha256Schema),
  grade: z.string().min(1),
  mechanism_sha256: sha256Schema,
  fingerprint: sha256Schema,
}).strict();
export type FindingSnapshot = z.infer<typeof findingSnapshotSchema>;
export const FINDING_STATES = ["new", "persisting", "moved", "materially-changed", "resolved", "reopened", "ignored", "unverifiable"] as const;
export type FindingState = typeof FINDING_STATES[number];
export interface FindingLifecycle { finding: FindingSnapshot; state: FindingState; previousId: string | null; reason: string }
export interface PublicationDecision { id: string; publish: boolean; state: FindingState; reason: string }

export const lastCompletedSchema = z.object({
  schema: z.literal("leveret.review-cache-last-completed/v1"),
  version: z.literal(REVIEW_CACHE_VERSION),
  repository_sha256: sha256Schema,
  pull_request: z.number().int().nonnegative(),
  base: commitSchema,
  head: commitSchema,
  range: z.string(),
  artifact_keys: z.partialRecord(z.enum(CACHE_ARTIFACTS), sha256Schema),
  findings: z.array(z.object({ finding: findingSnapshotSchema, state: z.enum(FINDING_STATES) }).strict()),
  completed_at: z.string().datetime(),
}).strict();
export type LastCompleted = z.infer<typeof lastCompletedSchema>;

export interface ReviewCacheOptions {
  dataRoot: string;
  repoRoot: string;
  repository: string;
  pullRequest: number;
  enabled?: boolean;
  maxBytes?: number;
  maxEntryBytes?: number;
}

export interface CacheLookup<T> { value?: T; decision: CacheDecision }

const exec = promisify(execFile);
const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function stableJson(value: unknown): string {
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, visit(child)]));
    throw new Error(`cache identity contains unsupported ${typeof item}`);
  };
  return JSON.stringify(visit(value));
}

export function canonicalRepositoryIdentity(value: string): string {
  let normalized = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "");
  normalized = normalized.replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) || normalized.includes("..")) throw new Error("repository identity must be a canonical owner/name");
  return normalized.toLowerCase();
}

function safeRelativePath(value: string, label: string): void {
  if (!value || value.includes("\0") || isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(`unsafe ${label}: ${value}`);
}

async function secureDirectory(root: string, path: string): Promise<void> {
  if (!pathIsInside(root, path)) throw new Error("cache path escaped its host-owned root");
  await mkdir(path, { recursive: true, mode: 0o700 });
  let current = root;
  const rel = relative(root, path);
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("cache directory contains a symlink");
  }
}
async function safeRead(root: string, path: string): Promise<string> {
  if (!pathIsInside(root, path)) throw new Error("cache read escaped its host-owned root");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("cache read rejected a non-regular file or symlink");
  return readFile(path, "utf8");
}


async function atomicWrite(root: string, path: string, body: string): Promise<void> {
  if (!pathIsInside(root, path)) throw new Error("cache write escaped its host-owned root");
  await secureDirectory(root, dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

function decision(artifact: CacheArtifact, outcome: CacheOutcome, key: string, started: number, bytes: number | null, reason: string): CacheDecision {
  return cacheDecisionSchema.parse({ schema: "leveret.cache-decision/v1", artifact, outcome, key, duration_ms: Math.max(0, performance.now() - started), bytes, reason });
}

function boundaryDigest(value: Omit<DependencyBoundary, "sha256">): string { return digest(stableJson(value)); }

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".go", ".inc", ".java", ".js", ".jsx", ".kt", ".kts", ".php", ".py", ".rb", ".rs", ".sh", ".swift", ".ts", ".tsx", ".vue"]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const MANIFEST_NAMES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "composer.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pyproject.toml", "requirements.txt", "Gemfile", "Gemfile.lock", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile", "CMakeLists.txt"]);
const TEST_PATH = /(^|\/)(?:test|tests|spec|specs|__tests__)(\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i;

function parseNameStatusZ(buffer: Buffer): string[] {
  const fields = buffer.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) break;
    const count = /^[RC]/.test(status) ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const path = fields[i++];
      if (!path) throw new Error("truncated NUL-delimited git diff");
      safeRelativePath(path, "changed path");
      paths.push(path);
    }
  }
  return [...new Set(paths)].sort();
}
async function trackedPaths(repo: string): Promise<string[]> {
  const result = await exec("git", ["ls-files", "-z"], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return (result.stdout as Buffer).toString("utf8").split("\0").filter(Boolean).map((path) => {
    safeRelativePath(path, "tracked path");
    return path;
  }).sort();
}

function dependencyRoleReason(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEST_PATH.test(path)) return "assigned test or contract consumer included conservatively";
  if (MANIFEST_NAMES.has(name)) return "manifest or generated-consumer identity included conservatively";
  if (/(^|\/)(?:\.github\/workflows|scripts?\/|publish|release|deploy|docker)/i.test(path)) return "publisher or generated consumer included conservatively";
  if (SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return "potential direct static caller or include consumer included conservatively";
  return "repository dependency boundary included conservatively";
}


export async function incrementalDependencyBoundary(repo: string, priorHead: string | null, head: string): Promise<DependencyBoundary> {
  const base = { schema: "leveret.dependency-boundary/v1" as const, prior_head: priorHead, head, range: priorHead ? `${priorHead}..${head}` : null };
  if (!priorHead) {
    const affected_paths = (await trackedPaths(repo)).map((path) => ({ path, reasons: ["full recompute: no prior completed head", dependencyRoleReason(path)] }));
    const value = { ...base, changed_paths: [], affected_paths, full_recompute: true, fallback_reason: "no prior completed head", reusable_artifacts: [] as CacheArtifact[] };
    return dependencyBoundarySchema.parse({ ...value, sha256: boundaryDigest(value) });
  }
  let changed: string[];
  try {
    const result = await exec("git", ["diff", "--name-status", "-z", priorHead, head, "--"], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    changed = parseNameStatusZ(result.stdout as Buffer);
  } catch (error) {
    const value = { ...base, changed_paths: [], affected_paths: [], full_recompute: true, fallback_reason: `incremental range unavailable: ${String(error)}`, reusable_artifacts: [] as CacheArtifact[] };
    return dependencyBoundarySchema.parse({ ...value, sha256: boundaryDigest(value) });
  }
  const affected = new Map<string, Set<string>>();
  for (const path of changed) affected.set(path, new Set(["changed in exact incremental range"]));
  const unsafe = changed.find((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const extension = extname(path).toLowerCase();
    return MANIFEST_NAMES.has(name) || (!DOC_EXTENSIONS.has(extension) && !TEST_PATH.test(path) && !SOURCE_EXTENSIONS.has(extension));
  });
  const source = changed.find((path) => SOURCE_EXTENSIONS.has(extname(path).toLowerCase()) && !TEST_PATH.test(path));
  const policy = changed.find((path) => /(^|\/)(?:\.leveret\.ya?ml|agents\/|rules\/|cards\/|\.leveret\/|memory\/)/i.test(path));
  let fallback: string | null = null;
  if (policy) fallback = `policy, guidance, rule, card, or knowledge input changed: ${policy}`;
  else if (unsafe) fallback = `unknown dependency boundary for changed path: ${unsafe}`;
  else if (source) fallback = `source changed; deterministic caller/graph completeness is not proven: ${source}`;
  const docsOrTestsOnly = changed.length > 0 && changed.every((path) => DOC_EXTENSIONS.has(extname(path).toLowerCase()) || TEST_PATH.test(path));
  const reusable: CacheArtifact[] = !fallback && docsOrTestsOnly ? ["project-facts", "graph-toolchain"] : [];
  if (fallback) {
    for (const path of await trackedPaths(repo)) {
      const reasons = affected.get(path) ?? new Set<string>();
      reasons.add(`full recompute: ${fallback}`);
      reasons.add(dependencyRoleReason(path));
      affected.set(path, reasons);
    }
  }
  const value = {
    ...base,
    changed_paths: changed,
    affected_paths: [...affected].sort(([a], [b]) => a.localeCompare(b)).map(([path, reasons]) => ({ path, reasons: [...reasons].sort() })),
    full_recompute: changed.length > 0 && (fallback !== null || !docsOrTestsOnly),
    fallback_reason: fallback ?? (docsOrTestsOnly ? null : changed.length === 0 ? null : "dependency reuse was not proven"),
    reusable_artifacts: reusable,
  };
  return dependencyBoundarySchema.parse({ ...value, sha256: boundaryDigest(value) });
}

export function findingSnapshot(input: {
  id: string; concernSource: string; rule: string; file: string; start: number; end?: number; context: string; evidenceHashes?: string[]; grade: string;
}): FindingSnapshot {
  const evidence = [...new Set(input.evidenceHashes ?? [])].sort();
  for (const value of evidence) sha256Schema.parse(value);
  const mechanism = { concern_source: input.concernSource, rule: input.rule };
  const exact = { ...mechanism, file: input.file, range: { start: input.start, end: input.end ?? input.start }, context_sha256: digest(input.context), evidence_sha256: evidence, grade: input.grade };
  return findingSnapshotSchema.parse({ schema: "leveret.finding-fingerprint/v1", id: input.id, ...exact, mechanism_sha256: digest(stableJson(mechanism)), fingerprint: digest(stableJson(exact)) });
}

export function reconcileFindings(current: FindingSnapshot[], previous: Array<{ finding: FindingSnapshot; state: FindingState }> = []): FindingLifecycle[] {
  const unused = new Set(previous.map((_, index) => index));
  const output: FindingLifecycle[] = [];
  for (const finding of current) {
    if (/^(?:ignored|priced-noise|false-positive)$/i.test(finding.grade)) { output.push({ finding, state: "ignored", previousId: null, reason: `grade ${finding.grade} is not publishable` }); continue; }
    if (/^unverifiable$/i.test(finding.grade)) { output.push({ finding, state: "unverifiable", previousId: null, reason: "current evidence is unverifiable" }); continue; }
    const exact = previous.findIndex((item, index) => unused.has(index) && item.finding.fingerprint === finding.fingerprint);
    const mechanism = exact >= 0 ? exact : previous.findIndex((item, index) => unused.has(index) && item.finding.mechanism_sha256 === finding.mechanism_sha256);
    if (mechanism < 0) { output.push({ finding, state: "new", previousId: null, reason: "no prior finding has this normalized mechanism" }); continue; }
    unused.delete(mechanism);
    const prior = previous[mechanism]!;
    if (prior.state === "resolved") output.push({ finding, state: "reopened", previousId: prior.finding.id, reason: "a previously resolved mechanism is actionable again" });
    else if (exact >= 0) output.push({ finding, state: "persisting", previousId: prior.finding.id, reason: "normalized mechanism, location, context, evidence, and grade are unchanged" });
    else if (prior.finding.context_sha256 === finding.context_sha256 && (prior.finding.file !== finding.file || stableJson(prior.finding.range) !== stableJson(finding.range))) output.push({ finding, state: "moved", previousId: prior.finding.id, reason: "the same normalized mechanism and context moved" });
    else output.push({ finding, state: "materially-changed", previousId: prior.finding.id, reason: "mechanism persists but location context, evidence, or grade changed" });
  }
  for (const index of unused) {
    const prior = previous[index]!;
    output.push({ finding: prior.finding, state: "resolved", previousId: prior.finding.id, reason: "prior normalized mechanism is absent from the completed result" });
  }
  return output;
}

export function publicationDecisions(lifecycle: FindingLifecycle[]): PublicationDecision[] {
  return lifecycle.filter((item) => item.state !== "resolved").map((item) => ({
    id: item.finding.id,
    publish: item.state !== "persisting" && item.state !== "ignored" && item.state !== "unverifiable",
    state: item.state,
    reason: item.state === "persisting" ? "mechanically unchanged finding was already published" : item.reason,
  }));
}

export function canonicalReviewResult(value: unknown): JsonValue {
  const clean = JSON.parse(stableJson(value)) as Record<string, JsonValue>;
  const configuration = clean.run_configuration;
  if (configuration && !Array.isArray(configuration) && typeof configuration === "object") {
    delete configuration.cache;
    delete configuration.timings;
    delete configuration.process;
  }
  return JSON.parse(stableJson(clean)) as JsonValue;
}

export function compareColdWarmResults(cold: unknown, warm: unknown): { equal: boolean; cold_sha256: string; warm_sha256: string } {
  const coldBody = stableJson(canonicalReviewResult(cold));
  const warmBody = stableJson(canonicalReviewResult(warm));
  return { equal: coldBody === warmBody, cold_sha256: digest(coldBody), warm_sha256: digest(warmBody) };
}

export class ReviewCache {
  readonly enabled: boolean;
  readonly repository: string;
  readonly repositorySha256: string;
  readonly pullRequest: number;
  readonly decisions: CacheDecision[] = [];
  lastCompletedDecision: { outcome: "hit" | "miss" | "corrupt-recovered"; reason: string } | undefined;
  private readonly root: string;
  private readonly repoRoot: string;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly staged = new Map<string, { key: CacheKey; payload: JsonValue }>();
  private readonly validatedRanges = new Map<string, Promise<boolean>>();

  private constructor(options: ReviewCacheOptions, root: string, repoRoot: string) {
    this.enabled = options.enabled ?? true;
    this.repository = canonicalRepositoryIdentity(options.repository);
    this.repositorySha256 = digest(this.repository);
    this.pullRequest = options.pullRequest;
    this.root = root;
    this.repoRoot = repoRoot;
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 32 * 1024 * 1024;
  }

  static async open(options: ReviewCacheOptions): Promise<ReviewCache> {
    if (!Number.isInteger(options.pullRequest) || options.pullRequest < 0) throw new Error("pull request must be a non-negative integer");
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) throw new Error("cache maxBytes must be a positive safe integer");
    if (options.maxEntryBytes !== undefined && (!Number.isSafeInteger(options.maxEntryBytes) || options.maxEntryBytes <= 0)) throw new Error("cache maxEntryBytes must be a positive safe integer");
    const repoRoot = await realpath(options.repoRoot);
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    const dataRoot = await realpath(options.dataRoot);
    if (pathIsInside(repoRoot, dataRoot) || pathIsInside(dataRoot, repoRoot)) throw new Error("LEVERET_DATA cache root and reviewed checkout must not contain one another");
    const root = join(dataRoot, "cache", "review-v1");
    await secureDirectory(dataRoot, root);
    return new ReviewCache(options, root, repoRoot);
  }

  key(artifact: CacheArtifact, base: string, head: string, inputs: Record<string, JsonValue>, boundary: DependencyBoundary): CacheKey {
    const exactHeadBoundary = digest(stableJson({ schema: boundary.schema, artifact, head, kind: "exact-head" }));
    const key = cacheKeySchema.parse({
      schema: "leveret.review-cache-key/v1", version: REVIEW_CACHE_VERSION, artifact,
      repository: { canonical: this.repository, sha256: this.repositorySha256 }, pull_request: this.pullRequest,
      base, head, inputs, dependency_boundary: { schema: boundary.schema, sha256: exactHeadBoundary },
    });
    return key;
  }

  keyDigest(key: CacheKey): string { return digest(stableJson(cacheKeySchema.parse(key))); }

  private prRoot(): string { return join(this.root, "repositories", this.repositorySha256, `pr-${this.pullRequest}`); }
  private entryRoot(artifact: CacheArtifact, keySha256: string): string { return join(this.prRoot(), "entries", artifact, keySha256); }

  private async checkoutMatches(key: CacheKey): Promise<boolean> {
    const range = `${key.base}:${key.head}`;
    let validation = this.validatedRanges.get(range);
    if (!validation) {
      validation = (async () => {
        try {
          const [base, head] = await Promise.all([
            exec("git", ["rev-parse", "--verify", `${key.base}^{commit}`], { cwd: this.repoRoot, encoding: "utf8" }),
            exec("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: this.repoRoot, encoding: "utf8" }),
          ]);
          return String(base.stdout).trim() === key.base && String(head.stdout).trim() === key.head;
        } catch { return false; }
      })();
      this.validatedRanges.set(range, validation);
    }
    return validation;
  }

  private async readEntry<T>(key: CacheKey, keySha256: string): Promise<{ value?: T; bytes: number | null; corrupt: boolean }> {
    const entryRoot = this.entryRoot(key.artifact, keySha256);
    const candidates: string[] = [];
    let pointerGeneration: string | undefined;
    let pointerEntrySha256: string | undefined;
    let corrupt = false;
    try {
      const pointer = pointerSchema.parse(JSON.parse(await safeRead(this.root, join(entryRoot, "current.json"))));
      if (pointer.key_sha256 !== keySha256) throw new Error("pointer key checksum mismatch");
      pointerGeneration = pointer.generation;
      pointerEntrySha256 = pointer.entry_sha256;
      candidates.push(pointer.generation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, corrupt: false };
      corrupt = true;
    }
    try {
      const generations = (await readdir(entryRoot, { withFileTypes: true }))
        .filter((item) => item.isFile() && /^[a-f0-9-]{36}\.json$/.test(item.name))
        .map((item) => item.name).sort().reverse();
      for (const name of generations) if (!candidates.includes(name)) candidates.push(name);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, corrupt }; }
    for (const generation of candidates) {
      try {
        safeRelativePath(generation, "cache generation");
        const body = await safeRead(this.root, join(entryRoot, generation));
        if (generation === pointerGeneration && pointerEntrySha256 && digest(body) !== pointerEntrySha256) throw new Error("entry envelope checksum mismatch");
        const entry = entrySchema.parse(JSON.parse(body));
        if (entry.key_sha256 !== keySha256 || stableJson(entry.key) !== stableJson(key)) throw new Error("entry key mismatch");
        const payloadBody = stableJson(entry.payload);
        if (digest(payloadBody) !== entry.payload_sha256 || Buffer.byteLength(payloadBody) !== entry.payload_bytes) throw new Error("entry payload checksum mismatch");
        return { value: entry.payload as T, bytes: entry.payload_bytes, corrupt: corrupt || generation !== pointerGeneration };
      } catch { corrupt = true; }
    }
    return { bytes: null, corrupt };
  }

  async get<T>(key: CacheKey): Promise<CacheLookup<T>> {
    const started = performance.now();
    const keySha256 = this.keyDigest(key);
    if (!this.enabled) {
      const result = { decision: decision(key.artifact, "fallback", keySha256, started, null, "cache disabled by deterministic cold-path configuration") };
      this.decisions.push(result.decision); return result;
    }
    if (!await this.checkoutMatches(key)) {
      const result = { decision: decision(key.artifact, "fallback", keySha256, started, null, "cache key base/head does not match the reviewed checkout; recompute required") };
      this.decisions.push(result.decision); return result;
    }
    const staged = this.staged.get(keySha256);
    if (staged) {
      const bytes = Buffer.byteLength(stableJson(staged.payload));
      const result = { value: staged.payload as T, decision: decision(key.artifact, "hit", keySha256, started, bytes, "artifact was prepared earlier in this run") };
      this.decisions.push(result.decision); return result;
    }
    const found = await this.readEntry<T>(key, keySha256);
    const outcome: CacheOutcome = found.value === undefined ? found.corrupt ? "corrupt-recovered" : "miss" : found.corrupt ? "corrupt-recovered" : "hit";
    const reason = found.value === undefined ? found.corrupt ? "all immutable generations failed schema or checksum validation; recompute required" : "no completed generation exists for the exact key" : found.corrupt ? "current generation was corrupt; recovered an older valid immutable generation" : "exact versioned key and checksums matched";
    const result = { ...(found.value === undefined ? {} : { value: found.value }), decision: decision(key.artifact, outcome, keySha256, started, found.bytes, reason) };
    this.decisions.push(result.decision); return result;
  }

  invalidate(key: CacheKey, reason: string): CacheDecision {
    const result = decision(key.artifact, "invalidated", this.keyDigest(key), performance.now(), null, reason);
    this.decisions.push(result); return result;
  }

  fallback(key: CacheKey, reason: string): CacheDecision {
    const result = decision(key.artifact, "fallback", this.keyDigest(key), performance.now(), null, reason);
    this.decisions.push(result); return result;
  }

  stage(key: CacheKey, payload: unknown): void {
    if (!this.enabled) return;
    const parsed = jsonSchema.parse(payload);
    const bytes = Buffer.byteLength(stableJson(parsed));
    if (bytes > this.maxEntryBytes) throw new Error(`cache artifact exceeds ${this.maxEntryBytes} byte limit`);
    this.staged.set(this.keyDigest(key), { key, payload: parsed });
  }

  async readLastCompleted(): Promise<LastCompleted | null> {
    try {
      const value = lastCompletedSchema.parse(JSON.parse(await safeRead(this.root, join(this.prRoot(), "last-completed.json"))));
      if (value.repository_sha256 !== this.repositorySha256 || value.pull_request !== this.pullRequest) throw new Error("last-completed identity mismatch");
      this.lastCompletedDecision = { outcome: "hit", reason: "last-completed metadata schema and repository/PR identity matched" };
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.lastCompletedDecision = { outcome: "miss", reason: "no last-completed metadata exists" };
      else this.lastCompletedDecision = { outcome: "corrupt-recovered", reason: `last-completed metadata rejected; full recompute required: ${String(error)}` };
      return null;
    }
  }

  async commitCompleted(metadata: Omit<LastCompleted, "schema" | "version" | "repository_sha256" | "pull_request" | "completed_at">): Promise<LastCompleted> {
    if (!this.enabled) throw new Error("disabled cache cannot advance last-completed metadata");
    const artifactKeys: Partial<Record<CacheArtifact, string>> = { ...metadata.artifact_keys };
    for (const cached of this.decisions) {
      if (cached.outcome === "hit" || cached.outcome === "corrupt-recovered") artifactKeys[cached.artifact] = cached.key;
    }
    for (const [keySha256, staged] of this.staged) {
      const payloadBody = stableJson(staged.payload);
      const entry = entrySchema.parse({
        schema: "leveret.review-cache-entry/v1", version: REVIEW_CACHE_VERSION, key: staged.key, key_sha256: keySha256,
        payload_sha256: digest(payloadBody), payload_bytes: Buffer.byteLength(payloadBody), created_at: new Date().toISOString(), payload: staged.payload,
      });
      const entryBody = JSON.stringify(entry);
      const generation = `${randomUUID()}.json`;
      const entryRoot = this.entryRoot(staged.key.artifact, keySha256);
      await atomicWrite(this.root, join(entryRoot, generation), entryBody);
      const pointer = pointerSchema.parse({ schema: "leveret.review-cache-pointer/v1", version: REVIEW_CACHE_VERSION, generation, key_sha256: keySha256, entry_sha256: digest(entryBody) });
      await atomicWrite(this.root, join(entryRoot, "current.json"), stableJson(pointer));
      artifactKeys[staged.key.artifact] = keySha256;
    }
    const completed = lastCompletedSchema.parse({
      schema: "leveret.review-cache-last-completed/v1", version: REVIEW_CACHE_VERSION,
      repository_sha256: this.repositorySha256, pull_request: this.pullRequest,
      ...metadata, artifact_keys: artifactKeys, completed_at: new Date().toISOString(),
    });
    await atomicWrite(this.root, join(this.prRoot(), "last-completed.json"), stableJson(completed));
    this.staged.clear();
    await this.prune();
    return completed;
  }

  discard(): void { this.staged.clear(); }

  private async prune(): Promise<void> {
    const files: Array<{ path: string; bytes: number; modified: number }> = [];
    const walk = async (root: string): Promise<void> => {
      for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) await walk(path);
        else if (item.isFile()) { const info = await stat(path); files.push({ path, bytes: info.size, modified: info.mtimeMs }); }
      }
    };
    await walk(this.root);
    let total = files.reduce((sum, item) => sum + item.bytes, 0);
    if (total <= this.maxBytes) return;
    const protectedPaths = new Set<string>();
    const protectedKeys = new Set<string>();
    for (const metadata of files.filter((item) => item.path.endsWith(`${sep}last-completed.json`))) {
      try {
        const value = lastCompletedSchema.parse(JSON.parse(await safeRead(this.root, metadata.path)));
        for (const key of Object.values(value.artifact_keys)) if (key) protectedKeys.add(key);
        protectedPaths.add(metadata.path);
      } catch { protectedPaths.add(metadata.path); }
    }
    for (const pointer of files.filter((item) => item.path.endsWith(`${sep}current.json`))) {
      if (!protectedKeys.has(dirname(pointer.path).slice(dirname(pointer.path).lastIndexOf(sep) + 1))) continue;
      try {
        const value = pointerSchema.parse(JSON.parse(await safeRead(this.root, pointer.path)));
        protectedPaths.add(pointer.path); protectedPaths.add(join(dirname(pointer.path), value.generation));
      } catch { protectedPaths.add(pointer.path); }
    }
    for (const item of files.sort((a, b) => a.modified - b.modified)) {
      if (total <= this.maxBytes) break;
      if (protectedPaths.has(item.path) || item.path.endsWith(`${sep}last-completed.json`)) continue;
      await rm(item.path, { force: true }); total -= item.bytes;
    }
  }
}
