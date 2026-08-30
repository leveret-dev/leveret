# Scope Decision

**Date:** 2026-08-29
**Status:** Approved. Specification prune executed; code prune executed in the commits that follow.
**Supersedes:** the coverage obligation in `specs/manifest/coverage-index.md`, which required every inventoried upstream artifact to map to a full specification
**Method:** six parallel read-only audits over the 42-file specification corpus (18,075 lines including the manifest), each judging capabilities against the product goals below with per-row evidence

## 1. Product definition

Leveret Inspect is a code-intelligence and code-review engine for developers and the coding agents acting on their behalf. Its goals, numbered for reference throughout this document:

1. Analyze source code.
2. Find flaws where they exist.
3. Suggest fixes and improvements.
4. Understand the codebase.
5. Understand the blast radius of a change.

It is explicitly **not**: an enterprise governance platform, a multi-tenant service, a portfolio or compliance reporting product, a CI pass/fail gatekeeper, or a plugin marketplace host.

The specification corpus was reverse-engineered from an upstream product built for the opposite purpose — a shared server that governs many projects for many principals and reports on their health over time. That difference in purpose, not code quality, is what most of this document cuts.

**Deployment assumption, on which many verdicts depend:** one operator on one machine — a developer and their coding agents — reaching the engine in-process or over loopback, analyzing a codebase that operator's filesystem account can already read. The engine grants no access its caller does not already possess.

## 2. Headline result

Roughly 12 to 15 percent of the specification corpus survives, and the surviving fraction is unevenly distributed:

| Area | Volume | Survival |
|---|---:|---|
| Analysis execution pipeline (plugin runtime, scanner gateway, compute engine, process runtime, persistence) | 1,767 lines | ~10% |
| Data model and query surface (project configuration, analysis results, search indexing, HTTP API) | 1,204 lines | ~17% |
| Peripheral platform (identity, web UI, notifications, telemetry, statistics) | 1,200 lines | ~4% intact, ~16% reduced |
| Compiled and systems-language analyzers | 5,620 lines | ~17% |
| Web-family analyzers and integrations | 7,629 lines | ~16% |

Three structural findings dominate the detail:

**The scanner/server split must go.** A separate producer process that serializes findings into a report, uploads it, and receives a queued task identifier is the load-bearing assumption behind five other capabilities: the wire format (~25 message types), the upload transport, report part storage, the asynchronous task queue, and the acknowledgement handshake. Goals 4 and 5 need the symbol graph the analysis just built, not a lossy serialization of its findings. Analysis runs in the same process as the intelligence layer. [Evidence: `specs/platform/scanner-gateway/specification.md` §2, §6, §7; `specs/platform/compute-engine/specification.md` §2, §4.1]

**The specified user interface is the wrong interface.** All forty-odd browser routes administer, govern, or report. The three views that would carry real value — a findings list with source context and suggested fix, a codebase structure and dependency map, and a blast-radius view for a change set — appear nowhere in the corpus. The last two are gaps, not cuts. [Evidence: `specs/platform/web-ui/specification.md` §4.1–§4.5]

**The rule catalogs are the largest single cut by volume.** 2,418 native rule keys plus at least 2,585 mirrored external rule identities, the majority naming, layout, convention, and deprecated-API rules that language-native tooling already emits and that the corpus already imports. Leveret Inspect should own only high-signal defect rules — roughly 400 keys — and delegate the rest through one standard-format importer. [Evidence: `specs/analyzers/rust/specification.md` §7.2 (815 mirrored keys); `specs/analyzers/python/specification.md` §12.1; `specs/analyzers/java/specification.md` §7; `specs/analyzers/infrastructure-as-code/specification.md` (2,057 lines of external catalog)]

## 3. Architecture consequence

