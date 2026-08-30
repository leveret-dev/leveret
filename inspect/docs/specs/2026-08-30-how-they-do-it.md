# How Shipping Products Get Their Results Without a Build

**Date:** 2026-08-30
**Status:** Approved. Synthesis of four investigations; amends `docs/specs/2026-08-29-code-graph-sourcing.md` §5.8, §9, §10, §12.
**Inputs:** `2026-08-30-snyk-without-build.md`, `2026-08-30-aikido-without-build.md`, `2026-08-30-reachability-without-build.md`, `2026-08-30-question-cost.md`, `2026-08-29-coderabbit-approach.md`

## 1. The answer in one line

They are not solving the problem we thought was unsolvable. They **decompose it into four cheaper problems**, three of which need no build at all, and they decline the fourth — including the vendors who have the inputs for it sitting in hand.

**Read §10 first if reading this once.** All four mechanisms are workarounds for being vendor-hosted, and we are not: the customer installs and operates the engine, so their runner already holds the credentials, caches, and toolchain these mechanisms exist to avoid needing. Sections 2–8 remain correct about what the vendors do and why; §10 corrects which of it we actually need.

The four mechanisms, each verified against a primary source:

| # | Mechanism | Who ships it | What it replaces |
|---|---|---|---|
| 1 | **Trust the committed lockfile as the resolved transitive closure** | Snyk, Aikido, everyone | dependency resolution we thought we had to perform |
| 2 | **Curated library API models matched by signature, not resolved type** | Snyk Code, Semgrep, Aikido, CodeQL | a type checker, for the sources-and-sinks question |
| 3 | **Syntactic cross-file name resolution** — import graph plus heuristic type inference, no compiler | Semgrep Pro / Opengrep, Snyk Code | a compiler frontend, for cross-file dataflow |
| 4 | **Central precomputation of public artifacts once, stitched per customer** | Endor Labs, Socket, deps.dev | per-analysis fetching and indexing of dependency code |
| 5 | **Agentic research across named sibling repositories** | CodeRabbit | cross-repository symbol resolution |

Mechanism 4 is the one we had not considered at all, and it is the direct answer to the private-dependency problem's public half.

## 2. Mechanism 1: the lockfile *is* the answer

Our §5.8 treated "resolve the dependency graph" as work the product performs. Two vendors show it is work the **customer's package manager already performed and committed**.

- Aikido parses lockfiles across ~15 ecosystems and **never re-resolves a dependency graph itself**; manifest-only inputs (no lockfile) are documented as lower-accuracy.
- Snyk's per-ecosystem split is sharp and worth copying verbatim as a design table:

| Ecosystem | Build needed? | Why |
|---|---|---|
| npm, Yarn, pnpm, Composer, Bundler, CocoaPods | no | lockfile parse; build only when no lockfile exists |
| Gradle | no | Snyk drives Gradle's own `compileClasspath` inspection |
| Go | no build, but yes a toolchain | shells `go list -json -deps` |
| **Maven** | **always `mvn install`** | **no lockfile format exists for Maven** |
| .NET SDK-style NuGet | yes, no fallback | "Snyk uses the build system to determine which dependencies are installed" |
| C/C++ | n/a | no manifest concept; hashes vendored sources against a database of official release archives, confidence-scored |

**The JVM is the worst case in the industry, and Maven is the reason.** Every vendor either requires a build for Maven (Snyk, Endor) or shells out to Maven purely to *resolve* (CodeQL `build-mode: none`). This is not our failure of imagination; it is a gap in the ecosystem. It also means our JDT rung-1 measurement — declarations plus a local artifact cache, no build tool invoked — is the single most valuable unmeasured number in the whole design, because nobody else has published it.

## 3. Mechanism 2: sources and sinks are matched by name, not resolved

Snyk Code (DeepCode lineage, ETH Zurich) pipeline per its own docs: parse → AST → "event graph" → proprietary logic-solver rule match. **No compile step, no classpath, no dependency archive read anywhere.** Snyk states plainly: "Snyk does not require compilation or a build to perform analysis."

