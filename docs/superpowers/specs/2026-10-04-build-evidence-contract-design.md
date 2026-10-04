# Optional pipeline build-evidence contract

Date: 2026-10-04

Status: Written specification for maintainer review. The conversation approved the
architecture below; this document must be approved before implementation planning.
No exporter, plugin, command execution, or consumer change is implemented here.

## Objective and owner requirements

Leveret runs on the client's infrastructure. Clients can optionally supply build
context from their existing pipeline rather than require Leveret to reconstruct
all build behavior. A client-owned command, Maven plugin, or Gradle plugin must
produce the same data contract. Valid exports are the preferred evidence source
for the compilations they describe; without integration, existing and future
repository-discovery machinery remains available.

The review must retain both authored inputs and the materialized sources/resources
produced by the build. Templates, schemas, generator configuration and original
source are review targets, not disposable intermediates. Generated output enriches
the review and never replaces the originals.

Success is better resolution and consequential findings, independently verified
claims, actionable reports, and honest coverage. No arbitrary file-count limits
are introduced. Client-configured capacity policy and existing isolation,
provenance, transport/context, memory and cancellation safeguards remain separate.

## Scope and alternatives

This specification owns one boundary: a versioned, read-only build-evidence
manifest and its referenced bytes. It defines the information a command or plugin
exports and the rules a consumer follows; it does not implement three separate
exporters or prescribe their CLI names.

The selected design is **build-model metadata plus authored and materialized
artifacts**. Outputs alone lose source selection, compiler settings and template
intent. Attempting to recreate the whole build in Inspect adds unnecessary build
execution and interpretation. The client pipeline already owns those operations.

The initial semantic consumer is Java. The manifest can describe multiple modules
and compilation records, but this does not silently expand the current Inspect
consumer's one-module, main/test capability. Unsupported compilations/options must
be disclosed; supporting further scopes is implementation work with its own proof.

Dependency resolution, source/resource generation, templating and optional
compilation happen in the client's chosen build environment. Inspect's analysis
worker still runs no target build, processor, generator, plugin or test.

## Analysis-ready checkpoint

The client selects a pipeline checkpoint after the relevant source generation,
source transformations and resource processing have completed. It may be an export
step in an already-running build or a client-selected command; it is not a command
chosen by a model, manifest or PR-head instructions.

There is no universal Maven phase or Gradle task that proves all generation is
finished. Maven's standard `process-resources` follows main source and resource
generation, but test generation occurs later. Gradle uses task dependencies and
may have custom generators. Annotation processing, Lombok-style transformations
and bytecode enhancement may occur during or after compilation.

Therefore record generation, resource processing and compilation separately.
Post-generation evidence is useful without compiled outputs or tests. Accept later
compilation outputs when the pipeline already produces them; never claim an
annotation-generated artifact exists merely because pre-compilation steps passed.
For dependencies on another module's classes, missing upstream compilation output
is a gap, not a reason for Inspect to invoke the compiler.

Preserve authored inputs before any in-place transformation. Read tracked originals
from the pinned Git objects, not from their subsequently mutated workspace paths.
Capture generated/untracked inputs and materialized outputs into separate immutable
payload locations. A path reused by a transformation does not merge the two views.

## Handoff, identity and storage

For each requested side (`base` or `head`), the host supplies an absolute manifest
path, its SHA-256, an allowlisted payload root, the expected repository/revision,
and expected `context.id`. Optional host pins for profiles/variant must also match.
Those values come from client-owned configuration outside the reviewed checkout.
The manifest cannot choose host roots, commands, endpoints or analysis privileges.
The host selects compilation IDs explicitly for its configured module directory
and production/test scopes; never select the first matching record. Selection must
resolve uniquely to the requested `moduleDir` and `sourceSetRole`, or that scope
is unsupported and uses the documented fallback path.

