import { execFile } from "node:child_process";
import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auditConfig, createAuditRun } from "../src/audit.js";
import {
  BuildEvidenceInputError, type BuildEvidencePin, type BuildEvidenceRequest,
} from "../src/build-evidence-contract.js";
import {
  BuildEvidenceHostError, admitBuildEvidence, buildEvidenceSummary, type BuildEvidenceAdmission, type PublicBuildEvidenceSummary,
} from "../src/build-evidence.js";
import { redactAuditText, refreshSecretPolicy, screenText, withSecretPolicy, type SecretPolicy } from "../src/secret-screening.js";
import { referenceReplySchema } from "../src/inspect-java-contract.js";
import {
  FIXTURE_SECRET_MARKER, createBuildFixture, fixtureRequest, type BuildFixture, type FixtureSide,
} from "./build-evidence-fixture.js";
import type * as FsPromises from "node:fs/promises";

// One failure-injection point at the host boundary: reading the manifest and the frozen scratch copies. Everything
// delegates to the real implementation unless a test arms the hook.
const hooks = vi.hoisted(() => ({ readFile: undefined as ((path: string) => Error | undefined) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      const failed = hooks.readFile?.(String(path));
      return failed ? Promise.reject(failed) : (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});
afterEach(() => { hooks.readFile = undefined; });
const failure = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

// Manifests are edited as loose JSON on purpose: each case changes exactly one thing and republishes it.
type Json = any;

/** A credential value no built-in pattern recognizes: only the host's known-value list can catch it. */
const KNOWN = "corp-vault-credential-7f3a91";
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

let home: string;
let valid: BuildFixture;
let secret: BuildFixture;
let failed: BuildFixture;
let serial = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "leveret-build-evidence-"));
  [valid, secret, failed] = await Promise.all([
    createBuildFixture(join(home, "valid"), "valid"),
    createBuildFixture(join(home, "secret-resource"), "secret-resource"),
    createBuildFixture(join(home, "generation-failed"), "generation-failed"),
  ]);
}, 180_000);
afterAll(() => rmSync(home, { recursive: true, force: true }));

type PolicyInit = {
  refresh?: () => Promise<readonly string[]>; rules?: SecretPolicy["additionalRules"]; nonSecret?: readonly string[]; known?: readonly string[];
};

/** A policy that has not been refreshed yet: unavailable until the host (or admission) refreshes it. */
function makePolicy(init: PolicyInit = {}) {
  const calls = { refresh: 0 };
  const policy: SecretPolicy = {
    id: "policy-test", available: false, knownValues: new Set(init.known ?? []),
    refreshKnownValues: async () => { calls.refresh++; return init.refresh ? init.refresh() : []; },
    additionalRules: init.rules ?? [], nonSecretValues: new Set(init.nonSecret ?? []),
  };
  return { policy, calls };
}

async function readyPolicy(init: PolicyInit = {}) {
  const made = makePolicy(init);
  await refreshSecretPolicy(made.policy);
  made.calls.refresh = 0;
  return made;
}

/** One private working copy of a fixture export: mutable manifest, payload snapshot, manifest file and runtime directory. */
interface Case { request: BuildEvidenceRequest; manifest: Json; payload: string; runtime: string; dir: string }

function setup(f: BuildFixture, side: FixtureSide = "head"): Case {
  const dir = join(home, `case-${++serial}`);
  const payload = join(dir, "payload");
  const runtime = join(dir, "runtime");
  const manifestPath = join(dir, "manifest.json");
  mkdirSync(dir, { recursive: true });
  cpSync(f.pins[side].payloadRoot, payload, { recursive: true });
  copyFileSync(f.pins[side].manifestPath, manifestPath);
  const request: BuildEvidenceRequest = { ...fixtureRequest(f, side, runtime), pin: { ...f.pins[side], manifestPath, payloadRoot: payload } };
  return { request, manifest: structuredClone(f.manifests[side]), payload, runtime, dir };
}

const pinOf = (c: Case): BuildEvidencePin => c.request.pin!;
const withPin = (c: Case, change: Partial<BuildEvidencePin>): Case => { c.request = { ...c.request, pin: { ...pinOf(c), ...change } }; return c; };
function publishText(c: Case, text: string): Case {
  writeFileSync(pinOf(c).manifestPath, text);
  return withPin(c, { manifestSha256: sha256(text) });
}
const publish = (c: Case): Case => publishText(c, `${JSON.stringify(c.manifest)}\n`);
const art = (m: Json, id: string): Json => m.artifacts.find((a: Json) => a.id === id);

function admitted(admission: BuildEvidenceAdmission): Extract<BuildEvidenceAdmission, { outcome: "admitted" }> {
  if (admission.outcome !== "admitted") throw new Error(`expected an admitted export, got ${admission.outcome}`);
  return admission;
}

function readAllBytes(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.isDirectory() ? readAllBytes(join(dir, entry.name)) : readFileSync(join(dir, entry.name), "latin1"))
    .join("\n");
}

const scopeOf = (summary: PublicBuildEvidenceSummary, role: "production" | "test") => summary.scopes.find((scope) => scope.role === role)!;

