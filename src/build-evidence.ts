import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { freezeBuildArtifacts, scopeResolver, type FrozenBuildArtifacts } from "./build-artifacts.js";
import {
  BuildEvidenceInputError, parseBuildEvidence,
  type BuildCompilation, type BuildDiagnostic, type BuildEvidenceManifest, type BuildEvidencePin, type BuildEvidenceRequest,
} from "./build-evidence-contract.js";
import { isSafeRelativePath } from "./git-objects.js";
import { refreshSecretPolicy, screenText, type ExposureDecision, type SecretPolicy } from "./secret-screening.js";

/**
 * Consumer admission of an optional build-evidence export for one side of a review.
 *
 * Three kinds of failure stay apart. An invalid host pin is a `BuildEvidenceHostError`: trusted configuration
 * is wrong, so the call fails closed. A problem with the export itself (absent, altered, wrong repository,
 * revision or context, schema-invalid, secret-bearing metadata, screening unavailable) is a typed rejection
 * of the whole export, after which the caller resolves coverage independently per scope. A problem with one
 * artifact degrades only the compilations that depend on it. Anything else (descriptor or memory exhaustion,
 * a Git process that cannot run, cancellation, a bug) is neither: it rejects the call and is never read as
 * "the export is absent".
 *
 * The manifest is immutable and pinned by hash. What the consumer decided about each artifact lives beside it
 * in `artifacts`; nothing is rewritten. Text, metadata and diagnostics pass the host secret policy before any
 * of it is retained for exposure, and the public summary is a projection that carries no raw object, matched
 * value, host path or withheld content hash.
 */

export class BuildEvidenceHostError extends Error {
  constructor(readonly code: "invalid-host-configuration", message: string) {
    super(message);
    this.name = "BuildEvidenceHostError";
  }
}

export type RejectionReason =
  | "manifest-absent" | "manifest-unreadable" | "manifest-hash-mismatch" | "manifest-invalid"
  | "repository-mismatch" | "revision-mismatch" | "context-mismatch"
  | "secret-in-metadata" | "screening-unavailable";
/** Whether the secret policy examined this export's text and metadata. Unavailable is never reported as clean. */
export type ExposureCheck = "not-run" | "unavailable" | "checked";
export type ArtifactState = "available" | "missing" | "not-produced" | "withheld" | "rejected";
export type GapState = Exclude<ArtifactState, "available">;
export type ScopeRole = "production" | "test";
export type ScopeReason = "compilation-not-found" | "module-mismatch" | "role-mismatch" | "artifact-rejected" | "artifact-withheld" | "context-unverified";
export type StepState = BuildCompilation["generationState"];
export type BuildSelection = BuildEvidencePin["select"];

export type ArtifactStatus = {
  readonly state: ArtifactState;
  /** `exporter-declared`, a screening code, or a fixed admission sentence; never a path, hash or manifest value. */
  readonly reason: string | null;
  /** Compilations the consumer's own rejection or withholding degrades. Empty for exporter-declared states. */
  readonly compilationIds: readonly string[];
};

export type ScopeStatus = {
  readonly role: ScopeRole;
  readonly compilationId: string | null;
  /** `selected` only says the consumer kept the scope; the bridge still judges inventory, classpath and settings. */
  readonly state: "not-requested" | "unsupported" | "degraded" | "selected";
  readonly reasons: readonly ScopeReason[];
  /** Artifacts this scope depends on, by state, whatever the cause. */
  readonly gaps: Readonly<Record<GapState, number>>;
  /** An authored original failed Git identity: exported facts bound to this revision must be discarded. */
  readonly exportedFactsDiscarded: boolean;
  /** The exporter's step outcomes, reported as given: not inventory, semantic or model-review coverage. */
  readonly generationState: StepState | null;
  readonly resourceState: StepState | null;
  readonly compilationState: StepState | null;
};

