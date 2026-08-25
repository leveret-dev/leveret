import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "yaml";
import { validateChangeManifestCheckout, type ChangeFile, type ChangeManifest } from "./change-evidence.js";
import { ENGINES, type Engine } from "./engines/registry.js";
import { executableIdentity, run, safeChildEnvironment, type ExecutableIdentity } from "./exec.js";
import type { EngineReport, Finding, ScanResult } from "./findings.js";
import { pathIsInside } from "./path.js";
import type { Profile } from "./profile.js";
import type { ProjectFacts } from "./project-facts.js";

export const EVIDENCE_PACK_SCHEMA = "leveret.evidence-pack/v1" as const;
export const MAX_EVIDENCE_PACK_BYTES = 256 * 1024;
const MAX_LEADS = 200;
const MAX_OMITTED_IDS = 100;
const MAX_WORKFLOW_FILES = 20;
const MAX_WORKFLOW_JOBS = 100;
const MAX_WORKFLOW_STEPS = 300;
const MAX_STEP_TEXT = 48;
const MAX_TEXT = 1_000;
const MAX_SELECTED_FILES = 200;

export type FileDispositionName = "selected" | "ignored" | "generated" | "binary" | "lock" | "deleted" | "no-reviewable";
export type FileKind = "source" | "test" | "workflow" | "manifest" | "publisher" | "documentation" | "asset" | "unknown";
export type AnalyzerLifecycle = "not_applicable" | "started" | "completed" | "degraded" | "failed";

export interface FileDisposition {
  path: string;
  status: ChangeFile["status"];
  disposition: FileDispositionName;
  reason: string;
  language: string;
  kind: FileKind;
  evidenceId: string;
  facts: {
    sourceRoot: string | null;
    testRoot: string | null;
    buildSystems: string[];
    frameworks: string[];
    workflowEvidenceId: string | null;
  };
}

export interface WorkflowStepFact {
  index: number;
  id: string | null;
  name: string | null;
  kind: "run" | "uses" | "other";
  shell: string | null;
  shellSource: "step" | "job" | "workflow" | "runner-default" | "unknown" | null;
  commandNames: string[];
  uses: string | null;
  text: string | null;
  truncated: boolean;
  evidenceId: string;
}

export interface WorkflowJobFact {
  id: string;
  name: string | null;
  runsOn: string | null;
  shell: string;
  shellSource: "job" | "workflow" | "runner-default" | "unknown";
  steps: WorkflowStepFact[];
  omittedStepIds: string[];
  omittedStepCount: number;
  evidenceId: string;
}

export interface WorkflowFact {
  path: string;
  name: string | null;
  status: "completed" | "degraded";
  jobs: WorkflowJobFact[];
  omittedJobIds: string[];
  omittedJobCount: number;
  errors: string[];
  evidenceId: string;
}

export interface AnalyzerFact {
  id: string;
  applicability: "applicable" | "not_applicable";
  lifecycle: AnalyzerLifecycle;
  reason: string;
  definitionSha256: string;
  configSha256: string;
  profileSourceSha256: string | null;
  ruleSources: Array<{ path: string; sha256: string | null; error: string | null }>;
  executable: ExecutableIdentity | null;
  selectedFiles: string[];
  omittedSelectedFileIds: string[];
  omittedSelectedFileCount: number;
  counts: { found: number | null; surviving: number; reminders: number; suppressed: number };
  durationMs: number | null;
  cache: "unknown";
  evidenceIds: string[];
  semanticCoverage: false;
  staticResult: EngineReport["status"] | "not-run";
  detail: string | null;
}

export interface EvidenceLead {
  id: string;
  evidenceId: string;
  engine: string;
  rule: string;
  severity: Finding["severity"];
  file: string;
  range: { start: number; end: number };
  message: string;
  provenance: "introduced" | "pre-existing" | "unknown";
  source: "finding" | "reminder";
}

export interface EvidencePack {
  schema: typeof EVIDENCE_PACK_SCHEMA;
  version: 1;
  base: string;
  head: string;
  range: string;
  provenance: {
    changeManifestSha256: string;
    projectFactsSha256: string;
    profileConfigSha256: string;
    profileSourceSha256: string | null;
    engineRegistrySha256: string;
    scanResultSha256: string;
  };
  files: FileDisposition[];
  project: ProjectFacts & {
    omitted: { languages: number; buildSystems: number; frameworks: number; sourceRoots: number; testRoots: number; manifests: number; manifestErrors: number };
  };
  workflows: {
    files: WorkflowFact[];
    omittedFileIds: string[];
    omittedFileCount: number;
    errors: string[];
  };
  analyzers: AnalyzerFact[];
  leads: {
    items: EvidenceLead[];
    totalAfterSuppression: number;
    deduplicated: number;
    omittedIds: string[];
    omittedIdCount: number;
    omittedIdsTruncated: number;
  };
  suppression: { entries: ScanResult["suppressed"]; preExisting: number };
  completeness: {
    manifestTruncated: boolean;
    errors: string[];
    staticCleanIsSemanticCoverage: false;
  };
  limits: {
    maxPackBytes: number;
    contextBytes: number;
    maxLeads: number;
    maxWorkflowFiles: number;
    maxWorkflowJobs: number;
    maxWorkflowSteps: number;
    maxStepTextBytes: number;
    maxSelectedFilesPerAnalyzer: number;
  };
}