describe("secret policy", () => {
  it("withholds all text while screening is unavailable instead of calling it clean", () => {
    const { policy } = makePolicy();
    expect(screenText("harmless text", policy)).toEqual({ state: "withheld", reason: "screening-unavailable" });
  });

  it("detects the built-in credential shapes and never echoes what it found", async () => {
    const { policy } = await readyPolicy();
    expect(screenText("an ordinary sentence\nwith two lines", policy)).toEqual({ state: "available" });
    for (const text of [
      "Authorization: Bearer abcdef0123456789",
      `token ${FIXTURE_SECRET_MARKER}`,
      "https://user:hunter2@example.test/path",
      "run --api-key=zzz-not-real",
      "sk-abcdefghijklmnopqrstuvwxyz0123",
      "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----",
    ]) {
      const decision = screenText(text, policy);
      expect(decision).toEqual({ state: "withheld", reason: "secret-detected" });
      expect(JSON.stringify(decision)).not.toContain(text.slice(0, 12));
    }
  });

  it("finds exact known values and accumulates them across refreshes without ever removing one", async () => {
    let values: readonly string[] = [KNOWN];
    const { policy } = makePolicy({ refresh: async () => values });
    await refreshSecretPolicy(policy);
    expect(policy.available).toBe(true);
    expect(screenText(`connect with ${KNOWN} now`, policy)).toEqual({ state: "withheld", reason: "secret-detected" });
    values = ["second-rotated-value-9c2e"];
    await refreshSecretPolicy(policy);
    expect(screenText("second-rotated-value-9c2e", policy).state).toBe("withheld");
    expect(screenText(KNOWN, policy).state).toBe("withheld");
    values = [];
    await refreshSecretPolicy(policy);
    expect(screenText(KNOWN, policy).state).toBe("withheld");
    expect([...policy.knownValues].sort()).toEqual([KNOWN, "second-rotated-value-9c2e"].sort());
  });

  it("makes a failed refresh unavailable without leaking its error, and a later refresh recovers", async () => {
    let mode: "ok" | "broken" = "ok";
    const { policy } = makePolicy({ refresh: async () => { if (mode === "broken") throw new Error(`store password ${KNOWN}`); return [KNOWN]; } });
    await refreshSecretPolicy(policy);
    expect(policy.available).toBe(true);
    mode = "broken";
    await expect(refreshSecretPolicy(policy)).resolves.toBeUndefined();
    expect(policy.available).toBe(false);
    const decision = screenText("harmless text", policy);
    expect(decision).toEqual({ state: "withheld", reason: "screening-unavailable" });
    expect(JSON.stringify(decision)).not.toContain("password");
    mode = "ok";
    await refreshSecretPolicy(policy);
    expect(policy.available).toBe(true);
    expect(screenText("harmless text", policy)).toEqual({ state: "available" });
    expect(screenText(KNOWN, policy).state).toBe("withheld");
  });

  it("excludes a declared nonsecret placeholder by exact value, never by length or similarity", async () => {
    const { policy } = await readyPolicy({
      known: ["local-endpoint-key", "local-endpoint-key-2", "abc"],
      nonSecret: ["local-endpoint-key", "sk-local-placeholder-000000000000"],
    });
    expect(screenText("key=local-endpoint-key", policy)).toEqual({ state: "available" });
    // A different value that merely contains the placeholder, and a short value nobody declared, stay secret.
    expect(screenText("key=local-endpoint-key-2", policy).state).toBe("withheld");
    expect(screenText("key=abc", policy).state).toBe("withheld");
    // A built-in pattern match that is exactly a declared placeholder is excluded; one character more is not.
    expect(screenText("OPENAI_API_KEY sk-local-placeholder-000000000000 ok", policy)).toEqual({ state: "available" });
    expect(screenText("OPENAI_API_KEY sk-local-placeholder-0000000000001 ok", policy).state).toBe("withheld");
  });

  it("applies host regex rules repeatedly, whatever state the supplied pattern carries", async () => {
    const rule = { id: "corp-token", pattern: /\bCORP-\d{6}\b/g };
    const { policy } = await readyPolicy({ rules: [rule] });
    for (let round = 0; round < 4; round++) {
      expect(screenText(`ticket CORP-123456 attached (${round})`, policy)).toEqual({ state: "withheld", reason: "secret-detected" });
    }
    rule.pattern.lastIndex = 9_999;
    expect(screenText("ticket CORP-123456", policy).state).toBe("withheld");
    expect(screenText("ticket CORP-12345", policy)).toEqual({ state: "available" });
  });

  it("redacts built-ins as before and, inside a policy scope only, every known value longest first", async () => {
    const token = "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz";
    expect(redactAuditText(token)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(redactAuditText(token)).toContain("[REDACTED]");
    expect(redactAuditText(`plain ${KNOWN}`)).toBe(`plain ${KNOWN}`);

    const { policy } = await readyPolicy({ known: [KNOWN, `${KNOWN}-extended`], rules: [{ id: "corp-token", pattern: /\bCORP-\d{6}\b/ }], nonSecret: ["declared-placeholder"] });
    policy.knownValues.add("declared-placeholder");
    const text = `a ${KNOWN}-extended b ${KNOWN} c CORP-111111 d CORP-222222 e declared-placeholder`;
    await withSecretPolicy(policy, async () => {
      expect(redactAuditText(text)).toBe("a [REDACTED] b [REDACTED] c [REDACTED] d [REDACTED] e declared-placeholder");
    });
    expect(redactAuditText(`plain ${KNOWN}`)).toBe(`plain ${KNOWN}`);
  });

  it("keeps overlapping policy scopes apart", async () => {
    const [one, two] = await Promise.all([readyPolicy({ known: ["only-in-one-1111"] }), readyPolicy({ known: ["only-in-two-2222"] })]);
    const text = "only-in-one-1111 only-in-two-2222";
    // Each scope yields to the other at several awaits, so a leaked or shared store would show in the output.
    const settle = async (count: number) => { for (let i = 0; i < count; i++) await Promise.resolve(); };
    const seen = await Promise.all([
      withSecretPolicy(one.policy, async () => { await settle(5); const out = redactAuditText(text); await settle(3); return out; }),
      withSecretPolicy(two.policy, async () => { await settle(2); const out = redactAuditText(text); await settle(6); return out; }),
    ]);
    expect(seen).toEqual(["[REDACTED] only-in-two-2222", "only-in-one-1111 [REDACTED]"]);
  });

  describe("private key blocks", () => {
    // What counts as a block: from the leftmost BEGIN header to the nearest END footer after it. The expressions below
    // state that meaning directly and serve as the reference for arbitrary mixes of headers and footers.
    const LEGACY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
    const FRAGMENTS = [
      "-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN EC PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN DSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY", "-----END PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----",
      "-----END OPENSSH PRIVATE KEY-----", "END PRIVATE KEY-----", "-----", "\n", "\r\n", "MIIBVgIBADANBg", " body ", "",
    ];

    it("keeps the multi-line semantics of the earlier rule on every mix of markers", async () => {
      const { policy } = await readyPolicy();
      let seed = 20_261_004;
      const next = (bound: number) => { seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0; return seed % bound; };
      for (let round = 0; round < 4_000; round++) {
        const input = Array.from({ length: 1 + next(10) }, () => FRAGMENTS[next(FRAGMENTS.length)]!).join(next(2) === 0 ? "" : "\n");
        expect(redactAuditText(input), JSON.stringify(input)).toBe(input.replace(LEGACY_BLOCK, "[REDACTED]"));
        expect(screenText(input, policy).state, JSON.stringify(input)).toBe(input.search(LEGACY_BLOCK) >= 0 ? "withheld" : "available");
      }
    });

    it("redacts a whole block across lines and leaves an unterminated header alone", () => {
      const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
      expect(redactAuditText(`a\n${key}\nb`)).toBe("a\n[REDACTED]\nb");
      expect(redactAuditText(`${key} then ${key}`)).toBe("[REDACTED] then [REDACTED]");
      expect(redactAuditText("-----BEGIN PRIVATE KEY-----\nbody only")).toBe("-----BEGIN PRIVATE KEY-----\nbody only");
      expect(redactAuditText("-----BEGIN PRIVATE KEY-----\nx\n-----BEGIN EC PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----\nz")).toBe("[REDACTED]\nz");
    });

    it("screens hostile input in linear time: a quarter million unterminated headers neither stall nor leak a match", async () => {
      // The input has no footer at all, so nothing may be redacted, and screening time must grow linearly with its length:
      // a quadratic scan would run for minutes here. The child's wall-clock kill is only a backstop with orders of magnitude
      // of margin, so a regression is a clean failure rather than a flaky threshold.
      const root = fileURLToPath(new URL("..", import.meta.url));
      const program = [
        `import { redactAuditText, refreshSecretPolicy, screenText } from ${JSON.stringify(pathToFileURL(join(root, "src/secret-screening.ts")).href)};`,
        "const policy = { id: 'hostile', available: false, knownValues: new Set(), refreshKnownValues: async () => [], additionalRules: [], nonSecretValues: new Set() };",
        "await refreshSecretPolicy(policy);",
        "const open = '-----BEGIN PRIVATE KEY-----\\n'.repeat(250000);",
        "const closed = open + '-----END PRIVATE KEY-----';",
        "process.stdout.write(JSON.stringify({",
        "  openScreen: screenText(open, policy), openUnchanged: redactAuditText(open) === open,",
        "  closedScreen: screenText(closed, policy), closedRedacted: redactAuditText(closed),",
        "}));",
      ].join("\n");
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
        cwd: root, env: process.env, maxBuffer: 1 << 20, timeout: 40_000,
      });
      expect(JSON.parse(stdout)).toEqual({
        openScreen: { state: "available" }, openUnchanged: true,
        closedScreen: { state: "withheld", reason: "secret-detected" }, closedRedacted: "[REDACTED]",
      });
    }, 120_000);
  });
});