| Decision | Replaces |
|---|---|
| One process, synchronous analysis, invoked per request | three supervised OS processes with IPC, readiness gating, and restart escalation |
| In-process analyzer invocation over compiled-in analyzers | dynamic plugin discovery, classloader isolation, API version negotiation |
| One embedded relational file, hand-written schema | dialect abstraction across four database engines, operator-provisioned server, loopback database server |
| Relational store as the only store | a second search engine with denormalized documents, a synchronization queue, and permission-filtered queries |
| Library API plus a local protocol as the primary surface | a servlet container, two HTTP API families, three wire formats, cookie sessions, and a browser security header policy |
| One local token when a loopback adapter is exposed | users, passwords, groups, sessions, CSRF, permission matrices, permission templates, proxy SSO, and a six-mechanism authentication dispatch chain |
| Findings returned in the response | email, webhooks, a notification queue, a subscription catalog, and an event dispatch framework with no registered handlers |

Goals 4 and 5 are join-and-reachability questions — "who calls this", "what transitively depends on this file", "which findings sit in the files this diff touches". Recursive queries over symbol and reference tables answer those in an embedded relational engine directly; a key-value or flat-file store would mean hand-rolling both the join and the traversal. That is why the store survives while almost everything around it does not.

**What "one process" does and does not decide, clarified 2026-08-29.** It cuts the supervised service topology: no web tier separate from a worker tier, no search process, no IPC command file, no readiness gating, no restart escalation. It does **not** decide that compiler frontends run inside the process that serves queries. The analysis target is a codebase we did not write, so a producer reading it is handling untrusted input at unbounded cost — measured at 11 GB and 503 seconds on one configuration during the spikes. `docs/specs/2026-08-29-code-graph-sourcing.md` section 5.2 therefore places resolution in short-lived worker processes with a heap cap and a deadline, reporting facts over a pipe or a file — and section 5.3 adds an isolated sandbox for the *opportunistic* escalations that resolve dependencies or compile the target, which execute target-authored build logic and so need egress and resource controls of their own. Section 5.5 makes those escalations optional by design: private dependencies and non-standard build strategies mean they frequently cannot succeed, so no feature may depend on them. That is a launch-and-wait, not a supervised node: `ProcessBuilder` with limits and a timeout, not the launcher, lifecycle, and command-file machinery section 8 deleted. The service process keeps settings, logging, the store, the queries, and the name-only tier.

## 4. Keep

| Capability | Why | Source |
|---|---|---|
| Finding read model: rule, component, path, line, text range, message, secondary flow locations | this is the output of goals 1 and 2, and the flows are the evidence goal 3 needs | `specs/platform/analysis-results/specification.md` §3.1 |
| Rule catalog with per-rule defaults and parameters | goal 2 needs a definition of what a flaw is; this is what survives the quality-profile cut | `specs/platform/project-configuration/specification.md` §5.1 |
| Standard-format finding interchange, reader and writer as one codec | the reader is what pays for every delegation to native tooling; the writer gives findings reach into editors, CI, and other agents | `specs/platform/scanner-gateway/specification.md` §9 |
| Semantic frontends for Java, Kotlin, Python, Go | resolved symbols, references, and call edges for goals 4 and 5; none requires a successful build, and Kotlin/Java is where the engine can analyze itself | `specs/analyzers/java/specification.md` §5–§6.3; `specs/analyzers/kotlin/specification.md`; `specs/analyzers/python/specification.md` §5–§7; `specs/analyzers/go/specification.md` §5 |
| Semantic frontends for JavaScript and TypeScript | the type model covers a large share of real codebases for goals 4 and 5 | `specs/analyzers/typescript/specification.md`; `specs/analyzers/javascript/specification.md` |
| Secrets and Unicode-security detection | best goal-2 value per unit of machinery: language-independent, no parser required | `specs/analyzers/text-and-secrets/specification.md` |
| Per-file failure isolation and partial results | goals 1, 4, and 5 must produce useful output on repositories that do not fully parse | `specs/analyzers/go/specification.md` §12; `specs/analyzers/java/specification.md` §8 |
| Settings loading with file, environment, argument, system-property precedence | every invocation must be configurable, and this precedence is the boring correct one | `specs/platform/process-runtime/specification.md` §4.2 — already implemented |
| Runtime directory layout with temp cleaning | the index, the finding history, and the result cache need a durable home | `specs/platform/process-runtime/specification.md` §4.1 — already implemented |
| Thin session over the embedded store: commit, rollback, prepared statements, batched writes committing per batch | batched writes are what make indexing a large repository survivable | `specs/platform/persistence/specification.md` §7.1 — already implemented |
| Stable analysis-target and file identity | findings and derived graphs must survive across runs | `specs/platform/project-configuration/specification.md` §3.1 |
| Server-authoritative presentation: a client route guard is never a security boundary | costs nothing, stays correct after every cut | `specs/platform/web-ui/specification.md` §3.2, §9 |
| Observation is not delivery: a log line, counter, or delivery record is evidence of an attempt, never proof of receipt or action | load-bearing for goals 2 and 3 — never report a finding as addressed because it was emitted | `specs/platform/events-notifications/specification.md` §2 |

