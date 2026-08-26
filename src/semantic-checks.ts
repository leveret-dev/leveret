import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  CAVEAT_CARDS,
  CAVEAT_CARD_SET_SHA256,
  MAX_CARD_SET_BYTES,
  MAX_CARD_BYTES,
  MAX_SELECTED_CARDS,
  selectCaveatCards,
  validateCaveatCards,
  type CaveatCard,
} from "./caveat-cards.js";
import { validateEvidencePack, type EvidencePack, type EvidencePackFile } from "./evidence-pack.js";
import { pathIsInside } from "./path.js";

export const GUIDANCE_SCHEMA = "leveret.guidance-result/v1" as const;
const MAX_GUIDANCE_BYTES = 64 * 1024;
const MAX_EVIDENCE_EXCERPT = 500;
const MAX_RULE_LEADS = 50;
const RULE_IDS = ["external-command-not-preflighted", "udev-trigger-before-consumer", "uv-sync-bare-project-command", "workflow-prerequisite-same-job"] as const;

export type SemanticRuleId = typeof RULE_IDS[number];
export type MutationId = "sibling-job-substitution" | "trigger-settle-deletion" | "uv-run-to-bare-command" | "last-list-entry-removal" | "pipe-to-file-substitution" | "wrong-mode-equal-byte";

export interface GuidanceLead {
  id: string;
  ruleId: SemanticRuleId;
  selectedFacts: string[];
  evidence: { path: string; startLine: number; endLine: number; excerpt: string; sha256: string };
  command: { argv: string[]; output: string; bounded: true } | null;
  message: string;
  limitations: string;
  applicability: string;
  provenance: { kind: "host-packaged-rule"; evidencePackSha256: string };
}

export interface MutationProfile {
  id: MutationId;
  version: 1;
  inputFormat: "text" | "json";
  description: string;
  limitations: string;
}

export interface MutationResult {
  mutationId: MutationId;
  inputSha256: string;
  result: string;
  resultSha256: string;
  limitations: string;
}

export interface MutationLead {
  id: string;
  mutationId: MutationId;
  selectedFacts: string[];
  evidence: { path: string; evidenceId: string };
  command: null;
  limitations: string;
  applicability: string;
  provenance: { kind: "host-packaged-mutation"; evidencePackSha256: string };
}

export interface CoverageRow {
  targetId: string;
  status: "rule" | "mutation" | "residual-question" | "model-only";
  mechanismId: string;
  rationale: string;
}

export interface GuidanceResult {
  schema: typeof GUIDANCE_SCHEMA;
  version: 1;
  base: string;
  head: string;
  provenance: {
    evidencePackSha256: string;
    changeManifestSha256: string;
    cardSetSha256: string;
    ruleSetSha256: string;
    dataSha256: string;
  };
  selectedCards: CaveatCard[];
  ruleLeads: GuidanceLead[];
  mutationLeads: MutationLead[];
  residualQuestions: Array<{ cardId: string; question: string }>;
  omissions: string[];
  budgets: { selectedCards: number; cardBytes: number; maxCards: number; maxCardBytes: number; totalBytes: number; maxTotalBytes: number };
  coverage: CoverageRow[];
  rejectedControls: Array<{ targetId: string; rationale: string }>;
  impact: { basis: "frozen-promoted-rule-fixtures"; withoutGuidance: { targetFindings: number; controlFindings: number }; withGuidance: { targetFindings: number; controlFindings: number }; added: { targetFindings: number; controlFindings: number }; removed: { targetFindings: number; controlFindings: number } };
}

export interface GuidanceFile { path: string; guidance: GuidanceResult; sha256: string; bytes: number }
export interface LoadGuidanceExpected { base: string; head: string; evidencePackSha256: string; sha256?: string }

type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null; }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function lineNumber(source: string, offset: number): number { return source.slice(0, Math.max(0, offset)).split("\n").length; }

