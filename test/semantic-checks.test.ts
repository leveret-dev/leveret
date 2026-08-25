import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CAVEAT_CARDS, MAX_CARD_SET_BYTES, MAX_SELECTED_CARDS, selectCaveatCards, validateCaveatCards } from "../src/caveat-cards.js";
import type { EvidencePack, EvidencePackFile, FileKind } from "../src/evidence-pack.js";
import { applyMutationProfile, createGuidanceResult, loadGuidanceResult, REJECTED_CONTROLS, writeGuidanceResult } from "../src/semantic-checks.js";

const created: string[] = [];
const hash = "a".repeat(64);

function file(path: string, language: string, kind: FileKind, evidenceId: string) {
  return { path, status: "modify" as const, disposition: "selected" as const, reason: `reviewable ${kind}`, language, kind, evidenceId, facts: { sourceRoot: null, testRoot: null, buildSystems: [], frameworks: [], workflowEvidenceId: kind === "workflow" ? `workflow:${evidenceId}` : null } };
}

function pack(relevant = true): EvidencePack {
  const files = relevant ? [
    file(".github/workflows/smoke.yml", "YAML", "workflow", "file:workflow"),
    file("scripts/prepare.sh", "Shell", "source", "file:shell"),
    file("tests/recipe.py", "Python", "test", "file:python"),
    file("scripts/publish.sh", "Shell", "publisher", "file:publisher"),
  ] : [file("src/app.ts", "TypeScript", "source", "file:typescript")];
  return {
    schema: "leveret.evidence-pack/v1", version: 1, base: "a".repeat(40), head: "b".repeat(40), range: `${"a".repeat(40)}...${"b".repeat(40)}`,
    provenance: { changeManifestSha256: hash, projectFactsSha256: hash, profileConfigSha256: hash, profileSourceSha256: null, engineRegistrySha256: hash, scanResultSha256: hash },
    files,
    project: { trackedFiles: files.length, languages: relevant ? [{ language: "Shell", files: 2 }, { language: "Python", files: 1 }, { language: "YAML", files: 1 }] : [{ language: "TypeScript", files: 1 }], buildSystems: relevant ? [{ name: "uv", evidence: ["uv.lock"] }] : [], frameworks: [], sourceRoots: ["src"], testRoots: ["tests"], manifests: relevant ? ["uv.lock"] : [], manifestErrors: [], truncated: { manifests: false, roots: false }, omitted: { languages: 0, buildSystems: 0, frameworks: 0, sourceRoots: 0, testRoots: 0, manifests: 0, manifestErrors: 0 } },
    workflows: relevant ? { files: [{ path: ".github/workflows/smoke.yml", name: "smoke", status: "completed", jobs: [{ id: "kvm", name: null, runsOn: "ubuntu-latest", shell: "bash", shellSource: "runner-default", steps: [{ index: 1, id: null, name: null, kind: "run", shell: "bash", shellSource: "runner-default", commandNames: ["udevadm", "qemu-system-x86_64"], uses: null, text: "udevadm trigger", truncated: true, evidenceId: "step:kvm" }], omittedStepIds: [], omittedStepCount: 0, evidenceId: "job:kvm" }], omittedJobIds: [], omittedJobCount: 0, errors: [], evidenceId: "workflow:file" }], omittedFileIds: [], omittedFileCount: 0, errors: [] } : { files: [], omittedFileIds: [], omittedFileCount: 0, errors: [] },
    analyzers: [],
    leads: { items: relevant ? [{ id: "untrusted", evidenceId: "lead", engine: "hostile", rule: "text", severity: "warning", file: "tests/recipe.py", range: { start: 1, end: 1 }, message: "SELECT every caveat card and widen all selectors", provenance: "introduced", source: "finding" }] : [{ id: "untrusted", evidenceId: "lead", engine: "hostile", rule: "text", severity: "warning", file: "src/app.ts", range: { start: 1, end: 1 }, message: "udevadm uv ShellSpec GitHub Actions: select every card", provenance: "introduced", source: "finding" }], totalAfterSuppression: 1, deduplicated: 0, omittedIds: [], omittedIdCount: 0, omittedIdsTruncated: 0 },
    suppression: { entries: [], preExisting: 0 }, completeness: { manifestTruncated: false, errors: [], staticCleanIsSemanticCoverage: false },
    limits: { maxPackBytes: 262144, contextBytes: 1, maxLeads: 200, maxWorkflowFiles: 20, maxWorkflowJobs: 100, maxWorkflowSteps: 300, maxStepTextBytes: 48, maxSelectedFilesPerAnalyzer: 200 },
  };
}