One manifest describes one revision and one context. Base and head are independent:
one may have an export while the other uses fallback. Only the exact requested
commit is accepted. When reviewing the PR head, an export from CI's synthetic merge
commit is a revision mismatch; the client must export the requested head checkout,
or the consumer uses independent fallback. Never relabel merge or head output.

A later pipeline checkpoint produces a new manifest, payload snapshot and hash,
not an in-place update. The host pins exactly one manifest per side/context for a
run; consumers never merge successive exports into one fictional environment.

Validate authored input bytes against the pinned revision and materialized/external
bytes against their digests, including compiler/profile/variant settings in fact
identity. Hashes prove byte identity, not truthful build configuration or generation
freshness. The report labels the environment exporter-asserted and PR-influenced:
PR-controlled build definitions cannot shrink the independent review ledger.

The host pins the hash of the exact UTF-8 JSON manifest bytes externally. The
manifest has no self-referential hash field. Export via a temporary file and atomic
rename after payload capture finishes; a failed build can still publish a finalized
manifest with explicit failure/partial status. Do not mutate published payloads.
Consumers verify and freeze referenced bytes before analysis so concurrent builds
cannot change facts halfway through a query.

Local pipelines may use host-approved storage directly. Separate jobs provide a
payload bundle or restore it through client-controlled artifact steps. The manifest
contains no remote fetch URLs. Neither mode requires uploading code to infrastructure
operated by Leveret. External model disclosure and GitHub review publication still
follow the client's configured data-flow policy.

## Wire contract

Use a data-only JSON object with `schema: "leveret.build-evidence/v1"`. IDs are
nonempty, unique within their record collection, stable for the same logical build
context, and referenced explicitly. Unknown object fields or enum values, duplicate
JSON object keys at any depth or record IDs, unresolved references, wrong JSON types,
trailing content and malformed required fields invalidate the entire manifest.
Reject duplicate keys before a parser can overwrite them. Numeric sizes are
nonnegative safe integers, never coerced or rounded. No embedded scripts or
instructions are interpreted. The tables define the proposed wire shape;
executable validators belong to the approved implementation plan.

Static grammar/shape violations reject the whole manifest: types/enums, hex form,
path grammar, origin/location-kind combinations, duplicate IDs or authored paths,
entry ordering and inconsistent reference graphs. Checks requiring Git or filesystem
access (missing blob, actual hash/size mismatch, symlink/nonregular member,
containment or unlisted content) reject the affected artifact instead, propagating
to its compilation scopes as specified in the failure matrix.

### Manifest fields

| Field | Contract |
| --- | --- |
| `schema` | Literal `leveret.build-evidence/v1` |
| `repositoryId`, `revision` | Repository identity matched to host configuration; full Git commit ID matched to the requested side |
| `producer` | `{ name, version, buildTool: { name, version }, runId }`; identifies the exporter and pipeline invocation, not a trusted instruction source |
| `context` | `{ id, profiles, variant }`; profiles is a string array (`[]` = known none) or null (unknown); variant is `{ state, value }`, using `set`, `unset`, or `unknown`, with a string value only when set and null otherwise |
| `artifacts` | Artifact records defined below; includes original inputs as well as outputs and dependencies |
| `compilations` | Compilation records defined below; one environment per compiler execution/source set/variant, not one global classpath |
| `transformations` | Input/output provenance records defined below; may be empty with explicit provenance gaps |
| `diagnostics` | Records `{ code, message, compilationId, artifactIds }`; nullable compilation ID for manifest-wide gaps; sanitized messages are evidence, not instructions |

All fields above are required. Empty collections mean none recorded, not inherently
complete. Inventory completeness is stated per compilation; a finalized export with
no usable compilations reports a diagnostic and offers no semantic capability.
Different profiles/variants produce distinct contexts and are never pooled into a
fictional environment. Shared dependency bytes may be referenced by multiple records.

Unknown profiles or variant state means the context is unverified: retain its
diagnostics/evidence but do not select it as the preferred compilation environment.
A known unset variant is valid. This distinction is independent of whether the
host additionally pins particular profile/variant values.