export type ExposedDiagnostic =
  | ({ readonly state: "available" } & BuildDiagnostic)
  | { readonly state: "withheld"; readonly reason: "secret-detected" | "screening-unavailable"; readonly compilationId: string | null; readonly artifactIds: readonly string[] };

type Common = { side: "base" | "head"; repositoryId: string; revision: string; secretPolicyId: string };

export type UnconfiguredBuildEvidence = Common & { outcome: "unconfigured" };

export type RejectedBuildEvidence = Common & {
  outcome: "rejected";
  reason: RejectionReason;
  /** A fixed sentence, or the parser's schema-owned wording with record positions. Never a raw manifest value. */
  detail: string;
  manifestSha256: string;
  contextId: string;
  selection: BuildSelection;
  exposureCheck: ExposureCheck;
};

export type AdmittedBuildEvidence = Common & {
  outcome: "admitted";
  manifestSha256: string;
  contextId: string;
  /** False when a pinned profile or variant is unknown in the manifest: no preferred semantic environment. */
  contextVerified: boolean;
  exposureCheck: "checked";
  selection: BuildSelection;
  /** The validated, deeply frozen manifest without its diagnostics, which are exposed only through `diagnostics`. */
  manifest: Readonly<Omit<BuildEvidenceManifest, "diagnostics">>;
  diagnostics: readonly ExposedDiagnostic[];
  /** Consumer availability per manifest artifact, in manifest order. */
  artifacts: ReadonlyMap<string, ArtifactStatus>;
  /** Private frozen bytes and roots of what stayed available. Never serialize, log or show it. */
  frozen: FrozenBuildArtifacts;
  /** Compilations the consumer will not use an exported environment for: rejected or withheld inputs, unverified context. */
  degraded: ReadonlySet<string>;
  scopes: readonly [ScopeStatus, ScopeStatus];
};

export type BuildEvidenceAdmission = UnconfiguredBuildEvidence | RejectedBuildEvidence | AdmittedBuildEvidence;

export type PublicBuildEvidenceSummary = Common & {
  outcome: BuildEvidenceAdmission["outcome"];
  reason: RejectionReason | null;
  contextId: string | null;
  contextVerified: boolean | null;
  manifestSha256: string | null;
  exposureCheck: ExposureCheck;
  selection: BuildSelection | null;
  scopes: readonly ScopeStatus[];
  artifacts: Readonly<Record<ArtifactState, number>> | null;
  diagnostics: { total: number; withheld: number } | null;
};

const DETAIL: Record<Exclude<RejectionReason, "manifest-invalid">, string> = {
  "manifest-absent": "the pinned manifest file does not exist",
  "manifest-unreadable": "the pinned manifest file could not be read",
  "manifest-hash-mismatch": "the manifest bytes differ from the pinned SHA-256",
  "repository-mismatch": "the manifest describes a different repository",
  "revision-mismatch": "the manifest describes a different revision",
  "context-mismatch": "the manifest context differs from the host-pinned context",
  "secret-in-metadata": "manifest metadata matched the secret policy",
  "screening-unavailable": "the secret policy could not be applied",
};

const RESOURCE_ERRORS = ["EMFILE", "ENFILE", "ENOMEM", "ENOSPC", "EDQUOT"];
const NO_GAPS: Readonly<Record<GapState, number>> = Object.freeze({ missing: 0, "not-produced": 0, withheld: 0, rejected: 0 });

function invalidHost(what: string): never {
  throw new BuildEvidenceHostError("invalid-host-configuration", `invalid build-evidence host configuration: ${what}`);
}