describe("admission of a configured export", () => {
  it("does nothing for a side without a pinned export: no lookup and no policy initialization", async () => {
    const c = setup(valid);
    const { policy, calls } = makePolicy();
    const reads: string[] = [];
    hooks.readFile = (path) => { reads.push(path); return undefined; };
    const admission = await admitBuildEvidence({ ...c.request, pin: undefined, runtimeDir: join(c.dir, "never-created") }, policy);
    expect(admission).toMatchObject({ outcome: "unconfigured", side: "head", repositoryId: "fixture", revision: valid.head, secretPolicyId: "policy-test" });
    expect(calls.refresh).toBe(0);
    expect(policy.available).toBe(false);
    expect(reads).toEqual([]);
    expect(existsSync(join(c.dir, "never-created"))).toBe(false);
    expect(buildEvidenceSummary(admission)).toMatchObject({ outcome: "unconfigured", reason: null, exposureCheck: "not-run", scopes: [], manifestSha256: null });
  });

  it.each(["head", "base"] as const)("admits an unchanged %s export beside, not inside, its immutable manifest", async (side) => {
    const f = valid;
    const c = setup(f, side);
    const { policy, calls } = makePolicy();
    const admission = admitted(await admitBuildEvidence(c.request, policy));
    expect(calls.refresh).toBe(1);
    expect(admission).toMatchObject({ side, repositoryId: "fixture", revision: f[side], secretPolicyId: "policy-test", exposureCheck: "checked", contextVerified: true });
    expect(admission.manifestSha256).toBe(pinOf(c).manifestSha256);
    // The retained manifest is the validated, deeply frozen original; diagnostics are exposed only after screening.
    const { diagnostics, ...expected } = f.manifests[side];
    expect(admission.manifest).toEqual(expected);
    expect("diagnostics" in admission.manifest).toBe(false);
    expect(diagnostics).toEqual([]);
    expect(admission.diagnostics).toEqual([]);
    expect(Object.isFrozen(admission.manifest)).toBe(true);
    expect(Object.isFrozen(admission.manifest.artifacts)).toBe(true);
    expect(Object.isFrozen(admission.manifest.artifacts[0])).toBe(true);
    expect(Object.isFrozen(admission.manifest.compilations[0]!.compileClasspath)).toBe(true);
    // Availability lives in the consumer record; every artifact of this export stayed available and frozen.
    expect([...admission.artifacts.keys()]).toEqual(f.manifests[side].artifacts.map((artifact) => artifact.id));
    for (const status of admission.artifacts.values()) expect(status).toEqual({ state: "available", reason: null, compilationIds: [] });
    expect(admission.frozen.available.size).toBe(f.manifests[side].artifacts.length);
    if (side === "head") expect(readFileSync(admission.frozen.available.get("pricing-output")!.path)).toEqual(Buffer.from(f.outputBytes.get("pricing-output")!));
    expect([...admission.frozen.sourceRoots.keys()].sort()).toEqual(["prod", "test"]);
    expect(admission.degraded.size).toBe(0);
  });

  it("reports the selected scopes with their stage states kept separate from coverage", async () => {
    const c = setup(valid);
    const summary = buildEvidenceSummary(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(summary).toMatchObject({
      side: "head", repositoryId: "fixture", revision: valid.head, secretPolicyId: "policy-test", outcome: "admitted", reason: null,
      contextId: "fixture-main", contextVerified: true, manifestSha256: pinOf(c).manifestSha256, exposureCheck: "checked",
      selection: { moduleDir: ".", productionId: "prod", testId: "test" }, diagnostics: { total: 0, withheld: 0 },
      artifacts: { available: valid.manifests.head.artifacts.length, missing: 0, "not-produced": 0, withheld: 0, rejected: 0 },
    });
    expect(Object.keys(summary).sort()).toEqual([
      "artifacts", "contextId", "contextVerified", "diagnostics", "exposureCheck", "manifestSha256", "outcome", "reason",
      "repositoryId", "revision", "scopes", "secretPolicyId", "selection", "side",
    ]);
    expect(summary.scopes.map((scope) => scope.role)).toEqual(["production", "test"]);
    expect(scopeOf(summary, "production")).toEqual({
      role: "production", compilationId: "prod", state: "selected", reasons: [], exportedFactsDiscarded: false,
      gaps: { missing: 0, "not-produced": 0, withheld: 0, rejected: 0 },
      generationState: "succeeded", resourceState: "succeeded", compilationState: "succeeded",
    });
    expect(scopeOf(summary, "test")).toMatchObject({ compilationId: "test", state: "selected", reasons: [] });
    // The summary carries no raw objects, host paths, or content hashes and no rolled-up coverage claim.
    const text = JSON.stringify(summary);
    for (const hidden of [c.dir, valid.repo, home, c.payload]) expect(text).not.toContain(hidden);
    for (const artifact of valid.manifests.head.artifacts) {
      if (artifact.availability === "available" && artifact.kind === "file") expect(text).not.toContain(artifact.content.sha256);
    }
    expect(text).not.toMatch(/coverage|complete/i);
  });

  it("keeps a failed generation or build as reported stage state, not as an invalid or empty environment", async () => {
    const c = setup(failed);
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(admission.artifacts.get("pricing-output")).toEqual({ state: "not-produced", reason: "exporter-declared", compilationIds: [] });
    expect(admission.artifacts.get("prod-classes")!.state).toBe("not-produced");
    expect(admission.artifacts.get("consumer-original")!.state).toBe("available");
    expect(admission.diagnostics).toEqual([{
      state: "available", code: "generation-failed", message: "template generation failed for compilation prod", compilationId: "prod", artifactIds: ["pricing-output"],
    }]);
    const summary = buildEvidenceSummary(admission);
    expect(summary.artifacts).toMatchObject({ "not-produced": 3, available: failed.manifests.head.artifacts.length - 3 });
    expect(scopeOf(summary, "production")).toMatchObject({
      state: "selected", reasons: [], generationState: "failed", resourceState: "succeeded", compilationState: "not-run",
      gaps: { missing: 0, "not-produced": 2, withheld: 0, rejected: 0 },
    });
    expect(scopeOf(summary, "test")).toMatchObject({
      state: "selected", reasons: [], generationState: "not-run", resourceState: "not-run", compilationState: "not-run",
      gaps: { "not-produced": 3 },
    });
    // Nothing exporter-declared degrades the consumer record; the bridge decides from the reported gaps.
    expect(admission.degraded.size).toBe(0);
    expect([...admission.frozen.sourceRoots.keys()].sort()).toEqual(["prod", "test"]);
    expect(summary.diagnostics).toEqual({ total: 1, withheld: 0 });
  });
});

describe("failure matrix: the whole export is rejected", () => {
  const cases: Array<[string, string, (c: Case) => void]> = [
    ["a configured manifest that is absent", "manifest-absent", (c) => { withPin(c, { manifestPath: join(c.dir, "gone", "manifest.json") }); }],
    ["a manifest path that is a directory", "manifest-unreadable", (c) => { withPin(c, { manifestPath: c.dir }); }],
    ["bytes that differ from the pinned hash", "manifest-hash-mismatch", (c) => { withPin(c, { manifestSha256: "0".repeat(64) }); }],
    ["an unknown field named after a credential", "manifest-invalid", (c) => { c.manifest[FIXTURE_SECRET_MARKER] = FIXTURE_SECRET_MARKER; publish(c); }],
    ["a manifest that tries to bring its own secret rules", "manifest-invalid", (c) => { c.manifest.secretRules = [{ id: "mine", pattern: "." }]; publish(c); }],
    ["a repeated object key", "manifest-invalid", (c) => { publishText(c, JSON.stringify(c.manifest).replace('"schema":', '"schema":"x","schema":')); }],
    ["content after the document", "manifest-invalid", (c) => { publishText(c, `${JSON.stringify(c.manifest)}\n{}`); }],
    ["a different repository", "repository-mismatch", (c) => { c.request = { ...c.request, repositoryId: "another-repository" }; }],
    ["a different revision", "revision-mismatch", (c) => { c.request = { ...c.request, revision: valid.base }; }],
    ["a different host-pinned context", "context-mismatch", (c) => { withPin(c, { expectedContext: { ...pinOf(c).expectedContext, id: "elsewhere" } }); }],
    ["different pinned profiles", "context-mismatch", (c) => { withPin(c, { expectedContext: { ...pinOf(c).expectedContext, profiles: ["release"] } }); }],
    ["a different pinned variant", "context-mismatch", (c) => { withPin(c, { expectedContext: { ...pinOf(c).expectedContext, variant: { state: "set", value: "debug" } } }); }],
  ];

  it.each(cases)("rejects %s as %s and exposes nothing", async (_name, reason, arrange) => {
    const c = setup(valid);
    arrange(c);
    const { policy } = makePolicy();
    const admission = await admitBuildEvidence(c.request, policy);
    expect(admission.outcome).toBe("rejected");
    expect(admission).toMatchObject({ reason, side: "head", repositoryId: c.request.repositoryId, revision: c.request.revision });
    for (const key of ["manifest", "frozen", "artifacts", "diagnostics"]) expect(key in admission).toBe(false);
    const summary = buildEvidenceSummary(admission);
    expect(summary).toMatchObject({ outcome: "rejected", reason, scopes: [], artifacts: null, diagnostics: null });
    const text = JSON.stringify([admission, summary]);
    for (const hidden of [c.dir, valid.repo, home, FIXTURE_SECRET_MARKER]) expect(text).not.toContain(hidden);
    // Rejected before any byte was frozen.
    expect(existsSync(c.runtime)).toBe(false);
  });

  it("treats unknown pinned profiles or variant as an unverified context that cannot supply the preferred environment", async () => {
    const c = setup(valid);
    c.manifest.context.profiles = null;
    c.manifest.context.variant = { state: "unknown", value: null };
    publish(c);
    withPin(c, { expectedContext: { id: "fixture-main", profiles: ["release"], variant: { state: "set", value: "debug" } } });
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(admission.contextVerified).toBe(false);
    expect([...admission.degraded].sort()).toEqual(["prod", "test"]);
    expect(admission.frozen.sourceRoots.size).toBe(0);
    const summary = buildEvidenceSummary(admission);
    expect(summary).toMatchObject({ outcome: "admitted", contextVerified: false });
    for (const role of ["production", "test"] as const) {
      expect(scopeOf(summary, role)).toMatchObject({ state: "degraded", reasons: ["context-unverified"] });
    }
  });

  // Unknown profiles or an unknown variant leave the context unverified whatever the host additionally pins:
  // the host cannot confirm what the exporter did not know, and a known unset variant is valid.
  const unknownContexts: Array<[string, (c: Case) => void, BuildEvidencePin["expectedContext"]]> = [
    ["unknown profiles, nothing pinned beyond the id", (c) => { c.manifest.context.profiles = null; }, { id: "fixture-main" }],
    ["an unknown variant, nothing pinned beyond the id", (c) => { c.manifest.context.variant = { state: "unknown", value: null }; }, { id: "fixture-main" }],
    ["unknown profiles and variant, nothing pinned beyond the id", (c) => { c.manifest.context.profiles = null; c.manifest.context.variant = { state: "unknown", value: null }; }, { id: "fixture-main" }],
    ["unknown profiles while a matching variant is pinned", (c) => { c.manifest.context.profiles = null; }, { id: "fixture-main", variant: { state: "unset", value: null } }],
    ["an unknown variant while matching profiles are pinned", (c) => { c.manifest.context.variant = { state: "unknown", value: null }; }, { id: "fixture-main", profiles: [] }],
  ];

  it.each(unknownContexts)("marks %s unverified and selects no preferred environment", async (_name, arrange, expectedContext) => {
    const c = setup(valid);
    arrange(c);
    publish(c);
    withPin(c, { expectedContext });
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(admission.contextVerified).toBe(false);
    expect([...admission.degraded].sort()).toEqual(["prod", "test"]);
    expect(admission.frozen.sourceRoots.size).toBe(0);
    const summary = buildEvidenceSummary(admission);
    expect(summary).toMatchObject({ outcome: "admitted", contextVerified: false });
    for (const role of ["production", "test"] as const) {
      expect(scopeOf(summary, role)).toMatchObject({ state: "degraded", reasons: ["context-unverified"] });
    }
  });

  it("verifies a known empty profile list and a known unset variant, pinned or not", async () => {
    for (const expectedContext of [{ id: "fixture-main" }, { id: "fixture-main", profiles: [], variant: { state: "unset" as const, value: null } }]) {
      const c = withPin(setup(valid), { expectedContext });
      const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
      expect(admission.contextVerified).toBe(true);
      expect(admission.degraded.size).toBe(0);
    }
  });
});

describe("host and isolation faults are not optional-export rejections", () => {
  const pins: Array<[string, (pin: BuildEvidencePin) => BuildEvidencePin]> = [
    ["a relative manifest path", (pin) => ({ ...pin, manifestPath: "manifest.json" })],
    ["a relative payload root", (pin) => ({ ...pin, payloadRoot: "payload" })],
    ["a malformed manifest hash", (pin) => ({ ...pin, manifestSha256: "ABC" })],
    ["an uppercase manifest hash", (pin) => ({ ...pin, manifestSha256: pin.manifestSha256.toUpperCase() })],
    ["an empty context id", (pin) => ({ ...pin, expectedContext: { ...pin.expectedContext, id: "" } })],
    ["an unknown variant pin", (pin) => ({ ...pin, expectedContext: { ...pin.expectedContext, variant: { state: "unknown", value: null } } })],
    ["an empty production id", (pin) => ({ ...pin, select: { ...pin.select, productionId: "" } })],
    ["an empty test id", (pin) => ({ ...pin, select: { ...pin.select, testId: "" } })],
    ["a module directory that leaves the repository", (pin) => ({ ...pin, select: { ...pin.select, moduleDir: "../elsewhere" } })],
  ];

  it.each(pins)("fails closed on %s with a host error, not a rejected admission", async (_name, change) => {
    const c = setup(valid);
    const { policy, calls } = makePolicy();
    const error = await admitBuildEvidence({ ...c.request, pin: change(pinOf(c)) }, policy).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(BuildEvidenceHostError);
    expect(error).not.toBeInstanceOf(BuildEvidenceInputError);
    expect((error as Error).message).not.toContain(c.dir);
    expect(calls.refresh).toBe(0);
    expect(existsSync(c.runtime)).toBe(false);
  });

  it("lets an unexpected failure of the host propagate instead of reading it as an absent export", async () => {
    const c = setup(valid);
    const missingRepo = { ...c.request, repo: join(c.dir, "no-such-repository") };
    const error = await admitBuildEvidence(missingRepo, makePolicy().policy).then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ENOENT" });
    expect(error).not.toBeInstanceOf(BuildEvidenceInputError);
    expect(error).not.toBeInstanceOf(BuildEvidenceHostError);
    expect(readdirSync(c.runtime)).toEqual([]);
  });

  it("separates unreadable manifests from resource exhaustion and from bugs", async () => {
    const c = setup(valid);
    const read = (code: string | Error) => {
      hooks.readFile = (path) => path === pinOf(c).manifestPath ? (typeof code === "string" ? failure(code) : code) : undefined;
      return admitBuildEvidence(c.request, makePolicy().policy);
    };
    expect(await read("EACCES")).toMatchObject({ outcome: "rejected", reason: "manifest-unreadable" });
    await expect(read("EMFILE")).rejects.toMatchObject({ code: "EMFILE" });
    await expect(read("ENOMEM")).rejects.toMatchObject({ code: "ENOMEM" });
    await expect(read(new TypeError("unexpected worker failure"))).rejects.toThrow("unexpected worker failure");
  });

  it("propagates cancellation as cancellation, before any read and during later stages", async () => {
    const pre = setup(valid);
    const reads: string[] = [];
    hooks.readFile = (path) => { reads.push(path); return undefined; };
    const aborted = new AbortController();
    aborted.abort();
    await expect(admitBuildEvidence({ ...pre.request, signal: aborted.signal }, makePolicy().policy)).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toEqual([]);

    const midRefresh = setup(valid);
    const controller = new AbortController();
    const { policy } = makePolicy({ refresh: async () => { controller.abort(); return []; } });
    await expect(admitBuildEvidence({ ...midRefresh.request, signal: controller.signal }, policy)).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(midRefresh.runtime)).toBe(false);

    const midScreening = setup(valid);
    const screening = new AbortController();
    hooks.readFile = (path) => { if (path.includes(`${sep}build-artifacts-`)) screening.abort(); return undefined; };
    await expect(admitBuildEvidence({ ...midScreening.request, signal: screening.signal }, makePolicy().policy)).rejects.toMatchObject({ name: "AbortError" });
    expect(readdirSync(midScreening.runtime)).toEqual([]);
  });

  it("removes its private copies when a host fault interrupts screening and never reports it as an artifact fault", async () => {
    const c = setup(valid);
    hooks.readFile = (path) => path.includes(`${sep}build-artifacts-`) ? failure("EMFILE") : undefined;
    await expect(admitBuildEvidence(c.request, makePolicy().policy)).rejects.toMatchObject({ code: "EMFILE" });
    expect(readdirSync(c.runtime)).toEqual([]);
  });
});