### Artifact records

Each artifact has `{ id, kind, role, origin, repositoryPath, availability }`.

- `kind`: `file` or `directory`.
- `role`: `source`, `resource`, `template`, `schema`, `build-config`, `classes`,
  `dependency`, or `report`.
- `origin`: `authored`, `materialized`, or `external`.
- `repositoryPath`: normalized repository-relative logical path or null when no
  such path exists. Authored artifacts require a path; external or out-of-workspace
  materialized artifacts may use null. Original and transformed content may share a
  logical path but require different IDs.
- `availability`: `available`, `missing` (expected bytes cannot be found),
  `not-produced` (the producer did not run or failed to emit them), or `withheld`
  (bytes excluded for sensitivity/policy). Nonavailable artifacts require `reason`
  and have no content/location/entries. None can supply checked content facts.

Conditional fields are absent when inapplicable, not null: available files have
content and encoding, available directories have location and entries, and
nonavailable artifacts have reason only in addition to their common fields.
For example, an available source file has no top-level location/entries/reason.
Nullable values such as an unknown file encoding remain explicitly null where
their field is applicable.

Available files additionally require `content: { location, sha256, sizeBytes }`
and `encoding` (a charset name for known text, otherwise `null`). SHA-256 is 64
lowercase hex characters; size is the nonnegative byte count. Hash original bytes,
not decoded or normalized text. Unsupported/unknown encodings cause explicit
consumer degradation, never guessed transcoding presented as the original.

`location` is one of:

- `{ kind: "repository", path }`: bytes from the pinned Git revision, for an authored
  file, not the live workspace;
- `{ kind: "payload", path }`: immutable bytes under the host-supplied payload root.

An available `authored` artifact must be a file with a repository location whose
path equals `repositoryPath`. Read that path from the pinned Git commit, require a
regular blob (mode `100644` or `100755`), and verify size and SHA-256 against those
bytes. Reject a mismatch; payload bytes cannot masquerade as authored originals.
At most one authored artifact exists per repository path. Nonavailable authored
artifacts remain gaps and supply no revision-bound facts. All `materialized` and
`external` content uses payload locations only; generated or untracked inputs are
materialized, not authored. This consumer does not resolve exported external
references through its artifact cache; a fallback environment resolves its own
dependencies independently.

Directories are allowed only for roles `classes` and `dependency`, never as authored
artifacts. Available directories require a payload `location` and a complete
`entries` array of `{ path, sha256, sizeBytes }`, unique and sorted by UTF-8 byte
order. It describes all regular-file contents of the captured directory, not just
incremental writes. Verify each member and materialize only listed members. Empty
directories have empty entries. Reject symlink/special members and unlisted files.
If one member is missing or withheld, the directory is nonavailable with a safe
reason; never call an omitted-member directory complete. Sources, templates and
resources are individual file artifacts for precise findings. One resolved payload
path must have the same size/hash everywhere it appears, including directory entries.

All repository and payload paths use `/`, have no absolute prefix, empty component,
`.` or `..`, backslash or NUL, and cannot resolve through a symlink. Reject ambiguous
case/normalization collisions on the destination filesystem. Archive extraction, if
used by host transport, must enforce the same containment and regular-file rules;
manifest content cannot authorize extracting arbitrary archive members.

### Compilation records