/** Host pins are trusted configuration: any malformed value fails closed, with a fixed message that echoes nothing. */
function validatePin(request: BuildEvidenceRequest, pin: BuildEvidencePin): void {
  if (request.side !== "base" && request.side !== "head") invalidHost("side");
  if (request.repositoryId === "" || request.revision === "") invalidHost("repository or revision");
  if (!isAbsolute(pin.manifestPath)) invalidHost("manifest path must be absolute");
  if (!isAbsolute(pin.payloadRoot)) invalidHost("payload root must be absolute");
  if (!/^[0-9a-f]{64}$/.test(pin.manifestSha256)) invalidHost("manifest hash must be 64 lowercase hex characters");
  const { id, profiles, variant } = pin.expectedContext;
  if (id === "") invalidHost("context id");
  if (profiles !== undefined && !(Array.isArray(profiles) && profiles.every((profile) => typeof profile === "string"))) invalidHost("pinned profiles");
  if (variant !== undefined && !((variant.state === "set" && typeof variant.value === "string") || (variant.state === "unset" && variant.value === null))) invalidHost("pinned variant");
  const { moduleDir, productionId, testId } = pin.select;
  if (moduleDir !== "." && !isSafeRelativePath(moduleDir)) invalidHost("module directory");
  if (productionId === "" || testId === "") invalidHost("compilation selection");
}

/** Exact comparison of the optional host pins. Unknown manifest values cannot confirm a pin; known ones must equal it. */
function matchContext(manifest: BuildEvidenceManifest, pin: BuildEvidencePin): "verified" | "unverified" | "mismatch" {
  const { context } = manifest;
  const expected = pin.expectedContext;
  if (context.id !== expected.id) return "mismatch";
  let verified = true;
  if (expected.profiles !== undefined) {
    if (context.profiles === null) verified = false;
    else {
      const actual = [...context.profiles].sort();
      const wanted = [...expected.profiles].sort();
      if (actual.length !== wanted.length || actual.some((profile, index) => profile !== wanted[index])) return "mismatch";
    }
  }
  if (expected.variant !== undefined) {
    if (context.variant.state === "unknown") verified = false;
    else if (context.variant.state !== expected.variant.state || context.variant.value !== expected.variant.value) return "mismatch";
  }
  return verified ? "verified" : "unverified";
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* stringsIn(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) yield* stringsIn(item);
}

/**
 * Every string of the manifest except diagnostic text, which is withheld item by item. Identity fields (IDs,
 * paths, names, coordinates) cannot be rewritten to remove a secret, so one hit rejects exposure of the export.
 */
function metadataLeaks(manifest: BuildEvidenceManifest, policy: SecretPolicy): boolean {
  const { diagnostics, ...rest } = manifest;
  const references = diagnostics.map((item) => [item.compilationId, item.artifactIds]);
  for (const text of stringsIn([rest, references])) if (screenText(text, policy).state !== "available") return true;
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Admits one side's configured export. `unconfigured` performs no lookup and never touches the policy.
 * Cancellation and host failures reject the call; the private copies made so far are removed.
 */
export async function admitBuildEvidence(request: BuildEvidenceRequest, policy: SecretPolicy): Promise<BuildEvidenceAdmission> {
  const common: Common = { side: request.side, repositoryId: request.repositoryId, revision: request.revision, secretPolicyId: policy.id };
  const { pin, signal } = request;
  if (pin === undefined) return { ...common, outcome: "unconfigured" };
  validatePin(request, pin);
  signal?.throwIfAborted();

  const reject = (reason: RejectionReason, detail?: string, exposureCheck: ExposureCheck = "not-run"): RejectedBuildEvidence => ({
    ...common, outcome: "rejected", reason, detail: detail ?? DETAIL[reason as keyof typeof DETAIL], manifestSha256: pin.manifestSha256,
    contextId: pin.expectedContext.id, selection: pin.select, exposureCheck,
  });

  let bytes: Buffer;
  try {
    bytes = await readFile(pin.manifestPath, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return reject("manifest-absent");
    if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code) && !RESOURCE_ERRORS.includes(code)) return reject("manifest-unreadable");
    throw error;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== pin.manifestSha256) return reject("manifest-hash-mismatch");

  let manifest: BuildEvidenceManifest;
  try {
    manifest = parseBuildEvidence(bytes);
  } catch (error) {
    if (error instanceof BuildEvidenceInputError) return reject("manifest-invalid", error.safeReason);
    throw error;
  }
  if (manifest.repositoryId !== request.repositoryId) return reject("repository-mismatch");
  if (manifest.revision !== request.revision) return reject("revision-mismatch");
  const context = matchContext(manifest, pin);
  if (context === "mismatch") return reject("context-mismatch");

  await refreshSecretPolicy(policy);
  signal?.throwIfAborted();
  if (!policy.available) return reject("screening-unavailable", undefined, "unavailable");
  if (metadataLeaks(manifest, policy)) return reject("secret-in-metadata", undefined, "checked");

  const frozen = await freezeBuildArtifacts(request, manifest);
  try {
    return await decide(common, request, pin, manifest, context === "verified", frozen, policy);
  } catch (error) {
    await rm(frozen.scratch, { recursive: true, force: true });
    throw error;
  }
}

