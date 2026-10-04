# Optional Build Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an actual Leveret reviewer use original templates/source alongside client-produced generated sources/resources, resolve supported Java compilations from their exported environment, and report gaps without making build integration mandatory.

**Architecture:** Validate a host-pinned build manifest, admit and freeze referenced bytes, then adapt selected compilations into the existing Inspect engine. An artifact-aware read tool exposes originals, outputs and lineage through existing evidence/audit machinery. Independent cache-only discovery remains the per-scope fallback; no build command or exporter plugin runs inside Inspect.

**Tech Stack:** TypeScript 7 / Node ES2023, Zod 4.4.3, TypeBox 1.3.7, Vitest 4.1, Pi coding-agent 0.84.2; Kotlin 2.4, JDK 25+, JDT Core 3.46, JUnit/AssertJ and H2; existing Linux Bubblewrap/prlimit boundary. No new runtime dependency is required for this plan.

**Spec:** [Optional pipeline build-evidence contract](../specs/2026-10-04-build-evidence-contract-design.md). The maintainer approved its basis and requested this plan. Source-root membership and compiler-platform fingerprints are planning clarifications in that spec; approve them with this plan before execution.

**Status:** Plan for human review. No product implementation is authorized until the plan and execution method are approved. Continue in `/root/git/.leveret_worktrees/build-evidence-contract`, branch `docs/build-evidence-contract`; do not create another worktree or modify `main`.

## Global Constraints

- “Generated output enriches the review and never replaces the originals.”
- “Inspect's analysis worker still runs no target build, processor, generator, plugin or test.”
- “One manifest describes one revision and one context.” Base/head exports are independently pinned; later checkpoints are new immutable snapshots, never merged.
- “No arbitrary file-count limits are introduced.” Keep client capacity policy distinct from isolation, transport/context, memory and cancellation safeguards.
- “Hashes prove byte identity, not truthful build configuration or generation freshness.” Report the environment as exporter-asserted and PR-influenced.
- Authored files are regular Git blobs at the pinned revision, modes `100644` or `100755`; payload bytes cannot masquerade as originals.
- Manifest schema is `leveret.build-evidence/v1`; unknown fields/types/enums, duplicate JSON keys/IDs and trailing content reject the entire export. Git/filesystem admission failures reject affected artifacts/scopes.
- Compilations are selected explicitly by ID, matching `moduleDir` and `sourceSetRole`. No first-record selection or cross-variant classpath union.
- Paths remain contained; artifacts have immutable SHA-256 identities; source-map positions use one-based lines, zero-based UTF-16 columns and exclusive ends.
- Secret screening precedes model/audit/public exposure. Withheld inputs cannot supply semantic facts; missing screening is not “clean”. No new provider credential store.
- “Keep build-step outcome, export inventory, semantic coverage and model-review coverage separate.” Failed or unrun compilation does not by itself invalidate a complete supported input environment.
- Imported artifacts are evidence, never instructions, skills, hooks, executables or automatic learning.
- Preserve frozen parity thresholds and historical evaluation records. Own-tool model runs are pre-authorized; use Grok, Gemini Flash or Z.ai Flash while keeping declared experiment identities pinned.

## Review Focus

1. Two source roots contain the same basename, or a template overwrites a tracked `.java`: neither file may disappear or be cited as the other view — Tasks 1, 2, 4 and 7.
2. A classpath jar shadows a same-named upstream class: a bare JDT key/FQN must not create a checked caller of the wrong source declaration — Tasks 4 and 5.
3. A matching Java version hides different platform bytes, or `--release` is ignored: never claim the exported API environment was reproduced — Tasks 4 and 6.
4. A payload directory changes through an ancestor symlink or an unlisted class appears: freezing must remain contained and failures propagate to every affected compilation — Task 2.
5. A provider credential refreshes after admission, or a secret is in diagnostics rather than a file: no raw value may reach process/tool audit, native session or publication — Tasks 3, 7 and 8.

## Scope, file ownership and dependencies

This plan delivers the **shared consumer and client-command integration boundary**. A working test-owned client command produces real template/resource outputs and the exact manifest; production accepts any client-owned command producing that contract. The host supplies the artifacts, not a command for Leveret to execute. Maven/Gradle plugins are separate producer implementations against this same boundary, not unfinished plugins or mandatory prerequisites in this delivery.

The first Java consumer still selects one production and one test compilation of one configured module. Multiple source roots within those compilations are necessary for generation and are supported. Other compilation records remain retrievable evidence with explicit unsupported semantic scope. Advanced compiler/JPMS settings are supported only when their semantics are proved; otherwise retain the artifacts, disclose the capability gap and use coherent independent fallback. Never guess a platform or silently normalize unknown options.