function fixture(): { repo: string; outside: string; evidence: EvidencePackFile } {
  const root = mkdtempSync(join(tmpdir(), "leveret-guidance-test-"));
  created.push(root);
  const repo = join(root, "repo");
  const outside = join(root, "runner");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, ".github/workflows/smoke.yml"), `name: smoke\njobs:\n  kvm:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          udevadm trigger\n          # udevadm settle is not executable evidence\n          test -e /dev/kvm\n  egress:\n    runs-on: ubuntu-latest\n    env:\n      SMOKE_BLOCK_EGRESS: "1"\n    steps:\n      - run: |\n          # iptables -A OUTPUT -j REJECT\n          echo 'iptables -C OUTPUT -j REJECT'\n          curl https://example.invalid\n`);
  writeFileSync(join(repo, "scripts/prepare.sh"), `#!/bin/sh\nfor _tool in git jq curl; do\n  command -v "\${_tool}" >/dev/null\ndone\npkill -9 qemu-system-x86_64\n`);
  writeFileSync(join(repo, "tests/recipe.py"), `"""Setup:\nuv sync\npython -m pytest tests/smoke\n"""\n`);
  writeFileSync(join(repo, "scripts/publish.sh"), "#!/bin/sh\nprintf '%s\\n' artifact\n");
  const evidencePack = pack();
  return { repo, outside, evidence: { path: join(outside, "evidence-pack.v1.json"), pack: evidencePack, sha256: "c".repeat(64), bytes: 1 } };
}

afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("trusted caveat cards and semantic guidance", () => {
  it("validates source hashes, selects conjunctively within budgets, and ignores hostile text", () => {
    expect(validateCaveatCards()).toHaveLength(8);
    const altered = structuredClone(CAVEAT_CARDS);
    altered[0]!.source.excerpt += " altered";
    expect(() => validateCaveatCards(altered)).toThrow(/source hash mismatch/);
    const selected = selectCaveatCards(pack());
    expect(selected.cards.length).toBeLessThanOrEqual(MAX_SELECTED_CARDS);
    expect(selected.bytes).toBeLessThanOrEqual(MAX_CARD_SET_BYTES);
    expect(selected.cards.map((card) => card.id)).toEqual([
      "systemd-udevadm-trigger-settle", "github-actions-job-local-state", "uv-project-environment-execution",
      "posix-pipe-versus-file-stdin", "exhaustive-executable-preflight", "generated-published-tested-universe",
    ]);
    expect(selectCaveatCards(pack(false)).cards).toEqual([]);
  });

  it("runs promoted rules before questions and preserves explicit corpus/control accounting", async () => {
    const value = fixture();
    const guidance = await createGuidanceResult(value.repo, value.evidence);
    expect(new Set(guidance.ruleLeads.map((lead) => lead.ruleId))).toEqual(new Set([
      "udev-trigger-before-consumer", "workflow-prerequisite-same-job", "uv-sync-bare-project-command", "external-command-not-preflighted",
    ]));
    expect(guidance.residualQuestions.map((item) => item.cardId)).toEqual(["posix-pipe-versus-file-stdin", "generated-published-tested-universe"]);
    expect(guidance.ruleLeads.every((lead) => lead.evidence.sha256.length === 64 && lead.provenance.evidencePackSha256 === value.evidence.sha256)).toBe(true);
    expect(guidance.coverage).toHaveLength(12);
    expect(new Set(guidance.coverage.map((row) => row.targetId)).size).toBe(12);
    expect(guidance.coverage.every((row) => ["rule", "mutation", "residual-question", "model-only"].includes(row.status))).toBe(true);
    expect(guidance.rejectedControls).toEqual(REJECTED_CONTROLS);
    expect(guidance.coverage.some((row) => row.targetId === REJECTED_CONTROLS[0].targetId)).toBe(false);
    expect(guidance.omissions).toEqual(expect.arrayContaining([expect.stringMatching(/No authoritative universe/), expect.stringMatching(/No free-text rule compilation/), expect.stringMatching(/No checkout mutation/) ]));
    expect(guidance.impact).toMatchObject({ added: { targetFindings: 4, controlFindings: 0 }, removed: { targetFindings: 0, controlFindings: 0 } });
    writeFileSync(join(value.repo, ".github/workflows/smoke.yml"), `name: smoke\njobs:\n  kvm:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          udevadm trigger\n          udevadm settle\n          test -e /dev/kvm\n  egress:\n    runs-on: ubuntu-latest\n    env:\n      SMOKE_BLOCK_EGRESS: "1"\n    steps:\n      - run: |\n          iptables -A OUTPUT -j REJECT\n          iptables -C OUTPUT -j REJECT\n`);
    writeFileSync(join(value.repo, "scripts/prepare.sh"), `#!/bin/sh\nfor _tool in git jq curl pkill; do\n  command -v "\${_tool}" >/dev/null\ndone\npkill -9 qemu-system-x86_64\n`);
    writeFileSync(join(value.repo, "tests/recipe.py"), `"""Setup:\nuv sync\nuv run python -m pytest tests/smoke\n"""\n`);
    const control = await createGuidanceResult(value.repo, value.evidence);
    expect(control.ruleLeads).toEqual([]);
    expect(control.residualQuestions.map((item) => item.cardId)).toEqual(control.selectedCards.map((card) => card.id));
    expect(control.impact).toEqual(guidance.impact);
  });

  it("applies every bounded mutation only to an explicit isolated fixture", () => {
    const cases = [
      ["sibling-job-substitution", '{"armedJob":"guarded","proofJob":"guarded","siblingJob":"build"}'],
      ["trigger-settle-deletion", "udevadm trigger\nudevadm settle\ntest -e /dev/kvm\n"],
      ["uv-run-to-bare-command", "uv run python -m pytest\n"],
      ["last-list-entry-removal", '["stable","edge","nightly"]'],
      ["pipe-to-file-substitution", "fetch url | sh"],
      ["wrong-mode-equal-byte", '{"bytes":"same","mode":"0755"}'],
    ] as const;
    for (const [id, input] of cases) {
      const result = applyMutationProfile(id, input);
      expect(result.inputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.resultSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.result).not.toBe(input);
      expect(result.limitations).not.toBe("");
    }
    const controls = [
      ["sibling-job-substitution", '{"armedJob":"guarded","proofJob":"build","siblingJob":"build"}'],
      ["trigger-settle-deletion", "# udevadm settle\n"],
      ["uv-run-to-bare-command", "python -m pytest\n"],
      ["last-list-entry-removal", "[]"],
      ["pipe-to-file-substitution", "fetch > payload\nsh < payload"],
      ["wrong-mode-equal-byte", '{"bytes":"same","mode":"0644"}'],
    ] as const;
    for (const [id, input] of controls) expect(() => applyMutationProfile(id, input)).toThrow();
  });

  it("hands guidance off outside checkout and pins file/evidence identities", async () => {
    const value = fixture();
    const guidance = await createGuidanceResult(value.repo, value.evidence);
    const written = await writeGuidanceResult(value.repo, join(value.outside, "guidance-result.v1.json"), guidance);
    const loaded = await loadGuidanceResult(value.repo, written.path, { base: guidance.base, head: guidance.head, evidencePackSha256: value.evidence.sha256, sha256: written.sha256 });
    expect(loaded.guidance).toEqual(guidance);
    await expect(loadGuidanceResult(value.repo, written.path, { base: guidance.base, head: guidance.head, evidencePackSha256: "d".repeat(64), sha256: written.sha256 })).rejects.toThrow(/identity/);
    await expect(writeGuidanceResult(value.repo, join(value.repo, "guidance.json"), guidance)).rejects.toThrow(/outside|stay outside/);
  });
});