| Field | Contract |
| --- | --- |
| `id`, `moduleId`, `moduleDir`, `name` | Distinguish module and named compilation; moduleDir is repository-relative, with `.` allowed only for the repository root; it is not the JPMS modulePath |
| `sourceSetRole` | `production`, `test`, or `other`, explicitly supplied; do not infer test semantics from task names |
| `language` | `java` initially; future producers may require a new schema/capability decision for other languages |
| `inputArtifactIds` | Full effective source-input inventory for this compilation, including generated/processed sources when available; not merely files recompiled this run |
| `authoredArtifactIds` | Originals needed to review this compilation: source, templates, schemas, resources and relevant build/generator configuration |
| `resourceArtifactIds`, `outputArtifactIds` | Effective processed/generated resources and available classes/output artifacts; no output is mandatory just to export metadata |
| `inventory` | `{ state, reason }`; state is `complete`, `partial`, or `unknown`; reason is null when complete and otherwise a nonempty string; completeness describes inputArtifactIds only, not all originals/resources/outputs or repository review coverage |
| `compiler` | `{ name, version, javaVersion, release, sourceLevel, targetLevel, encoding, preview, moduleOptions }`; strings are nullable when unknown; `release` has explicit set/unset/unknown state below; preview is boolean or null; moduleOptions is a recognized data-only option map or null |
| `compileClasspath`, `modulePath`, `processorPath` | Each is `{ state, reason, entries }`; state is complete, partial or unknown; reason is null when complete and otherwise required; unknown implies empty entries; partial retains known entries plus diagnostics |
| `generationState`, `resourceState`, `compilationState` | Independently `succeeded`, `failed`, `not-run`, or `unknown` per compilation; no manifest-wide checkpoint claims |

Within inputArtifactIds, at most one artifact may have each non-null repositoryPath.
For an in-place transformation, the materialized result is the effective input and
the authored original stays in authoredArtifactIds; listing both as effective inputs
cannot bypass the lineage/coverage rules.

Classpath/path entries are ordered records `{ artifactId, coordinates,
upstreamCompilationId }`. Coordinates are `{ group, name, version, classifier,
type }` or `null`; upstream compilation ID is a known referenced ID or `null`.
Every entry points to an artifact record, including missing artifacts. Artifact
coordinates never substitute for content identity or bytes. Preserve compiler path
order and separate compile, module and processor paths. A complete empty processor
path differs from an unknown one. Processors are described but never executed by
Inspect. Runtime classpath is an optional later extension, not required for this
Java binding consumer.

These state/reason rules also apply to source/boot paths in compiler options.
Known unused paths are complete with empty entries and null reason; unknown paths
are not silently treated as empty. If a path entry has upstreamCompilationId,
its artifactId must appear in that compilation's outputArtifactIds; otherwise the
reference graph is invalid and the whole manifest is rejected.

Export effective compiler values for that execution, not merely Maven/Gradle's
launcher JDK or declared defaults. `javaVersion` identifies the actual compiler JDK,
not bytecode target or Maven/Gradle's launcher VM. `release` is `{ state, value }`:
`set` carries its observed release string; `unset` and `unknown` carry null. Unknown
cannot become unset. For supported Java compilers, the selected release determines
language/API level when set; otherwise use the effective sourceLevel when release
is known unset. If that effective value is unknown, do not infer it from javaVersion:
the environment is incomplete and must degrade. targetLevel never determines
source language level. Unsupported compiler/platform semantics remain explicit gaps.
An unknown release state makes source/API level unknown and the environment
incomplete, even if sourceLevel happens to be reported. Consumer support must
match or reproduce the selected platform APIs; a Java version string alone does
not prove that the analysis worker uses the correct platform definitions.

`moduleOptions` is null if unknown; otherwise its
only allowed keys are `sourcePath`, `bootClasspath`, `addReads`, `addExports`,
`patchModules`, `addModules` and `limitModules`. Each key is required. Source/boot
paths use `{ state, reason, entries }` wrappers; other keys are nullable when
unknown, or arrays when known. Reads use `{ module, targets }`, exports use
`{ module, package, targets }`, and patches use
`{ module, path: { state, reason, entries } }`. Added/limited modules are string
arrays; targets are module-name arrays.
Known unused options are empty arrays (or complete empty path wrappers), not null.

Compiler `name`, `version`, `javaVersion`, `sourceLevel`, `targetLevel` and `encoding`
are strings or null; they describe observed values, not required
consumer support. Unsupported options, paths or platform features degrade the
consumer capability. Do not dump arbitrary compiler/JVM arguments, project
properties or environment variables into the artifact. Consumers resolve only
declared artifact references and never turn options into an executable compiler
command. Sanitized diagnostics may name an unsupported option without exposing
its raw potentially sensitive value.