async function decide(
  common: Common, request: BuildEvidenceRequest, pin: BuildEvidencePin, manifest: BuildEvidenceManifest,
  contextVerified: boolean, frozen: FrozenBuildArtifacts, policy: SecretPolicy,
): Promise<AdmittedBuildEvidence> {
  const { signal } = request;

  // Text-bearing artifacts are screened from the frozen bytes the model could later be shown. Binary roles
  // (compiled classes, dependency jars) are never served as text and have no screening state.
  // ponytail: whole-file screening; chunked screening would need overlap handling for multi-line rules.
  const withheld = new Map<string, "secret-detected" | "screening-unavailable">();
  for (const [id, { artifact, path }] of frozen.available) {
    signal?.throwIfAborted();
    if (artifact.kind !== "file" || artifact.role === "classes" || artifact.role === "dependency") continue;
    const decision: ExposureDecision = screenText((await readFile(path)).toString("utf8"), policy);
    if (decision.state === "withheld") withheld.set(id, decision.reason);
  }
  signal?.throwIfAborted();

  const scopesOf = scopeResolver(manifest);
  const rejections = new Map(frozen.rejected.map((item) => [item.artifactId, item]));
  const artifacts = new Map<string, ArtifactStatus>();
  const gapCounts = new Map<string, Record<GapState, number>>();
  const rejectedScopes = new Set<string>();
  const withheldScopes = new Set<string>();
  const discardedScopes = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const rejection = rejections.get(artifact.id);
    const hold = withheld.get(artifact.id);
    let status: ArtifactStatus;
    if (rejection) {
      status = { state: "rejected", reason: rejection.reason, compilationIds: rejection.compilationIds };
      for (const scope of rejection.compilationIds) {
        rejectedScopes.add(scope);
        if (artifact.origin === "authored") discardedScopes.add(scope);
      }
    } else if (hold) {
      status = { state: "withheld", reason: hold, compilationIds: scopesOf(artifact.id) };
      for (const scope of status.compilationIds) withheldScopes.add(scope);
    } else if (artifact.availability !== "available") {
      status = { state: artifact.availability, reason: "exporter-declared", compilationIds: [] };
    } else {
      status = { state: "available", reason: null, compilationIds: [] };
    }
    artifacts.set(artifact.id, status);
    if (status.state === "available") continue;
    for (const scope of scopesOf(artifact.id)) {
      const counts = gapCounts.get(scope) ?? { ...NO_GAPS };
      counts[status.state]++;
      gapCounts.set(scope, counts);
    }
  }

  const degraded = new Set<string>(contextVerified ? [...rejectedScopes, ...withheldScopes] : manifest.compilations.map((item) => item.id));
  const compilations = new Map(manifest.compilations.map((item) => [item.id, item]));
  const scopeFor = (role: ScopeRole, id: string | null): ScopeStatus => {
    const none = { reasons: [] as ScopeReason[], gaps: NO_GAPS, exportedFactsDiscarded: false, generationState: null, resourceState: null, compilationState: null };
    if (id === null) return { role, compilationId: null, state: "not-requested", ...none };
    const compilation = compilations.get(id);
    const unsupported: ScopeReason[] = [];
    if (!compilation) unsupported.push("compilation-not-found");
    else {
      if (compilation.moduleDir !== pin.select.moduleDir) unsupported.push("module-mismatch");
      if (compilation.sourceSetRole !== role) unsupported.push("role-mismatch");
    }
    if (!compilation || unsupported.length > 0) return { role, compilationId: id, state: "unsupported", ...none, reasons: unsupported };
    const reasons: ScopeReason[] = [];
    if (rejectedScopes.has(id)) reasons.push("artifact-rejected");
    if (withheldScopes.has(id)) reasons.push("artifact-withheld");
    if (!contextVerified) reasons.push("context-unverified");
    return {
      role, compilationId: id, state: reasons.length > 0 ? "degraded" : "selected", reasons,
      gaps: gapCounts.get(id) ?? NO_GAPS, exportedFactsDiscarded: discardedScopes.has(id),
      generationState: compilation.generationState, resourceState: compilation.resourceState, compilationState: compilation.compilationState,
    };
  };

  const diagnostics = manifest.diagnostics.map((item): ExposedDiagnostic => {
    const held = [screenText(item.code, policy), screenText(item.message, policy)].find((decision) => decision.state === "withheld");
    return held?.state === "withheld"
      ? { state: "withheld", reason: held.reason, compilationId: item.compilationId, artifactIds: item.artifactIds }
      : { state: "available", ...item };
  });

  const available = new Map([...frozen.available].filter(([id]) => !withheld.has(id)));
  const sourceRoots = new Map([...frozen.sourceRoots].filter(([id]) => !degraded.has(id)));
  const { diagnostics: _exposedSeparately, ...retained } = manifest;
  return {
    ...common, outcome: "admitted", manifestSha256: pin.manifestSha256, contextId: pin.expectedContext.id, contextVerified,
    exposureCheck: "checked", selection: pin.select, manifest: deepFreeze(retained), diagnostics: deepFreeze(diagnostics), artifacts,
    frozen: { available, rejected: frozen.rejected, sourceRoots, scratch: frozen.scratch }, degraded,
    scopes: [scopeFor("production", pin.select.productionId), scopeFor("test", pin.select.testId)],
  };
}