## 5. Trim — capability survives, machinery does not

| Capability | Survives | Goes |
|---|---|---|
| Ordered analysis pipeline | a plain ordered function sequence, stop on first failure | report reassembly, task container, analysis UUIDs, profile loading, snapshot switch, indexer and notification stages, step registry |
| Cross-run finding correlation | match by rule plus file plus content hash; classify new, pre-existing, fixed | durable issue lifecycle, concurrent-edit conflict resolver, plugin-change invalidation |
| Issue lifecycle | two states — present and suppressed — plus a reason | four more states, an eleven-row transition matrix, assignment, comments, changelog, bulk change |
| Symbolic execution | method-local path sensitivity for roughly ten defect classes over one shared intraprocedural framework, retaining flow-to-secondary-location explainability | cross-procedure behavior cache, bundled per-library behavior models, the single-language exploded-graph apparatus, five tuned exploration limits |
| Rule catalogs | bug and vulnerability classes needing a semantic model or path sensitivity (~400 of 2,418 keys) | code-smell, naming, layout, convention, and deprecated-API mass; delegated to native tooling |
| Change-set scoping | git-native selection: working tree, staged, commit range, branch versus merge-base | the date-or-version period as governance baseline, four period types, a four-level precedence chain, new-code metric mirrors |
| Metric catalog | roughly a dozen structural keys: lines, ncloc, files, functions, statements, cyclomatic and cognitive complexity, comment density, duplication counts | ratings, debt index, development cost, remediation effort, densities, coverage families, and every new-code duplicate (~140 of 156 keys) |
| Configuration model | typed reads of one repo-local config file merged over catalog defaults, overridden by flags | database-stored setting tiers, the thirteen-value-type metadata model, secured settings and encryption helpers, profile inheritance lattice |
| Duplication | within-repository token-hash detection reporting duplicate ranges as findings | density metrics, the XML-in-a-measure encoding, cross-project matching |
| Connection pool | one pool, one size knob | the read-only pool, six tunables, pool statistics, the exhaustion-observability contract |
| Migration | a schema-version stamp plus wipe-and-rebuild on mismatch | history rows, the version-state taxonomy, progress projection, downgrade detection — until user-authored state exists that cannot be recomputed |
| Logging | one log file, level configuration, plain and JSON layouts | four per-process files, per-process level overrides, the rolling-policy family |
| Shared analyzer infrastructure | one symbol/reference/call-edge model, one metric computer, one file-recognition registry, one suppression filter, one content-hash cache with import-dependency propagation, one test-file classifier | six parallel semantic-model architectures, ten suffix property surfaces, nine highlighting specifications, eight duplication token producers, four test heuristics, six cache schemes, and the second execution mode in every analyzer |
| HTTP as a surface | one optional loopback adapter with one JSON shape, one error envelope with a machine-readable category, limit-plus-cursor pagination | servlet container, four-state startup machine, two API families, three wire formats, eight filters, header policy, discovery routes |
| Provider integration | one authenticated client that reads a pull request's changed files and posts a line-anchored comment carrying a suggested change | repository import, provisioning, binding and setting records, delegated login, role and team synchronization, health gauges |