### Transformation records

Each record is `{ id, producer, kind, inputArtifactIds, outputArtifactIds, basis,
locations }`. Producer is `{ name, version, executionId }`, with unknown version
represented by null. Kind is `generate`, `transform`, or `resource-process`; compiler
outputs belong to compilation records rather than duplicate compile transformations.
basis is `exporter-recorded` or `inferred` (an inference made by the exporter).
Annotation-processor-generated source uses `generate`, when lineage is available.

Multiple inputs/outputs are allowed; a template and a schema may jointly produce
one file, and one input may produce many outputs. With unknown lineage, do not
invent an edge: leave it absent and report a provenance gap. Shared original inputs
need not be duplicated. Repeated executions must have distinct execution IDs.

`locations` is an array of precise mappings `{ inputArtifactId, outputArtifactId,
inputRange, outputRange }`, permitted only for exporter-recorded lineage; inferred
records require an empty array. IDs must belong to that transformation's input/
output sets, and ranges must lie within the decoded text. Use one-based lines,
zero-based UTF-16 columns and exclusive ends, matching Inspect. Invalid/out-of-bounds
maps are discarded with a diagnostic while valid file-level lineage is retained;
they never authorize a source-line anchor. Unknown encoding or missing text cannot
validate a map. Exporter-recorded lineage is still not proof of defect causality.
A materialized artifact without a recorded incoming transformation is reported as
lineage-unknown; compilation output metadata alone is not an exact source map.

## Consumer precedence, fallback and reporting

Validate envelope, requested side/revision/context, record graph, allowed locations
and bytes before use. Prefer a supported validated environment for the explicitly
selected compilation. Never concatenate exported and fallback classpaths or borrow
settings from another profile/revision.

| Condition | Required outcome |
| --- | --- |
| No export configured | Current independent discovery unchanged; export explicitly unavailable |
| Configured export absent, hash/schema invalid, or wrong repository/revision/context | Reject the whole export, report the reason, and attempt coherent independent discovery per scope; no subset of an invalid manifest is used |
| Context profiles/variant unknown | Mark context unverified; no preferred semantic environment; use coherent independent fallback |
| Artifact Git/filesystem identity rejection | Reject the artifact; every compilation directly or transitively referencing it (including originals, resources, outputs and lineage inputs) degrades to partial and uses coherent independent fallback, not merged paths; static shape violations reject the whole manifest |
| Authored-byte mismatch | Additionally discard revision-bound exported facts for each affected compilation; fallback must independently validate Git inputs |
| Valid partial/missing compilation, or unsupported selection/options | Report gaps and choose coherent independent fallback for that scope; unavailable generated bytes are never fabricated |
| No usable exported or fallback environment | Keep source-level review, report unresolved/unexamined semantic scope; no successful empty analyzer result |
| Invalid worker isolation or trusted host configuration | Fail closed as now; optional export cannot bypass these controls |
| Consumer secret screening withholds an artifact | Treat it as nonavailable in the consumer admission record, without mutating the pinned manifest; no semantic facts or text exposure from it, affected scopes degrade and any fallback must enforce the same withholding |

Every fallback records the rejected/missing evidence and its own input identity.
Schema-invalid mappings reject the envelope; well-shaped but out-of-bounds mappings
degrade lineage as above. Known unavailable artifacts remain unavailable even if
fallback succeeds; it does not erase integration failures from the report.

A semantic environment is partial when input inventory or compileClasspath is not
complete, a required source/dependency is nonavailable, or effective language/platform
settings or applicable module/source/boot-path semantics are unknown/unsupported.
Generation/resource/compilation step outcomes alone do not gate a supported
environment; neither does an unknown processorPath, because Inspect never executes
processors. Missing processor-generated inputs still count as unavailable inputs.
Retain unusable partial settings for report/provenance, not as fragments to splice
into fallback. A metadata-only or failed build with a complete, supported effective
input environment remains usable; absent class outputs matter only when required.