const MUTATION_PROFILES: readonly MutationProfile[] = [
  { id: "sibling-job-substitution", version: 1, inputFormat: "json", description: "Move a proof marker from the armed job to an authoritative sibling job in an isolated fixture.", limitations: "Fixture JSON must contain distinct armedJob and siblingJob strings, with proofJob equal to armedJob." },
  { id: "trigger-settle-deletion", version: 1, inputFormat: "text", description: "Delete one literal udevadm settle command line from an isolated workflow fixture.", limitations: "Only a standalone literal settle line is changed." },
  { id: "uv-run-to-bare-command", version: 1, inputFormat: "text", description: "Remove one literal uv run prefix from an isolated command fixture.", limitations: "Only the first literal uv run prefix is changed." },
  { id: "last-list-entry-removal", version: 1, inputFormat: "json", description: "Remove the final member from an authoritative JSON string array fixture.", limitations: "The fixture must be a non-empty array of unique strings." },
  { id: "pipe-to-file-substitution", version: 1, inputFormat: "text", description: "Replace one producer | consumer line with regular-file stdin in an isolated shell fixture.", limitations: "Only a simple literal two-command pipeline without redirections is changed." },
  { id: "wrong-mode-equal-byte", version: 1, inputFormat: "json", description: "Keep fixture bytes equal while changing executable mode to 0644.", limitations: "The fixture must contain string fields bytes and mode, with mode 0755." },
];

export const COVERAGE_MATRIX: readonly CoverageRow[] = [
  { targetId: "pfblockerng-2444-r3790082579", status: "mutation", mechanismId: "wrong-mode-equal-byte", rationale: "Equal-byte/wrong-mode is deterministic only in an isolated fixture with explicit bytes and mode." },
  { targetId: "pfblockerng-2444-r3790082583", status: "model-only", mechanismId: "stale-generated-url-postcondition", rationale: "The required repository URL is repository policy; no global literal or inferred postcondition is safe." },
  { targetId: "pfblockerng-2444-r3790082585", status: "residual-question", mechanismId: "generated-published-tested-universe", rationale: "Fail-closed publication needs an authoritative artifact universe not present in generic repository text." },
  { targetId: "pfblockerng-2444-r3790082589", status: "mutation", mechanismId: "last-list-entry-removal", rationale: "A final-member mutation is bounded when a machine-readable list supplies the universe." },
  { targetId: "pfblockerng-2444-r3790082591", status: "residual-question", mechanismId: "non-vacuous-negative-assertions", rationale: "Completeness cannot be proved without an authoritative forbidden-member universe." },
  { targetId: "pfblockerng-2444-r3790082592", status: "mutation", mechanismId: "pipe-to-file-substitution", rationale: "An isolated transport fixture can deterministically distinguish pipe stdin from file stdin." },
  { targetId: "pfblockerng-2521-r3803609623", status: "rule", mechanismId: "udev-trigger-before-consumer", rationale: "Parsed workflow job order supplies trigger, settle, and consumer facts." },
  { targetId: "pfblockerng-2521-r3803609637", status: "rule", mechanismId: "external-command-not-preflighted", rationale: "A literal command-v loop supplies an authoritative exhaustive list for set comparison." },
  { targetId: "pfblockerng-2521-r3803609653", status: "rule", mechanismId: "uv-sync-bare-project-command", rationale: "uv manifest evidence plus an ordered literal recipe makes the mismatch deterministic." },
  { targetId: "pfblockerng-2521-r3803609662", status: "model-only", mechanismId: "parsed-command-guard-universe", rationale: "Without the guard's declared normalized command grammar, widening spellings would compile prose into a rule." },
  { targetId: "pfblockerng-2521-r3803609666", status: "rule", mechanismId: "workflow-prerequisite-same-job", rationale: "Parsed YAML preserves job boundaries and ordered run steps for armed egress jobs." },
  { targetId: "pfblockerng-2521-r3803609673", status: "residual-question", mechanismId: "non-vacuous-executable-assertion", rationale: "Comments and bare listings are excluded, but intended locale failure semantics remain project-specific." },
];