## 6. Cut

Grouped, with the volume each removes.

- **Plugin and extension runtime, entire** (319 lines): artifact discovery, twenty-plus manifest headers, classloader isolation and API masking, version negotiation, dependency exclusion, archive deployment, dependency-injection container and lifecycle, process-side markers, boot-configuration narrowing, installation persistence, risk consent, service discovery. Survivor: a compile-time language-to-analyzer map.
- **Scanner/server transport**: bootstrap handshake, engine and JVM provisioning, the report wire format, upload transport (whose documented threshold arithmetic overflows to zero persisted parts with a success acknowledgement), part storage, upload authentication, task submission.
- **Asynchronous execution**: durable task queue, worker pool and its operator surface, queue recovery and retention, task activity history, task messages and per-user dismissal, task timeout, the publication and visibility protocol.
- **Governance layer**: quality gates and condition evaluation, quality profiles as a persisted editable entity with thirty administrative routes, profile inheritance and editor delegation, permission model, permission templates, project visibility, custom-rule authoring over an API.
- **Second data store** (391 lines): the search cluster, five indexes, authorization parent documents and permission filtering, the transaction-coupled recovery queue and daemon, asynchronous indexing with its degraded-read contract and operator reindex route, sort-rank encodings, suggestion and facet query surfaces.
- **Identity, entire but for one token**: users, passwords, sessions and cookies, CSRF, groups, proxy SSO, system passcode, the authentication dispatch chain.
- **Browser surface, entire as specified**: roughly forty routes across instance administration, project administration, profiles and gates, measures and treemaps, project activity, task queue inspection, source browsing, account and session screens, tutorials, marketplace, API browsers, plugin page hosting, localization.
- **Outbound delivery**: email with its thirteen configuration keys, webhooks with delivery history, the notification queue and daemon, the subscription catalog, the event dispatch framework, the server-push event vocabulary.
- **Outbound telemetry** (~145 lines): the upload pipeline, a twenty-four-key metric vocabulary built on portfolios, applications, and report subscriptions, and a legacy payload shipping unhashed project identifiers, keys, line counts, and platform names. Cutting it removes a privacy liability along with the code.
- **Operational monitoring for a fleet**: the metrics scrape endpoint and its twenty-four families, cluster health aggregation, safe mode, license gauges that are permanently zero, performance interceptors, the five-group task scheduler.
- **Reporting and history**: measure and issue-count history with retention purge, analysis events, project badges, the technical-debt metric family, compliance filters and facets, project-measure search, the new-code-focus statistics page and its fixed twenty-percent projection.
- **Legacy compatibility surfaces**: proto2 field-number preservation, deprecated rule aliases and dual repository registrations, hotspot-to-issue migration machinery, the 117-table canonical inventory and its ~70-step historical migration catalog.
- **First-class analyzer status for PHP, Ruby, Scala, Rust, VB.NET, CSS, Flex, and the JSP embedding adapter**: 2,102 lines of parser embeddings and rule catalogs for languages whose own specifications disclaim any semantic index, plus one analyzer that shells out to an external tool it packages as a native binary, plus one whose complete observable contract is negative.
- **The .NET delivery model**: build-orchestrated external scanner, a second-runtime analyzer assembly, eight protobuf streams. Without a successful build there are no results at all, which is an adoption barrier no goal survives.
- **Per-analyzer periphery**: syntax highlighting across nine specifications, duplication token producers across eight, coverage import across twelve formats, test-execution import across six, telemetry emission, framework and ecosystem detection specials, custom-rule extension APIs, internal tuning properties, quick-fix availability metadata that is overwhelmingly empty.
- **Identity federation and provider provisioning**: directory and federated authentication, repository import and binding for four hosting platforms, delegated login, role synchronization.
- **Already-built code that these cuts orphan**: see section 8.