export interface EvidencePackFile {
  path: string;
  pack: EvidencePack;
  sha256: string;
  bytes: number;
}

export interface CreateEvidencePackOptions {
  repo: string;
  manifest: ChangeManifest;
  profile: Profile;
  profilePath?: string;
  rulesRoot?: string;
  project: ProjectFacts;
  scan: ScanResult;
  engines?: Engine[];
}

export interface LoadEvidencePackExpected {
  base: string;
  head: string;
  changeManifestSha256?: string;
  sha256?: string;
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
const clip = (value: string, max = MAX_TEXT): string => Buffer.from(value).subarray(0, max).toString("utf8").replace(/\uFFFD$/u, "");

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function changeManifestSha256(manifest: ChangeManifest): string {
  return canonicalSha256(manifest);
}

const evidenceId = (prefix: string, value: unknown): string => `${prefix}:${canonicalSha256(value).slice(0, 16)}`;
const pathBase = (path: string): string => path.split("/").at(-1) ?? path;
const pathParts = (path: string): string[] => path.toLowerCase().split("/");
function staticNames(values: string[]): Record<string, true> {
  return Object.fromEntries(values.map((value) => [value, true]));
}
const hasPart = (path: string, names: Record<string, true>): boolean => pathParts(path).some((part) => names[part] === true);
const underRoot = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

const LOCK_FILES = staticNames(["bun.lock", "bun.lockb", "cargo.lock", "composer.lock", "gemfile.lock", "go.sum", "package-lock.json", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "yarn.lock"]);
const MANIFEST_FILES = staticNames(["cargo.toml", "composer.json", "gemfile", "go.mod", "package.json", "package.swift", "pom.xml", "pyproject.toml", "requirements.txt", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);
const DOC_EXTENSIONS = staticNames([".adoc", ".md", ".mdx", ".rst"]);
const DOC_PARTS = staticNames(["doc", "docs", "documentation"]);
const ASSET_EXTENSIONS = staticNames([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".webp"]);
const BINARY_EXTENSIONS = staticNames([".7z", ".a", ".class", ".dll", ".dylib", ".exe", ".gz", ".jar", ".o", ".so", ".tar", ".tgz", ".woff", ".woff2", ".zip"]);
const IGNORED_PARTS = staticNames(["node_modules", "third_party", "third-party", "vendor", "vendors"]);
const GENERATED_PARTS = staticNames(["build", "coverage", "dist", "generated", "out", "target"]);
const TEST_PARTS = staticNames(["__tests__", "spec", "specs", "test", "tests"]);
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "C", ".cc": "C++", ".cpp": "C++", ".cs": "C#", ".css": "CSS", ".go": "Go", ".html": "HTML", ".java": "Java", ".js": "JavaScript", ".jsx": "JavaScript", ".json": "JSON", ".kt": "Kotlin", ".kts": "Kotlin", ".php": "PHP", ".py": "Python", ".rb": "Ruby", ".rs": "Rust", ".sh": "Shell", ".swift": "Swift", ".ts": "TypeScript", ".tsx": "TypeScript", ".vue": "Vue", ".yaml": "YAML", ".yml": "YAML",
};

function fileKind(file: ChangeFile): FileKind {
  const lower = file.path.toLowerCase();
  const name = pathBase(lower);
  const extension = extname(name);
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(lower)) return "workflow";
  if (pathParts(lower).some((part) => TEST_PARTS[part] === true) || /(?:^|[._-])(test|spec)\.[^.]+$/u.test(name)) return "test";
  if (MANIFEST_FILES[name] === true) return "manifest";
  if (/^(dockerfile|containerfile)(\..+)?$/u.test(name) || /(?:^|\/)(publish|release|deploy)(?:[._-][^/]*)?$/u.test(lower) || name.endsWith(".gemspec")) return "publisher";
  if (DOC_EXTENSIONS[extension] === true || hasPart(lower, DOC_PARTS)) return "documentation";
  if (ASSET_EXTENSIONS[extension] === true || BINARY_EXTENSIONS[extension] === true) return "asset";
  if (file.language || LANGUAGE_BY_EXTENSION[extension]) return "source";
  return "unknown";
}