export const REJECTED_CONTROLS = [{ targetId: "pfblockerng-2521-r3803609633", rationale: "Do not promote the GNU-tar absolute-path suggestion: it makes the PATH-resolution assertion tautological." }] as const;
export const PROMOTED_IMPACT = { basis: "frozen-promoted-rule-fixtures", withoutGuidance: { targetFindings: 0, controlFindings: 0 }, withGuidance: { targetFindings: COVERAGE_MATRIX.filter((row) => row.status === "rule").length, controlFindings: 0 }, added: { targetFindings: COVERAGE_MATRIX.filter((row) => row.status === "rule").length, controlFindings: 0 }, removed: { targetFindings: 0, controlFindings: 0 } } as const;
export const SEMANTIC_RULE_SET_VERSION = 2;
export const SEMANTIC_RULE_SET_SHA256 = sha256(JSON.stringify({ version: SEMANTIC_RULE_SET_VERSION, rules: RULE_IDS }));
export const SEMANTIC_DATA_SHA256 = sha256(JSON.stringify({ coverage: COVERAGE_MATRIX, controls: REJECTED_CONTROLS, mutations: MUTATION_PROFILES, impact: PROMOTED_IMPACT }));

function mutationProfile(id: MutationId): MutationProfile {
  const profile = MUTATION_PROFILES.find((item) => item.id === id);
  if (!profile) throw new Error(`unknown mutation profile: ${id}`);
  return profile;
}