/** The only shape of an admission that may reach a model, an audit record or a report. */
export function buildEvidenceSummary(admission: BuildEvidenceAdmission): PublicBuildEvidenceSummary {
  const { side, repositoryId, revision, secretPolicyId } = admission;
  const identity = { side, repositoryId, revision, secretPolicyId };
  if (admission.outcome === "unconfigured") {
    return { ...identity, outcome: "unconfigured", reason: null, contextId: null, contextVerified: null, manifestSha256: null, exposureCheck: "not-run", selection: null, scopes: [], artifacts: null, diagnostics: null };
  }
  if (admission.outcome === "rejected") {
    return {
      ...identity, outcome: "rejected", reason: admission.reason, contextId: admission.contextId, contextVerified: null,
      manifestSha256: admission.manifestSha256, exposureCheck: admission.exposureCheck, selection: { ...admission.selection }, scopes: [], artifacts: null, diagnostics: null,
    };
  }
  const artifacts: Record<ArtifactState, number> = { available: 0, ...NO_GAPS };
  for (const status of admission.artifacts.values()) artifacts[status.state]++;
  return {
    ...identity, outcome: "admitted", reason: null, contextId: admission.contextId, contextVerified: admission.contextVerified,
    manifestSha256: admission.manifestSha256, exposureCheck: admission.exposureCheck, selection: { ...admission.selection },
    scopes: admission.scopes.map((scope) => ({ ...scope, reasons: [...scope.reasons], gaps: { ...scope.gaps } })),
    artifacts, diagnostics: { total: admission.diagnostics.length, withheld: admission.diagnostics.filter((item) => item.state === "withheld").length },
  };
}
