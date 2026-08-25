import { createHash } from "node:crypto";
import type { EvidencePack, FileKind } from "./evidence-pack.js";

export const CAVEAT_CARD_SCHEMA = "leveret.caveat-card/v1" as const;
export const MAX_SELECTED_CARDS = 6;
export const MAX_CARD_BYTES = 1024;
export const MAX_CARD_WORDS = 250;
export const MAX_CARD_SET_BYTES = 8 * 1024;

export interface CardSelector {
  languages?: string[];
  fileKinds?: FileKind[];
  buildSystems?: string[];
  workflowCommandsAll?: string[];
  workflowCommandsAny?: string[];
}

export interface CaveatCard {
  schema: typeof CAVEAT_CARD_SCHEMA;
  id: string;
  version: number;
  selector: CardSelector;
  source: { url: string; upstreamVersion: string; retrievedAt: string; excerpt: string; sha256: string };
  invariant: string;
  limitations: string;
  ruleId: string | null;
  residualQuestion: string;
  retirement: { revalidateAfter: string; condition: string };
}

const CARDS: readonly CaveatCard[] = [
  {
    schema: CAVEAT_CARD_SCHEMA, id: "systemd-udevadm-trigger-settle", version: 1,
    selector: { languages: ["YAML"], fileKinds: ["workflow"], workflowCommandsAll: ["udevadm"], workflowCommandsAny: ["qemu-system-x86_64", "qemu-img"] },
    source: { url: "https://www.freedesktop.org/software/systemd/man/latest/udevadm.html", upstreamVersion: "systemd 261.2", retrievedAt: "2026-08-24", excerpt: "Apart from triggering events, also waits for those events to finish.", sha256: "595d7597b5cb31947fccb7041781db8a70626365751320c95c13147f9ae2e0c5" },
    invariant: "A udev trigger must settle its events before a later step consumes the resulting device state.",
    limitations: "Only literal commands ordered in one parsed job are proved.",
    ruleId: "udev-trigger-before-consumer", residualQuestion: "Does every path settle before device use?",
    retirement: { revalidateAfter: "2027-02-24", condition: "Revalidate when systemd semantics change." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "github-actions-job-local-state", version: 1,
    selector: { languages: ["YAML"], fileKinds: ["workflow"] },
    source: { url: "https://docs.github.com/en/actions/get-started/understand-github-actions#jobs", upstreamVersion: "GitHub Actions docs 2026-08-24", retrievedAt: "2026-08-24", excerpt: "A job is a set of steps in a workflow that is executed on the same runner. Steps are executed in order and are dependent on each other.", sha256: "5e23d3ac77669069e61d2c54de168f5cf3b7b45b2bd2e3fd73ff1992d31d0f95" },
    invariant: "Stateful setup, proof, and use must occur in order in the same job unless state is explicitly transferred.",
    limitations: "Artifacts, services, reusable workflows, and persistent runners are not inferred.",
    ruleId: "workflow-prerequisite-same-job", residualQuestion: "Does every armed job contain ordered setup and proof?",
    retirement: { revalidateAfter: "2027-02-24", condition: "Revalidate when GitHub job isolation changes." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "uv-project-environment-execution", version: 1,
    selector: { languages: ["Python"], buildSystems: ["uv"] },
    source: { url: "https://docs.astral.sh/uv/concepts/projects/run/", upstreamVersion: "uv 0.12.5 docs", retrievedAt: "2026-08-24", excerpt: "When working on a project, it is installed into the virtual environment at .venv. This environment is isolated from the current shell by default. Instead, use uv run to run commands in the project environment.", sha256: "8627379f0cff185ca13e14b379ab6f5d1a7649692628723f0a4cfc7dd3289531" },
    invariant: "Commands that rely on a uv project environment should run through uv run, not a bare interpreter from the current shell.",
    limitations: "An activated .venv or intentional system interpreter can be valid.",
    ruleId: "uv-sync-bare-project-command", residualQuestion: "Is bare execution intentionally outside the uv environment?",
    retirement: { revalidateAfter: "2027-02-24", condition: "Revalidate when uv environment semantics change." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "posix-pipe-versus-file-stdin", version: 1,
    selector: { languages: ["Shell", "Python"], fileKinds: ["test"] },
    source: { url: "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_09_02", upstreamVersion: "POSIX.1-2024 Issue 8", retrievedAt: "2026-08-24", excerpt: "The standard output of command1 shall be connected to the standard input of command2.", sha256: "c9f1742e163f39207910ab230db6c796dc0c9e4a6684006ce85cfe5e0b0ef13c" },
    invariant: "A pipe-topology contract is not proved by invoking the consumer with regular-file input redirection.",
    limitations: "Equivalent bytes do not prove descriptor topology.",
    ruleId: null, residualQuestion: "Does the test preserve production stdin topology?",
    retirement: { revalidateAfter: "2029-12-31", condition: "Revalidate for a new POSIX edition." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "exhaustive-executable-preflight", version: 1,
    selector: { languages: ["Shell"], fileKinds: ["source"] },
    source: { url: "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_09_01_04", upstreamVersion: "POSIX.1-2024 Issue 8", retrievedAt: "2026-08-24", excerpt: "If the command name does not contain any slash characters, the command name shall be searched for using the PATH environment variable.", sha256: "e6350cf3d768b86eccacbfd26f7a8e06d57dd60cbe99ebb0a8f567dd3951c60a" },
    invariant: "A structurally exhaustive command preflight must include every later literal external command in its scope.",
    limitations: "Only literal inventories and commands are compared.",
    ruleId: "external-command-not-preflighted", residualQuestion: "Are dynamic commands absent from the exhaustive preflight?",
    retirement: { revalidateAfter: "2029-12-31", condition: "Revalidate for POSIX or tokenizer changes." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "generated-published-tested-universe", version: 1,
    selector: { languages: ["Shell"], fileKinds: ["publisher", "test"] },
    source: { url: "https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/references.md#parameters", upstreamVersion: "shellspec f2d13f991885ef44e6b54e571e0842222251b111", retrievedAt: "2026-08-24", excerpt: "Multiple Parameters definitions are merged.", sha256: "1845978a1407f22af4897388ad86b05a38b37c08fc4ebe39b80b2aadca52dd59" },
    invariant: "Generated, published, and tested sets can be compared only when they derive from an authoritative machine-readable universe.",
    limitations: "Prose and filename patterns are not authoritative universes.",
    ruleId: null, residualQuestion: "What machine-readable source defines the complete universe?",
    retirement: { revalidateAfter: "2027-02-24", condition: "Revalidate for ShellSpec or manifest changes." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "non-vacuous-negative-assertions", version: 1,
    selector: { languages: ["Shell"], fileKinds: ["test"] },
    source: { url: "https://github.com/shellspec/shellspec/blob/f2d13f991885ef44e6b54e571e0842222251b111/docs/references.md#include-matcher", upstreamVersion: "shellspec f2d13f991885ef44e6b54e571e0842222251b111", retrievedAt: "2026-08-24", excerpt: "The output should include <STRING>", sha256: "c92c690934e2118ff6483315cc97dc0f4e6de7f3fd214f02330b439a966e8b08" },
    invariant: "Substring presence, comments, and bare listings do not prove that an executable negative assertion fails for every forbidden member.",
    limitations: "A manifest must define the forbidden-member universe.",
    ruleId: null, residualQuestion: "Does each forbidden member make an executable assertion fail?",
    retirement: { revalidateAfter: "2027-02-24", condition: "Revalidate for ShellSpec matcher changes." },
  },
  {
    schema: CAVEAT_CARD_SCHEMA, id: "posix-executable-path-identity", version: 1,
    selector: { languages: ["Shell", "YAML"], fileKinds: ["source", "workflow", "test"] },
    source: { url: "https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_09_01_04", upstreamVersion: "POSIX.1-2024 Issue 8", retrievedAt: "2026-08-24", excerpt: "If the command name does not contain any slash characters, the command name shall be searched for using the PATH environment variable.", sha256: "e6350cf3d768b86eccacbfd26f7a8e06d57dd60cbe99ebb0a8f567dd3951c60a" },
    invariant: "A bare command name proves neither the resolved executable path nor its implementation identity.",
    limitations: "An absolute path can make an identity test tautological.",
    ruleId: null, residualQuestion: "Which executable should PATH resolve without a tautological test?",
    retirement: { revalidateAfter: "2029-12-31", condition: "Revalidate for a new POSIX edition." },
  },
];

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function cardBytes(card: CaveatCard): number { return Buffer.byteLength(JSON.stringify(card)); }

export function validateCaveatCards(cards: readonly CaveatCard[] = CARDS): readonly CaveatCard[] {
  const ids = new Set<string>();
  for (const card of cards) {
    if (JSON.stringify(Object.keys(card).sort()) !== JSON.stringify(["id", "invariant", "limitations", "residualQuestion", "retirement", "ruleId", "schema", "selector", "source", "version"])) throw new Error(`invalid caveat card fields: ${card.id}`);
    if (Object.keys(card.selector).some((key) => !["languages", "fileKinds", "buildSystems", "workflowCommandsAll", "workflowCommandsAny"].includes(key)) || Object.values(card.selector).some((values) => !Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || value.length === 0))) throw new Error(`invalid caveat card selector: ${card.id}`);
    if (JSON.stringify(Object.keys(card.source).sort()) !== JSON.stringify(["excerpt", "retrievedAt", "sha256", "upstreamVersion", "url"]) || JSON.stringify(Object.keys(card.retirement).sort()) !== JSON.stringify(["condition", "revalidateAfter"])) throw new Error(`invalid caveat card provenance fields: ${card.id}`);
    if (card.schema !== CAVEAT_CARD_SCHEMA || !/^[a-z0-9][a-z0-9-]+$/u.test(card.id) || !Number.isSafeInteger(card.version) || card.version < 1 || ids.has(card.id)) throw new Error("invalid or duplicate caveat card identity");
    ids.add(card.id);
    if (sha256(card.source.excerpt) !== card.source.sha256) throw new Error(`caveat card source hash mismatch: ${card.id}`);
    if (!/^https:\/\//u.test(card.source.url) || !card.source.upstreamVersion || !/^\d{4}-\d{2}-\d{2}$/u.test(card.source.retrievedAt)) throw new Error(`invalid caveat card source: ${card.id}`);
    if (cardBytes(card) > MAX_CARD_BYTES || JSON.stringify(card).trim().split(/\s+/u).filter(Boolean).length > MAX_CARD_WORDS) throw new Error(`caveat card exceeds budget: ${card.id} (${cardBytes(card)} bytes)`);
    if (!card.invariant || !card.limitations || !card.residualQuestion || !card.retirement.condition || !/^\d{4}-\d{2}-\d{2}$/u.test(card.retirement.revalidateAfter)) throw new Error(`incomplete caveat card: ${card.id}`);
  }
  return cards;
}

function intersects(actual: Set<string>, expected: readonly string[] | undefined): boolean { return !expected || expected.some((value) => actual.has(value)); }
function includesAll(actual: Set<string>, expected: readonly string[] | undefined): boolean { return !expected || expected.every((value) => actual.has(value)); }

export function selectCaveatCards(pack: EvidencePack): { cards: CaveatCard[]; omissions: string[]; bytes: number } {
  validateCaveatCards();
  const languages = new Set(pack.files.filter((file) => file.disposition !== "deleted").map((file) => file.language));
  const fileKinds = new Set(pack.files.filter((file) => file.disposition !== "deleted").map((file) => file.kind));
  const buildSystems = new Set(pack.project.buildSystems.map((item) => item.name));
  const commands = new Set(pack.workflows.files.flatMap((file) => file.jobs.flatMap((job) => job.steps.flatMap((step) => step.commandNames))));
  const applicable = CARDS.filter((card) => intersects(languages, card.selector.languages)
    && intersects(fileKinds, card.selector.fileKinds)
    && intersects(buildSystems, card.selector.buildSystems)
    && includesAll(commands, card.selector.workflowCommandsAll)
    && intersects(commands, card.selector.workflowCommandsAny))
    .sort((left, right) => CARDS.indexOf(left) - CARDS.indexOf(right) || left.id.localeCompare(right.id));
  const selected: CaveatCard[] = [];
  const omissions: string[] = [];
  let bytes = 0;
  for (const card of applicable) {
    const size = cardBytes(card);
    if (selected.length >= MAX_SELECTED_CARDS || bytes + size > MAX_CARD_SET_BYTES) omissions.push(`${card.id}: guidance budget`);
    else { selected.push(card); bytes += size; }
  }
  return { cards: selected, omissions, bytes };
}

export const CAVEAT_CARDS = validateCaveatCards();
export const CAVEAT_CARD_SET_SHA256 = sha256(JSON.stringify(CARDS));