| File / area | Responsibility |
| --- | --- |
| `src/build-evidence-contract.ts` (new) | Strict wire schemas, unique-key JSON parsing, references, conditional fields and source-root/compiler data types |
| `src/build-evidence.ts` (new) | Host pins, per-side selection, import failure matrix, admission records and safe public summaries |
| `src/build-artifacts.ts` (new) | Git/payload byte admission, directory manifests, contained reads, freezing and source-root layout |
| `src/secret-screening.ts` (new) | Existing audit text patterns plus active known-value/configured-rule screening; no credential storage |
| `src/build-artifact-reader.ts` (new) | Bounded artifact/lineage retrieval with manifest-bound citations and cursors |
| `src/build-java-inputs.ts` (new) | Supported environment decision and prepared JVM inputs; no build reconstruction |
| `src/git-objects.ts` (new, extracted) | Existing NUL-safe tree/batch-blob reads reused by legacy snapshot and authored admission |
| `src/inspect-java.ts`, `src/inspect-java-contract.ts` | Trusted optional import configuration; existing bridge and result/location contract |
| JVM `JavaFacts.kt`, `JavaAnalysisIdentity.kt`, `JavaExtractor.kt`, `JavaFactStore.kt`, `JavaReferences.kt`, `JavaAnalysisMain.kt` | Normalized compilation input, exact origin-aware extraction/query and immutable fact publication |
| JVM `JavaCompilationEnvironment.kt` (new) | Compiler environment data/eligibility and resolved source/binary origin index |
| `src/runner/pi-tools.ts`, `pi.ts`, `discovery-legs.ts`, `pi-system.ts`, `verify-output.ts` | Tools, phase context/allowlists, provenance, safe final findings and lifecycle |
| `src/audit.ts`, `src/app/render.ts` | Shared secret handling and original/generated publication boundaries |
| `test/build-evidence-fixture.ts`, `test/fixtures/build-evidence/export.mts` (new) | Actual client-owned fixture pipeline/exporter, not a mocked worker or shipped plugin |
| `test/build-evidence*.test.ts`, existing Inspect/runner tests, JVM analysis tests | Behavior, security, origin and fallback regressions |
| `bench/build-evidence.mts`, `bench/review-evidence.mts` (new) | Installed-command and actual reviewer-consumption proof, reusing existing trace conventions |

Dependency order: Task 1 → 2 → 3; Task 4 uses the Task 1 types and Task 2 layout; Task 5 uses Task 4; Task 6 joins Tasks 2–5; Task 7 uses Task 6; Task 8 joins tools with lifecycle/audit; Task 9 proves the integrated outcome. Execute sequentially; do not split shared interfaces across concurrent writers.

Native LSP references for `openInspectJava` identify `src/runner/pi.ts` as the production caller. `bench/inspect-java.mts` and `test/inspect-java.test.ts` are known direct callers outside the source-only TS project. Before exported-symbol edits, re-run LSP references including their projects; migrate every caller, no aliases or version shims. Kotlin has no configured native server here: use scoped structural/text discovery for its callsites.

## Shared interface decisions

These names are decisions for implementation, not APIs already shipped:

```ts
// Public signature declarations; implementations and nested wire types belong to the tasks below.
import type { z } from "zod";
export interface BuildEvidenceManifest {
  schema: "leveret.build-evidence/v1";
  repositoryId: string; revision: string;
  producer: BuildProducer; context: BuildContext;
  artifacts: BuildArtifact[]; compilations: BuildCompilation[];
  transformations: BuildTransformation[]; diagnostics: BuildDiagnostic[];
}
export declare const buildEvidenceSchema: z.ZodType<BuildEvidenceManifest>;
export declare function parseBuildEvidence(bytes: Uint8Array): BuildEvidenceManifest;

export type BuildEvidencePin = {
  manifestPath: string; manifestSha256: string; payloadRoot: string;
  expectedContext: { id: string; profiles?: readonly string[]; variant?: BuildVariant };
  select: { moduleDir: string; productionId: string; testId: string | null };
};
export type BuildEvidenceRequest = {
  repo: string; repositoryId: string; revision: string; side: "base" | "head";
  pin: BuildEvidencePin | undefined; runtimeDir: string; signal?: AbortSignal;
};
export declare function admitBuildEvidence(
  request: BuildEvidenceRequest, policy: SecretPolicy,
): Promise<BuildEvidenceAdmission>;

export type SecretPolicy = {
  id: string; available: boolean; knownValues: Set<string>;
  refreshKnownValues: () => Promise<readonly string[]>;
  additionalRules: readonly { id: string; pattern: RegExp }[];
  nonSecretValues: ReadonlySet<string>;
};
export declare function refreshSecretPolicy(policy: SecretPolicy): Promise<void>;
export declare function screenText(text: string, policy: SecretPolicy): ExposureDecision;
export declare function redactAuditText(text: string): string;
export declare function withSecretPolicy<T>(policy: SecretPolicy, run: () => Promise<T>): Promise<T>;
export declare function prepareBuildJavaInputs(
  admission: BuildEvidenceAdmission, config: InspectJavaConfig,
): Promise<BuildJavaDecision>;
export declare function readBuildArtifact(
  admission: BuildEvidenceAdmission, request: BuildArtifactReadRequest, policy: SecretPolicy,
): Promise<BuildArtifactReadReply>;
```

Task 1 defines `BuildProducer`, `BuildContext`, `BuildArtifact`, `BuildCompilation`, `BuildTransformation`, `BuildDiagnostic` and `BuildVariant` directly from the spec, inferring nested types from the strict schemas rather than inventing another field shape. Data result types are defined as follows:

- `ExposureDecision`: `{ state: "available" }` or `{ state: "withheld"; reason: "secret-detected" | "screening-unavailable" }`; never carries matched values.
- `BuildEvidenceAdmission`: a discriminated union `unconfigured | rejected | admitted`. Common fields are side/repository/revision, safe diagnostics and the secret-policy ID. Rejected carries a safe machine-readable reason, no raw manifest. Admitted additionally holds the immutable validated manifest/hash, private frozen artifact index, per-artifact `available | missing | not-produced | withheld | rejected` status and affected compilation IDs. Private roots/bytes never enter the public summary.
- `BuildJavaDecision`: `prepared | fallback | unavailable` per selected role. Prepared carries normalized `PreparedJavaCompilation` records; fallback carries scope/reason only, with legacy inputs resolved independently; unavailable exposes no successful empty fact set.
- `BuildArtifactReadRequest`: `{ manifestSha256, artifactId, range: { startLine, endLine } | null, byteBudget, cursor? }`. The bridge selects the side/admission, never a root supplied by the model.
- `BuildArtifactReadReply`: the existing structured success/error convention, with citation, origin, safe text, effective returned range, lineage and `complete/truncated/nextCursor` delivery. Unsupported or withheld bytes return a structured unavailable reason, not empty success. A header/next line that cannot fit returns `budget-too-small` with required bytes.

Add optional `buildEvidence: { base?: BuildEvidencePin; head?: BuildEvidencePin }` and optional host-only screening rules/nonsecret placeholder values to the existing external, SHA-pinned Java configuration. No new command/path/provider selection surface in the manifest. No export configured means no manifest/payload lookup or secret-policy initialization for this capability. Invalid host configuration/isolation still fails closed; invalid optional export data follows the spec's fallback matrix.

Normalized JVM inputs use `JavaCompilationInput(id, resolutionDomain, sourceSet, files, roots, sourcePath, classpath, compiler, origins)` inside `JavaAnalysisInput(repositoryId, revision, pathRoot, artifactRoot, compilations, skippedFiles, diagnostics, buildIdentity)`. sourceSet is main/test; files are JavaSourceInput records; roots/sourcePath/classpath are ordered frozen paths under the two allowed roots. origins maps verified physical files/binary entries to artifact/source identities.
`JavaSourceInput` is `{ physicalPath, displayPath, encoding, buildArtifact }`, with nullable buildArtifact for legacy inputs. `PreparedJavaCompilation` is the TypeScript JSON representation of JavaCompilationInput, using sandbox-contained path strings and the same compiler/origin fields; Task 6 performs that serialization and Task 4 owns the JVM definition.
`JavaCompilerEnvironment` holds effective source/target/encoding/preview plus verified platform identity and ordered paths. Exported resolution domains are compilation-specific; the cache-only adapter retains its existing conservative shared-module ambiguity semantics. The actual method key remains available as bindingKey; canonical method IDs are length-delimited resolution-domain + binding-key identities, not names/FQNs alone. artifactRoot remains the common containment root for binaries, not an exporter-chosen mount.

## Task 1: Strict wire validation and real client-export fixtures

**Files:** Create `src/build-evidence-contract.ts`, `test/build-evidence-contract.test.ts`, `test/build-evidence-fixture.ts`, `test/fixtures/build-evidence/export.mts`.

**Interfaces:** Produce `buildEvidenceSchema`, `parseBuildEvidence`, wire types and test helper `createBuildFixture(dir: string, mode?: "valid" | "in-place" | "generation-failed" | "template-defect" | "secret-resource"): Promise<BuildFixture>`. `BuildFixture` is `{ repo, base, head, pins: { base, head }, manifests: { base, head }, originalBytes, outputBytes }`: repo is a path string; base/head are commit strings; pins are BuildEvidencePin; manifests are BuildEvidenceManifest; byte collections are ReadonlyMap of artifact ID to Uint8Array. Fixed compilation IDs are `prod` and `test`; modes declare their actual selected artifact IDs. Task 1 also defines `fixtureRequest(f, side, runtimeDir): BuildEvidenceRequest` and a test-only client command with `--repo`, `--revision`, `--output`, `--mode` flags.

- [ ] Write failing strict-parse tests. In particular:

```ts
const f = await createBuildFixture(dir);
const validBytes = Buffer.from(JSON.stringify(f.manifests.head));
// Both duplicates have the same valid value: ordinary JSON.parse alone would accept them.
const topDuplicate = Buffer.from(validBytes.toString().replace(
  '"schema":', '"schema":"leveret.build-evidence/v1","schema":'));
const nestedDuplicate = Buffer.from(validBytes.toString().replace(
  '"id":"prod"', '"id":"prod","id":"prod"'));
expect(() => parseBuildEvidence(topDuplicate)).toThrow(BuildEvidenceInputError);
expect(() => parseBuildEvidence(nestedDuplicate)).toThrow(BuildEvidenceInputError);
expect(parseBuildEvidence(validBytes).compilations[0].moduleDir).toBe(".");
expect(parseBuildEvidence(validBytes).compilations[0].compiler.release)
  .toEqual({ state: "unset", value: null });
```