How does it know `HttpServletRequest.getParameter` is a source? Its "Framework support" doc gives it away: coverage is gated on being **"trained on Projects using the framework"**, security-team annotated, and rated *Comprehensive* or *Partial* by named source/sink completeness. That is a curated per-library signature model, in the same category as CodeQL's and Semgrep's — not resolved-type binding.

**Consequence for us:** the flaw-finding consumer needs a *curated model of well-known library APIs*, not resolution into dependency code. A rule can fire on `getParameter(...)` reaching `executeQuery(...)` with only import-scoped confidence that the receiver is the modelled type. Precision comes from the model's quality, and the model is a data asset we author once — not a capability gated on a classpath.

## 4. Mechanism 3: syntactic cross-file resolution, shipping at scale

Semgrep Pro (and Aikido's Opengrep fork of Semgrep CE, which is Aikido's disclosed SAST engine for every language) performs whole-project **syntactic** name resolution: matching identifier uses to import and declaration sites across files, populating an `id_info` AST field, then layering heuristic type inference, cross-file constant propagation, and cross-file taint on top. Semgrep's own product page: it "works without compiled code."

This is the same class of mechanism as our import-scoped resolver from work item 11 — and it is what a product with a very large install base ships as its cross-file story. Our design was not settling; it was arriving at the industry's actual answer.

Self-disclosed limits worth inheriting as known ceilings: a CommonJS export-pattern gap, CE/Pro result divergence, automatic fallback to single-file analysis above 5 GB or 3 hours, and polyglot repositories (call chains crossing language boundaries) named by Semgrep as structurally unsolvable for a single-repo source-only tool. Aikido's own split: 12 languages get real cross-file taint, 7 are intra-file only.

## 5. Mechanism 4: index the public half once, centrally

This is the finding that changes our design, and it is a direct quote from Endor Labs' own engineering write-up, not our inference:

> "we create a call graph per package version, store those call graphs and then, given a client dependency set, we stitch them on the fly."

Verified as a real shipping pattern at three vendors, at three granularities:

| Vendor | Granularity of the central index | Public? |
|---|---|---|
| Endor Labs | per-package-version **function-level call graphs** | no, proprietary |
| Socket | per-CVE curated vulnerability→function specs | no |
| deps.dev (Google) | package/version/license/advisory/dependency-graph only — API v3 schema verified to have **zero** symbol or call-graph fields | yes, documented API |

The counter-example matters equally: Sourcegraph SCIP indexing is **per-tenant**, and its own documentation says cost "scales with the depth of your dependency graph" — no cross-customer sharing. So the pattern is real but not universal, and the ones who do it built the index themselves.

**Why this is the answer to §5.8's bucket three.** A public artifact is identical for every customer. Indexing `com.fasterxml.jackson.core:jackson-databind:2.17.0` once yields declarations and call edges reusable across every analysis forever. Nothing is fetched per review; nothing is compiled; the customer's private code is resolved *against* that index locally. Private artifacts stay unresolved — but the index removes the entire public half of the problem from the per-analysis critical path, and the public half is the larger half.

**What it does not solve, stated honestly.** Endor's own Java docs still require the customer to have run a successful local build (`.m2` cache populated, target artifact on disk) for full function-level reachability; the precomputation removes re-analysis of the *dependency* side, never the first-party root. When the build fails, Endor drops to dependency-level only — no call graph, no function granularity. So central precomputation is a dependency-side optimisation, not a first-party resolver.

## 6. CodeQL `build-mode: none`: our design problem solved in public

GitHub added a no-build mode for Java, made it the default for Java-only repositories, and documented the tradeoffs. It works on **>90% of Java repositories** by GitHub's own account. Mechanically it still shells out to Maven or Gradle to **resolve dependencies** — needing network access, and private-registry credentials for accuracy — but **never invokes a compile**.

That is precisely the cut point our escalation ladder was groping for, chosen independently by the largest code-scanning deployment in existence: *resolve, don't compile*. And its documented failure modes are a free list of what to expect: inaccurate dependency guesses when build scripts cannot be queried, generated code invisible, JDK-version collisions causing partial analysis, colliding class names breaking dataflow call targets, Kotlin unsupported in mixed repositories.

