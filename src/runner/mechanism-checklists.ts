import { createHash } from "node:crypto";
import type { EvidencePack, FileKind } from "../evidence-pack.js";

export type ChecklistLeg = "correctness" | "test-honesty" | "contract-operability";

export interface MechanismChecklist {
  id: string;
  version: 1;
  leg: ChecklistLeg;
  selector: {
    languagesAny?: string[];
    fileKindsAny?: FileKind[];
    workflowCommandsAny?: string[];
  };
  question: string;
  steps: string[];
  evidenceStandard: string;
  limitations: string;
  sha256: string;
}

type ChecklistSource = Omit<MechanismChecklist, "sha256">;

const SOURCES: readonly ChecklistSource[] = [
  {
    id: "no-op-metadata-postconditions",
    version: 1,
    leg: "correctness",
    selector: { languagesAny: ["Shell"], fileKindsAny: ["source"] },
    question: "Does every equal-content or no-op branch still enforce required metadata and postconditions?",
    steps: [
      "Locate equality, up-to-date, and no-op branches around changed writes.",
      "List required mode, ownership, URL, marker, and other postconditions enforced by the write path.",
      "Verify each skip branch enforces the same applicable postconditions.",
    ],
    evidenceStandard: "Cite both the skip branch and the write branch's required postcondition; do not infer a requirement from filename conventions.",
    limitations: "Only explicit sibling write/skip control flow is compared; external deployment metadata remains unknown.",
  },
  {
    id: "generated-artifact-fail-closed",
    version: 1,
    leg: "contract-operability",
    selector: { languagesAny: ["Shell", "Python"], fileKindsAny: ["publisher", "manifest"] },
    question: "Does publication fail closed when any member of the authoritative generated-artifact universe is missing?",
    steps: [
      "Identify the machine-readable generator or manifest that defines the artifact universe.",
      "Compare generated, staged, published, and tested members without inventing names from prose.",
      "Verify a missing required member produces failure rather than silent omission.",
    ],
    evidenceStandard: "Cite the authoritative universe and the exact missing-member branch; without a machine-readable universe, mark the checklist unresolved.",
    limitations: "Repository prose and filename patterns are not authoritative universes.",
  },
  {
    id: "list-boundary-test-honesty",
    version: 1,
    leg: "test-honesty",
    selector: { languagesAny: ["Shell", "Python"], fileKindsAny: ["test"] },
    question: "Can first, middle, and final list members be removed or renamed while the changed tests remain green?",
    steps: [
      "Find changed production or fixture lists that claim exhaustive behavior.",
      "Map tests and mutations to first, middle, and final positions.",
      "For negative assertions, confirm every forbidden candidate is materialized by a fixture that can fail.",
    ],
    evidenceStandard: "Name the authoritative list and the exact uncovered position or vacuous fixture.",
    limitations: "Do not demand positional tests when membership is derived from a separately proved set invariant.",
  },
  {
    id: "exhaustive-runtime-preflight",
    version: 1,
    leg: "contract-operability",
    selector: { languagesAny: ["Shell"], fileKindsAny: ["source"] },
    question: "Does an explicitly exhaustive command preflight include every later literal non-base-system command?",
    steps: [
      "Locate literal for-list preflights checked through command -v or type.",
      "Compare later literal external commands after excluding continuations, substitutions, project helpers, shell builtins, and base utilities.",
      "Verify each surviving command is declared before expensive or destructive work begins.",
    ],
    evidenceStandard: "Cite the declared list and later literal command; dynamic dispatch remains unknown rather than clean.",
    limitations: "Base-system availability and sourced helper functions are outside this structural comparison.",
  },
  {
    id: "parsed-package-command-equivalence",
    version: 1,
    leg: "test-honesty",
    selector: { languagesAny: ["Python"], fileKindsAny: ["test"] },
    question: "Do command-policy guards and fixtures treat equivalent package-install spellings and quoting consistently?",
    steps: [
      "Inspect the parser or normalizer rather than raw substring assertions.",
      "Cover pip, pip3, python -m pip, quoted package arguments, and requirements-file exclusions where applicable.",
      "Require planted fixtures that fail when each supported spelling bypasses the guard.",
    ],
    evidenceStandard: "Cite a concrete accepted spelling that the parser misses and the fixture that should expose it.",
    limitations: "Only the guard's declared command grammar is in scope; do not generalize to arbitrary shell evaluation.",
  },
  {
    id: "executable-locale-assertion",
    version: 1,
    leg: "test-honesty",
    selector: { languagesAny: ["Python", "YAML"], fileKindsAny: ["test", "workflow"], workflowCommandsAny: ["locale"] },
    question: "Does the locale guard execute a failing assertion for the required locale rather than accept comments or a bare listing?",
    steps: [
      "Parse workflow jobs and executable run bodies; ignore comments and unrelated jobs.",
      "Require locale output to feed a predicate for the named locale with nonzero failure when absent.",
      "Check planted comment-only and bare-listing controls are rejected.",
    ],
    evidenceStandard: "Cite the executable command chain and demonstrate how absence reaches a failing exit status.",
    limitations: "Locale aliases and platform-specific canonicalization require explicit project policy.",
  },
  {
    id: "udev-event-settling",
    version: 1,
    leg: "correctness",
    selector: { languagesAny: ["YAML"], fileKindsAny: ["workflow"], workflowCommandsAny: ["udevadm"] },
    question: "Does every triggered device event explicitly settle before the workflow tests or uses that device?",
    steps: [
      "Locate udevadm trigger calls and the first later access to the affected device.",
      "Require udevadm settle or an equivalent event-completion barrier before that access.",
      "Treat intervening package installation, sleep, or unrelated synchronous work as delay, not proof of event completion.",
    ],
    evidenceStandard: "Cite the trigger, missing completion barrier, and first device consumer; timing delay alone cannot refute the race.",
    limitations: "A command option that synchronously waits for the specific event satisfies the barrier when its semantics are cited.",
  },
  {
    id: "workflow-job-local-proof",
    version: 1,
    leg: "test-honesty",
    selector: { languagesAny: ["Python", "YAML"], fileKindsAny: ["test", "workflow"] },
    question: "Does each workflow invariant require setup and proof inside the same job that consumes the state?",
    steps: [
      "Parse workflow jobs separately; do not flatten steps across jobs.",
      "For each guarded consumer, locate its prerequisite setup and executable proof in that same job.",
      "Add a sibling-job control that must not satisfy the invariant.",
    ],
    evidenceStandard: "Cite the consumer job and the misplaced setup or proof from a different job; repository-wide presence is insufficient.",
    limitations: "Explicit artifacts, outputs, or reusable-workflow contracts may transfer state when their handoff is proved.",
  },
  {
    id: "managed-environment-command",
    version: 1,
    leg: "test-honesty",
    selector: { languagesAny: ["Python"], fileKindsAny: ["test", "documentation", "manifest"] },
    question: "Do changed executable examples enter the dependency environment declared by the same documentation or manifest?",
    steps: [
      "Identify the environment manager and dependency group the changed text tells users to install.",
      "Trace each documented Python command without assuming an interactive environment remains activated.",
      "Require uv run, an explicit environment interpreter, or a proved activation step.",
    ],
    evidenceStandard: "Cite the install instruction and executable command; show that a fresh shell resolves different dependencies or interpreter state.",
    limitations: "Repository-wide contributor setup may satisfy activation only when the changed instructions explicitly depend on it.",
  },
] as const;