Also reject escaped duplicate keys (`id`/`\u0069d`), trailing content, invalid UTF-8, unknown/conditional fields, unsafe numeric sizes, duplicate IDs/authored paths, conflicting payload hashes, invalid root membership, bad contexts, source-map IDs outside their input/output sets and inferred precise mappings. Complete-empty paths remain distinct from unknown; referenced upstream output IDs must agree.

- [ ] Run `npm test -- test/build-evidence-contract.test.ts`; observe RED on the missing parser/validation behavior.
- [ ] Implement one duplicate-key-aware decoder: first validate JSON grammar with the standard parser, then walk tokens to detect decoded key duplicates at every object depth before accepting the parsed value; do not use regex to parse JSON. Apply strict Zod conditional schemas and reference-graph validation. Throw `BuildEvidenceInputError(code: "invalid-input", safeReason: string)` without raw values. No new parsing dependency.
- [ ] Implement the fixture exporter as a real, test-owned pipeline command: read pinned originals, generate Java plus filtered resource output, compute hashes/roots/platform fingerprints and publish payload then manifest atomically. It never emits a prewritten success response; modes change actual bytes/outcomes. Exporter execution belongs to the fixture's client stage, not the consumer.
- [ ] Run the same tests GREEN; commit `feat: validate optional build-evidence manifests`.

## Task 2: Git-backed originals and contained immutable artifact admission

**Files:** Create `src/git-objects.ts`, `src/build-artifacts.ts`, `test/build-artifacts.test.ts`; modify `src/inspect-java.ts` to reuse extracted Git readers. Keep the test fixture helper in Task 1 as the only shared fixture owner.

**Interfaces:** Extract existing `gitBytes`, `tree`, `blobs` without changing their semantics, exporting `readGitTree(repo: string, revision: string): Promise<GitTreeEntry[]>` and `readGitBlobs(repo: string, entries: readonly GitTreeEntry[]): Promise<Map<string, Buffer>>` from `src/git-objects.ts`; GitTreeEntry is the current `{ path, oid, mode }` record. Produce `freezeBuildArtifacts(request: BuildEvidenceRequest, manifest: BuildEvidenceManifest): Promise<FrozenBuildArtifacts>`. FrozenBuildArtifacts is `{ available: ReadonlyMap<string, { artifact: BuildArtifact; path: string }>, rejected: readonly ArtifactRejection[], sourceRoots: ReadonlyMap<string, readonly FrozenSourceRoot[]> }`; ArtifactRejection records artifactId, safe reason and affected compilation IDs, and FrozenSourceRoot records rootId, private path and verified member IDs. No public host paths.

- [ ] Write failing tests for in-place transformation and inherited-root attacks:

```ts
const f = await createBuildFixture(dir, "in-place");
const frozen = await freezeBuildArtifacts(fixtureRequest(f, "head", runDir), f.manifests.head);
expect(await readFile(frozen.available.get("pricing-original")!.path))
  .toEqual(Buffer.from(f.originalBytes.get("pricing-original")!));
expect(await readFile(frozen.available.get("pricing-output")!.path))
  .toEqual(Buffer.from(f.outputBytes.get("pricing-output")!));
expect(frozen.available.get("pricing-original")!.artifact.origin).toBe("authored");
expect(frozen.available.get("pricing-output")!.artifact.origin).toBe("materialized");
```

The actual assertions compare both exact byte buffers and IDs, not a helper returning a predetermined boolean. Also reject payload masquerade as authored, nonregular Git modes, actual size/hash mismatch, deleted blobs, ancestor/leaf symlinks, directory special/unlisted members, inconsistent hash claims, case collisions and post-capture changes. A shared bad dependency must affect every referencing scope, including lineage/resource/output references; a safe unrelated artifact remains available. Test 2,001 admitted ordinary artifacts without a default count gate.
- [ ] Run `npm test -- test/build-artifacts.test.ts test/inspect-java.test.ts -t 'artifact|in-place|source|repositories above 2000'` and observe the targeted RED.
- [ ] Implement filesystem reads from a held directory FD on the existing supported Linux host, traversing components with `O_DIRECTORY/O_NOFOLLOW` and leaf files with `O_NOFOLLOW`; do not rely on a realpath-then-open check. Freeze regular bytes into owned private scratch, verify size/hash, and materialize source roots from explicit members. For directories validate the full pinned inventory and reject unlisted members before use. Poll AbortSignal during streaming; cancellation leaves no published complete admission. Never delete input roots or copy whole directories indiscriminately.
- [ ] Run tests GREEN and the existing legacy snapshot regression file once; confirm the extraction of Git helpers introduced no behavior change. Commit `feat: admit immutable build artifacts against pinned Git inputs`.

## Task 3: Consumer secret screening and private import outcomes

**Files:** Create `src/secret-screening.ts`, `src/build-evidence.ts`, `test/build-evidence.test.ts`; modify `src/audit.ts` and its known redaction callers after native LSP reference lookup.

**Interfaces:** Produce `SecretPolicy`, `ExposureDecision`, `refreshSecretPolicy`, `screenText`, `withSecretPolicy`, `admitBuildEvidence` and `buildEvidenceSummary(admission): PublicBuildEvidenceSummary`. The summary carries safe side/revision/context IDs, selection/outcome, manifest hash and per-scope counts/reasons plus generationState/resourceState/compilationState. Those stage states are reported separately and never substitute for inventory/semantic/model coverage. Exclude raw objects, matched secrets, host paths and withheld content hashes.