## 7. What nobody solves, regardless of build

Every vendor examined — CodeQL, Endor, Socket, Aikido, Snyk — documents the same blind spots whether or not a build ran: **reflection, dynamic dispatch and loading, generated code, dependency-injection wiring.** A build buys type-resolution confidence, not reflection confidence. Snyk requires bytecode for CLI reachability and still carries the caveat; Endor's full-build Java mode carries it too.

This validates the runtime-wiring-sites honesty channel from §5.3 as the correct and complete answer to that class, and it removes any suggestion that a build would have rescued it.

## 8. The mis-framing, named

Per `2026-08-30-question-cost.md`: our comparison measured **inputs** (does the vendor install dependencies? execute shell?) instead of **outputs** (which question does each feature answer, and what does answering it honestly require?).

Ranked by minimum input, the questions a review product answers form nine cost levels — L1 single file with no semantics, through L7 fetched public declarations, to L8 type checker plus classpath, and L9 statically undecidable. Mapping our five goals onto them:

| Goal | Levels it needs | Needs L8? |
|---|---|---|
| 1. Analyze source | L1–L3 | no |
| 2. Find flaws | L1–L7 for the overwhelming majority | only for a bounded checked-type minority |
| 3. Suggest fixes | rides goal 2's evidence | same minority |
| 4. Understand the codebase | L6–L7 | **no** |
| 5. Blast radius of a change | L6–L7, plus L9 as an honesty channel | **no** |

**No goal in this product requires L8 to function.** L8 raises precision on an already-named minority of goal-2 and goal-3 findings. Goals 4 and 5 — the ones we called join-and-reachability and assumed forced a resolved symbol graph — bottom out one level short of a type checker, because reachability through first-party code needs only the import graph.

CodeRabbit is the proof from the vendor side: it reaches L8's *inputs* (it installs dependencies, it can execute shell) and still ships type-aware TypeScript rules disabled and Java deep analysis off by default. **They built the elevator to the top floor and ride it to the sixth.**

## 9. Amendments this makes to the design

1. **A curated library API model becomes a first-class part**, not a rule-authoring detail — the mechanism that makes flaw-finding work without resolution into dependency code (§3). Coverage is per-framework and admits *Comprehensive* / *Partial* grading, as Snyk's does.
2. **A central public-artifact index becomes the design's answer to the public dependency half** (§5): index public artifacts once by coordinate, keyed by the exact version and hash the lockfile pins, and stitch to first-party code per analysis. Removes fetching from the per-review path entirely.
3. **The lockfile is promoted from evidence to primary input** (§2). Per-ecosystem behaviour is a table we own, and Maven's missing lockfile format is a first-class special case, not an edge case.
4. **"Resolve, don't compile" replaces the rung 1/2/3 ladder's centre of gravity** (§6). Dependency resolution without compilation is where the industry's default sits.
5. **Rung numbering is now ambiguous** between the execution ladder (rungs 1–3, §5.3) and the question-cost levels (L1–L9). The execution ladder keeps "rung"; question cost uses "level".
6. **The rung-1 Java number stays the most valuable unmeasured quantity**, and §2 explains why nobody else has published it: on Maven, everyone either builds or shells out to Maven, so the declarations-plus-cache path is genuinely unexplored territory rather than a known-bad option.

## 9a. Mechanism 5: agentic cross-repo research, and why resolution beats it

CodeRabbit's multi-repo analysis (`docs.coderabbit.ai/knowledge-base/multi-repo-analysis`, read 2026-08-30) is the fifth mechanism, and it is the clearest case in this whole survey of a vendor substituting inference for a fact they cannot obtain.

**What it does.** The customer names related repositories as `org/repo`, optionally with free-text `instructions` — capped at 2,000 characters — telling the agent what the repository contains and where to focus. During a review, a research agent inspects the change, decides whether it may affect a linked repository, searches that repository, and reports cross-repository impact if it finds any. On higher plans, automatic linking "infers relationships by examining import statements, dependency manifests, API consumption, and broader architectural patterns", accumulating links "progressively... over time as it reviews more pull requests". The number of linked repositories is capped by plan.