describe("selection from the host pin", () => {
  const selections: Array<[string, Partial<BuildEvidencePin["select"]>, { production: string[]; test: string[] }]> = [
    ["an unknown production id", { productionId: "ghost" }, { production: ["compilation-not-found"], test: [] }],
    ["an id that differs only by case", { productionId: "PROD" }, { production: ["compilation-not-found"], test: [] }],
    ["a test compilation requested as production", { productionId: "test" }, { production: ["role-mismatch"], test: [] }],
    ["a production compilation requested as test", { testId: "prod" }, { production: [], test: ["role-mismatch"] }],
    ["a module directory the compilations do not have", { moduleDir: "services/api" }, { production: ["module-mismatch"], test: ["module-mismatch"] }],
  ];

  it.each(selections)("marks the scope unsupported for %s and keeps the rest of the export", async (_name, change, reasons) => {
    const c = setup(valid);
    withPin(c, { select: { ...pinOf(c).select, ...change } });
    const summary = buildEvidenceSummary(admitted(await admitBuildEvidence(c.request, makePolicy().policy)));
    for (const role of ["production", "test"] as const) {
      const scope = scopeOf(summary, role);
      if (reasons[role].length === 0) {
        expect(scope).toMatchObject({ state: "selected", reasons: [] });
      } else {
        expect(scope).toMatchObject({
          state: "unsupported", reasons: reasons[role], generationState: null, resourceState: null, compilationState: null,
          gaps: { missing: 0, "not-produced": 0, withheld: 0, rejected: 0 }, exportedFactsDiscarded: false,
        });
      }
    }
  });

  it("does not request a test scope when none is configured", async () => {
    const c = setup(valid);
    withPin(c, { select: { ...pinOf(c).select, testId: null } });
    const summary = buildEvidenceSummary(admitted(await admitBuildEvidence(c.request, makePolicy().policy)));
    expect(scopeOf(summary, "test")).toMatchObject({ state: "not-requested", compilationId: null, reasons: [] });
    expect(scopeOf(summary, "production")).toMatchObject({ state: "selected", compilationId: "prod" });
    expect(summary.selection).toEqual({ moduleDir: ".", productionId: "prod", testId: null });
  });
});

