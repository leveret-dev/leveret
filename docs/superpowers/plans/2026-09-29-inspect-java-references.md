# Java Reference Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a real Leveret review retrieve checked Java method references outside its pinned diff, with honest coverage and analysis identity.

**Architecture:** Add one `java-analysis` JVM module alongside the existing classpath and persistence modules. A bounded, short-lived internal command resolves classpaths, extracts JDT facts, and persists or queries an analysis; a TypeScript bridge supplies verified snapshots and exposes the result to the existing reviewer. Keep the model/provider process outside the extraction sandbox.

**Tech Stack:** Existing TypeScript/Zod/TypeBox/Vitest and Kotlin 2.4.0/JDK 25+/JUnit/AssertJ/H2; Eclipse JDT Core 3.46.0; Gson 2.13.2 for JVM JSON; Linux Bubblewrap and util-linux `prlimit` for the initial enforced worker boundary.

**Spec:** [Approved Java references specification](../specs/2026-09-29-inspect-java-references-design.md).

**Status (2026-10-02):** Delivered in [Java reference evidence for reviews](https://github.com/leveret-dev/leveret/pull/78), including actual model consumption. See the [evaluation report](../../reports/2026-09-29-inspect-java-references.md) for exercised behavior and limits. The task checkboxes below preserve the original plan, not a new backlog; do not recreate its retired branch or worktree. General review-quality/parity evaluation remains separate.

**Current direction:** Leveret runs on client infrastructure. Prioritize useful findings, independent verification, honest coverage and actionable reports. Arbitrary file-count caps are not the default product policy; [client-controlled Java limits](https://github.com/leveret-dev/leveret/pull/80) is open, not yet merged. Context/transport and worker safety bounds are not repository-size quotas. Own-tool paid/local evaluations are pre-authorized; use Grok, Gemini Flash or Z.ai Flash without changing pinned models in formal comparisons.

## Global Constraints

- “Leveret is the product. Inspect is its inspection and information-extraction module, supplying evidence rather than review judgments.”
- “The initial scope is one Java module, including production and test source roots, using supported cache-only classpath inputs.”
- “Paths are repository-relative. Positions use one-based lines and zero-based UTF-16 columns; ranges have exclusive ends.”
- “JDT binding recovery is not authority.” Neither ambiguous candidates nor method-reference expressions become asserted call edges.
- “A dirty or mismatched checkout cannot be labeled as the requested revision.” Identity includes source contents, configuration, producer/JDK, and ordered artifact hashes.
- “PR-head facts remain separate from accepted-base facts and cannot overwrite them.” Publish only finalized analyses, in one transaction.
- “The worker has an enforced memory cap and deadline, no analysis credentials, and no network access during extraction.” No target builds, generators, processors, package managers, or tests.
- “Complete delivery does not imply complete analysis.” Preserve summary coverage on every page; zero checked references is not proof of safety.
- Reuse existing classpath workers, H2, `ChangeManifest`, tool evidence IDs, audit capture, and phase selection. Do not add a graph service, fallback resolver, or new product lifecycle.
- A scripted query alone does not satisfy real-review consumption. Own-tool paid/local evaluation is pre-authorized by the maintainer's standing policy; the historical per-run approval requirements below are superseded. Historical private research stays private.

## Review Focus

1. Recovery hidden in argument/signature types can select the wrong overload despite `method.isRecovered == false` — Task 2 tests missing receiver/argument types and nested generic bounds.
2. Main/test classpath contamination can validate an impossible production call — Tasks 1–2 test separate scopes and a dependency available only to tests.
3. Source/artifact changes during preparation can manufacture a valid-looking identity — Task 4 freezes inputs and tests changed contents at identical paths, symlink escapes, and dirty unchanged files.
4. Base/head path changes and half-open Unicode ranges can filter the wrong caller — Task 3 tests rename, deletion, CRLF, supplementary characters, and zero-line hunks.
5. Delivery limits, cancellation, or concurrent query launches can lose evidence or expose half-written state — Tasks 3–5 test page equivalence, scope-bound cursors, publication rollback, process cleanup, and serialized H2 access.

## Existing seams and file map

Current implementation facts that constrain this plan:

- `CacheOnlyClasspathWorker.analyze(pom, localRepository)` and `GradleLockfileClasspathWorker.analyze(projectDir, localRepository)` return `ClasspathAnalysis`, but some missing artifacts throw. Extraction needs a structured partial result, not a catch-all empty classpath.
- `DbSession.batch()` commits batches internally. It cannot implement atomic analysis publication. Use `prepare()`/JDBC batches and one explicit `commit()` instead.
- `validateChangeManifestCheckout()` checks commit identities, not every source byte. The new snapshot boundary must validate unchanged analyzed files too.
- `runStreaming()` has bounded output and TERM/KILL escalation. `safeChildEnvironment()` removes credential variables but retains HOME/XDG paths; environment filtering alone is not filesystem isolation.
- `buildPiTools()` annotates tools with evidence IDs. Specialized discovery and the verifier use explicit allowlists in `discovery-legs.ts`; registering a tool alone will not reach those phases.
- Runtime `App.main` currently only accepts configuration startup. Keep that behavior and add one internal `java` command branch without invoking startup temp-directory clearing for worker commands.

Planned ownership (paths below are new unless marked existing):

| Area | Files and responsibility |
| --- | --- |
| Partial classpaths | Existing `inspect/java-classpath/src/main/kotlin/com/leveret/inspect/classpath/{ClasspathAnalysis,CacheOnlyClasspathWorker,GradleLockfileClasspathWorker}.kt`; preserve selected artifacts and explain missing inputs |
| Java facts | `inspect/java-analysis/src/main/kotlin/com/leveret/inspect/java/{JavaFacts,JavaExtractor,JavaAnalysisIdentity}.kt`; records, JDT visitor, verified analysis identity |
| Store/query/command | Same package: `{JavaFactStore,JavaReferences,JavaAnalysisMain}.kt`; transactional H2, exact-method queries, strict command JSON |
| Host bridge | `src/inspect-java.ts`; trusted configuration, immutable snapshot preparation, sandbox launcher, serialized command lifecycle |
| Owning TS wire boundary | `src/inspect-java-contract.ts`; strict Zod request/result schemas, inferred types, and error codes |
| Reviewer integration | Existing `src/runner/{pi,pi-tools,pi-system,discovery-legs}.ts` and `agents/review.md`; lifecycle, active tool, evidence guidance and provenance |
| Build and usage | New `inspect/java-analysis/build.gradle.kts`; existing `inspect/{settings.gradle.kts,gradle/libs.versions.toml,runtime/build.gradle.kts,README.md}` and runtime `App.kt`; package the command and document requirements |
| Validation | New Kotlin tests beside the new module; existing classpath tests; new `test/inspect-java.test.ts`, existing runner tests; `bench/inspect-java.mts` for explicit, opt-in acceptance/evaluation |

Do not split these into generic producer, transport, worker, or graph frameworks.
Before changing an exported symbol during execution, use native LSP references to
migrate every caller. Paths and symbols above were inspected during planning;
re-read their current state before editing.

Execution preflight: use `npm ci` for the locked Node dependencies and the
existing Gradle wrapper for JVM dependencies. Confirm JDK 25+, Bubblewrap,
`prlimit`, and the documented oracle prerequisites before the first RED/GREEN
cycle. Dependency setup builds Leveret, never the repository being inspected.

## Shared interface decisions

These are internal contracts, not a universal query API. Kotlin owns production
facts; TypeScript validates the subprocess boundary. Use matching field names,
not a schema generator or a second public schema family.

- `Position { line: number; column: number }`, `Range { start: Position; end: Position }`, and `Location { path: string; range: Range }` follow the spec's coordinate convention.
- `JavaMethod { id, signature, location, nameRange: Range, sourceSet: "main" | "test" }`; a target selector is `{ path, position }` pointing inside the declaration's name token, so nested methods cannot make a body-position selector ambiguous. Store `nameRange` alongside the full declaration range for later lookup.
- `JavaReference { id, targetId, location, enclosing: JavaMethod | null, sourceSet, kind: "call" | "method-reference", basis: "checked" }`.
- `UnresolvedSite { id, location, sourceSet, reason, candidates: Array<{ targetId, basis }> | null }`; `null` means candidates are unknown, not proven absent. Do not invent candidates from spelling.
- `AnalysisSummary { analysisId, repositoryId, revision, configurationSha256, coverage }`. Coverage has `complete`, main/test examined/skipped/unresolved counts, and a diagnostic count. Exact file/diagnostic details are paged records.
- `AnalysisData { summary, methods, references, unresolved, files, diagnostics }`. `files` records path, source set and examined/skipped disposition with reasons. Lists are produced once; avoid repeated AST walks or intermediate whole-corpus copies.
- `ReferenceRequest { analysisId, configurationSha256, manifest: ChangeManifest, side: "base" | "head", target: { path, position }, byteBudget, cursor? }`; the bridge supplies the expected configuration digest from its pinned summary.
- `ReferencePage { summary, target: JavaMethod, side, items, delivery: { complete, truncated, omittedRecords, nextCursor } }`. `items` is a tagged union of checked reference, unresolved site, file coverage, and diagnostic records. This allows the coverage header to remain bounded without discarding detailed coverage.
- `InspectError { code, message, requiredBytes?: number }`; boundary replies are `{ ok: true, result } | { ok: false, error: InspectError }`. Codes: `invalid-input`, `snapshot-mismatch`, `configuration-mismatch`, `target-missing`, `target-indeterminate`, `analysis-unavailable`, `invalid-cursor`, `worker-failed`, `resource-exhausted`, `budget-too-small`. `requiredBytes` is present only for a budget error. All failures use this shape, never a success-shaped empty result.

JVM exceptions are `InspectException(code: String, message: String)` and are
converted once by the command boundary. Strictly validate required fields,
finite integer ranges, path containment, schema versions, and identity matches.
Do not use Gson reflective deserialization to bypass Kotlin constructors or
non-null validation; use its JSON tree/stream API with explicit validation.

## Task 1: Preserve usable classpaths when dependencies are missing

**Files:** Modify the three existing classpath source files above, their existing
`CacheOnlyClasspathWorkerTest.kt` and `GradleLockfileClasspathWorkerTest.kt`, and
`inspect/gradle/libs.versions.toml` / `java-classpath/build.gradle.kts` for the
shared Gson JSON dependency. Update their embedded `WorkerMain`/oracle callers
only where the changed result contract requires it.

**Interfaces:** Keep both existing `analyze(...): ClasspathAnalysis` signatures.
Replace `missClasses` with `diagnostics: List<ClasspathDiagnostic>` where each
record has `sourceSet: String?`, `reason: String`, `coordinate: String?`, and
`message: String`. `ClasspathAnalysis` retains resolver tuple, profiles, policy,
ordered main/test paths, and test roots; `complete` is false when resolution has
a gap. Keep `write(): String` and `read(text: String): ClasspathAnalysis`, moving
their internal payload to strict versioned JSON and migrating every caller.

- [ ] Write regression cases in the existing test files: remove one of two cached artifacts; assert the surviving path remains in its original scope/order, the absent coordinate is reported, and `complete == false`. Retain exact classpath oracle comparisons for healthy input. Test missing parent/POM metadata separately from a missing JAR; malformed/unbounded versions remain explicit errors.

  In test `missing artifact preserves the other compile entry`, with only
  `t:present:1` cached and `t:absent:1` missing:
  ```kotlin
  assertThat(analysis.mainClasspath).containsExactly("t/present/1/present-1.jar")
  assertThat(analysis.diagnostics.map { it.coordinate }).contains("t:absent:1")
  assertThat(analysis.complete).isFalse()
  ```
- [ ] Run the two classpath test classes and observe the missing-artifact assertions fail against the existing throwing behavior: `./inspect/gradlew -p inspect :java-classpath:test --tests '*CacheOnlyClasspathWorkerTest' --tests '*GradleLockfileClasspathWorkerTest'`.
- [ ] Change the shared resolution paths, not the new consumer: preserve successful results exposed by Maven Resolver collection/resolution exceptions and annotate incomplete scopes. If model/collection failure prevents determining a classpath, report that whole scope as unknown; never claim the remaining list is complete. Gradle lockfile resolution reports missing entries individually while preserving other locked entries. Missing dependency inputs are data; unexpected parser/programming failures are not swallowed.
- [ ] Run the same command to GREEN; use an isolated dependency cache to exercise the real `WorkerMain` output with one missing artifact. Its JSON must distinguish incomplete resolution from an empty healthy classpath. Oracle provisioning may execute fixture builds only in the existing test-oracle boundary, never in the production worker.
- [ ] Commit the partial-result behavior and updated consumers as one change: `feat(inspect): preserve partial classpath evidence`.

## Task 2: Extract checked Java method references with JDT

**Files:** Create `java-analysis/build.gradle.kts`, `JavaFacts.kt`,
`JavaExtractor.kt`, `JavaAnalysisIdentity.kt`, and
`inspect/java-analysis/src/test/kotlin/com/leveret/inspect/java/JavaExtractorTest.kt`.
Modify `settings.gradle.kts` and `libs.versions.toml`. The module depends on
`:java-classpath`, `:persistence`, JDT 3.46.0 and Gson 2.13.2, with existing test
libraries and JVM 25 compilation settings.

**Interfaces:**
- `JavaExtractor.extract(input: JavaAnalysisInput): AnalysisData`.
- `JavaAnalysisInput` contains repository/revision, frozen source root, source-file hashes/root assignments, explicit Java level, resolved classpath result, frozen artifact paths/hashes, extractor/JDK identities, and effective configuration.
- `JavaAnalysisIdentity.compute(input: JavaAnalysisInput): AnalysisIdentity`, where `AnalysisIdentity` carries `analysisId` and `configurationSha256`. Hash a deterministic ordered representation owned by this module; TypeScript consumes the identity instead of reimplementing its canonicalization.

- [ ] Add the spec's two-file fixture with exact location assertions. Assert only the numeric invocation targets `price(int)`; the string invocation targets a different declaration. Add method references, `super` calls, initializers, nested/local classes, generics/varargs, CRLF and supplementary-Unicode cases. Verify enclosing attribution never crosses into an outer callable through a nested class or treats a deferred lambda body as its creator's invocation.
- [ ] Add negative cases: missing receiver/argument/parameter type, ambiguous `null` overload, malformed invocation, a dependency available only on the test classpath, and duplicate declaration identities. Assert suspect sites are unresolved and unrelated checked calls survive. Run `./inspect/gradlew -p inspect :java-analysis:test --tests '*JavaExtractorTest'` and record RED.

  In test `numeric overload retains the unchanged test call`, select the method
  declared at line 3 of `Pricing.java` and inspect only references to its ID:
  ```kotlin
  assertThat(numericReferences.map { it.location.range })
      .containsExactly(Range(Position(3, 27), Position(3, 43)))
  assertThat(numericReferences.map { it.sourceSet }).containsExactly("test")
  assertThat(numericReferences.map { it.basis }).containsExactly("checked")
  ```
- [ ] Implement batch `ASTParser.createASTs` extraction, with separate main and test environments. Main sees main roots/classpath; tests see main plus test roots and the test classpath. Collect facts only for the current batch's requested files, avoiding duplicate main facts. Set compiler options explicitly; disable binding recovery for the authoritative pass, retain syntax diagnostics, and check binding/signature/receiver/argument identity plus relevant compiler errors before emitting `checked`. Normalize generic uses with `getMethodDeclaration()` and map declaration keys to source locations. Traverse supported method invocation/reference nodes once; do not construct edges from identifier matching. Leave lambda sites without a falsely attributed enclosing source method if no proper callable identity is available.
- [ ] Compute analysis identity from actual frozen contents, source assignments, resolver configuration, ordered artifact hashes, all extractor distribution JAR hashes, and the worker JDK's executable/release/module identities. Record the actual boot-library JDK separately from source language level; unsupported release/preview configuration is explicit, never silently downgraded. Reject inconsistent identities. Use bounded worker memory rather than retaining ASTs after each file's facts are collected.
- [ ] Run the targeted suite to GREEN and invoke `JavaExtractor.extract` on the real fixture through a throwaway JVM harness. Check exact target/range/basis output, not only counts. Update `inspect/README.md` with the added module and precise supported scope after this smoke passes; commit as `feat(inspect): extract checked Java method references`.

## Task 3: Publish immutable analyses and query outside-diff references

**Files:** Create `JavaFactStore.kt`, `JavaReferences.kt`,
`JavaFactStoreTest.kt`, and `JavaReferencesTest.kt` in the new module's main/test
package. Create `src/inspect-java-contract.ts` for Zod schemas/type exports and
consumer-visible failures; exercise it through the real boundary in Tasks 4–5.

**Interfaces:**
- `JavaFactStore(sessions: SessionFactory)` with `publish(data: AnalysisData): AnalysisSummary`, `summary(analysisId: String): AnalysisSummary`, `methodAt(analysisId: String, path: String, position: Position): JavaMethod`, and `query(request: ReferenceRequest): ReferencePage`. Query directly with indexed SQL and bounded JDBC iteration; do not deserialize a whole analysis for each page.
- `JavaReferences` owns pure helpers `outsideDiff(location: Location, manifest: ChangeManifest, side: String): Boolean` and `page(records: Iterator<DetailRecord>, context: PageContext, byteBudget: Int, cursor: String?): ReferencePage`. `DetailRecord` is the shared tagged item union; `PageContext` holds summary, target, side, manifest digest and total query-record count. `JavaFactStore.query` owns the session lifetime and calls these helpers before closing its JDBC resources.
- TS exports the shared types above and `referenceReplySchema`; the wire manifest is the existing `ChangeManifest` shape, not a renamed diff model.

- [ ] Add transactional tests using the existing embedded H2 setup pattern. Publish base A and head B, then fail a write before commit: reopening must expose A and B unchanged and no failed analysis. Conflicting content for an existing analysis ID is rejected. Add query tests for a deleted method selected on base, wrong revision/configuration, name-token ambiguity, rename paths, unchanged lines in changed files, zero-line hunks, exclusive ends, and an incomplete manifest. Assert exact returned reference IDs/locations.
- [ ] Add pagination tests: concatenating all pages yields the same ordered records as the unbounded fixture expectation with no loss/duplicates. Bind cursors to analysis, manifest digest, target and side; reject changed identities, invalid offsets, negative/nonfinite budgets and malformed cursors. Incomplete coverage must remain false on the last page even when delivery becomes complete. Run `./inspect/gradlew -p inspect :java-analysis:test --tests '*JavaFactStoreTest' --tests '*JavaReferencesTest'` and record RED.

  In test `last page does not erase unresolved coverage`:
  ```kotlin
  assertThat(allPageReferenceIds).containsExactlyElementsOf(expectedReferenceIds)
  assertThat(lastPage.delivery.complete).isTrue()
  assertThat(lastPage.delivery.nextCursor).isNull()
  assertThat(lastPage.summary.coverage.complete).isFalse()
  ```
- [ ] Own a small hand-written schema in `JavaFactStore.kt`: analyses, methods, references, unresolved sites, and coverage records, all keyed by analysis ID. Reuse `Database`, `SessionFactory`, and `Schema.ensure`; use a dedicated derived-facts database so a schema rebuild cannot wipe unrelated state. Publish with one transaction using JDBC batching without `DbSession.batch()`'s intermediate commits. Store completed-with-gaps analyses; never finalize interrupted extraction. Deterministic row ordering and indexed `(analysis_id, target_id)` queries replace general graph traversal.
- [ ] Implement target selection, mismatch checks, and the spec's hunk intersection algorithm. Unresolved sites remain scope-wide, not attributed to the queried target. Match name-token position exactly; return the full declaration range. Page tagged detail records with a fixed summary. Accept positive integer budgets up to 262,144 bytes, defaulting to 65,536 bytes; never split a JSON record. If the header or next record cannot fit, return `budget-too-small` with `requiredBytes` instead of an empty non-advancing cursor. If required bytes exceed the maximum, report that explicit delivery limitation; do not silently clip evidence. Delivery counts refer to this query's records, not claimed total runtime callers.
- [ ] Run the targeted suites to GREEN. Smoke: extract the fixture, publish, close/reopen H2, query both sides and page through unresolved details; an attempted stale query must fail. Commit as `feat(inspect): query revision-bound Java reference facts`.

## Task 4: Connect verified snapshots to the bounded JVM command

**Files:** Create `JavaAnalysisMain.kt`, `JavaAnalysisMainTest.kt`,
`src/inspect-java.ts`, and `test/inspect-java.test.ts`. Modify existing runtime
`App.kt`, `runtime/build.gradle.kts`, its `DistributionTest.kt`, and
`inspect/README.md`. Do not change global `runStreaming` semantics.

**Interfaces:**
- `JavaAnalysisMain.execute(args: Array<String>): Int`; `leveret-inspect java --request <absolute-file>` accepts one strict JSON command (`analyze` or `references`), emits one JSON reply on stdout, and sends logs only to stderr. Runtime dispatch happens before normal `App` startup; existing no-subcommand behavior remains intact.
- `loadInspectJavaConfig(repo: string, path: string, sha256: string): Promise<InspectJavaConfig>`.
- `openInspectJava(repo: string, manifest: ChangeManifest, config: InspectJavaConfig, runtimeDir: string): Promise<InspectJavaBridge>`.
- `InspectJavaBridge` exposes `summaries: { base: AnalysisSummary; head: AnalysisSummary }`, `references(request: ReferenceRequest): Promise<ReferencePage>`, and `close(): Promise<void>`; failures throw `InspectJavaError extends Error` with `code` and optional `requiredBytes` from `InspectError`.
- Config pins repository identity, installed distribution/JDK paths and hashes, operator cache location, selected module, per-side source roots and language configuration, and worker limits. Load it only from a hash-pinned file outside the reviewed checkout, through paired `LEVERET_INSPECT_JAVA_CONFIG` / `LEVERET_INSPECT_JAVA_CONFIG_SHA256` environment variables. The model never chooses executables, cache paths, mounts, JVM options, or worker limits.

- [ ] Write boundary tests with a real temporary Git repository and installed JVM distribution. Change an unchanged source file without changing HEAD; replace an artifact at the same path; add an escaping source/cache symlink; request a source root outside the checkout. Assert rejection or explicit skipped coverage as appropriate, never success under the old identity. Test base/head identity isolation and malformed JSON with missing/null required values.
- [ ] Write enforcement tests using a test-only worker in the same launcher: attempt network access, read a sentinel in host HOME, expose provider/GitHub/JVM-option environment variables, allocate past memory limits, and ignore TERM until the hard deadline. Assert denial/termination and no finalized store entry. A poisoned POM extension/Gradle script/annotation processor must not execute. Run `npm test -- test/inspect-java.test.ts` plus `./inspect/gradlew -p inspect :java-analysis:test --tests '*JavaAnalysisMainTest' :runtime:test --tests '*DistributionTest'` and record RED.

  In test `dirty unchanged source cannot reuse head analysis`:
  ```typescript
  await expect(openInspectJava(repo, manifest, config, runtimeDir))
    .rejects.toMatchObject({ code: "snapshot-mismatch" });
  ```
- [ ] Prepare private per-run snapshots from Git objects, not `checkout` hooks, filters, submodules, or target scripts. Validate the live head against all analyzed source/build metadata and reject dirty/untracked Java inputs rather than labeling them as the commit. Batch Git object reads and reject unsafe paths, nonregular files, invalid UTF-8 and conflicting roots. Read base from its pinned objects without switching the user's checkout. Include source/build metadata necessary for existing workers; disclose Java files/modules outside supported roots. Do not copy `.git`, credential stores or target executables into the analysis namespace.
- [ ] Implement the command pipeline: resolve from the configured bare artifact cache, freeze selected artifacts into per-run scratch with verified hashes, extract, and publish. Missing resolution still uses the explicitly supplied roots/language with incomplete coverage. Store H2 outside the target and serialize commands on each bridge to respect embedded H2 ownership. Keep base/head summaries separate; query only the configured identities. Recheck expected snapshot/configuration identity on bridge calls; do not select the latest stored analysis implicitly.
- [ ] Launch via trusted `prlimit` and `bwrap`, reusing `runStreaming` for output limits and timeout reporting. Initial supported host: Linux x86-64 with these tools and a usable namespace facility; unavailable enforcement fails closed. Use a private PID/network/mount namespace, `--die-with-parent`, `--new-session`, cleared environment, empty HOME/XDG/temp, read-only source/toolchain/cache mounts, and only per-run scratch/store writable. Never copy the oracle harness's `--ro-bind / /`. Do not expose host `/proc`, home, credential sockets, or the provider process; use namespace-local `/proc` and minimal devices.
- [ ] Enforce separate limits: default JVM heap 1,073,741,824 bytes; virtual address-space soft and hard limit 8,589,934,592 bytes; deadline 180,000 ms; stdout/stderr capture at most 8,388,608 bytes each. The address-space limit covers native reservations too and is not an RSS promise. Set metaspace to 268,435,456 bytes, direct buffers and reserved code cache to 134,217,728 bytes each; verify the selected JVM starts within these limits. Validate positive trusted overrides. Pass no inherited `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `JDK_JAVA_OPTIONS` or provider variables. Use the private PID namespace plus hard termination to leave no worker descendants; ensure `close()` drains/cancels active work before removing only owned scratch state.
- [ ] Run the boundary/enforcement tests to GREEN and smoke the installed `leveret-inspect java` executable through this exact sandbox, not an in-process substitute. Document installation/configuration and supported-host failures. Commit as `feat(inspect): run Java analysis through an isolated internal command`.

## Task 5: Make reviewer and verifier consume the evidence

**Files:** Modify `src/runner/pi.ts`, `pi-tools.ts`, `pi-system.ts`,
`discovery-legs.ts`, `agents/review.md`, `test/pi-runner.test.ts`, and
`test/discovery-legs.test.ts`; extend `test/inspect-java.test.ts` for the real
registered-tool query. No public MCP-server expansion is needed for this slice.

**Interfaces:** Add `inspectJava?: InspectJavaBridge` to `PiToolsOptions` and an
explicit availability/analysis-summary entry to bundle capabilities. Register
`leveret_java_references` with `{ side, target: { path, position }, byteBudget?,
cursor? }`; the host supplies its pinned manifest and selected analysis ID to
`bridge.references`. The tool cannot analyze arbitrary repositories or replace
trusted configuration. Existing `annotateEvidence` attaches its evidence ID.

- [ ] Test the tool against a real extracted fixture: numeric caller included, other overload excluded, missing dependency disclosed, base deletion query preserved. Test phase selection by invoking the registered tool from single discovery, specialized discovery, and verifier selections rather than asserting copied allowlist text. Confirm unavailable configuration is surfaced honestly and unrelated non-Java reviews retain their existing tool behavior. Run `npm test -- test/inspect-java.test.ts test/pi-runner.test.ts test/discovery-legs.test.ts` and record RED.

  In test `reviewer tool returns checked test caller evidence`, decode the actual
  registered tool response, including its success/error envelope:
  ```typescript
  expect(reply.ok).toBe(true);
  expect(referenceItems.map(item => item.location.path))
    .toEqual(["src/test/java/example/PricingTest.java"]);
  expect(referenceItems.map(item => item.kind)).toEqual(["call"]);
  expect(reply.result.summary.coverage.complete).toBe(true);
  ```
- [ ] Open one bridge after manifest/trusted-state preparation when host configuration is supplied; attach compact base/head identity and coverage summaries to discovery and verifier context. Register the tool for all relevant specialized legs and the targeted verifier. Convert typed bridge errors back to the shared structured error envelope at the tool boundary. No configuration means explicitly unavailable, not a silently successful empty analyzer. Configured failures carry their structured reason and cannot be hidden behind a structural result labeled checked. Close the bridge from the runner's existing `finally` path, including initialization failures before bundle creation.
- [ ] Update shared system guidance and `agents/review.md` to use the exact-method tool for supported Java questions, distinguish call from method-reference evidence, follow delivery cursors, disclose coverage, and retain cheap existing tools for other questions. Bump the shared prompt version and affected leg-definition versions. Do not demand fabricated findings; a no-defect review can still demonstrate evidence consumption.
- [ ] Include bridge implementation/distribution/configuration and analysis identities in runner tool/policy provenance and any review reuse key that depends on this evidence. In particular, hashing only `pi-tools.ts` is not enough when the bridge changes. Reuse existing audit tool result capture and evidence IDs; do not add a telemetry subsystem or mix references into deterministic finding leads. Record unavailable capability status too.
- [ ] Run the targeted tests to GREEN. Through actual `buildPiTools`, invoke the tool, retrieve the cited caller source, and inspect captured evidence IDs and unresolved coverage. This proves tool integration, not model use. Commit as `feat(review): consume Inspect Java reference evidence`.

## Task 6: Demonstrate the complete outcome and record measured limits

**Files:** Create `bench/inspect-java.mts`; update `inspect/README.md` and the
root README's current no-integration statement only after the integration works.
Write `docs/reports/2026-09-29-inspect-java-references.md` from actual evidence,
not predicted results. Keep private traces and downloaded corpora outside Git.

**Interfaces:** The opt-in driver runs as
`npx tsx bench/inspect-java.mts --mode deterministic|review --config <outside-checkout.json> --config-sha256 <sha256> --output <outside-checkout-dir>`.
It reuses the production bridge and Pi runner, never an alternative extractor or
fake model. Deterministic mode makes no provider calls; review mode requires an
explicit execution approval and records provider/model/configuration identity.

- [ ] Implement a deterministic fixture builder in the driver: commit the approved two-file example at multiplier 10, then change only `price(int)` to multiplier 12; add separate cases for missing inputs, overloads, test callers, base deletion, stale identity, pagination, and unsupported additional module disclosure. Fix commit metadata and record full hashes. Compare exact expected source locations/target identities, not only nonempty output.
- [ ] Reuse the already-provisioned Commons Lang corpus at `620f4ff4b4b0934e6dc46465fe5c92fd7e1fb997` from the existing oracle fixture, verifying its actual checkout and cache hashes first. Never silently provision by running its build inside this driver. Freeze 20 selectors from syntax-only method enumeration in `(path, name-offset)` order before invoking any reference producer; do not choose only methods Inspect successfully resolves. Independently check source evidence for the comparison and retain unresolved cases in the denominator. Use the same revision/source sets for Inspect, CodeGraph, and Serena, with an empty same-revision manifest for this reference-retrieval comparison. The separate two-revision fixture proves diff integration. Record version/configuration, exact versus candidate evidence, omissions, latency, and any unavailable comparison capability rather than claiming universal superiority.
- [ ] Run `./inspect/gradlew -p inspect :runtime:installDist`, `npm run build`, `npm test`, and `npm run test:inspect` once at the integrated boundary. Confirm Linux oracle prerequisites before the last command; its fixture-only provisioning is separate from extraction. Run deterministic mode through the installed command. Retain no temporary scaffolds or generated corpus trees in the repository.
- [ ] With separate model-execution approval, run review mode against the fixed Java change. Require a recorded `leveret_java_references` call, its returned out-of-diff caller, a subsequent use of that evidence in the real review's reasoning/coverage, and preserved incomplete-coverage disclosure for the missing-dependency variant. A scripted tool call or mocked session does not pass. If no paid/local model run is authorized, report this acceptance criterion as unverified and do not declare the feature complete.
- [ ] Populate the report with exact revisions, hashes, commands, observed outcomes, main/test coverage, baseline comparison and limitations. Do not change the separate parity gate. Commit the exercised integration documentation and evaluation driver as `test(inspect): demonstrate Java reference evidence in Leveret reviews`.

## Verification and delivery policy

Each task's RED/GREEN checks run once per meaningful state, with a real-path smoke
after the fix. Agents must not run build/lint/tests mid-flight while editing;
the task owner runs the stated checks at the completed checkpoint. Behavior tests
must protect consumer outcomes, not source wording, defaults, copied allowlists,
or mocked forwarding. Remove implementation-coupled assertions rather than
re-pinning them.

Use the single condensed adversarial reviewer at the whole-branch gate, covering
contract compliance, correctness/hostile inputs, test honesty, and unnecessary
machinery. Preserve the repository's commit-time graph refresh. No merge, deploy,
paid run, or scope expansion is implied by this planning document. Follow the
active repository's PR/CI/bot-permission policy when publication is authorized.

## Sources and planning verification

- [JDT 3.46.0 artifact and pinned source revision](https://repo.maven.apache.org/maven2/org/eclipse/jdt/org.eclipse.jdt.core/3.46.0/org.eclipse.jdt.core-3.46.0.pom): dependency tuple and EPL-2.0 notice; retain third-party notices.
- [ASTParser API](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/dom/ASTParser.html): batch environments, compiler options and binding recovery. It resets settings after parsing; configure each main/test batch independently.
- [IMethodBinding API](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/dom/IMethodBinding.html): normalize generic instantiations with `getMethodDeclaration()`.
- [Gson 2.13.2 artifact](https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.13.2/gson-2.13.2.pom) and [strict streaming reader](https://github.com/google/gson/blob/gson-parent-2.13.2/gson/src/main/java/com/google/gson/stream/JsonReader.java): use strict JSON and explicit required-field validation, not reflective Kotlin construction.
- [Bubblewrap security model](https://github.com/containers/bubblewrap/blob/main/README.md): isolation depends on the supplied mounts/namespaces; the executable is not a ready-made policy.
- [Linux resource limits](https://man7.org/linux/man-pages/man2/getrlimit.2.html): `RLIMIT_AS` is virtual address space; `RLIMIT_RSS` is not an effective Linux memory limit.

Planning inspected the existing code and private reference research without
importing that research. Bubblewrap 0.12.0, util-linux 2.41.5 and JDK 26.0.2 are
present on the planning host; a bounded network-isolated `/usr/bin/true` launch
succeeded. This does not prove the future JVM worker, extraction, store, or
reviewer integration: those checks remain explicit tasks above.

## Execution handoff

Recommended method: **Native**, sequentially in the existing isolated worktree.
The six tasks share one evolving fact/identity contract, so keeping that context
with one implementer avoids unnecessary handoffs. Use one fresh condensed
whole-branch reviewer before completion. Alternatively choose subagent-driven
execution with task-by-task independent review. Either method requires approval
of this plan before implementation starts.