## 7. Gaps — what no specification owns

The corpus never had to serve goals 3, 4, and 5, so it does not. Partial coverage exists and is cited; none of it is a foundation.

| Gap | State of partial coverage |
|---|---|
| Cross-file resolved symbol identity | the entire symbol wire model is one declaration range plus repeated reference ranges, scoped to a single file, with no name, kind, qualified identity, or cross-file target [`specs/platform/scanner-gateway/specification.md` §7.3] |
| Reference, call, override, and type edges as a queryable graph | nothing persists edges; the only cross-file relation stored is text duplication, and the only flow data is attached to one finding and discarded otherwise |
| Cross-language symbol coverage | one analyzer emits symbols; another explicitly states no symbol table or reference index is produced and that an implementation must not claim otherwise [`specs/analyzers/kotlin/specification.md` §6.5] |
| Transitive impact query with the edge path that reached each result | the nearest thing is an extension point documented as a no-op [`specs/platform/compute-engine/specification.md` §5 step 6] |
| Public-surface classification | public API is counted in aggregate and never enumerated; visibility is absent from every wire message |
| Diff-scoped analysis as a request shape | file status and prior hashes exist, but only as optimizations inside a whole-project pass |
| Per-result-kind incrementality contract | per-language content hashes exist; no platform statement of what a change invalidates |
| Machine-applicable fix payload | the report carries a boolean asserting a fix exists elsewhere; the text edits live in a product this corpus does not specify |
| Fix verification scope | nothing verifies a fix; resolution is a human transition |
| Test-to-code attribution | coverage import destroys exactly this, reducing instruction counts to a binary line hit and merging reports [`specs/integrations/jacoco/specification.md` §9] |
| Agent-facing query contract with explicit staleness | the non-browser channel is a push stream with no message id or retry field, so a disconnected client cannot replay; nothing states which revision an answer reflects |
| Resolution confidence and the unresolved-reference set as output | honesty is per-run, never per-edge; a blast radius that silently omits unresolved edges is worse than no answer |

### New parts, in build order

1. **`platform/code-graph`** — symbols, typed edges, per-edge resolution confidence, the unresolved-reference set as a first-class output, and delta application so one analysis replaces only its own facts. Consumes `platform/persistence`. Every other part reads from it, and it is the one thing a consuming agent provably cannot rebuild per query. **Cost amended from Large to Medium by `docs/specs/2026-08-29-code-graph-sourcing.md`:** this part drives existing compiler-backed libraries rather than writing per-language frontends — Eclipse JDT Core in a worker for Java, the Kotlin Analysis API in a per-version worker, an embeddable parser in-process for everything else — over a checkout we fetched, with **opportunistic** escalation into a sandbox **we** own — dependency resolution at rung 2, compilation at rung 3, per §5.3. Nothing asks the customer for a build plugin, a CI step, an artifact they must produce, or registry credentials, and nothing ever runs the target program or its tests. Because private dependencies and non-standard build strategies defeat escalation on exactly the codebases customers have (§5.5), **rung 1 alone must carry every feature**; escalation improves answers where it happens to work. The part therefore has two outputs of equal standing (§5.8): facts precise enough for deterministic findings, and *orientation* for a reviewing model — the declarations a change touches, their importers, bound callers and labelled candidate sets, symbols we could not fetch, and the runtime-wiring sites in the affected set.
2. **`platform/agent-gateway`, minimal** — symbol lookup and references over a library API plus a local socket, with the index version and head revision on every response. **Small.** It makes part 1 useful the day it lands and fixes the query vocabulary before later parts inherit a browser-shaped one.
3. **`platform/impact`** — the closed affected set with hop distance and edge paths, bounded traversal with a truncation marker naming which bound fired, and mandatory counts of both unresolved references and runtime-wiring sites on the frontier. **Medium.** Leveret Inspect returns the set and the paths; ranking which of them matters is the agent's judgment about its current task. Affected *tests* are not part of it — see the note under the identity boundary.
4. **`platform/change-scope`** — a change set as a first-class request, plus the classification of every result kind as incremental, dependent, or full-pass. **Medium.** The agent knows its diff perfectly well; what it cannot know is which results the diff invalidates.
5. **`platform/remediation`, mechanical subset** — ordered text edits with exact ranges, a safety class, and the re-analysis scope that must come back clean. **Medium**, small if scoped to rules whose analyzer already computes an exact range. Opt-in per rule. Prose fix generation stays with the agent, which does it better.