**What that tells us.** A plan-capped *count* of repositories, and discovery that accrues per review rather than existing upfront, both say the same thing: this is per-review research cost, not an index. And the auto-linking signals — imports and dependency manifests — are precisely the declarations any dependency parse already reads. They are inferring, from data that states the answer outright, a relationship they then hand to an agent to go search.

**Why we do not need it.** A coordinate in the lockfile matching a coordinate an organisation repository publishes **is** the link — deterministic, available on the first review, no accumulation, no cap, no free-text hint about where to look. And the output is different in kind: resolved symbols and edges rather than an agent's reading of a sibling tree. `docs/specs/2026-08-29-code-graph-sourcing.md` work item 18 records this, along with the part their design has to confront too and ours must state explicitly — **which ref**, since a sibling repository's default branch is not the version the lockfile pins. Notably their docs handle the same problem the same way: default branch by default, with an option to point at a specific branch or pull request when the change you depend on has not merged.

**Where it is genuinely better.** Nothing about resolution answers "does this change break a *contract* that is not a symbol" — a REST route, a database schema, a serialisation shape, a queue message. Their four named use cases are mostly this, and an agent reading two repositories is a reasonable answer to it where a symbol graph is not. That is orientation work (§8, consumer two), and it needs the graph to point the model at the right files rather than to replace it.

## 10. The mechanism we already had and did not price: the runner is theirs

Owner observation, 2026-08-30, and it reorders this whole document: **all four mechanisms above are workarounds for a constraint we do not have.** Every vendor in §1 is vendor-hosted for its primary path, so each had to invent a way to avoid needing the customer's environment. We ship an engine the customer installs and operates. Their runner already contains what those mechanisms substitute for.

| Mechanism above | What it substitutes for | Still needed on a customer-operated runner? |
|---|---|---|
| 1. Trust the lockfile as the closure | resolving against a registry we cannot reach | **partly** — the lockfile is still the cheapest and most reliable read, and it works cold |
| 2. Curated library API models | a type checker over dependency code | **yes, independently** — it is cheaper than resolution even when resolution is available, and it is how rules stay silent honestly |
| 3. Syntactic cross-file resolution | a compiler frontend | **yes** — it is the floor, and the floor must always work |
| 4. Central public-artifact index | fetching and indexing dependencies per analysis | **demoted** — a cold-start optimisation, no longer the answer to private dependencies |

The evidence for the inversion is already in §5 and §6, read the other way round. Endor Labs' Java scan requires a populated `.m2` and a built artifact *because it runs where the build ran*. CodeQL's `build-mode: none` shells out to Maven to resolve and documents needing private-registry credentials for accuracy — **GitHub's default Java mode works because it executes inside the customer's own Actions runner.** Snyk's CLI reachability can demand compiled bytecode for the same reason, while its SaaS path, the one that never sees the customer's environment, is the one that cannot. Their requirements are not admissions of weakness; they are the shape of a tool that runs on your machine, which is our shape.

The differentiator is therefore narrow and real: the vendor-hosted reviewers in CodeRabbit's class have **no route to a private artifact at all**, and that is structural for them. The tools that do have a route already require what we would require. So this is not a novel capability — it is a capability we were about to design around instead of using.

**And the runner is a component we build, not an environment we survey.** Owner correction, same day: successive drafts wrote "cold ephemeral runner", "cache may be absent", "toolchain may be missing", and "cold start is prohibitive" as facts about the world. They are properties of something we ship. A dependency cache keyed by lockfile identity, a persistent fact store, warm sibling-repository indexes, provisioned toolchains, and a resident process that pays compiler cold start once are all work items, not constraints. Mechanism 4 changes shape accordingly: the public-artifact index is best shipped as a verifiable data bundle the runner pulls and extends locally, not as a service of ours in the request path.