describe("artifact identity failures degrade only the affected scopes", () => {
  it("rejects a tampered generated source for the production scope and the test scope that consumes it", async () => {
    const c = setup(valid);
    writeFileSync(join(c.payload, "generated/main/example/Pricing.java"), "package example; // tampered after export\n");
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    const status = admission.artifacts.get("pricing-output")!;
    expect(status.state).toBe("rejected");
    expect(status.reason).toMatch(/^[A-Za-z][A-Za-z0-9 ,.-]*$/);
    expect([...status.compilationIds].sort()).toEqual(["prod", "test"]);
    expect(admission.frozen.available.has("pricing-output")).toBe(false);
    expect(admission.frozen.sourceRoots.size).toBe(0);
    expect([...admission.degraded].sort()).toEqual(["prod", "test"]);
    expect(admission.artifacts.get("consumer-original")!.state).toBe("available");
    const summary = buildEvidenceSummary(admission);
    expect(scopeOf(summary, "production")).toMatchObject({ state: "degraded", reasons: ["artifact-rejected"], exportedFactsDiscarded: false, gaps: { rejected: 1 } });
    expect(summary.artifacts).toMatchObject({ rejected: 1 });
    expect(JSON.stringify(summary)).not.toContain("tampered");
  });

  it("keeps production usable when only a test-only authored original fails, and discards that scope's exported facts", async () => {
    const c = setup(valid);
    art(c.manifest, "pricing-test").content.sha256 = "a".repeat(64);
    publish(c);
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(admission.artifacts.get("pricing-test")).toMatchObject({ state: "rejected", compilationIds: ["test"] });
    expect([...admission.degraded]).toEqual(["test"]);
    expect([...admission.frozen.sourceRoots.keys()]).toEqual(["prod"]);
    expect(admission.artifacts.get("pricing-output")!.state).toBe("available");
    const summary = buildEvidenceSummary(admission);
    expect(scopeOf(summary, "production")).toMatchObject({ state: "selected", reasons: [], exportedFactsDiscarded: false });
    expect(scopeOf(summary, "test")).toMatchObject({ state: "degraded", reasons: ["artifact-rejected"], exportedFactsDiscarded: true, gaps: { rejected: 1 } });
  });
});