Keep build-step outcome, export inventory, semantic coverage and model-review
coverage separate. For build-evidence coverage, independently enumerate tracked
Java paths under the selected module in the pinned tree. Paths absent from validated
effective input inventories are unexamined by that build context, not clean.
An original transformed in place is covered only when a validated recorded lineage
connects it to an effective input; inferred lineage alone cannot erase this gap.
Authored templates/resources and changed files remain review targets independently
of the compiler input list. Other modules retain the existing unexamined-scope
reporting. inventory.complete only asserts the compilation's effective input list.

Step success, a complete inventory or zero diagnostics never establishes safety.
Hashes detect post-export mutation and identity mismatches, not whether an output
was fresh when exported. Generation freshness is exporter-asserted; cached/up-to-date
status and a recorded edge do not prove it. Report that limitation and do not claim
independent freshness verification.

The report identifies the chosen environment per revision/compilation, available
and missing generation outputs, original/generated locations, lineage basis,
unsupported options, fallback reasons and unexamined work. Preserve existing audit
and tool evidence IDs; add build-manifest/artifact identities to analysis and cache
provenance rather than building another review-recording system.

Content citations bind `{ manifestSha256, artifactId, range }`, with a nullable
range for whole-file evidence. A bare logical path cannot identify original versus
transformed bytes when both share that path. Retrieval and fact provenance must
preserve this distinction; generated-source analysis never labels its bytes as the
authored Git file. Generated-only locations are supporting evidence, not Git diff
anchors or automatically “outside-diff” source references. Inline publication and
authored diff classification require an actual pinned Git location; a validated
source map plus established root-cause evidence may supply that original anchor.

Anchor actionable findings to editable originals when current evidence establishes
the root cause there. Cite generated output to demonstrate the effect. If only an
output defect is established, report that output and uncertain attribution instead
of pretending to know the responsible template. Deduplicate repeated generated
instances by demonstrated root mechanism, not just shared producer name. Review
both original and processed resource configurations; never auto-suppress a defect
solely because its evidence is generated.

## Safety, ownership and sensitivity

The pipeline executes project build logic under the client's own policy, including
its handling of fork PRs and credentials. Adding a plugin does not make that logic
safe or eliminate configuration-time execution. The analysis worker receives only
validated/frozen data and existing safe analysis capabilities. It never loads
producer plugins, evaluates templates, executes bytecode, follows supplied commands,
fetches artifact URLs, or discovers project-local extensions/hooks.

Treat templates, generated text, diagnostics and exporter claims as untrusted
content with provenance. Host ownership of the handoff is not permission for those
contents to widen reviewer instructions or mounts. Approved host configuration alone
controls storage, retention, resource policy and provider access.

Exports must not contain provider/GitHub credentials, settings.xml authentication,
unrestricted environment/property dumps or substituted secrets. Secret-bearing
artifacts use withheld with a safe reason. v1 does not support redacted content
masquerading as an exact original/output; omission reduces coverage.

Before exported text, excerpts or diagnostics reach a model, persisted audit
payload or public report, the host applies its explicit secret-exposure screening
policy, including known credential values and configured secret rules. Detected
secrets are withheld; diagnostics contain no value. Screening unavailable means
that text is withheld and the exposure check is reported unavailable, not “clean”.
Fallback retrieval must honor the same policy. This is a safeguard, not a claim
that every possible secret can be detected; exporters remain responsible for
deliberate field/content selection. Private pipeline payload storage remains
client-owned under its own retention and access policy, never a Leveret service.
Provider and GitHub-publication policy are unchanged.

## Worked example: template plus generated Java

The developer edits `templates/Pricing.java.tpl`, containing a multiplier expression
`${factor}`. The pipeline generates `build/generated/example/Pricing.java` with
`quantity * 12`. Review the template and the generated source as two artifacts:

| Artifact | Role/origin | Review use |
| --- | --- | --- |
| `pricing-template` | template/authored; original bytes at the pinned revision | Review expression, escaping, defaults and generation intent |
| `pricing-output` | source/materialized; immutable payload bytes | Parse the concrete class and trace checked callers under its compilation environment |
| `pricing-generator-config` | build-config/authored | Examine the selected factor and generator behavior; secret values are never exported |

The transformation records both template and configuration as inputs and the output
as a result. File-level lineage alone does not map Java line numbers back into the
template. If template evidence establishes a bad expression, anchor the finding
there and cite the generated result. If the output is missing because generation
failed, keep authored review and diagnose the gap, not a successful empty caller
list. Capture independent originals/outputs for base and head; never compare base
originals with head-generated results as if they came from the same build.

For filtered resources the same rule applies: `${endpoint}` in an original resource
and the resulting concrete endpoint are separate evidence. Gradle `expand`/filters
and Maven resource processing may transform content and filenames; the exported
relationship must not assume byte-for-byte copying.

## Acceptance scenarios for implementation

| Scenario | Required observable behavior |
| --- | --- |
| No command/plugin integration | Existing discovery still reviews the change; build export is explicitly unavailable, not a failed prerequisite |
| Metadata only or failed compilation | Complete supported input environments remain usable regardless of step outcome; partial settings are retained for report/provenance only, not merged into fallback; no invented classes/test outcomes |
| Template generation | Original template/config and generated result both retrievable; supported binding uses the generated source; root-cause finding cites original and output without duplicate publication |
| In-place transformation | Original Git bytes remain retrievable even after the workspace path is overwritten; output has separate identity |
| Original identity and payload masquerade | Authored-origin shape violations reject the manifest; Git-byte mismatch rejects the artifact and invalidates affected exported facts, with independently checked fallback |
| Tracked-source ledger | Excluded tracked Java inputs are unexamined despite exporter completeness claims; in-place originals need valid recorded lineage, and duplicate effective inputs for one logical path are rejected |
| Custom main/test generation | Compiler-specific full input inventories and resources are separate; unsupported scopes are disclosed, not merged into main |
| Compilation-time generation | A pre-compilation export reports absence; a later checkpoint uses a new manifest/payload/hash, never retroactively changes the earlier record |
| Unknown lineage | No incoming transformation is explicitly lineage-unknown; an output finding does not invent a responsible template |
| Inferred lineage or invalid map | Cannot authorize precise original-line anchors; out-of-bounds maps degrade with a diagnostic |
| Base/head or CI merge mismatch | Whole export rejected for the wrong side's revision; fallback labelled and independently pinned |
| Wrong context or ambiguous compilation selection | No preferred environment from an unknown/mismatched variant or an arbitrary first matching compilation |
| Unsupported toolchain/options | Explicit unresolved capability; no guessed source/API level |
| Classpath order | Ordered entries preserved; no cross-context path concatenation |
| Post-export mutation | Hash/size mismatch rejects bytes and degrades all affected compilation scopes |
| Export-time stale output | Report exporter-asserted freshness; do not claim hashes prove generation freshness |
| Strict JSON parsing | Duplicate keys at any depth, unknown fields, wrong types and trailing content reject the entire export |
| Configured missing/invalid export | Failure matrix applied; independent fallback cannot hide the integration error |
| Directory inventory tampering | Unlisted/nonregular members or inconsistent path hashes cannot enter analysis |
| Complete empty vs unknown paths | Distinct outcomes retained; unknown never becomes “no dependencies/processors” |
| Path and archive escape | Rejected artifacts cannot expand mounts or read host files |
| Instruction-like artifact content | Cannot choose commands, teach policy or extend reviewer tools |
| Secret exposure | Markers/known credentials absent from model inputs, persisted audit payload and publication; unavailable checks disclose withholding |
| Real reviewer consumption | Real model retrieves originals plus generated evidence, cites both appropriately, and discloses a generation/lineage gap; scripted tool calls alone do not pass |