Almost nothing survives that question. A cold runner is warmed as the first step of the first analysis, so it costs one-time latency and never fidelity. The single thing we cannot provision is **authority we were not granted** — an unconfigured registry, an unshared repository — and that is a reporting obligation, not a design constraint: resolve as far as authority allows, then name the host, the coordinates, the affected-reference count, and the grant that would close the gap.

Full analysis, including what it costs (fork-authored build logic on a credentialed runner is the sharp edge) and what it promotes (the warm-cache rung-1 Java configuration, never measured by anyone), is in `docs/specs/2026-08-29-code-graph-sourcing.md` §5.5.

## 11. Licensing a facts-only index: decided

**Owner decision, 2026-08-30: a derived index of declarations and edges over public artifacts is licence-safe, and the risk row is narrowed to a schema constraint rather than an open legal question.** The reasoning, recorded so it is not re-litigated:

- **Signatures and declarations are functional facts about a published interface, not expression.** A row saying that `com.example.Client` declares `send(Request): Response` describes the work; it does not reproduce it. That distinction is the whole basis of the fact/expression line in copyright.
- **The closest authority is directly on point and favourable.** *Google LLC v. Oracle America* (US Supreme Court, 2021) held that copying the Java SE API's declaring code was fair use, on a transformative-purpose analysis. Our use is narrower than the one upheld there: we do not reimplement the interface, we describe it, and we describe it in order to answer questions about the customer's own code.
- **The interoperability line runs the same way.** *Sega v. Accolade* and *Sony v. Connectix* permit intermediate copying to obtain interface facts; in the EU, Software Directive 2009/24/EC excludes ideas and principles from protection and permits observation and study directed at interoperability. Reading a published artifact to learn what it declares sits inside that.
- **Copyleft does not propagate to a fact table.** Reading a GPL or AGPL artifact to record its declared signatures neither links against it nor produces a derivative work of it in any ordinary reading. Nothing of the licensed work ships in our index.
- **The EU database right runs in our favour, not against us.** The sui generis right protects the maker's substantial investment in a database — which describes ours.
- **The practice is broad, old, and unlitigated.** Registry indexes, `deps.dev`, dependency graphs at the major forges, every IDE's local symbol cache, and at least two commercial reachability products (§5) all store derived facts about third-party artifacts.

**What the decision does not cover, and therefore what the schema must forbid.** Doc comments are authored prose and are unambiguously expressive; method bodies and cached source or bytecode fragments are the work itself. An index holding those is a text cache with an index attached, and every argument above stops applying to it. So the constraint is structural: **the shared index has no column for a doc comment, a body, or a source fragment.** Where a reviewer needs a doc comment, read it at answer time from the artifact the analysis already holds, per-customer, and do not persist it centrally.

**The live constraints are operational rather than legal.** Registry terms of service govern bulk fetching — rate limits, mirroring guidance, and polite-crawler expectations at Maven Central and the npm registry are contract and etiquette, not copyright, and they bound how fast the index can be populated. Storage scale, refresh policy on new versions, and whether coverage is exhaustive or popularity-ranked remain open and are engineering decisions.

## 12. Contested and unverified

- **Snyk Java reachability has two delivery paths and our slices disagreed about which is authoritative.** The SCM/SaaS import path is GA and Snyk's own reachability page states it analyses "without requiring the application to be built prior to the scan". A separate Snyk support article, reachable only via a search-engine cache (`support.snyk.io` returned HTTP 401 live and archived), states the CLI path (Early Access) requires "the app already built (compiled), and the bytecode of the app should be available". Most probable reconciliation: two paths with different requirements, the SaaS one build-free. `[UNVERIFIED — the CLI quote could not be fetched directly]`
- Aikido's container-scanner identity (Trivy, per third-party blogs) is not confirmed in Aikido's current primary docs. `[UNVERIFIED]`
- Endor's central call-graph index granularity and retention are described in an engineering blog, not a spec; whether it covers all package versions or a popularity-ranked subset is unstated. `[UNVERIFIED]`
- No vendor publishes reachability-specific precision or recall. The only independent numbers found are general SAST detection figures from an academic benchmark. `[UNVERIFIED for reachability]`