describe("secret screening before exposure", () => {
  it("withholds a credential-bearing resource, degrades the scopes that depend on it, and leaves the manifest untouched", async () => {
    const c = setup(secret);
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
    expect(admission.artifacts.get("app-resource-output")).toEqual({ state: "withheld", reason: "secret-detected", compilationIds: ["prod", "test"] });
    for (const id of ["pricing-output", "app-resource-original", "consumer-original", "prod-classes"]) {
      expect(admission.artifacts.get(id)!.state, id).toBe("available");
    }
    expect(admission.frozen.available.has("app-resource-output")).toBe(false);
    expect(admission.frozen.sourceRoots.size).toBe(0);
    expect([...admission.degraded].sort()).toEqual(["prod", "test"]);
    // The pinned manifest still says what the exporter said; the consumer record says what the consumer allows.
    expect(art(admission.manifest, "app-resource-output")).toEqual(art(secret.manifests.head, "app-resource-output"));
    expect(art(admission.manifest, "app-resource-output").availability).toBe("available");
    expect(admission.manifestSha256).toBe(pinOf(c).manifestSha256);

    const summary = buildEvidenceSummary(admission);
    expect(summary.artifacts).toMatchObject({ withheld: 1, available: secret.manifests.head.artifacts.length - 1 });
    expect(scopeOf(summary, "production")).toMatchObject({ state: "degraded", reasons: ["artifact-withheld"], exportedFactsDiscarded: false, gaps: { withheld: 1 } });
    expect(scopeOf(summary, "test")).toMatchObject({ state: "degraded", reasons: ["artifact-withheld"], gaps: { withheld: 1 } });
    const visible = JSON.stringify([summary, [...admission.artifacts], admission.diagnostics]);
    expect(visible).not.toContain(FIXTURE_SECRET_MARKER);
    const withheld = art(secret.manifests.head, "app-resource-output");
    expect(visible).not.toContain(withheld.content.sha256);
    expect(visible).not.toContain(withheld.content.location.path);
    expect(visible).not.toContain(c.payload);
  });

  it("withholds exactly the artifacts that contain a host-known value and honors a declared nonsecret value only when it is exact", async () => {
    const value = "billing.example.test"; // the endpoint inside the authored generator config and the filtered resource
    const withheld = async (init: PolicyInit) => {
      const admission = admitted(await admitBuildEvidence(setup(secret).request, makePolicy(init).policy));
      return [...admission.artifacts].filter(([, status]) => status.state === "withheld").map(([id]) => id).sort();
    };
    expect(await withheld({ refresh: async () => [value] })).toEqual(["app-resource-output", "pricing-generator-config"]);
    // The whole run still withholds the leaked token resource; the placeholder only removes the endpoint.
    expect(await withheld({ refresh: async () => [value], nonSecret: [value] })).toEqual(["app-resource-output"]);
    expect(await withheld({ refresh: async () => [value], nonSecret: ["billing.example"] })).toEqual(["app-resource-output", "pricing-generator-config"]);
  });

  it("finds a marker that became active after bytes were last readable, and keeps it for the run", async () => {
    let values: readonly string[] = [];
    const { policy } = makePolicy({ refresh: async () => values });
    const first = admitted(await admitBuildEvidence(setup(valid).request, policy));
    expect(first.artifacts.get("pricing-output")!.state).toBe("available");
    const text = Buffer.from(valid.outputBytes.get("pricing-output")!).toString("utf8");
    expect(screenText(text, policy)).toEqual({ state: "available" });

    values = ["quantity * 12"];
    const second = admitted(await admitBuildEvidence(setup(valid).request, policy));
    expect(second.artifacts.get("pricing-output")).toEqual({ state: "withheld", reason: "secret-detected", compilationIds: ["prod", "test"] });
    expect(second.degraded.size).toBe(2);
    expect(screenText(text, policy)).toEqual({ state: "withheld", reason: "secret-detected" });

    values = [];
    const third = admitted(await admitBuildEvidence(setup(valid).request, policy));
    expect(third.artifacts.get("pricing-output")!.state).toBe("withheld");
    expect(policy.knownValues.has("quantity * 12")).toBe(true);
  });

  it("withholds a diagnostic that carries a credential and keeps the export", async () => {
    const c = setup(valid);
    c.manifest.diagnostics = [
      { code: "upload-failed", message: `registry rejected ${KNOWN}`, compilationId: "prod", artifactIds: [] },
      { code: "log", message: `remote said ${FIXTURE_SECRET_MARKER}`, compilationId: null, artifactIds: ["pricing-output"] },
      { code: "CORP-424242", message: "ticket reference", compilationId: "test", artifactIds: [] },
      { code: "note", message: "plain diagnostic", compilationId: "test", artifactIds: [] },
    ];
    publish(c);
    const rules = [{ id: "corp-token", pattern: /\bCORP-\d{6}\b/g }];
    const admission = admitted(await admitBuildEvidence(c.request, makePolicy({ refresh: async () => [KNOWN], rules }).policy));
    expect(admission.diagnostics).toEqual([
      { state: "withheld", reason: "secret-detected", compilationId: "prod", artifactIds: [] },
      { state: "withheld", reason: "secret-detected", compilationId: null, artifactIds: ["pricing-output"] },
      { state: "withheld", reason: "secret-detected", compilationId: "test", artifactIds: [] },
      { state: "available", code: "note", message: "plain diagnostic", compilationId: "test", artifactIds: [] },
    ]);
    // Diagnostics are informational: the export and its scopes are unaffected.
    expect(admission.degraded.size).toBe(0);
    expect([...admission.artifacts.values()].every((status) => status.state === "available")).toBe(true);
    expect("diagnostics" in admission.manifest).toBe(false);
    const summary = buildEvidenceSummary(admission);
    expect(summary.diagnostics).toEqual({ total: 4, withheld: 3 });
    const visible = JSON.stringify([summary, admission.diagnostics, admission.manifest, [...admission.artifacts]]);
    for (const hidden of [KNOWN, FIXTURE_SECRET_MARKER, "CORP-424242"]) expect(visible).not.toContain(hidden);
  });

  const metadata: Array<[string, (c: Case) => void, PolicyInit]> = [
    ["a known value in producer metadata", (c) => { c.manifest.producer.runId = `run-${KNOWN}`; }, { refresh: async () => [KNOWN] }],
    ["a credential-shaped artifact id referenced across the manifest", (c) => {
      c.manifest = JSON.parse(JSON.stringify(c.manifest).replaceAll('"pricing-output"', `"pricing-output-${FIXTURE_SECRET_MARKER}"`));
    }, {}],
    ["a host rule match in a compilation name", (c) => { c.manifest.compilations[0].name = "CORP-555555 main"; }, { rules: [{ id: "corp-token", pattern: /\bCORP-\d{6}\b/g }] }],
    ["a known value in an artifact path", (c) => {
      const template = art(c.manifest, "pricing-template");
      template.repositoryPath = `templates/${KNOWN}.tpl`;
      template.content.location.path = template.repositoryPath;
    }, { refresh: async () => [KNOWN] }],
  ];

  it.each(metadata)("rejects the export for %s instead of rewriting identity fields", async (_name, arrange, init) => {
    const c = setup(valid);
    arrange(c);
    publish(c);
    const admission = await admitBuildEvidence(c.request, makePolicy(init).policy);
    expect(admission).toMatchObject({ outcome: "rejected", reason: "secret-in-metadata", exposureCheck: "checked" });
    const summary = buildEvidenceSummary(admission);
    expect(summary).toMatchObject({ outcome: "rejected", reason: "secret-in-metadata", exposureCheck: "checked", scopes: [] });
    const text = JSON.stringify([admission, summary]);
    for (const hidden of [KNOWN, FIXTURE_SECRET_MARKER, "CORP-555555", c.dir]) expect(text).not.toContain(hidden);
    expect("manifest" in admission).toBe(false);
    expect(existsSync(c.runtime)).toBe(false);
  });

  it("rejects the export, and reports the check unavailable, when screening cannot run; its error never surfaces", async () => {
    const c = setup(valid);
    const { policy } = makePolicy({ refresh: async () => { throw new Error(`credential store locked: ${KNOWN}`); } });
    const admission = await admitBuildEvidence(c.request, policy);
    expect(admission).toMatchObject({ outcome: "rejected", reason: "screening-unavailable", exposureCheck: "unavailable" });
    expect(policy.available).toBe(false);
    const summary = buildEvidenceSummary(admission);
    expect(summary).toMatchObject({ outcome: "rejected", reason: "screening-unavailable", exposureCheck: "unavailable" });
    const text = JSON.stringify([admission, summary]);
    expect(text).not.toContain(KNOWN);
    expect(text).not.toContain("credential store");
    expect(existsSync(c.runtime)).toBe(false);
  });

  describe("text longer than the engine's string ceiling", () => {
    // A decoded string never has more UTF-16 units than the text has bytes, so the engine's own string limit is the one
    // length past which a single decoded string may not exist. It is not a client capacity policy: nothing shorter is
    // withheld for its size, and the failure stays typed instead of ending the whole admission.
    const CEILING = constants.MAX_STRING_LENGTH;

    it("withholds such an artifact as screening-unavailable, degrades its scopes and still admits the export", async () => {
      const c = setup(valid);
      const size = CEILING + 1;
      mkdirSync(join(c.payload, "huge"), { recursive: true });
      writeFileSync(join(c.payload, "huge/blob.txt"), "");
      truncateSync(join(c.payload, "huge/blob.txt"), size); // sparse: no disk is used for the source
      const zeros = Buffer.alloc(1 << 22);
      const hash = createHash("sha256");
      for (let left = size; left > 0; left -= zeros.length) hash.update(left >= zeros.length ? zeros : zeros.subarray(0, left));
      c.manifest.artifacts.push({
        id: "huge-resource", kind: "file", role: "resource", origin: "external", repositoryPath: null, availability: "available",
        content: { location: { kind: "payload", path: "huge/blob.txt" }, sha256: hash.digest("hex"), sizeBytes: size }, encoding: null,
      });
      c.manifest.compilations.find((compilation: Json) => compilation.id === "prod").resourceArtifactIds.push("huge-resource");
      publish(c);
      try {
        const admission = admitted(await admitBuildEvidence(c.request, makePolicy().policy));
        expect(admission.artifacts.get("huge-resource")).toEqual({ state: "withheld", reason: "screening-unavailable", compilationIds: ["prod", "test"] });
        expect(admission.frozen.available.has("huge-resource")).toBe(false);
        expect(admission.artifacts.get("consumer-original")!.state).toBe("available");
        expect(admission.exposureCheck).toBe("checked");
        expect([...admission.degraded].sort()).toEqual(["prod", "test"]);
        const summary = buildEvidenceSummary(admission);
        expect(summary.artifacts).toMatchObject({ withheld: 1 });
        expect(scopeOf(summary, "production")).toMatchObject({ state: "degraded", reasons: ["artifact-withheld"], gaps: { withheld: 1 } });
      } finally {
        rmSync(c.dir, { recursive: true, force: true }); // the private copy is as large as the artifact
      }
    }, 120_000);
  });
});