export const MECHANISM_CHECKLISTS: readonly MechanismChecklist[] = SOURCES.map((source) => ({
  ...source,
  sha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
}));

export const MECHANISM_CHECKLIST_SET_SHA256 = createHash("sha256").update(JSON.stringify(MECHANISM_CHECKLISTS)).digest("hex");

function intersects<T>(actual: Set<T>, expected: readonly T[] | undefined): boolean {
  return !expected || expected.some((value) => actual.has(value));
}

export function selectMechanismChecklists(
  leg: ChecklistLeg,
  pack: EvidencePack,
  assignedFiles: string[],
): MechanismChecklist[] {
  const assigned = new Set(assignedFiles);
  const facts = pack.files.filter((file) => assigned.has(file.path));
  const languages = new Set(facts.map((file) => file.language));
  const kinds = new Set(facts.map((file) => file.kind));
  const workflowCommands = new Set(pack.workflows.files
    .filter((workflow) => assigned.has(workflow.path))
    .flatMap((workflow) => workflow.jobs)
    .flatMap((job) => job.steps)
    .flatMap((step) => step.commandNames));
  return MECHANISM_CHECKLISTS.filter((checklist) => checklist.leg === leg
    && intersects(languages, checklist.selector.languagesAny)
    && intersects(kinds, checklist.selector.fileKindsAny)
    && intersects(workflowCommands, checklist.selector.workflowCommandsAny));
}