/** Priority is intentional: immutable manifest facts win before bounded path heuristics. */
function disposition(file: ChangeFile, kind: FileKind): Pick<FileDisposition, "disposition" | "reason"> {
  const lower = file.path.toLowerCase();
  const name = pathBase(lower);
  if (file.status === "delete" || !file.new.exists) return { disposition: "deleted", reason: "change manifest marks the head side missing" };
  if (file.binary || file.new.type === "binary" || BINARY_EXTENSIONS[extname(name)] === true) return { disposition: "binary", reason: "change manifest or bounded extension rule identifies binary content" };
  if (LOCK_FILES[name] === true) return { disposition: "lock", reason: "bounded lockfile name" };
  if (pathParts(lower).some((part) => IGNORED_PARTS[part] === true)) return { disposition: "ignored", reason: "bounded vendored dependency directory" };
  if (pathParts(lower).some((part) => GENERATED_PARTS[part] === true) || /(?:\.generated|\.gen|\.min)\.[^/]+$/u.test(name) || name.endsWith(".map")) return { disposition: "generated", reason: "bounded generated-artifact path or suffix" };
  if (kind === "documentation" || kind === "asset") return { disposition: "no-reviewable", reason: `${kind} has no reviewable source semantics in this pack` };
  return { disposition: "selected", reason: `reviewable ${kind} file` };
}

function boundedProjectFacts(facts: ProjectFacts): EvidencePack["project"] {
  const capEvidence = (items: { name: string; evidence: string[] }[], limit: number) => items.slice(0, limit).map((item) => ({ name: clip(item.name, 200), evidence: item.evidence.slice(0, 20).map((entry) => clip(entry, 500)).sort() }));
  const languages = facts.languages.slice(0, 30);
  const buildSystems = capEvidence(facts.buildSystems, 20);
  const frameworks = capEvidence(facts.frameworks, 30);
  const sourceRoots = facts.sourceRoots.slice(0, 50);
  const testRoots = facts.testRoots.slice(0, 50);
  const manifests = facts.manifests.slice(0, 50);
  const manifestErrors = facts.manifestErrors.slice(0, 50).map((error) => clip(error));
  return {
    trackedFiles: facts.trackedFiles,
    languages,
    buildSystems,
    frameworks,
    sourceRoots,
    testRoots,
    manifests,
    manifestErrors,
    truncated: { manifests: facts.truncated.manifests || manifests.length < facts.manifests.length, roots: facts.truncated.roots || sourceRoots.length < facts.sourceRoots.length || testRoots.length < facts.testRoots.length },
    omitted: {
      languages: Math.max(0, facts.languages.length - languages.length),
      buildSystems: Math.max(0, facts.buildSystems.length - buildSystems.length),
      frameworks: Math.max(0, facts.frameworks.length - frameworks.length),
      sourceRoots: Math.max(0, facts.sourceRoots.length - sourceRoots.length),
      testRoots: Math.max(0, facts.testRoots.length - testRoots.length),
      manifests: Math.max(0, facts.manifests.length - manifests.length),
      manifestErrors: Math.max(0, facts.manifestErrors.length - manifestErrors.length),
    },
  };
}

function defaultShell(runsOn: string | null): { shell: string; source: "runner-default" | "unknown" } {
  if (!runsOn) return { shell: "unknown", source: "unknown" };
  if (/windows/i.test(runsOn)) return { shell: "pwsh", source: "runner-default" };
  if (/(ubuntu|macos|linux)/i.test(runsOn)) return { shell: "bash", source: "runner-default" };
  return { shell: "unknown", source: "unknown" };
}