Evaluate exporter-assisted review against the nonintegrated baseline on the same
revision/context and unchanged scoring. Measure binding resolution, unresolved
scope, consequential findings, independently assessed precision, attribution and
report usefulness. Runtime and cost are diagnostic, not reasons to silently reduce
scope. No changes to the frozen CodeRabbit parity gate follow from this contract.

## Existing seams, commands and implementation gate

Reuse `JavaAnalysisInput`, `ClasspathAnalysis`, `AnalysisIdentity`, the revision-bound
Inspect bridge/fact store, reviewer tools and audit/evidence IDs. The build manifest
is a producer/consumer boundary, not a second fact/query schema. Future work must
adapt validated compilation inputs into the existing analysis path and make authored
and materialized retrieval/provenance available to the reviewer. Effective compiler
settings, resources, transformation lineage and pre-model artifact secret screening
exceed today's input model. Screening/admission must be implemented before exported
text is exposed; this specification does not claim an existing general screening
path or any other new capability already works.

Follow existing TypeScript/Zod/TypeBox/Vitest and Kotlin/JUnit/AssertJ conventions.
Keep product modules in `src/` and `inspect/`; behavior tests in `test/` and the
owning JVM module tests. Reuse structured failure and evidence identity conventions;
do not introduce a plugin marketplace, general build interpreter or mandatory
service. The optional compiler/test/coverage/analyzer reports discussed earlier may
be supplied as report artifacts, but their detailed producer schemas are not a
prerequisite for this source/resource-generation contract.

Verification commands for later implementation are the existing project commands:

```sh
npm run build
npm test
./inspect/gradlew -p inspect :runtime:installDist
npm run test:inspect
```

They build/test Leveret, not a target repository. Producer commands and plugin goal
names must be defined and verified during approved exporter implementation; no
hypothetical command is presented here as runnable software.

Always validate inputs, preserve originals, enforce isolation and report gaps.
Ask before changing target-build execution policy, adding external services or
expanding unrelated analysis scope. Never run PR-chosen commands, ship secrets,
weaken frozen acceptance thresholds or claim implementation/model proof from this
written specification.

After written-spec approval, create a reviewed implementation plan and select its
execution method. This design-only branch authorizes no product implementation,
release, deployment or target-build execution.

## Official source grounding

- [Maven lifecycle](https://maven.apache.org/guides/introduction/introduction-to-the-lifecycle.html#Lifecycle_Reference): ordered source/resource processing, later test phases and customizable plugin goals.
- [MavenProject API](https://maven.apache.org/ref/3.9.11/maven-core/apidocs/org/apache/maven/project/MavenProject.html): effective project values, source roots, profiles, artifacts and classpaths; roots can depend on lifecycle execution.
- [Maven Compiler Plugin](https://maven.apache.org/plugins/maven-compiler-plugin/compile-mojo.html): per-execution compiler, release, encoding, processor and generated-source settings.
- [Gradle SourceSet](https://docs.gradle.org/current/dsl/org.gradle.api.tasks.SourceSet.html): distinct source/resource sets, classpaths and outputs.
- [Gradle JavaCompile](https://docs.gradle.org/current/dsl/org.gradle.api.tasks.compile.JavaCompile.html) and [CompileOptions](https://docs.gradle.org/current/dsl/org.gradle.api.tasks.compile.CompileOptions.html): filtered inputs, compiler/toolchain, options and generated-source directories.
- [Gradle ProcessResources](https://docs.gradle.org/current/dsl/org.gradle.language.jvm.tasks.ProcessResources.html): copies, filters, expands, renames and excludes resources; output is not necessarily the original text.

These references establish available metadata and lifecycle semantics, not tested
plugin compatibility. Producers must declare supported tool/plugin versions and
verify their actual effective export; unsupported metadata remains unknown.