describe("audit capture of admitted evidence", () => {
  it("persists no credential value, however the evidence reaches the audit trail", async () => {
    const c = setup(secret);
    const { policy } = makePolicy({ refresh: async () => [KNOWN] });
    const data = mkdtempSync(join(home, "audit-"));
    const config = auditConfig(data, { LEVERET_TRACE_ROOT: join(data, "traces"), LEVERET_TRACE_SINKS: "private", LEVERET_TRACE_BLOB_BYTES: "64" });
    const run = (await createAuditRun(config, "run-build-evidence"))!;
    const leakedResource = Buffer.from(secret.outputBytes.get("app-resource-output")!).toString("utf8");
    const runDir = await withSecretPolicy(policy, async () => {
      const admission = admitted(await admitBuildEvidence(c.request, policy));
      await run.record("tools", "build_evidence", { summary: buildEvidenceSummary(admission) });
      // Raw material as a tool, a build process or an exception would hand it over.
      await run.record("tools", "execution_end", { stdout: `${leakedResource}\nvault=${KNOWN}`, argv: ["exporter", "--note", KNOWN], error: new Error(`exporter failed near ${KNOWN}`) });
      return (await run.finalize("complete")).runDir!;
    });
    const bytes = readAllBytes(runDir);
    expect(bytes).not.toContain(FIXTURE_SECRET_MARKER);
    expect(bytes).not.toContain(KNOWN);
    expect(bytes).toContain("[REDACTED]");
    expect(bytes).toContain("build_evidence");
    expect(bytes).toContain("artifact-withheld");
  });
});