**Cut by the build-integration trim, 2026-08-29:** *test attribution ingestion*, which was part 6. Per-test coverage requires the customer to run their suite with per-test output configured — build and CI integration by definition. If a report with per-test identity happens to exist we import it, but no part of the plan depends on one, and `platform/impact` therefore answers "which symbols and files" without answering "which tests". Consistent with the same rule: nothing in this product ever executes the target, which is why "fix verification" above means re-running *analysis* over a named scope rather than running the program to see whether it still works.

### Identity boundary

Leveret Inspect owns **resolved facts an agent cannot recompute**: symbols, edges, impact closures, mechanical fix payloads, verification scopes. It does **not** own narrative explanation — architectural layering, module communities, guided tours, onboarding prose. This repository already consumes two external local tools that produce those artifacts on a commit hook, and narrative is what an agent synthesizes best. Keeping that boundary sharp is what stops the product drifting into competing with tools it should consume.

## 8. Consequences for code already written

Both implemented modules are green and both lose most of their volume. Sunk cost is not an argument.

**`runtime/` — approximately 1,300 of 1,980 lines of main source become dead weight.** Delete: `ipc/CommandFile.kt`, `ipc/ProcessCommands.kt`, `proc/CommandFactory.kt`, `proc/JvmOptions.kt`, `proc/ProcessLauncher.kt`, `proc/ChildHandler.kt`, `proc/ChildLifecycle.kt`, `proc/SearchHealth.kt`, `supervise/Scheduler.kt`, `supervise/NodeLifecycle.kt`, `supervise/Reloader.kt`, `Shutdowner.kt`, `ChildEntryPoint.kt`. Keep: `config/` entire, `fs/` minus the web directory, `log/` minus per-process files and the rolling-policy family. `proc/ProcessId.kt` collapses to one log-prefix constant; `App.kt` collapses to a main that loads settings, configures logging, and runs an analysis.

**`persistence/` — the dialect layer and its dependents go.** Delete: `dialect/` (an interface with two implementations existing so an operator can point the product at their own server), `charset/` (61 lines meaningful only when an operator can provision the database wrong), `profiling/` (a reflective proxy on every statement for trace output nobody enables), `schema/` (~209 lines of DDL synthesis, replaced by one hand-written schema resource), `pool/EmbeddedDatabase.kt` (a TCP listener that existed only so two processes could share one file). Trim: `pool/Database.kt` to one pool, `migration/` to a schema stamp plus rebuild, `session/LargeInputs.kt` to a call-site expression. Keep: `session/DbSession.kt` and `session/SessionFactory.kt`, `config/` trimmed to the surviving keys.

**The PostgreSQL dialect goes with it.** Last turn's decision to support PostgreSQL for production alongside embedded H2 assumed a server-shaped product. A single-operator local engine owns its store; one embedded file with a hand-written schema replaces both the dialect abstraction and the migration engine.

## 9. Specification prune manifest

Files whose every capability is cut, with survivors already recorded in sections 4 and 5:

`specs/platform/plugin-extension-runtime/`, `specs/platform/search-indexing/`, `specs/platform/identity-access/`, `specs/platform/web-ui/`, `specs/platform/events-notifications/`, `specs/platform/telemetry-monitoring/`, `specs/platform/clean-as-you-code-statistics/`, `specs/analyzers/php/`, `specs/analyzers/ruby/`, `specs/analyzers/scala/`, `specs/analyzers/rust/`, `specs/analyzers/dotnet/`, `specs/analyzers/css/`, `specs/analyzers/flex/`, `specs/analyzers/jsp-java-embedding/`, `specs/integrations/github/`, `specs/integrations/gitlab/`, `specs/integrations/bitbucket/`, `specs/integrations/azure-devops/`, `specs/integrations/ldap-authentication/`, `specs/integrations/saml-authentication/`

That is 21 of the 42 specification files, 7,156 lines, removed in commit scope below. The 21 that remain are listed next.

Files that stay as trimmed reference, each to carry a header pointing at this decision: `specs/platform/process-runtime/`, `specs/platform/persistence/`, `specs/platform/scanner-gateway/`, `specs/platform/compute-engine/`, `specs/platform/project-configuration/`, `specs/platform/analysis-results/`, `specs/platform/http-api/`, `specs/analyzers/java/`, `specs/analyzers/java-symbolic-execution/`, `specs/analyzers/kotlin/`, `specs/analyzers/python/`, `specs/analyzers/go/`, `specs/analyzers/javascript/`, `specs/analyzers/typescript/`, `specs/analyzers/html/`, `specs/analyzers/xml/`, `specs/analyzers/embedded-web-yaml/`, `specs/analyzers/infrastructure-as-code/`, `specs/analyzers/text-and-secrets/`, `specs/integrations/scanner-engine/`, `specs/integrations/jacoco/`.

`specs/manifest/` stays intact. `release-baseline.md` and `license-map.md` remain the provenance and licensing record regardless of scope; `coverage-index.md` gains a note that this decision supersedes its completeness obligation.

## 10. Risks and revival triggers

| Risk | Trigger that revives the cut capability |
|---|---|
| Trimming symbolic execution loses cross-procedure findings — a resource opened in one method and closed in another, a nullable returned from a modeled library call | a defect class users report missing that only the cross-procedure behavior cache catches |
| Cutting the durable queue removes resumability; a long analysis interrupted near the end starts over | the content-hash result cache proving insufficient on a large repository |
| Migration reduced to wipe-and-rebuild re-indexes on every version bump | user-authored state that cannot be recomputed, specifically an accepted-findings baseline |
| Dropping first-class PHP and Ruby leaves goals 4 and 5 at syntax fidelity for those languages | first real users on those stacks. Note both specifications already disclaim any semantic index, so the cut removes catalogs and parser embeddings, not a symbol model |
| Cutting the browser security header policy is safe only while the surface is a library call or loopback-bound | any HTTP adapter on a routable interface. The whole policy returns together — frame options, content-security policy, transport security, no-sniff, method allow-list. This coupling is exactly the kind that gets forgotten between releases; it is recorded against the transport decision, not the header list |
| Collapsing the issue lifecycle to present-or-suppressed | users needing a third state, acknowledged but still reported. Cheap before launch, expensive after |
| Deferring C# despite Roslyn being the strongest available semantic model | a build-free Roslyn workspace path that loads a checkout without build orchestration |

## 11. Execution questions — answered 2026-08-29

1. **Specification prune**: delete outright. Executed: 21 files, 7,156 lines, git history retains them.
2. **Code prune**: apply section 8 now. Executed across seven commits; `runtime/` main source 1,980 → 529 lines, `persistence/` 862 → 221 lines, both suites green.

## 12. External code-intelligence tool: build versus consume

`platform/code-graph` is the largest proposed part, so the local code-intelligence tool this repository already runs was evaluated as a substitute rather than assumed away.

**What it is.** A local code-intelligence indexer, version 1.6.0, MIT licensed, published on a public registry with a public repository. TypeScript on Node with a native kernel and 29 tree-sitter grammar extractors. It keeps a SQLite index per repository, exposes a CLI (`index`, `sync`, `query`, `explore`, `callers`, `callees`, `impact`) and a tool-server surface, and honours `DO_NOT_TRACK` for its usage counters. The MIT licence means vendoring, porting, or embedding are all legally available with attribution — the objection that would have ended this evaluation does not exist.