const CONTROL_WORDS = staticNames(["case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "then", "until", "while"]);
function literalCommands(command: string): string[] {
  const names = new Set<string>();
  for (const fragment of command.split(/(?:\r?\n|&&|\|\||[|;])/u)) {
    const tokens = fragment.trim().match(/(?:"[^"]*"|'[^']*'|[^\s]+)/gu) ?? [];
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index]!)) index += 1;
    while (["command", "env", "nohup", "sudo"].includes(tokens[index]?.replace(/^['"]|['"]$/gu, "") ?? "")) {
      index += 1;
      while (tokens[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(tokens[index] ?? "")) index += 1;
    }
    const token = tokens[index]?.replace(/^['"]|['"]$/gu, "");
    if (!token || token.startsWith("$") || CONTROL_WORDS[token] === true) continue;
    if (/^[A-Za-z0-9_@+./:-]+$/u.test(token)) names.add(token);
    if (names.size >= 30) break;
  }
  return [...names].sort();
}

function yamlString(value: unknown, max = 500): string | null {
  return typeof value === "string" ? clip(value, max) : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

async function safeRepoFile(repo: string, relativePath: string): Promise<string> {
  const root = await realpath(repo);
  const path = await realpath(join(root, relativePath));
  if (!pathIsInside(root, path)) throw new Error("workflow path escapes reviewed checkout");
  return readFile(path, "utf8");
}

function workflowShell(value: JsonRecord | null): string | null {
  return yamlString(record(record(value?.defaults)?.run)?.shell);
}

async function workflowFact(repo: string, path: string, counters: { jobs: number; steps: number }): Promise<WorkflowFact> {
  const id = evidenceId("workflow", path);
  const errors: string[] = [];
  try {
    const raw = await safeRepoFile(repo, path);
    const root = record(parse(raw));
    if (!root) throw new Error("workflow root must be a mapping");
    const jobsValue = record(root.jobs);
    if (!jobsValue) throw new Error("workflow jobs must be a mapping");
    const workflowDefault = workflowShell(root);
    const jobs: WorkflowJobFact[] = [];
    const allJobIds = Object.keys(jobsValue).sort();
    const omittedJobIds: string[] = [];
    for (const jobId of allJobIds) {
      if (counters.jobs >= MAX_WORKFLOW_JOBS) { omittedJobIds.push(jobId); continue; }
      const job = record(jobsValue[jobId]);
      if (!job) { errors.push(`${jobId}: job must be a mapping`); continue; }
      counters.jobs += 1;
      const runsOn = yamlString(job["runs-on"]);
      const jobDefault = workflowShell(job);
      const fallback = defaultShell(runsOn);
      const shell = jobDefault ?? workflowDefault ?? fallback.shell;
      const shellSource: WorkflowJobFact["shellSource"] = jobDefault ? "job" : workflowDefault ? "workflow" : fallback.source;
      const rawSteps = Array.isArray(job.steps) ? job.steps : [];
      if (!Array.isArray(job.steps)) errors.push(`${jobId}: steps must be an array`);
      const steps: WorkflowStepFact[] = [];
      const omittedStepIds: string[] = [];
      for (const [stepIndex, rawStep] of rawSteps.entries()) {
        const stepId = `${jobId}/${stepIndex + 1}`;
        if (counters.steps >= MAX_WORKFLOW_STEPS) { omittedStepIds.push(stepId); continue; }
        const step = record(rawStep);
        if (!step) { errors.push(`${stepId}: step must be a mapping`); continue; }
        counters.steps += 1;
        const runText = yamlString(step.run, Number.MAX_SAFE_INTEGER);
        const uses = yamlString(step.uses);
        const stepShell = yamlString(step.shell);
        const resolvedShell = runText ? stepShell ?? jobDefault ?? workflowDefault ?? fallback.shell : null;
        const source: WorkflowStepFact["shellSource"] = !runText ? null : stepShell ? "step" : jobDefault ? "job" : workflowDefault ? "workflow" : fallback.source;
        const text = runText === null ? null : clip(runText, MAX_STEP_TEXT);
        steps.push({
          index: stepIndex + 1,
          id: yamlString(step.id, 200),
          name: yamlString(step.name),
          kind: runText !== null ? "run" : uses !== null ? "uses" : "other",
          shell: resolvedShell,
          shellSource: source,
          commandNames: runText === null ? [] : literalCommands(runText),
          uses,
          text,
          truncated: runText !== null && Buffer.byteLength(runText) > MAX_STEP_TEXT,
          evidenceId: evidenceId("workflow-step", { path, jobId, step: stepIndex + 1 }),
        });
      }
      jobs.push({
        id: jobId,
        name: yamlString(job.name),
        runsOn,
        shell,
        shellSource,
        steps,
        omittedStepIds: omittedStepIds.slice(0, MAX_OMITTED_IDS),
        omittedStepCount: omittedStepIds.length,
        evidenceId: evidenceId("workflow-job", { path, jobId }),
      });
    }
    return {
      path,
      name: yamlString(root.name),
      status: errors.length > 0 || omittedJobIds.length > 0 || jobs.some((job) => job.omittedStepCount > 0) ? "degraded" : "completed",
      jobs,
      omittedJobIds: omittedJobIds.slice(0, MAX_OMITTED_IDS),
      omittedJobCount: omittedJobIds.length,
      errors: errors.slice(0, 50).map((error) => clip(error)),
      evidenceId: id,
    };
  } catch (error) {
    return { path, name: null, status: "degraded", jobs: [], omittedJobIds: [], omittedJobCount: 0, errors: [clip(error instanceof Error ? error.message : String(error))], evidenceId: id };
  }
}

async function workflowFacts(repo: string, manifest: ChangeManifest): Promise<EvidencePack["workflows"]> {
  const paths = manifest.files.filter((file) => file.new.exists && /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(file.path)).map((file) => file.path).sort();
  const selected = paths.slice(0, MAX_WORKFLOW_FILES);
  const counters = { jobs: 0, steps: 0 };
  const files: WorkflowFact[] = [];
  for (const path of selected) files.push(await workflowFact(repo, path, counters));
  const omitted = paths.slice(MAX_WORKFLOW_FILES).map((path) => evidenceId("workflow", path));
  const errors = files.flatMap((file) => file.errors.map((error) => `${file.path}: ${error}`));
  return { files, omittedFileIds: omitted.slice(0, MAX_OMITTED_IDS), omittedFileCount: omitted.length, errors: errors.slice(0, 100).map((error) => clip(error)) };
}

function normalizeLeads(scan: ScanResult): EvidencePack["leads"] {
  const candidates = [
    ...scan.findings.map((finding) => ({ finding, source: "finding" as const })),
    ...scan.reminders.map((finding) => ({ finding, source: "reminder" as const })),
  ].map(({ finding, source }) => {
    const range = { start: finding.line, end: finding.endLine ?? finding.line };
    const mechanism = { engine: finding.engine, rule: finding.rule, file: finding.file, range };
    return {
      id: `L-${canonicalSha256(mechanism).slice(0, 16)}`,
      evidenceId: evidenceId("scan", mechanism),
      engine: finding.engine,
      rule: finding.rule,
      severity: finding.severity,
      file: finding.file,
      range,
      message: clip(finding.message),
      provenance: finding.provenance ?? "unknown",
      source,
    } satisfies EvidenceLead;
  }).sort((left, right) => left.id.localeCompare(right.id) || left.message.localeCompare(right.message) || left.source.localeCompare(right.source));
  const unique = new Map<string, EvidenceLead>();
  for (const lead of candidates) if (!unique.has(lead.id)) unique.set(lead.id, lead);
  const all = [...unique.values()].sort((left, right) => left.file.localeCompare(right.file) || left.range.start - right.range.start || left.engine.localeCompare(right.engine) || left.rule.localeCompare(right.rule));
  const items = all.slice(0, MAX_LEADS);
  const omitted = all.slice(MAX_LEADS).map((lead) => lead.id);
  return {
    items,
    totalAfterSuppression: candidates.length,
    deduplicated: candidates.length - all.length,
    omittedIds: omitted.slice(0, MAX_OMITTED_IDS),
    omittedIdCount: omitted.length,
    omittedIdsTruncated: Math.max(0, omitted.length - MAX_OMITTED_IDS),
  };
}

async function optionalFileSha256(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch { return null; }
}

async function ruleSources(root: string, paths: string[]): Promise<AnalyzerFact["ruleSources"]> {
  return Promise.all(paths.slice().sort().map(async (path) => {
    try {
      const base = await realpath(root);
      const resolved = await realpath(resolve(base, path));
      if (!pathIsInside(base, resolved)) throw new Error("rule source escapes trusted root");
      return { path, sha256: createHash("sha256").update(await readFile(resolved)).digest("hex"), error: null };
    } catch (error) {
      return { path, sha256: null, error: clip(error instanceof Error ? error.message : String(error)) };
    }
  }));
}

function customDefinition(profile: Profile, id: string): { bin: string; source: unknown } | undefined {
  const definition = profile.custom.find((item) => item.id === id);
  return definition ? { bin: definition.command[0]!, source: definition } : undefined;
}

async function analyzerFacts(options: CreateEvidencePackOptions, leads: EvidenceLead[], profileSourceSha256: string | null): Promise<AnalyzerFact[]> {
  const installed = options.engines ?? ENGINES;
  const reports = new Map(options.scan.engines.map((report) => [report.engine, report]));
  const ids = [...new Set([...installed.map((engine) => engine.id), ...reports.keys()])].sort();
  return Promise.all(ids.map(async (id) => {
    const engine = installed.find((candidate) => candidate.id === id);
    const custom = customDefinition(options.profile, id);
    const report = reports.get(id);
    const selected = [...new Set(report?.selectedFiles ?? [])].sort();
    const applicable = selected.length > 0 || (report !== undefined && report.status !== "not-applicable");
    const baseError = options.scan.baseErrors.find((item) => item.engine === id);
    const lifecycle: AnalyzerLifecycle = !applicable ? "not_applicable" : report?.status === "error" || report?.status === "missing" ? "failed" : baseError ? "degraded" : report ? "completed" : "failed";
    const profileConfig = options.profile.engines[id] ?? {};
    const sources = await ruleSources(options.rulesRoot ?? options.repo, profileConfig.rules ?? []);
    const definition = engine ? { id: engine.id, bin: engine.bin, select: String(engine.select), scan: String(engine.scan) } : custom?.source ?? { id, unavailable: true };
    const executable = applicable && (engine?.bin || custom?.bin) ? await executableIdentity(engine?.bin ?? custom!.bin, options.repo) : null;
    const analyzerLeadIds = leads.filter((lead) => lead.engine === id).map((lead) => lead.evidenceId);
    const statusEvidence = evidenceId("analyzer", { id, report, baseError });
    const suppressed = options.scan.suppressed.filter((entry) => entry.rule.startsWith(`${id}/`)).reduce((count, entry) => count + entry.count, 0);
    const reminders = options.scan.reminders.filter((finding) => finding.engine === id).length;
    const omittedSelected = selected.slice(MAX_SELECTED_FILES).map((path) => evidenceId("file", path));
    return {
      id,
      applicability: applicable ? "applicable" : "not_applicable",
      lifecycle,
      reason: !applicable ? (report ? "engine selector and trusted profile selected no reviewable changed files" : "engine was not selected for this run") : lifecycle === "failed" ? clip(report?.detail ?? "engine did not complete") : lifecycle === "degraded" ? clip(baseError?.detail ?? "base comparison degraded") : "applicable engine completed",
      definitionSha256: canonicalSha256(definition),
      configSha256: canonicalSha256(profileConfig),
      profileSourceSha256,
      ruleSources: sources,
      executable,
      selectedFiles: selected.slice(0, MAX_SELECTED_FILES),
      omittedSelectedFileIds: omittedSelected.slice(0, MAX_OMITTED_IDS),
      omittedSelectedFileCount: omittedSelected.length,
      counts: { found: report?.found ?? null, surviving: options.scan.findings.filter((finding) => finding.engine === id).length, reminders, suppressed },
      durationMs: report?.durationMs ?? null,
      cache: "unknown",
      evidenceIds: [statusEvidence, ...analyzerLeadIds].sort(),
      semanticCoverage: false,
      staticResult: report?.status ?? "not-run",
      detail: report?.detail ? clip(report.detail) : baseError?.detail ? clip(baseError.detail) : null,
    } satisfies AnalyzerFact;
  }));
}

function relevantFacts(path: string, project: EvidencePack["project"], workflows: EvidencePack["workflows"]): FileDisposition["facts"] {
  const sourceRoot = project.sourceRoots.filter((root) => underRoot(path, root)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;
  const testRoot = project.testRoots.filter((root) => underRoot(path, root)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;
  return {
    sourceRoot,
    testRoot,
    buildSystems: project.buildSystems.map((fact) => fact.name),
    frameworks: project.frameworks.map((fact) => fact.name),
    workflowEvidenceId: workflows.files.find((workflow) => workflow.path === path)?.evidenceId ?? null,
  };
}

export async function createEvidencePack(options: CreateEvidencePackOptions): Promise<EvidencePack> {
  await validateChangeManifestCheckout(options.repo, options.manifest);
  const [project, workflows, profileSourceSha256] = await Promise.all([
    Promise.resolve(boundedProjectFacts(options.project)),
    workflowFacts(options.repo, options.manifest),
    optionalFileSha256(options.profilePath),
  ]);
  const files = options.manifest.files.map((file) => {
    const kind = fileKind(file);
    return {
      path: file.path,
      status: file.status,
      ...disposition(file, kind),
      language: file.language ?? LANGUAGE_BY_EXTENSION[extname(file.path).toLowerCase()] ?? "unknown",
      kind,
      evidenceId: evidenceId("file", { path: file.path, old: file.old.oid, new: file.new.oid, status: file.status }),
      facts: relevantFacts(file.path, project, workflows),
    } satisfies FileDisposition;
  }).sort((left, right) => left.path.localeCompare(right.path));
  const leads = normalizeLeads(options.scan);
  const analyzers = await analyzerFacts(options, leads.items, profileSourceSha256);
  const context = { files, project, workflows, analyzers, leads };
  const pack: EvidencePack = {
    schema: EVIDENCE_PACK_SCHEMA,
    version: 1,
    base: options.manifest.base,
    head: options.manifest.head,
    range: options.manifest.range,
    provenance: {
      changeManifestSha256: changeManifestSha256(options.manifest),
      projectFactsSha256: canonicalSha256(options.project),
      profileConfigSha256: canonicalSha256(options.profile),
      profileSourceSha256,
      engineRegistrySha256: canonicalSha256((options.engines ?? ENGINES).map((engine) => ({ id: engine.id, bin: engine.bin, select: String(engine.select), scan: String(engine.scan) }))),
      scanResultSha256: canonicalSha256(options.scan),
    },
    files,
    project,
    workflows,
    analyzers,
    leads,
    suppression: { entries: options.scan.suppressed.slice().sort((a, b) => a.rule.localeCompare(b.rule)), preExisting: options.scan.preExisting },
    completeness: {
      manifestTruncated: options.manifest.truncated,
      errors: [...options.manifest.errors, ...options.manifest.files.flatMap((file) => file.errors.map((error) => `${file.path}: ${error}`)), ...workflows.errors].slice(0, 200).map((error) => clip(error)),
      staticCleanIsSemanticCoverage: false,
    },
    limits: {
      maxPackBytes: MAX_EVIDENCE_PACK_BYTES,
      contextBytes: Buffer.byteLength(JSON.stringify(context)),
      maxLeads: MAX_LEADS,
      maxWorkflowFiles: MAX_WORKFLOW_FILES,
      maxWorkflowJobs: MAX_WORKFLOW_JOBS,
      maxWorkflowSteps: MAX_WORKFLOW_STEPS,
      maxStepTextBytes: MAX_STEP_TEXT,
      maxSelectedFilesPerAnalyzer: MAX_SELECTED_FILES,
    },
  };
  validateEvidencePack(pack);
  const bytes = Buffer.byteLength(`${JSON.stringify(pack, null, 1)}\n`);
  if (bytes > MAX_EVIDENCE_PACK_BYTES) throw new Error(`evidence pack is ${bytes} bytes; bounded maximum is ${MAX_EVIDENCE_PACK_BYTES}`);
  return pack;
}

function exactKeys(value: JsonRecord, keys: string[], label: string): void {
  const expected = keys.slice().sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`invalid ${label} fields`);
}

function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

export function validateEvidencePack(value: unknown): EvidencePack {
  const pack = record(value);
  if (!pack) throw new Error("evidence pack must be an object");
  exactKeys(pack, ["schema", "version", "base", "head", "range", "provenance", "files", "project", "workflows", "analyzers", "leads", "suppression", "completeness", "limits"], "evidence pack");
  if (pack.schema !== EVIDENCE_PACK_SCHEMA || pack.version !== 1) throw new Error(`unsupported evidence pack schema ${String(pack.schema)}`);
  if (typeof pack.base !== "string" || typeof pack.head !== "string" || !/^[a-f0-9]{40,64}$/u.test(pack.base) || !/^[a-f0-9]{40,64}$/u.test(pack.head) || pack.range !== `${pack.base}...${pack.head}`) throw new Error("invalid evidence pack base/head identity");
  const provenance = record(pack.provenance);
  if (!provenance) throw new Error("invalid evidence pack provenance");
  exactKeys(provenance, ["changeManifestSha256", "projectFactsSha256", "profileConfigSha256", "profileSourceSha256", "engineRegistrySha256", "scanResultSha256"], "evidence pack provenance");
  for (const key of ["changeManifestSha256", "projectFactsSha256", "profileConfigSha256", "engineRegistrySha256", "scanResultSha256"]) if (!sha(provenance[key])) throw new Error(`invalid evidence pack ${key}`);
  if (provenance.profileSourceSha256 !== null && !sha(provenance.profileSourceSha256)) throw new Error("invalid evidence pack profileSourceSha256");
  if (!Array.isArray(pack.files) || !Array.isArray(pack.analyzers)) throw new Error("invalid evidence pack scope arrays");
  const filePaths = new Set<string>();
  for (const entry of pack.files) {
    const file = record(entry);
    if (!file) throw new Error("invalid evidence pack file disposition");
    exactKeys(file, ["path", "status", "disposition", "reason", "language", "kind", "evidenceId", "facts"], "file disposition");
    if (typeof file.path !== "string" || file.path.length === 0 || filePaths.has(file.path)) throw new Error("duplicate or invalid evidence pack file path");
    filePaths.add(file.path);
    if (!["selected", "ignored", "generated", "binary", "lock", "deleted", "no-reviewable"].includes(String(file.disposition))) throw new Error(`invalid disposition for ${file.path}`);
    if (typeof file.reason !== "string" || typeof file.language !== "string" || typeof file.kind !== "string" || typeof file.evidenceId !== "string") throw new Error(`incomplete disposition for ${file.path}`);
  }
  const analyzerIds = new Set<string>();
  for (const entry of pack.analyzers) {
    const analyzer = record(entry);
    if (!analyzer || typeof analyzer.id !== "string" || analyzerIds.has(analyzer.id)) throw new Error("duplicate or invalid analyzer record");
    analyzerIds.add(analyzer.id);
    if (!["applicable", "not_applicable"].includes(String(analyzer.applicability)) || !["not_applicable", "started", "completed", "degraded", "failed"].includes(String(analyzer.lifecycle)) || analyzer.cache !== "unknown" || analyzer.semanticCoverage !== false) throw new Error(`invalid analyzer lifecycle ${analyzer.id}`);
    if ((analyzer.applicability === "not_applicable") !== (analyzer.lifecycle === "not_applicable")) throw new Error(`inconsistent analyzer applicability ${analyzer.id}`);
  }
  const leads = record(pack.leads);
  if (!leads || !Array.isArray(leads.items)) throw new Error("invalid evidence pack leads");
  const leadIds = new Set<string>();
  for (const entry of leads.items) {
    const lead = record(entry);
    if (!lead || typeof lead.id !== "string" || leadIds.has(lead.id) || typeof lead.evidenceId !== "string") throw new Error("duplicate or invalid evidence lead");
    leadIds.add(lead.id);
  }
  if (!record(pack.project) || !record(pack.workflows) || !record(pack.suppression) || !record(pack.completeness) || !record(pack.limits)) throw new Error("invalid evidence pack sections");
  if (record(pack.completeness)?.staticCleanIsSemanticCoverage !== false) throw new Error("evidence pack must not claim semantic coverage from static analysis");
  return value as EvidencePack;
}

async function outsideCheckout(repo: string, path: string, existing: boolean): Promise<{ repo: string; path: string }> {
  const canonicalRepo = await realpath(repo);
  const requested = resolve(path);
  if (existing && (await lstat(requested)).isSymbolicLink()) throw new Error("evidence pack path must not be a symbolic link");
  const canonicalPath = existing ? await realpath(requested) : join(await realpath(dirname(requested)), basename(requested));
  if (pathIsInside(canonicalRepo, canonicalPath)) throw new Error("evidence pack must stay outside the reviewed checkout");
  return { repo: canonicalRepo, path: canonicalPath };
}

async function commit(repo: string, ref: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--verify", `${ref}^{commit}`], repo, { timeoutMs: 30_000, env: safeChildEnvironment() });
  if (result.code !== 0 || !/^[a-f0-9]{40,64}$/u.test(result.stdout.trim())) throw new Error(`cannot resolve evidence pack revision ${ref}`);
  return result.stdout.trim();
}

export async function validateEvidencePackCheckout(repo: string, pack: EvidencePack, expected?: LoadEvidencePackExpected): Promise<void> {
  validateEvidencePack(pack);
  const canonicalRepo = await realpath(repo);
  const [base, head] = await Promise.all([commit(canonicalRepo, pack.base), commit(canonicalRepo, "HEAD")]);
  if (base !== pack.base || head !== pack.head) throw new Error("evidence pack base/head does not match the reviewed checkout");
  if (expected && (expected.base !== pack.base || expected.head !== pack.head)) throw new Error("expected base/head does not match the evidence pack");
  if (expected?.changeManifestSha256 && expected.changeManifestSha256 !== pack.provenance.changeManifestSha256) throw new Error("change manifest hash does not match the evidence pack");
}

export async function writeEvidencePack(repo: string, path: string, pack: EvidencePack): Promise<EvidencePackFile> {
  await validateEvidencePackCheckout(repo, pack);
  await mkdir(dirname(resolve(path)), { recursive: true });
  const canonical = await outsideCheckout(repo, path, false);
  if (existsSync(canonical.path) && (await lstat(canonical.path)).isSymbolicLink()) throw new Error("evidence pack path must not be a symbolic link");
  const body = `${JSON.stringify(pack, null, 1)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_EVIDENCE_PACK_BYTES) throw new Error(`evidence pack is ${bytes} bytes; bounded maximum is ${MAX_EVIDENCE_PACK_BYTES}`);
  const temporary = `${canonical.path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, canonical.path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path: canonical.path, pack, sha256: createHash("sha256").update(body).digest("hex"), bytes };
}

export async function loadEvidencePack(repo: string, path: string, expected?: LoadEvidencePackExpected): Promise<EvidencePackFile> {
  const canonical = await outsideCheckout(repo, path, true);
  const body = await readFile(canonical.path);
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (expected?.sha256 && expected.sha256 !== sha256) throw new Error("evidence pack file hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch (error) { throw new Error(`invalid evidence pack JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const pack = validateEvidencePack(parsed);
  await validateEvidencePackCheckout(canonical.repo, pack, expected);
  return { path: canonical.path, pack, sha256, bytes: body.byteLength };
}