describe("artifact-aware Java reference contract", () => {
  const pos = (line: number, column: number) => ({ line, column });
  const span = (line: number, start: number, end: number) => ({ start: pos(line, start), end: pos(line, end) });
  const citation = { manifestSha256: "a".repeat(64), artifactId: "pricing-generated", origin: "materialized" };
  const success = {
    ok: true,
    result: {
      summary: {
        analysisId: "analysis", repositoryId: "repo", revision: "head", configurationSha256: "config",
        coverage: {
          complete: true, mainExamined: 1, testExamined: 1, mainSkipped: 0, testSkipped: 0,
          mainUnresolved: 0, testUnresolved: 0, diagnosticCount: 0,
        },
      },
      target: {
        id: "4:prod:Lexample/Pricing;.price(I)I", bindingKey: "Lexample/Pricing;.price(I)I",
        signature: "example.Pricing.price(int)",
        location: { path: "src/main/java/example/Pricing.java", range: span(3, 4, 50), buildArtifact: null },
        nameRange: span(3, 15, 20), sourceSet: "main",
      },
      side: "head",
      referenceScope: "all",
      items: [{
        kind: "reference",
        reference: {
          id: "site", targetId: "4:prod:Lexample/Pricing;.price(I)I",
          location: { path: "target/generated-sources/example/Caller.java", range: span(4, 24, 40), buildArtifact: citation },
          enclosing: null, sourceSet: "test", kind: "call", basis: "checked", diffStatus: "generated",
        },
        unresolved: null, file: null, diagnostic: null,
      }],
      delivery: { complete: true, truncated: false, omittedRecords: 0, nextCursor: null },
    },
  };

  it("decodes nullable legacy origins and generated artifact evidence through the single reply schema", () => {
    const decoded = referenceReplySchema.parse(success);
    expect(decoded.ok && decoded.result.target.location.buildArtifact).toBeNull();
    expect(decoded.ok && decoded.result.target.bindingKey).toBe("Lexample/Pricing;.price(I)I");
    expect(decoded.ok && decoded.result.referenceScope).toBe("all");
    expect(decoded.ok && decoded.result.items[0]?.reference).toMatchObject({
      diffStatus: "generated", location: { buildArtifact: citation },
    });
    expect(referenceReplySchema.parse({
      ok: false, error: { code: "unsupported-exported-environment", message: "release is unsupported" },
    })).toMatchObject({ ok: false, error: { code: "unsupported-exported-environment" } });
  });

  it.each([
    ["a missing nullable location origin", (value: Json) => { delete value.result.target.location.buildArtifact; }],
    ["a missing binding key", (value: Json) => { delete value.result.target.bindingKey; }],
    ["a missing query scope", (value: Json) => { delete value.result.referenceScope; }],
    ["a missing diff classification", (value: Json) => { delete value.result.items[0].reference.diffStatus; }],
    ["an invented diff classification", (value: Json) => { value.result.items[0].reference.diffStatus = "unknown"; }],
  ])("rejects %s", (_label, mutate) => {
    const value = structuredClone(success);
    mutate(value);
    expect(referenceReplySchema.safeParse(value).success).toBe(false);
  });
});