export function applyMutationProfile(id: MutationId, input: string): MutationResult {
  const profile = mutationProfile(id);
  let result: string;
  if (id === "sibling-job-substitution") {
    const value = record(JSON.parse(input));
    if (!value || typeof value.armedJob !== "string" || typeof value.siblingJob !== "string" || value.siblingJob === value.armedJob || value.proofJob !== value.armedJob) throw new Error("sibling-job fixture must colocate proof with armedJob and name a distinct siblingJob");
    result = JSON.stringify({ ...value, proofJob: value.siblingJob });
  } else if (id === "trigger-settle-deletion") {
    const matches = input.match(/^\s*udevadm\s+settle(?:\s+[^\n#]+)?\s*$/gmu) ?? [];
    if (matches.length !== 1) throw new Error("trigger-settle fixture must contain exactly one standalone settle line");
    result = input.replace(/^\s*udevadm\s+settle(?:\s+[^\n#]+)?\s*\n?/mu, "");
  } else if (id === "uv-run-to-bare-command") {
    if ((input.match(/\buv run\s+/gu) ?? []).length !== 1) throw new Error("uv fixture must contain exactly one uv run prefix");
    result = input.replace(/\buv run\s+/u, "");
  } else if (id === "last-list-entry-removal") {
    const value = JSON.parse(input) as unknown;
    if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string") || new Set(value).size !== value.length) throw new Error("list fixture must be a non-empty unique string array");
    result = JSON.stringify(value.slice(0, -1));
  } else if (id === "pipe-to-file-substitution") {
    const match = input.match(/^([A-Za-z0-9_./-]+(?:\s+[^|<>\n]+)?)\s*\|\s*([A-Za-z0-9_./-]+(?:\s+[^|<>\n]+)?)$/mu);
    if (!match || (input.match(/\|/gu) ?? []).length !== 1) throw new Error("pipe fixture must contain exactly one simple two-command pipeline");
    result = input.replace(match[0], `${match[1]!.trim()} > leveret-mutation.stdin\n${match[2]!.trim()} < leveret-mutation.stdin`);
  } else {
    const value = record(JSON.parse(input));
    if (!value || typeof value.bytes !== "string" || value.mode !== "0755") throw new Error("wrong-mode fixture must contain bytes and mode 0755");
    result = JSON.stringify({ ...value, mode: "0644" });
  }
  return { mutationId: id, inputSha256: sha256(input), result, resultSha256: sha256(result), limitations: profile.limitations };
}

async function reviewedFile(repo: string, path: string): Promise<string | null> {
  const root = await realpath(repo);
  try {
    const requested = resolve(root, path);
    const canonical = await realpath(requested);
    if (!pathIsInside(root, canonical) || (await lstat(canonical)).isSymbolicLink()) throw new Error(`review file escapes checkout: ${path}`);
    return await readFile(canonical, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function evidence(path: string, source: string, offset: number, excerpt: string): GuidanceLead["evidence"] {
  const bounded = excerpt.slice(0, MAX_EVIDENCE_EXCERPT);
  const startLine = lineNumber(source, offset);
  return { path, startLine, endLine: startLine + bounded.split("\n").length - 1, excerpt: bounded, sha256: sha256(bounded) };
}

function lead(ruleId: SemanticRuleId, packSha: string, selectedFacts: string[], itemEvidence: GuidanceLead["evidence"], message: string, limitations: string, applicability: string): GuidanceLead {
  const id = `semantic:${ruleId}:${sha256(JSON.stringify({ path: itemEvidence.path, line: itemEvidence.startLine, message })).slice(0, 20)}`;
  return { id, ruleId, selectedFacts: [...new Set(selectedFacts)].sort(), evidence: itemEvidence, command: null, message, limitations, applicability, provenance: { kind: "host-packaged-rule", evidencePackSha256: packSha } };
}

function shellCommands(source: string): Array<{ name: string; offset: number; line: string }> {
  const functions = new Set([...source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/gmu)].map((match) => match[1]!));
  const ignored: Record<string, true> = Object.fromEntries(["!", ".", ":", "[", "break", "case", "cd", "command", "continue", "do", "done", "echo", "elif", "else", "esac", "eval", "exec", "exit", "export", "false", "fi", "for", "if", "in", "local", "printf", "pwd", "read", "readonly", "return", "set", "shift", "test", "then", "trap", "true", "typeset", "ulimit", "umask", "unset", "until", "wait", "while", "sh", "rm", "mkdir"].map((name) => [name, true]));
  const commands: Array<{ name: string; offset: number; line: string }> = [];
  let offset = 0;
  let continuation = false;
  for (const rawLine of source.split(/(?<=\n)/u)) {
    const line = rawLine.replace(/\n$/u, "");
    const uncommented = line.replace(/(^|\s)#.*$/u, "$1").trim();
    const continuedFromPrevious = continuation;
    continuation = /\\\s*$/u.test(uncommented);
    if (continuedFromPrevious || /^[A-Za-z_][A-Za-z0-9_]*=.*\$\(/u.test(uncommented)) {
      offset += rawLine.length;
      continue;
    }
    const match = uncommented.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*(?:(?:env|nohup|sudo)\s+(?:-[^\s]+\s+)*)?([A-Za-z0-9_+.-]+)(?:\s|$)/u);
    const name = match?.[1];
    if (name && !ignored[name] && !functions.has(name) && !name.startsWith("pfb_") && !name.startsWith("-") && name !== "+" && !name.includes("/") && !uncommented.endsWith("() {") && !/^(?:command\s+-v|type\s)/u.test(uncommented)) commands.push({ name, offset: offset + line.indexOf(name), line: uncommented });
    offset += rawLine.length;
  }
  return commands;
}

function preflightLeads(path: string, source: string, fileEvidenceId: string, packSha: string): GuidanceLead[] {
  const leads: GuidanceLead[] = [];
  for (const loop of source.matchAll(/^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([A-Za-z0-9_+.-]+(?:\s+[A-Za-z0-9_+.-]+){2,})\s*;\s*do\s*$/gmu)) {
    const variable = loop[1]!;
    const start = loop.index;
    const tail = source.slice(start + loop[0].length);
    const done = tail.match(/^\s*done\s*$/mu);
    if (!done) continue;
    const body = tail.slice(0, done.index);
    if (!new RegExp(`(?:command\\s+-v|type\\s+)\\s+["']?\\$\\{?${variable}\\}?`, "u").test(body)) continue;
    const declared = new Set(loop[2]!.trim().split(/\s+/u));
    const afterOffset = start + loop[0].length + done.index! + done[0].length;
    for (const command of shellCommands(source.slice(afterOffset))) {
      if (declared.has(command.name)) continue;
      const itemEvidence = evidence(path, source, afterOffset + command.offset, command.line);
      leads.push(lead("external-command-not-preflighted", packSha, [fileEvidenceId], itemEvidence, `Literal external command ${command.name} is used after an exhaustive preflight that does not list it.`, "Function calls, dynamic command names, paths, shell builtins, and comments are excluded conservatively.", "A literal for-list of at least three tools is checked through command -v or type before later literal commands."));
    }
  }
  return leads;
}

function workflowRules(path: string, source: string, workflowEvidenceId: string, packSha: string): GuidanceLead[] {
  let root: JsonRecord | null;
  try { root = record(parse(source)); } catch { return []; }
  const jobs = record(root?.jobs);
  if (!jobs) return [];
  const leads: GuidanceLead[] = [];
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob);
    if (!job) continue;
    const jobOffset = Math.max(0, source.indexOf(jobId));
    const steps = Array.isArray(job.steps) ? job.steps.map(record).filter((step): step is JsonRecord => step !== null) : [];
    const runs = steps.map((step) => typeof step.run === "string" ? step.run : "");
    let pendingTrigger = false;
    for (const runText of runs) {
      for (const command of runText.split("\n")) {
        const executable = command.replace(/(^|\s)#.*$/u, "$1").trim();
        if (/\budevadm\s+trigger\b/u.test(executable)) pendingTrigger = !/(?:\btrigger\b[^\n]*\s--settle\b|\btrigger\s+-w\b)/u.test(executable);
        else if (/\budevadm\s+settle\b/u.test(executable)) pendingTrigger = false;
        else if (pendingTrigger && /(?:\/dev\/kvm\b|\bqemu-system-|\bqemu-img\b)/u.test(executable)) {
          const offset = source.indexOf(command, jobOffset);
          leads.push(lead("udev-trigger-before-consumer", packSha, [workflowEvidenceId], evidence(path, source, offset, command), `Workflow job ${jobId} consumes device state after udevadm trigger without an intervening settle.`, "Only literal commands in one parsed job are ordered; aliases, expressions, and reusable actions are not inferred.", "YAML job steps contain literal udevadm trigger and a later KVM/QEMU consumer."));
          pendingTrigger = false;
        }
      }
    }
    const jobEnv = record(job.env);
    const armed = [jobEnv?.SMOKE_BLOCK_EGRESS, ...steps.map((step) => record(step.env)?.SMOKE_BLOCK_EGRESS)].some((value) => value === true || value === 1 || value === "1" || value === "true") || runs.some((text) => /\bSMOKE_BLOCK_EGRESS=(?:1|true)\b/u.test(text));
    if (armed) {
      const combined = runs.join("\n");
      const setup = combined.search(/(^|\n)\s*(?:sudo\s+)?iptables\b/mu);
      const iptablesProof = combined.search(/(^|\n)\s*(?:sudo\s+)?iptables\s+-C\b/mu);
      const behaviorProof = combined.search(/(?:expect|assert|test).*(?:blocked|fail)/iu);
      const proof = [iptablesProof, behaviorProof].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? -1;
      if (setup < 0 || proof <= setup) {
        const marker = source.indexOf("SMOKE_BLOCK_EGRESS", jobOffset);
        leads.push(lead("workflow-prerequisite-same-job", packSha, [workflowEvidenceId], evidence(path, source, Math.max(0, marker), source.slice(Math.max(0, marker), Math.max(0, marker) + 120)), `Egress-blocking job ${jobId} lacks its own literal iptables setup and failing proof.`, "Artifacts, reusable workflows, custom actions, and dynamically constructed commands are not inferred.", "A parsed job explicitly arms SMOKE_BLOCK_EGRESS; prerequisites are evaluated only in that job."));
      }
    }
  }
  return leads;
}

function uvLeads(path: string, source: string, fileEvidenceId: string, packSha: string): GuidanceLead[] {
  const sync = source.search(/\buv\s+sync\b/u);
  if (sync < 0) return [];
  const tail = source.slice(sync, sync + 5000);
  const bare = tail.search(/(^|[\s`$;])python(?:3)?\s+-m\s+pytest\b/mu);
  if (bare < 0 || /\buv\s+run\s+python(?:3)?\s+-m\s+pytest\b/u.test(tail.slice(0, bare + 100))) return [];
  const offset = sync + bare + (tail.slice(bare).match(/(^|[\s`$;])/u)?.[0].length ?? 0);
  const excerpt = source.slice(offset, source.indexOf("\n", offset) < 0 ? source.length : source.indexOf("\n", offset));
  return [lead("uv-sync-bare-project-command", packSha, [fileEvidenceId], evidence(path, source, offset, excerpt), "A recipe performs uv sync and later invokes project pytest through a bare Python interpreter.", "An explicitly activated .venv or intentional system interpreter requires reviewer confirmation.", "The evidence pack identifies uv and the changed file contains an ordered literal uv sync/bare pytest recipe.")];
}

function mutationLeads(pack: EvidencePack, cards: CaveatCard[], packSha: string): MutationLead[] {
  const mutationByCard: Record<string, MutationId> = {
    "github-actions-job-local-state": "sibling-job-substitution",
    "systemd-udevadm-trigger-settle": "trigger-settle-deletion",
    "uv-project-environment-execution": "uv-run-to-bare-command",
    "generated-published-tested-universe": "last-list-entry-removal",
    "posix-pipe-versus-file-stdin": "pipe-to-file-substitution",
    "posix-executable-path-identity": "wrong-mode-equal-byte",
  };
  return cards.flatMap((card) => {
    const mutationId = mutationByCard[card.id];
    if (!mutationId) return [];
    const candidate = pack.files.find((file) => card.selector.languages?.includes(file.language) && card.selector.fileKinds?.includes(file.kind));
    if (!candidate) return [];
    const profile = mutationProfile(mutationId);
    return [{ id: `mutation:${mutationId}:${sha256(candidate.evidenceId).slice(0, 20)}`, mutationId, selectedFacts: [candidate.evidenceId], evidence: { path: candidate.path, evidenceId: candidate.evidenceId }, command: null, limitations: profile.limitations, applicability: `${profile.description} Apply only to an isolated fixture with its stated authoritative input.`, provenance: { kind: "host-packaged-mutation" as const, evidencePackSha256: packSha } }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}

export async function createGuidanceResult(repo: string, evidencePackFile: EvidencePackFile): Promise<GuidanceResult> {
  const pack = validateEvidencePack(evidencePackFile.pack);
  const selected = selectCaveatCards(pack);
  const selectedIds = new Set(selected.cards.map((card) => card.id));
  const ruleLeads: GuidanceLead[] = [];
  for (const file of pack.files.filter((item) => item.disposition !== "deleted")) {
    const source = await reviewedFile(repo, file.path);
    if (source === null) continue;
    if (selectedIds.has("exhaustive-executable-preflight") && file.language === "Shell" && file.kind === "source") ruleLeads.push(...preflightLeads(file.path, source, file.evidenceId, evidencePackFile.sha256));
    if (selectedIds.has("uv-project-environment-execution") && file.language === "Python") ruleLeads.push(...uvLeads(file.path, source, file.evidenceId, evidencePackFile.sha256));
    if ((selectedIds.has("systemd-udevadm-trigger-settle") || selectedIds.has("github-actions-job-local-state")) && file.kind === "workflow") {
      const workflowEvidenceId = pack.workflows.files.find((workflow) => workflow.path === file.path)?.evidenceId ?? file.evidenceId;
      ruleLeads.push(...workflowRules(file.path, source, workflowEvidenceId, evidencePackFile.sha256));
    }
  }
  ruleLeads.sort((left, right) => left.id.localeCompare(right.id));
  const omittedRuleLeadCount = Math.max(0, ruleLeads.length - MAX_RULE_LEADS);
  ruleLeads.splice(MAX_RULE_LEADS);
  const resolvedRules = new Set(ruleLeads.map((item) => item.ruleId));
  const residualQuestions = selected.cards.filter((card) => !card.ruleId || !resolvedRules.has(card.ruleId as SemanticRuleId)).map((card) => ({ cardId: card.id, question: card.residualQuestion }));
  const mutationItems = mutationLeads(pack, selected.cards, evidencePackFile.sha256);
  const result: GuidanceResult = {
    schema: GUIDANCE_SCHEMA, version: 1, base: pack.base, head: pack.head,
    provenance: { evidencePackSha256: evidencePackFile.sha256, changeManifestSha256: pack.provenance.changeManifestSha256, cardSetSha256: CAVEAT_CARD_SET_SHA256, ruleSetSha256: SEMANTIC_RULE_SET_SHA256, dataSha256: SEMANTIC_DATA_SHA256 },
    selectedCards: selected.cards,
    ruleLeads,
    mutationLeads: mutationItems,
    residualQuestions,
    omissions: [...selected.omissions, ...(omittedRuleLeadCount > 0 ? [`${omittedRuleLeadCount} semantic rule leads omitted by the ${MAX_RULE_LEADS}-lead budget.`] : []), "No authoritative universe: repository-specific generated/published/tested literals are not promoted.", "No free-text rule compilation: parsed command-guard spelling and metadata postconditions remain model-only.", "No checkout mutation: mutation profiles apply only to isolated fixtures."],
    budgets: { selectedCards: selected.cards.length, cardBytes: selected.bytes, maxCards: MAX_SELECTED_CARDS, maxCardBytes: MAX_CARD_BYTES, totalBytes: selected.bytes, maxTotalBytes: MAX_CARD_SET_BYTES },
    coverage: COVERAGE_MATRIX.map((row) => ({ ...row })),
    rejectedControls: REJECTED_CONTROLS.map((row) => ({ ...row })),
    impact: structuredClone(PROMOTED_IMPACT),
  };
  return validateGuidanceResult(result);
}

export function validateGuidanceResult(value: unknown): GuidanceResult {
  const result = record(value);
  if (!result || result.schema !== GUIDANCE_SCHEMA || result.version !== 1) throw new Error("unsupported guidance result schema");
  if (!/^[a-f0-9]{40,64}$/u.test(String(result.base)) || !/^[a-f0-9]{40,64}$/u.test(String(result.head))) throw new Error("invalid guidance base/head");
  const provenance = record(result.provenance);
  if (!provenance || provenance.cardSetSha256 !== CAVEAT_CARD_SET_SHA256 || provenance.ruleSetSha256 !== SEMANTIC_RULE_SET_SHA256 || provenance.dataSha256 !== SEMANTIC_DATA_SHA256 || !["evidencePackSha256", "changeManifestSha256"].every((key) => /^[a-f0-9]{64}$/u.test(String(provenance[key])))) throw new Error("invalid guidance provenance");
  if (!Array.isArray(result.selectedCards) || result.selectedCards.length > MAX_SELECTED_CARDS) throw new Error("invalid selected caveat cards");
  validateCaveatCards(result.selectedCards as CaveatCard[]);
  const trusted = new Map(CAVEAT_CARDS.map((card) => [card.id, JSON.stringify(card)]));
  for (const card of result.selectedCards as CaveatCard[]) if (trusted.get(card.id) !== JSON.stringify(card)) throw new Error(`guidance contains an untrusted caveat card: ${card.id}`);
  const selectedCards = result.selectedCards as CaveatCard[];
  if (selectedCards.some((card, index) => index > 0 && CAVEAT_CARDS.findIndex((host) => host.id === selectedCards[index - 1]!.id) >= CAVEAT_CARDS.findIndex((host) => host.id === card.id))) throw new Error("selected caveat cards are not in stable host order");
  if (!Array.isArray(result.ruleLeads) || result.ruleLeads.length > MAX_RULE_LEADS || !Array.isArray(result.mutationLeads) || !Array.isArray(result.residualQuestions) || !Array.isArray(result.omissions) || !Array.isArray(result.coverage) || !Array.isArray(result.rejectedControls)) throw new Error("incomplete or unbounded guidance result");
  for (const entry of result.ruleLeads as unknown[]) {
    const item = record(entry);
    const itemEvidence = record(item?.evidence);
    const itemProvenance = record(item?.provenance);
    if (!item || typeof item.id !== "string" || !RULE_IDS.includes(item.ruleId as SemanticRuleId) || !Array.isArray(item.selectedFacts) || !itemEvidence || typeof itemEvidence.excerpt !== "string" || sha256(itemEvidence.excerpt) !== itemEvidence.sha256 || !Number.isSafeInteger(itemEvidence.startLine) || !Number.isSafeInteger(itemEvidence.endLine) || Number(itemEvidence.startLine) < 1 || Number(itemEvidence.endLine) < Number(itemEvidence.startLine) || itemProvenance?.kind !== "host-packaged-rule" || itemProvenance.evidencePackSha256 !== provenance.evidencePackSha256) throw new Error("invalid semantic rule lead");
  }
  for (const entry of result.mutationLeads as unknown[]) {
    const item = record(entry);
    const itemProvenance = record(item?.provenance);
    if (!item || typeof item.id !== "string" || !MUTATION_PROFILES.some((profile) => profile.id === item.mutationId) || !Array.isArray(item.selectedFacts) || itemProvenance?.kind !== "host-packaged-mutation" || itemProvenance.evidencePackSha256 !== provenance.evidencePackSha256) throw new Error("invalid semantic mutation lead");
  }
  const resolvedRules = new Set((result.ruleLeads as GuidanceLead[]).map((item) => item.ruleId));
  const expectedQuestions = selectedCards.filter((card) => !card.ruleId || !resolvedRules.has(card.ruleId as SemanticRuleId)).map((card) => ({ cardId: card.id, question: card.residualQuestion }));
  if (JSON.stringify(result.residualQuestions) !== JSON.stringify(expectedQuestions)) throw new Error("residual questions were not suppressed after deterministic rules");
  if (!(result.omissions as unknown[]).every((item) => typeof item === "string")) throw new Error("invalid guidance omissions");
  if (JSON.stringify(result.coverage) !== JSON.stringify(COVERAGE_MATRIX) || JSON.stringify(result.rejectedControls) !== JSON.stringify(REJECTED_CONTROLS)) throw new Error("guidance corpus/control accounting differs from the promoted host data");
  const budgets = record(result.budgets);
  if (!budgets || Number(budgets.selectedCards) !== (result.selectedCards as unknown[]).length || Number(budgets.maxCards) !== MAX_SELECTED_CARDS || Number(budgets.maxCardBytes) !== MAX_CARD_BYTES || Number(budgets.cardBytes) !== Number(budgets.totalBytes) || Number(budgets.totalBytes) > MAX_CARD_SET_BYTES || Number(budgets.maxTotalBytes) !== MAX_CARD_SET_BYTES) throw new Error("guidance budget exceeded");
  if (JSON.stringify(result.impact) !== JSON.stringify(PROMOTED_IMPACT)) throw new Error("invalid deterministic guidance impact counts");
  return value as GuidanceResult;
}

async function outsideCheckout(repo: string, path: string, existing: boolean): Promise<string> {
  const root = await realpath(repo);
  const requested = resolve(path);
  if (existing && (await lstat(requested)).isSymbolicLink()) throw new Error("guidance path must not be a symbolic link");
  const canonical = existing ? await realpath(requested) : join(await realpath(dirname(requested)), basename(requested));
  if (pathIsInside(root, canonical)) throw new Error("guidance must stay outside the reviewed checkout");
  return canonical;
}

export async function writeGuidanceResult(repo: string, path: string, guidance: GuidanceResult): Promise<GuidanceFile> {
  validateGuidanceResult(guidance);
  await mkdir(dirname(resolve(path)), { recursive: true });
  const canonical = await outsideCheckout(repo, path, false);
  if (existsSync(canonical) && (await lstat(canonical)).isSymbolicLink()) throw new Error("guidance path must not be a symbolic link");
  const body = `${JSON.stringify(guidance, null, 1)}\n`;
  if (Buffer.byteLength(body) > MAX_GUIDANCE_BYTES) throw new Error("guidance result exceeds bounded maximum");
  const temporary = `${canonical}.${process.pid}.tmp`;
  try { await writeFile(temporary, body, { mode: 0o600 }); await rename(temporary, canonical); }
  finally { await rm(temporary, { force: true }); }
  return { path: canonical, guidance, sha256: sha256(body), bytes: Buffer.byteLength(body) };
}

export async function loadGuidanceResult(repo: string, path: string, expected: LoadGuidanceExpected): Promise<GuidanceFile> {
  const canonical = await outsideCheckout(repo, path, true);
  const body = await readFile(canonical);
  const fileSha = sha256(body);
  if (expected.sha256 && expected.sha256 !== fileSha) throw new Error("guidance file hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch (error) { throw new Error(`invalid guidance JSON: ${String(error)}`); }
  const guidance = validateGuidanceResult(parsed);
  if (guidance.base !== expected.base || guidance.head !== expected.head || guidance.provenance.evidencePackSha256 !== expected.evidencePackSha256) throw new Error("guidance identity does not match the evidence pack");
  return { path: canonical, guidance, sha256: fileSha, bytes: body.byteLength };
}