- [ ] Write failing admission/exposure tests using actual fixture payloads and AuditWriter captures. Configured absent/hash-invalid/wrong-context/schema-invalid manifests reject the entire export and retain safe reasons. Git/filesystem rejection degrades affected scopes only. Test a credential marker in a resource, a diagnostic and metadata ID; none may appear in model-safe replies or persisted audit records. Metadata containing a known secret rejects exposure of that export rather than rewriting identity fields. An unavailable policy withholds text, and a policy refresh finds a newly active marker in formerly readable bytes.

```ts
expect(summary.outcome).toBe("rejected"); // wrong host-pinned context
expect(admission.artifacts.get("secret-resource")!.state).toBe("withheld");
expect(readAllAuditBytes(run)).not.toContain(f.secretMarker);
```

- [ ] Run `npm test -- test/build-evidence.test.ts test/audit.test.ts`; observe RED on those new behaviors.
- [ ] Move the existing `SECRET_TEXT` and `redactAuditText` implementation into `src/secret-screening.ts`, migrating all actual callers rather than adding a re-export alias. Reuse those built-ins for screen/withhold detection; add host-pinned regex rules with stable IDs and exact known values. Use AsyncLocalStorage for the active policy so raw process/tool/error audit sanitization can also remove known values before persistence. Regex checks must reset state; known values are accumulated for the run, not removed on refresh. Explicit client-declared nonsecret placeholders (e.g. a keyless local endpoint's literal key) are excluded by exact value, never inferred from length. No rule is read from the target/export. Screening failure emits only safe codes.
- [ ] Implement the spec failure matrix in `admitBuildEvidence`, keeping typed `BuildEvidenceInputError` separate from invalid host/isolation errors. Do not catch generic worker failures as benign metadata absence. Availability records live beside, not inside, the immutable manifest. Parse/validate selection before any public summary; apply secret policy to text and all metadata/diagnostics before exposing it.
- [ ] Run tests GREEN and commit `feat: screen build evidence before audit and reviewer exposure`.

## Task 4: Explicit compilation environments in the JVM extractor

**Files:** Modify JVM `JavaFacts.kt`, `JavaAnalysisIdentity.kt`, `JavaExtractor.kt`; create `JavaCompilationEnvironment.kt`, `JavaCompilationEnvironmentTest.kt`; update existing extractor/fact-store tests for the normalized constructor without weakening observable assertions.

**Interfaces:** Produce the normalized input records defined above; `JavaCompilationEnvironment.supportProblem(workerPlatform: Map<String,String>): String?`; `JavaOriginIndex.resolve(binding: IMethodBinding, compilationId: String): ResolvedMethodOrigin?`. Preserve current non-recovered binding/signature requirements. A null origin is unresolved, not a name-only match.

- [ ] Add failing real-JDT tests: original `Consumer.java` calls a generated `Pricing.java` in a second source root, and the numeric overload resolves while the string overload is excluded; different root members with identical basenames remain distinct. Explicit main/test encodings and language levels cannot be pooled. A jar with the same binary type name but a different method body/owner must not acquire callers of an unrelated source declaration. Duplicate declarations within an environment stay indeterminate; existing cache-only duplicate-source tests preserve their conservative result.

```kotlin
assertThat(data.references.filter { it.targetId == generatedPrice.id }
    .map { it.location.path }).containsExactly("src/main/java/example/Consumer.java")
assertThat(data.references.single().location.buildArtifact?.artifactId).isEqualTo("consumer-original")
```

The first assertion uses the actual selected numeric target, and the second fixture has exactly one relevant reference by construction.
- [ ] Run `./inspect/gradlew -p inspect :java-analysis:test --tests '*JavaCompilationEnvironmentTest' --tests '*JavaExtractorTest'` and observe RED.
- [ ] Replace hard-coded Batch construction with explicit compilation inputs. Keep the cache-only adapter's existing source-path/classpath semantics; exported inputs use their exact path order, roots, member files and encoding with no injected main-root/classpath union. Source/processor/classpath artifacts are data; no processors loaded. Include every setting, origin, manifest/compilation identity and platform hash in analysis identity. Do not repeat AST walks: collect declaration origins and pending calls during existing visits; resolve them afterward. Use lazily cached ordered binary/source origin lookup against frozen entries, not a new whole-codebase structural fallback engine. Only join a caller to a selected source declaration when its origin is established; shadow/ambiguous origins remain unresolved.
- [ ] Implement explicit supported-environment checks. The initial positive environment is UTF-8, preview disabled, known source/target levels supported by JDT, known-unused JPMS options and a verified platform matching the worker, with release known unset. Explicit verified boot definitions may be consumed only when the real tests prove correct API resolution. Treat any other release/platform/JPMS semantics as `unsupported-exported-environment`, retaining raw artifacts for the reviewer and coherent independent fallback. Do not claim support from option names or version-string equality. Add a control where a newer JDK API would falsely resolve under an older `--release`; it must yield explicit unsupported/unresolved capability, never checked evidence in that claimed environment. Broader platform support is a separate evidence-driven extension, not a stub in this code.
- [ ] Run targeted JVM tests GREEN, then `./inspect/gradlew -p inspect :java-analysis:test`; commit `feat(inspect): analyze explicit frozen compilation environments`.

## Task 5: Artifact-aware fact identities, locations and query scope

**Files:** Modify JVM `JavaFacts.kt`, `JavaFactStore.kt`, `JavaReferences.kt`, existing store/reference tests; modify `src/inspect-java-contract.ts` and add focused TS contract behavior tests within `test/build-evidence.test.ts`.

**Interfaces:** Add nullable `BuildArtifactCitation(manifestSha256, artifactId, origin)` to `Location` as `buildArtifact`. Add `bindingKey` to `JavaMethod`, using canonical resolution-domain IDs consistently. Add `referenceScope: "outside-diff" | "all"` to request/page context, defaulting to outside-diff at the host boundary. Returned references carry `diffStatus: "outside-diff" | "in-diff" | "generated"`; unknown diff classification fails/degrades rather than inventing outside-diff.

- [ ] Write failing transactional/query tests for original and transformed bytes sharing one logical path, generated-only locations, deleted base targets, renamed originals, two compilation variants sharing one binding key, and cursor reuse across different scope/origin selections. Original verified bytes obey the existing half-open hunk rules. Generated evidence is available in `all`, never silently labelled outside-diff or turned into a Git anchor. Mixed-source results remain byte-budget bounded with summary coverage retained.
- [ ] Run `./inspect/gradlew -p inspect :java-analysis:test --tests '*JavaFactStoreTest' --tests '*JavaReferencesTest'`; observe RED.
- [ ] Extend the existing fact/query schema and JSON readers/writers coherently, incrementing the dedicated derived-store stamp from 3 to 4. Do not migrate unrelated state. Use parameterized SQL and existing hash keys. Preserve target-first paging, source/cursor identity and exact UTF-16 ranges. Include query scope in cursor identity. Validate artifact-target origin within its analysis; never resolve an original path by silently substituting transformed bytes.
- [ ] Update all existing result consumers/tests for the intentional contract extension. No compatibility alias or alternate query engine. `referenceReplySchema` remains the single success/error decoder; query locations include nullable buildArtifact even in legacy results. Driver overload checks use bindingKey plus resolved origin/identity, not hard-coded legacy method ID formatting.
- [ ] Run JVM and focused TS tests GREEN; commit `feat(inspect): preserve artifact origins in reference facts and queries`.

## Task 6: Optional per-side import bridge and prepared JVM command

**Files:** Create `src/build-java-inputs.ts`, `test/build-java-inputs.test.ts`; modify `src/inspect-java.ts`, JVM `JavaAnalysisMain.kt`, and `JavaAnalysisMainTest.kt`.

**Interfaces:** Produce `prepareBuildJavaInputs` and `BuildJavaDecision`. Normalize both cache-only and admitted export paths into Task 4 inputs. Keep `openInspectJava(repo, manifest, config, runtimeDir, policy?: SecretPolicy): Promise<InspectJavaBridge>` as the one bridge. Extend its `references` target to a strict union `{path,position}` or `{artifactId,position}`; artifact targets are allowed only in the pinned imported view. Extend bridge with `buildEvidence` per-side admissions/public summaries and `readArtifact(side, request)` for its run. A configured artifact pin cannot select an executable.

- [ ] Write real installed-worker tests: valid exported production context beats a misleading POM/lockfile without running it; a configured wrong/absent export records failure then independently resolves legacy fallback; a base export with head fallback stays isolated; base-over/head-under mismatch is not hidden. Complete metadata remains usable with compilationState not-run. Known unsupported platform or missing required artifact yields the advertised per-scope fallback/unavailable reason without a successful empty list. Poisoned processors/template commands in payload are never executed. Reading an original path after in-place transformation does not return the generated bytes.
- [ ] Run `./inspect/gradlew -p inspect :runtime:installDist && npm test -- test/build-java-inputs.test.ts test/inspect-java.test.ts`; observe the new-path RED.
- [ ] Add optional buildEvidence pins and screening configuration to the existing trusted Java config parser. Reject unsafe host configuration before fallback. Choose and freeze one admission per side and explicit compilation ID. Stage only admitted source members and dependencies into private paths, keeping source map/display identities separate. Do not mount raw payload roots, HOME, credential stores or an extra cache. Fallback resolves its own paths/settings; never splice exported fragments into cache-only inputs.
- [ ] Migrate the internal JSON command to schema 2 with `kind: "analyze"` and a discriminated `input` (`cache-only` or `prepared`), plus the unchanged read-only store/query operation. `cache-only` invokes existing classpath workers and normalizes their output; `prepared` accepts host-generated frozen compilation data and never calls a classpath resolver. Update all commands/tests/bench callers; no v1 shim. Preserve bwrap/prlimit, hash rechecks, atomic publication, cancellation and serialization. Query revalidation checks pinned configuration/original revision plus frozen export identities, not mutated live transformed files.
- [ ] Run tests GREEN and `npm run build`; commit `feat(inspect): prefer validated pipeline inputs with explicit per-scope fallback`.

## Task 7: Reviewer retrieval, lineage and original/generated publication

**Files:** Create `src/build-artifact-reader.ts`, `test/build-artifact-reader.test.ts`; modify `src/runner/pi-tools.ts`, `src/runner/discovery-legs.ts`, `src/runner/verify-output.ts`, `src/app/render.ts`; update their affected behavior tests.

**Interfaces:** Produce `readBuildArtifact`; register read-only `leveret_build_artifact` accepting side plus Task 1 IDs/ranges/budget/cursor. Expose source/resource/template/schema/build-config/report text and safe lineage, never arbitrary paths or binary content. Extend `leveret_java_references` with the Task 6 target union and referenceScope. Add optional `build_citations` to canonical findings/verifier rows; each citation is `{ manifestSha256, artifactId, range }`, and machine validation resolves it against admitted source bytes. No producer instruction becomes a trusted ruling.

- [ ] Write real registered-tool tests for original/template + generated Java + processed resource retrieval, in-place views, multi-page UTF-16 line ranges, invalid/stale cursors, unsupported encoding, secret-policy refresh and a generated-only location with no repo path. Assert exact bytes/locations, not copied allowlists. A nonavailable/binary artifact returns structured error; delivery completeness never becomes semantic completeness.

```ts
expect(original.result.text).toContain("quantity + ${factor}");
expect(generated.result.text).toContain("quantity + 12");
expect(original.result.citation.artifactId).toBe("pricing-template");
expect(generated.result.citation.artifactId).toBe("pricing-output");
```

The fixture contains an actual plus-vs-multiply pricing defect and a natural authored contract; output text is read from admitted files, not mocked echo responses.
- [ ] Run `npm test -- test/build-artifact-reader.test.ts test/discovery-legs.test.ts test/app.test.ts`; observe RED.
- [ ] Implement bounded immutable reads with cursors binding manifest/artifact/hash/policy/range. Refresh and screen before every exposure. Keep supported UTF-8 decoding exact; other encodings are explicitly unavailable until independently supported, never silently transcoded. Return whole lines without splitting a code point and explicit requiredBytes if the next line/header exceeds the budget. Lineage maps are exposed only after ID/range validation; unknown and inferred provenance stay labelled.
- [ ] Register with `annotateEvidence` and all relevant phase allowlists as optional tools. Add current build status and artifact IDs as capability context, not a deterministic defect lead dump. Strictly resolve finding citations; a generated location is never an inline Git path. A finding may use an independently read/verified original as root-cause anchor, or a validated exact map plus verified root-cause reasoning; otherwise publish output evidence with uncertain attribution in the walkthrough. Do not map line numbers from file-only/inferred lineage or deduplicate solely by generator name.
- [ ] Run tests GREEN and commit `feat(review): retrieve original and generated build evidence with truthful anchors`.

## Task 8: Host lifecycle, credentials, audit/cache provenance and prompts

**Files:** Modify `src/runner/pi.ts`, `pi-tools.ts`, `pi-system.ts`, `src/audit.ts`, `src/review-cache.ts`, `agents/review.md`, `agents/verify.md`; test `test/pi-runner.test.ts`, `test/audit.test.ts`, `test/review-cache.test.ts`.

**Interfaces:** Assemble the actual SecretPolicy before imported data/process/tool records. Use public Pi 0.84.2 `ModelRuntime.getAuth(providerOrModel)` (observed AuthResult.auth.apiKey/headers), plus available host credential environment values and host-pinned rules; do not list private credential data through a new store. The known-values refresh callback resolves only active routes under existing host auth/egress policy. Never print auth objects or error values. Attach immutable import decisions/manifest hashes/artifact references and policy IDs to existing capability/tool/policy/cache provenance.

- [ ] Write failing real-runner/resource-loader tests: no buildEvidence config does not touch a payload path or change non-Java behavior; configured import errors are visible and do not widen resources; raw process/tool error output with a known credential is sanitized before audit; refreshed auth values cannot leak into cached artifact reads/native sessions. Cache keys change with an exported compiler/source-root/artifact or secret-policy change; output formatting alone is not a semantic cache identity. Build text cannot become a host skill/MCP config or learning record.
- [ ] Run `npm test -- test/pi-runner.test.ts test/audit.test.ts test/review-cache.test.ts`; observe RED.
- [ ] Initialize active secret policy from trusted settings before admission/JVM/probe capture, refreshing known values before tool exposure. Reuse the same active policy in audit sanitization and fallback content paths; do not sanitize only after the recorder captured raw output. Keep matched values only in memory. Unsupported auth resolution means unavailable screening, not a fabricated empty secret set. Preserve explicit keyless local providers through host-declared nonsecret placeholders.
- [ ] Pass one bridge/admission through existing runner lifecycle; close owned readers/scratch on success, cancellation and failure. Add build summaries and citations to normal structured outputs, not another logging subsystem. Include new module sources, decoder/schema, JVM distribution, manifest/compilation/artifact identities in tool/cache provenance. Update system prompt/leg versions once and teach choice of originals vs generated data, query scope, lineage/freshness limits, fallback and gaps. Do not lower frozen thresholds or auto-learn from build output.
- [ ] Run tests GREEN; commit `feat(review): carry pipeline evidence provenance through lifecycle and publication`.

## Task 9: End-to-end client command and actual model consumption

**Files:** Create `bench/build-evidence.mts`, `bench/review-evidence.mts`, `test/build-evidence-bench.test.ts`; modify `bench/inspect-java.mts`, `test/inspect-java-bench.test.ts`, `package.json`, `inspect/README.md`, `docs/app.md`; write `docs/reports/2026-10-04-build-evidence-integration.md` only after real execution, with its actual observed run date and evidence.

**Interfaces:** Share existing RunnerEvent payload/checksum reading and submitted-record evidence-use checks in `bench/review-evidence.mts`, migrating the old Java driver/tests with no alias exports. `verifyBuildEvidenceConsumption(traceDir: string, expected: BuildConsumptionExpectation): Promise<BuildConsumptionVerdict>` requires actual successful tool events and subsequent submitted-record citations of originals and generated evidence, plus an honest generation/lineage gap. BuildConsumptionExpectation is `{ side, manifestSha256, originalArtifactId, generatedArtifactId, originalPath, requireGap }`, with string IDs/hash/path, side base/head and boolean requireGap. BuildConsumptionVerdict is `{ status: "verified" | "unverified", originalRetrieved, generatedRetrieved, submittedUse, gapDisclosed, toolCallIds }`, booleans plus a string array. No title/word matching alone or thinking-only citation.

- [ ] Write failing driver/regression tests. Swapped manifest/side, only one view consumed, citation in an unrelated record, unknown lineage presented as precise and a rejected export scored as complete must fail. Run `npm test -- test/inspect-java-bench.test.ts test/build-evidence-bench.test.ts`; expect RED for missing verification logic or acceptance of those invalid traces.
- [ ] Implement the complete driver and add `"bench:build-evidence": "tsx bench/build-evidence.mts"` to package scripts, using the real fixture client command outside the analysis worker. Freeze original/generated hashes and revision pins before review. Cases are supported valid generation, in-place template defect, missing output, unsupported compiler context, hostile source map and secret resource. A configured report comparison uses the same frozen inputs with and without export, keeping models/prompts/scoring declared; no claim of general parity.
- [ ] Run integrated verification once after all mutations; expect GREEN for the full suites and deterministic cases, not merely successful startup:

```sh
npm run build
npm test
./inspect/gradlew -p inspect :runtime:installDist
npm run test:inspect
npx tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck --strict bench/build-evidence.mts
```

Then run the implemented deterministic driver and its real-review mode against outside-checkout pinned configs; exact CLI flags are fixed in this task as `--mode deterministic|review --config <file> --config-sha256 <sha> --output <new-dir>`, reusing the existing Java benchmark driver convention. Review mode requires `LEVERET_PAID_MODEL_APPROVED=1` (already authorized) and declares `LEVERET_RUNNER_PROVIDER`, `LEVERET_RUNNER_MODEL`, `LEVERET_RUNNER_EFFORT` and `LEVERET_PI_AGENT_DIR`. Use configured Grok/Gemini Flash/Z.ai Flash, not the orchestrator's quota.
- [ ] Observe the running installed worker and real reviewer: both original and generated views retrieved/cited in submitted findings/coverage, exact supported caller evidence, explicit missing/uncertain lineage and no secret marker in model-visible/private-audit/publication bytes. A scripted session cannot pass. Do not call the feature complete on schema tests or persisted facts alone.
- [ ] Update docs with only exercised commands, supported compiler/platform/encoding subsets, the client command handoff, optional fallback and realistic privacy claims. No hypothetical Maven/Gradle plugin is presented as shipped. Record exact revision/config/artifact hashes and model identities, remove temporary scaffolding, commit `test: prove optional pipeline evidence improves real review consumption`.

## Self-review and approval gate

Before handing this plan to an executor, check:

1. Every spec section has an owning task: wire/selection (1, 3, 6), storage/originals/directories (2), secrecy (3, 7, 8), environments/platform (4, 6), facts/citations/maps (5, 7), fallback/coverage/lifecycle (6, 8), real outcome (9).
2. Every future symbol named above has a producing task and matching consumers. Keep sourceRoots/platform clarifications synchronized with the validator, fixture exporter and both JVM input branches.
3. Review Focus controls are in their owning task; existing decoder/overload/duplicate/hunk/paging/processor-isolation regressions remain, not replaced with incidental default assertions.
4. No independent producer implementation or new service is smuggled into this consumer plan. Plugin projects, wider language/JPMS/release support and automatic target-build execution are not implicit deliverables.
5. No stubs/empty fallback analysis or mocked review “proof”. Complete client-command ingestion and actual model use are mandatory, with supported-scope limitations stated rather than hidden.

Recommended execution is **native sequential implementation**, followed by one independent condensed whole-branch adversarial review, normal PR checks/bot availability checks and review handling. The tasks share strongly coupled source/fact/citation identities; sequential ownership avoids conflicting adapters. Paid verification is already authorized, but implementation starts only after approval of this plan, its spec clarifications and the execution method.
