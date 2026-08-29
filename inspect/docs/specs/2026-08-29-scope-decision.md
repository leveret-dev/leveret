# Scope Decision

**Date:** 2026-08-29
**Status:** Proposed — awaiting owner approval on the two execution questions in section 11
**Supersedes:** the coverage obligation in `specs/manifest/coverage-index.md`, which required every inventoried upstream artifact to map to a full specification
**Method:** six parallel read-only audits over the 34-file specification corpus (18,075 lines), each judging capabilities against the product goals below with per-row evidence

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

1. **`platform/code-graph`** — symbols, typed edges, per-edge resolution confidence, the unresolved-reference set as a first-class output, and delta application so one analysis replaces only its own facts. Consumes `platform/persistence`. **Large**; the cost is one emitter per language plus a symbol key stable across re-analysis. Every other part reads from it, and it is the one thing a consuming agent provably cannot rebuild per query — the analyzers already pay for resolution to evaluate rules, so resolved edges are a by-product of work already done.
2. **`platform/agent-gateway`, minimal** — symbol lookup and references over a library API plus a local socket, with the index version and head revision on every response. **Small.** It makes part 1 useful the day it lands and fixes the query vocabulary before later parts inherit a browser-shaped one.
3. **`platform/impact`** — the closed affected set with hop distance and edge paths, bounded traversal with a truncation marker naming which bound fired, and a mandatory count of unresolved references on the frontier. **Medium.** Leveret Inspect returns the set and the paths; ranking which of them matters is the agent's judgment about its current task.
4. **`platform/change-scope`** — a change set as a first-class request, plus the classification of every result kind as incremental, dependent, or full-pass. **Medium.** The agent knows its diff perfectly well; what it cannot know is which results the diff invalidates.
5. **`platform/remediation`, mechanical subset** — ordered text edits with exact ranges, a safety class, and the re-analysis scope that must come back clean. **Medium**, small if scoped to rules whose analyzer already computes an exact range. Opt-in per rule. Prose fix generation stays with the agent, which does it better.
6. **Test attribution ingestion** — per-test coverage that preserves test identity against line ranges. **Small to medium**, with most of the cost outside this repository.

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

That is 21 of 34 specification files, approximately 11,400 lines.

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

## 11. Execution questions for the owner

1. **Specification prune**: delete the 21 files outright, relying on git history, or move them to `specs/archive/` with a pointer from this document?
2. **Code prune**: apply section 8 to `runtime/` and `persistence/` now, or leave both modules intact until `platform/code-graph` needs the space?

Both are recorded here so that either answer leaves an auditable decision.