**Schema alignment is high.** Its `nodes` table carries identity, kind, qualified name, file, language, ranges, signature, visibility, export flag, and return type; `edges` carries source, target, kind, line, column, and a provenance marker; `files` carries a content hash for incremental sync; and `unresolved_refs` is a first-class table with a pending/failed lifecycle, candidate lists, and a name-tail index for retry. That is the shape section 7 proposed, and it independently supplies the two items the specification corpus lacked entirely: per-symbol visibility and export flags, and the unresolved-reference set as an output rather than a swallowed failure. As a design blueprint it is worth more than the corpus was on this subject.

**Resolution fidelity is the blocker.** Measured against this repository after the prune — 34 files, roughly 750 lines of main Kotlin — the index holds 370 nodes and 697 edges, of which 338 are structural `contains` and 359 are semantic (`calls` 223, `references` 55, `instantiates` 47, `imports` 34), against 740 references it failed to resolve. The honest breakdown matters: the large majority of those failures are external, `assertThat` 60 times, `Test` 38, then standard-library and test-framework names — references nothing in the repository can resolve without indexing dependencies, so recording them as unresolved is correct behaviour, not a defect. Only 120 failed references have a name matching any indexed node, and some of those are coincidental collisions on names like `contains` and `append`. Intra-repository resolution is therefore serviceable; dependency and type resolution are absent by design, because extraction is grammar-based with name matching and has no classpath, no inferred types, and so no overload, inheritance, or re-export discrimination. The provenance column is populated only for edges its callback and function-pointer synthesizers invent, so it marks synthesis rather than grading confidence.

**Verdict.** Adopt the design, not the index.

| Shape | Verdict |
|---|---|
| Keep consuming it as development tooling for this repository | **Yes, unchanged.** It already answers `callers`, `callees`, and `impact` for our own source today, which is a reason not to rush `platform/impact` for internal convenience — that part exists for the product, not for us. |
| Mirror its schema in our own store, with attribution | **Yes.** Validated design, MIT, zero runtime coupling. `nodes` / `edges` / `unresolved_refs` / `files` with content hashes is the starting shape for `platform/code-graph`. |
| Shell out to its CLI and read its SQLite file as the breadth tier for languages we own no frontend for, marking those edges name-only | **Deferred, with a trigger.** Costs a Node runtime in our distribution and couples us to an undocumented internal schema currently at its ninth migration. Trigger: a user needing structural answers for a language outside the Tier-1 set. |
| Port the grammar-based extraction approach to the JVM for that same breadth tier | **Deferred behind the option above.** Same capability without Node in the distribution, at medium-to-large cost. Only worth it if the shell-out proves unacceptable in practice. |
| Adopt its index as the product's graph | **No.** Section 3 fixes this product's identity on resolved facts an agent cannot recompute. A name-matched graph with no type resolution cannot carry goal 5's soundness claim, and building on it would make Leveret Inspect a wrapper over a tool it is supposed to differentiate from. |

The per-edge basis field — `checked`, `declared`, `documented`, `import-scoped`, `scope-local`, `name-matched`, `synthesized` — is what lets facts of different strength coexist in one graph without the weak ones quietly contaminating a blast-radius answer. It replaces the three-value `resolved` / `name-only` / `heuristic` field proposed here, which had no slot for facts that are decidable without a type checker.

**Superseded in part by `docs/specs/2026-08-29-code-graph-sourcing.md`.** That evaluation extended this comparison to the wider ecosystem and reached a different conclusion about *who produces* the resolved tier: not frontends of our own for five languages, but existing compiler-backed producers we ingest — with Kotlin as the single unresolved case. It also closes the improve-or-fork question for both local tools: neither, on architectural and maintainer-intent grounds recorded there, with the payoff for our own development loop bounded at 120 edges by the measurements above.
