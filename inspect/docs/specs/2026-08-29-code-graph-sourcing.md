# Code Graph Sourcing: Build, Improve, or Consume

**Date:** 2026-08-29
**Status:** Approved. The four spikes in section 11 ran on 2026-08-29; results are recorded there and in `docs/spikes/`. `platform/code-graph` is now plannable, and **no compiler frontend of our own is required.**
**Amends:** `docs/specs/2026-08-29-scope-decision.md` sections 7 and 12. Section 7 costed `platform/code-graph` as **Large**, driven by "one emitter per language analyzer". That assumption does not survive this evaluation.
**Method:** four parallel source-verified library investigations, every licence read from the project's own licence file, every maintenance claim pinned to a release or commit date observed on 2026-08-29

## 1. The question

Before writing per-language semantic frontends, three cheaper paths were tested: improve the MIT-licensed local indexer we already run, adopt the second local tool, or consume an existing code-graph library — with particular attention to Java and Kotlin, where the ecosystem is richest.

The conclusion, stated first: **stop planning to write frontends; plan to ingest resolved facts from compiler-backed producers, and own the store, the confidence model, and the queries.** Improving either local tool is the wrong investment, for reasons that are about their architecture and their maintainers' stated intent rather than their quality.

## 2. Verdicts

**Scope rule, settled 2026-08-30. Three statements, and they replace every earlier form.**

1. **Nothing is ever built.** No compilation, no package-manager invocation, no build-tool invocation, no generator, no target execution — not on our machines, not on theirs, not opportunistically. The rungs 2 and 3 that earlier drafts admitted as "opportunistic" are **cut**, and section 5.3 records what that costs.
2. **Dependencies resolve by exactly two routes.** Either the artifact is **public and pinned** by the target's own declarations and lockfile, and we fetch it by coordinate and hash; or it is **private and its source is a repository we already read as its reviewer**, and we resolve against that source. **No private registry, ever** — no Artifactory, no Nexus, no authenticated index, no credential of the customer's held or used by us.
3. **Everything before the model serves the review.** Facts, findings, and orientation are evidence that enters a review; none of them is a separate product. This is why the specification corpus is being mined for capability rather than reproduced as a system: no dashboards, no quality gates, no debt ratings, no portfolio reporting (section 5.9).

The consequence worth stating plainly: **the product's fidelity is exactly what declarations, public archives, and readable sibling sources yield.** There is no escalation path that rescues a weak answer, which makes the unmeasured rung-1 Java number in section 11 the single gating measurement of the design.

This rule went through four wrong forms before settling, all recorded because the reasoning matters more than the conclusion. First "nothing executes, ever", which cut producers on a rule the owner never set. Then "sandbox execution is free because it imposes no customer burden", which ignored that a vendor-hosted sandbox cannot reach a private registry. Then "the runner is the customer's, so escalation usually works", which was true about authority and wrong about desirability. The settled form cuts building outright — not because it is impossible, but because a resolution path that depends on reproducing somebody else's build is a path whose reliability we cannot state, and an unreliable tier that no feature may depend on is a tier not worth maintaining.

| Candidate | Licence | Last activity | Fidelity | Shape for us | Verdict |
|---|---|---|---|---|---|
| Local grammar indexer (`@colbymchenry/codegraph`) | MIT | release 2026-08-26 | name matching, no classpath | separate process, Node + native addon | keep as dev tooling; do not improve, do not fork |
| Graphify (`graphifyy`) | Apache-2.0 | package current | tree-sitter + path resolution; plus a language-model narrative layer | Python CLI, output format only | keep as comprehension aid; never an input |
| **Eclipse JDT Core** | EPL-2.0 | release 2026-06-09, commit 2026-08-02 | **real ECJ compiler bindings, classpath optional, no build required** | **embeddable JVM library, Maven Central** | **adopt for Java** |
| **SCIP format + JVM bindings** | Apache-2.0 | schema v0.9.0 2026-06-29 | n/a (format) | `org.scip-code:scip-java-bindings`, in-process parse | **adopt as an optional import format** — free fidelity when a customer already produces an index, never a requirement |
| scip-go | Apache-2.0 | commit 2026-08-14 | compiler-backed (`go/packages`) | separate process, emits SCIP | **cut by the no-build rule** — needs the Go toolchain and a resolved module tree. Go modules ship *source*, so fetching declarations replaces most of it |
| scip-java (Java) | Apache-2.0 | release v0.13.1 2026-07-02 | compiler-backed `javac` plugin | drives Gradle/Maven/Bazel | **cut by the no-build rule** — drives the target's build by design. JDT covers Java from a classpath alone |
| scip-java (Kotlin) | Apache-2.0 | same | cannot load into any Kotlin ≥ 2.3, measured | separate process | **cut** — disqualified on both counts |
| scip-typescript | Apache-2.0 | commit 2025-10-03 | compiler-backed (`tsc`) | Node CLI, emits SCIP | **cut by the no-build rule** — needs installed packages. Fetched `.d.ts` declarations replace most of it |
| scip-python | MIT | commit 2025-09-05 | compiler-backed (Pyright inference) | Node CLI, emits SCIP | **cut by the no-build rule** — needs a resolved environment. Independently distributed type stubs replace most of it |
| Joern `kotlin2cpg` / flatgraph | Apache-2.0 | commits 2026-08-28 | **embeds `kotlin-compiler-embeddable`** — genuinely compiler-backed Kotlin | Scala library, pinned compiler version | spike for Kotlin only |
| Kotlin Analysis API (K2 standalone) | Apache-2.0 | tracks Kotlin releases | real K2/FIR resolution without Gradle | JVM library, **not on Maven Central**, no stability guarantee | spike for Kotlin only |
| SootUp | LGPL-2.1 | release 2026-03-19 | bytecode, sound for its algorithm; needs compiled classes | embeddable JVM library, pure Java | **cut by the no-build rule** — no class files exist without a compile. The 961-edge measurement stands as the argument for revisiting if that rule ever changes |
| WALA | EPL-2.0 | release 2026-07-01 | bytecode, more precise dispatch analysis | embeddable JVM library | spike against SootUp once the bytecode tier is live |
| tree-sitter (`io.github.treesitter:jtreesitter`) | MIT | current | parse only, no resolution | **embeddable JVM library** | adopt as breadth substrate |
| JavaParser symbol solver | Apache-2.0 / LGPL-3.0 | release 2026-06-01 | hand-written approximation of compiler semantics | embeddable JVM library | reject — JDT is higher fidelity at equal cost |
| Spoon | CeCILL-C / MIT | release 2026-07-14 | JDT underneath | embeddable JVM library | reject — depend on JDT directly |
| OPAL | BSD-2-Clause | commit 2026-01-19 | bytecode | JVM library, pulls a Scala runtime | behind SootUp and WALA; the Scala runtime is the tiebreaker against it |
| Depends | MIT | commit 2026-04-20 | ANTLR grammars, no build | pure-Java, runnable jar | spike for the non-Tier-1 breadth gap |
| Kythe | Apache-2.0 | release 2026-07-16 | compiler-backed, requires compilation | CLI extractors per language | **cut by the no-build rule** |
| Glean | BSD-3-Clause | commit 2026-08-28 | ingests others' facts | Haskell over C++ and RocksDB, Thrift, no JVM client | reject the runtime, **steal the incremental design** |
| Stack graphs | Apache-2.0 / MIT | **archived** | syntactic name resolution, no types | Rust crates, no JVM binding | reject |
| CodeQL | proprietary terms | active | best fidelity surveyed | CLI | **reject — licence forbids our use case** |
| jQAssistant | **GPL-3.0** + embedded GPLv3 database | plugins 2026-06-26 | bytecode | JVM tool | reject — unshippable |
| OpenGrok | CDDL-1.0 | release 2026-08-24 | ctags plus a text index, not typed edges | JVM | reject |
| Sourcetrail | GPL | **archived 2021-12-14** | — | — | reject |

## 3. Improving the local grammar indexer: no, and the reasons are structural

Three independent blockers, each verified against its source rather than inferred:

**Its store has no concept of a dependency.** Nodes are populated exclusively from tree-sitter parses of project source text, and the file watcher tracks source files only. A compiler-backed resolver's candidate universe is the classpath — project classes plus every dependency archive. That is not a resolver swap; it is a category of input the schema was never designed to hold.

**Its distribution promise contradicts ours.** The product ships as a self-contained binary with a bundled runtime and signed release artifacts, explicitly requiring nothing to be compiled. Requiring a JDK for one language's resolution tier breaks that promise and adds a dimension to a release matrix that is not ours to complicate.

**The maintainer has drawn the boundary deliberately.** On the project's own issue tracker, closed 2026-06-02: compiler and language-server grade correctness and this tool "solve different problems and are complementary… LSP serves the editor's cursor; codegraph serves the agent's reasoning over the whole repo." The promoted roadmap builds a hosted layer *on top of* name-matched resolution, not a replacement for it.

Forking is legally trivial under MIT and practically unwise: `resolution/` is among the most actively changed subsystems in a near-daily-release project, so a fork owes an indefinite rebase tax for a capability upstream does not want.

**And the payoff would be small for us anyway.** Section 12 measured 740 unresolved references against 359 semantic edges on this repository, of which at most **120** could be internal misses — the rest are standard-library and test-framework names that no amount of name matching can resolve. A perfect resolver bolted onto that tool adds at most 120 edges here: **+33% of semantic edges, +17% of all edges**, before excluding coincidental collisions. Our own tool policy already routes authoritative definition, reference, and rename queries through a real language server, so those 120 edges are the difference between a fast first pass and a slightly faster first pass — not between right and wrong.

## 4. Graphify: no, and the two halves fail for different reasons

Apache-2.0, actively developed, corporately backed. Its graph over this repository is 449 nodes and 672 edges, of which **629 are `EXTRACTED`** — deterministic tree-sitter parsing plus a real cross-file resolution pass of roughly 3,100 lines covering path aliases, workspace resolution, and per-language import conventions — and **43 are `INFERRED`**, produced by a language-model pass over Markdown, alongside 3 narrative hyperedges.

The deterministic half is a real code-graph substrate, less mature than the other tool's equivalent, and written in Python: wrong runtime, no fidelity gain, nothing to improve toward our goal. The inferred half is its actual differentiator and is precisely what section 7's identity boundary excludes from what this product owns. Keep consuming it in the development loop; never feed it into `platform/code-graph`.

## 5. The finding that changes the plan

**For Java, a compiler-backed resolver runs in our own process, needs no build, and is on Maven Central today.** Eclipse JDT Core's `ASTParser` with `setResolveBindings(true)` yields real ECJ bindings — `ITypeBinding`, `IMethodBinding`, `IVariableBinding` — from a plain list of classpath entries. Measured on 203,436 lines of external Java: **99.998% of reference names and 100% of call sites resolve with a classpath**, at roughly 20 ms per thousand lines, from 10 jars totalling 10.6 MB. Pure Java, no second language runtime, EPL-2.0 file-scope copyleft safe to embed unmodified.

One claim in the first draft of this document was wrong and is struck: recovered bindings are **not** a usable `name-only` signal. `isRecovered()` is non-transitive — 51.9% of bindings that report `false` carry a recovered type underneath — it is never raised on calls at all, and 56% of the flags it does raise name the wrong symbol, one static-imported method recovering to a fabricated type. The correct ingest rule is `setBindingsRecovery(false)`, with a null binding becoming an unresolved-reference record. Details in `docs/spikes/2026-08-29-jdt-java-resolution.md`.

That single fact reframes `platform/code-graph`: it is not a part that writes semantic frontends. It is a part that **ingests resolved facts from producers of differing fidelity, records how each fact was obtained, and answers reachability questions over the result.**

### What a checkout at rest actually yields

**Correction, and it matters more than the trim it follows.** The three-value confidence vocabulary — `resolved`, `name-only`, `heuristic` — has no slot for facts that are decidable without a type checker, so writing it made me collapse "no compiler-backed resolver for language X" into "no semantic route for language X". That inference is wrong. Most of what goals 4 and 5 need is decidable from source, dependency declarations, and artifacts we can fetch ourselves — for every language, not just the two with an adoptable compiler frontend.

The unit of confidence is therefore not a tier but the **basis of each fact**:

| Fact | Basis | Needs a type checker? |
|---|---|---|
| Declarations: qualified name, kind, range, and syntactic visibility | parse tree | no |
| File and module import edges | import statements plus the language's own module and path rules | **no — these are decidable, not guessed** |
| Binding within a file or a scope | scope rules | no |
| Cross-file binding where the import graph leaves exactly one reachable candidate | import-scoped name resolution | no |
| Declared and annotated types | the source states them: TypeScript annotations, Go's static types, Python annotations, JSDoc tags | no |
| External symbol attribution: which package a name comes from, and its declared signature | dependency declarations plus declarations read out of the artifacts they name | no |
| Overload selection, generic instantiation, inheritance-precise dispatch, implicit conversion | type inference over the whole program | **yes** |
| Dependency injection, reflection, proxies, configuration-named classes | nothing static | invisible; counted, never guessed silently |

**Import-scoped resolution is the line I misdrew.** Global name matching over this repository finds 120 unresolved references whose name matches some indexed declaration — but 676 candidate pairings for those 120, roughly 5.6 candidates each, which is why a name-matched edge deserves no confidence. Resolving the *same* reference only against declarations reachable through that file's own import edges collapses most of those candidate sets to one. A fact that survives that test is not a guess; it is a resolved fact obtained without a type checker. Of the 740 references the grammar-based tool failed on here, **315 are dotted** — they carry a qualified prefix that the import graph plus the dependency's own declarations can bind directly.

**We can fetch the declarations we lack.** This capability was already accepted for Java and Kotlin: resolve the archives named by the dependency declarations, read them, never build. There is no reason it stops at the JVM, and stopping it there is what produced the false cliff:

- **Go** module distribution *is source*. Fetching the modules a `go.mod` declares yields complete declarations with their static types, parseable with a grammar and no Go toolchain anywhere.
- **TypeScript and JavaScript** packages commonly ship type declarations, and where they do not, a separate declaration package usually exists. Verified locally in an eleven-package tree: eleven `.d.ts` files, several packages exposing `index.d.ts`. Fetching declared packages gives external signatures without `npm install` and without running the compiler.
- **Python** type stubs are distributed independently of the packages, which is why a comparable product simply bundles them (section 14); wheels also often carry inline stubs. `[INFERENCE — the wheel side was not verified locally]`

That turns "name-only until a bundled frontend lands" into something much narrower: **every language reaches declarations, the import graph, scope-local binding, and import-scoped cross-file binding today; a bundled or fetched declaration set raises external symbols to resolved; only type-inference-dependent precision and runtime wiring stay out of reach.**

### The producer table, restated

Every row below needs only files at rest plus fetches of public, pinned artifacts. Rows that required a build were cut on 2026-08-30 and are listed after the table with what each one took with it, because the measurements stay valid and a future decision may revisit them.

| Producer | Rung | Runs where | Facts it earns | Needs |
|---|---|---|---|---|
| Grammar parse plus our own resolver — `jtreesitter` | 1 | in-process | declarations, imports, scope binding, import-scoped cross-file binding, declared and annotated types | source text only |
| The same, plus fetched dependency declarations | 1 | in-process, network to registries | adds external symbol attribution and signatures | dependency declarations and reachable artifacts |
| Eclipse JDT Core | 1 | worker process | type-inference precision for Java | a classpath assembled from declarations, pinned public archives, reviewed sibling sources, and the local cache — never from a build |
| Kotlin Analysis API standalone | 1 | worker, one per target language version | the same for Kotlin | the same classpath, plus a matching compiler frontend fetched as an artifact |
| Fetched public declaration packages — Go modules, `.d.ts` and declaration packages, Python stubs | 1 | in-process, network to public registries | declared and annotated types for Go, TypeScript, JavaScript, Python | the declarations the target pins, fetched by coordinate |
| Sibling-repository source, for private dependencies | 1 | in-process | the same facts as first-party source, for an internal library we read as its reviewer | read access to that repository, and a ref (work item 18) |

| Any SCIP or SARIF artifact the customer already produced | import | in-process reader | whatever that producer earned, recorded against it | nothing; it exists or it does not |

**What the no-build rule cut, and what each cut cost.** The measurements behind these stay valid; only their reachability changed.

| Cut producer | What it earned | Why it is gone |
|---|---|---|
| SootUp bytecode tier | 961 resolved call edges into dependency and platform code, 86% mapped to file and line | needs class files, which only a compile produces |
| scip-java | compiler-backed Java, plus generated sources as a by-product | drives the target's build by design |
| scip-go, scip-typescript, scip-python | compiler-backed resolution for four languages | each needs a provisioned toolchain and a resolved dependency tree, which is build-tool work even when no artifact is compiled. Their *declaration* half survives as the fetched-declarations row above |
| Generated sources via compilation | types that hand-written code references but a checkout does not contain | the compile is gone. **How to handle this is the one open question of the settled rule — see section 5.3** |

Blast radius into dependency code is therefore bounded by what declarations state: signatures yes, resolved call edges into a dependency's *internals* no. That is a real ceiling, it is now permanent rather than conditional, and it is the honest description of the product.

One producer stays cut on its own merits rather than on scope: **scip-java's Kotlin plugin**, which cannot load into any Kotlin at or above 2.3.

### 5.1 Self-analysis is not the product

The spikes answered "can this producer resolve references", and they answered it well. They did not answer "can this producer resolve references *in an arbitrary target*", and three of their conclusions need correcting on that axis.

**The Kotlin recommendation loses one of its three pillars.** Its numbers stand: 2,839 references, zero unresolved, 1,119 into libraries, 17 jars, no second language runtime. But "the artifact version equals the Kotlin version we already pin" was only true because the target *was us*. A target on Kotlin 1.9 or 2.0 needs a frontend for its language version; one embedded compiler resolves one language level well and degrades on others. So the Analysis API stays the recommendation, with a different deployment: a **per-version worker**, with the required compiler frontend resolved and cached per target rather than pinned once at our build time. That also removes the in-process objection — a target's compiler frontend never enters the service's classloader.

**The bytecode tier's value was real and is now out of reach.** Its 961 cross-boundary edges were measured on the one codebase whose classes were already sitting in a build directory. Compiled classes require a compile, and the settled rule forbids one — so the tier is cut, and its measurement is preserved as the exact quantification of what the rule costs: resolved call edges into dependency and platform internals, 86% mapped to file and line, that no source-only tier produces.

**The Java measurement transfers furthest, and its framing needed one correction.** It obtained the classpath in 2.8 seconds without compiling, but by invoking the target's build tool — rung 2, which executes target-authored build logic and is in scope inside our sandbox. So the 99.998% figure describes the lucky case — a target whose dependencies are publicly reachable and whose build runs unattended — not the general one. What decides the product's actual fidelity is the rung-1 path underneath it: declarations plus archives resolved from a cache or a public repository with no package manager invoked. That is the number to measure first, because it is the one every customer gets.

### 5.2 Why analysis runs in worker processes

The single-process decision in the scope decision cut a supervised topology whose purpose was scaling a web tier apart from a worker tier. It did not license running compiler frontends over untrusted input inside the process that serves queries. Four reasons, three of them already measured:

- **Resource blowups are routine, not exceptional.** The bytecode spike reached 8.2 million edges, 503 seconds, and 11 GB on one configuration of a 750-line input. The Java spike peaked at 890 MB on 203k lines. In-process, those are the product dying rather than one analysis failing. A worker takes `-Xmx` and a deadline; the service survives the kill.
- **Target input is hostile until proven otherwise.** Parsers, class readers, and archive readers over attacker-influenced input are a well-known failure surface — malformed archives, pathological nesting, adversarial identifiers. Per-file failure isolation, which the analyzer specifications already require, is only credible if a crash is contained.
- **Version multiplicity is inherent.** Different targets need different compiler frontends, and a service that analyzes several targets cannot hold conflicting compiler versions in one classloader. Worker processes make version selection a launch argument instead of a classloading problem — which is why the classloader-isolation machinery cut from the plugin runtime does not need to come back.
- **The target program never executes; its build may.** Reading a class file is not running it, so a rung-1 worker needs crash and resource containment rather than a code sandbox. Rungs 2 and 3 are different: resolving dependencies or compiling runs target-authored build logic, which belongs in the isolated sandbox of work item 14, never in a worker sharing anything with the service. Section 5.3 draws that line.

The service process keeps what it always kept: settings, logging, the store, the queries, and the name-only tier. Resolution runs beside it and reports facts over a pipe or a file.

### 5.3 What runs, where, and on whose behalf

**Nothing runs: not the target, not its build, not a generator, not a package manager.** Earlier drafts of this section spent themselves deciding whose sandbox a build should run in. The settled rule (section 2) removes the question. What remains is fetching bytes and reading them, which needs isolation for a different and simpler reason: archives and source from a repository we did not write are hostile *data*.

**What "untrusted input" means, given that.** One kind only, now: malformed and adversarial data — stack exhaustion, pathological nesting, decompression bombs, quadratic identifier handling — reaching parsers, archive readers, and decoders. Worker isolation contains a crash and a resource blowup. There is no target-authored code executing anywhere, so there is no supply-chain execution surface, which is the largest single simplification the no-build rule buys.

**The ladder collapses to a line.** Earlier drafts had five rungs and spent two revisions arguing about the middle two. Two axes were genuinely in play — who bears the burden, and where execution happens — and the settled rule answers both by removing execution entirely.

| Rung | What it touches | Customer burden | Executes target-authored code | Policy |
|---|---|---|---|---|
| 1. Files at rest | source, dependency declarations, lockfiles, indexes or reports the customer already produced, and generated output already present on disk | none | no | **in scope: the product** |
| 2. Fetching pinned public artifacts | archives named by the target's own declarations, retrieved by coordinate and hash from public registries | none | no — fetching is not executing | **in scope** |
| 3. Reading a private dependency's source from a repository we review | the sibling repository at a stated ref | none beyond the read access we already hold | no | **in scope** (work item 18) |
| 4. Any package-manager, build-tool, generator, or compiler invocation | resolving or producing anything by executing target-authored logic | none, but irrelevant — cut on reliability grounds, not burden | yes | **out of scope** |
| 5. Customer build integration, and program or test execution | a plugin, a CI step, an artifact they must produce; or running the target | real | yes | **never us** |

**Why cut rather than keep as opportunistic.** A tier no feature may depend on still costs everything a tier costs: a sandbox, an escalation policy, provenance for what it executed, an isolation story for contributor-authored build logic, and a support surface for every build system it half-works with. It pays that price to deliver fidelity we can never promise, on a schedule we cannot predict, for a *minority* of the questions the product answers (`docs/specs/2026-08-30-question-cost.md`: no goal requires the type-checker level to function). Removing it deletes more design than it deletes capability. That is the trade, stated so it can be revisited on evidence rather than on preference.

**The calibration that made this easy.** The comparable product installs dependencies, can execute shell, and *still* ships type-aware rules disabled in its flagship path and deep Java analysis off by default, because "Java analysis may require compiling more than the changed files". It built the capability and declines to spend it at review latency. Building a capability we would also decline to spend is the clearest possible argument for not building it.

The Java spike obtained its classpath by invoking the target's build tool, which the settled rule forbids. Its `full` column is therefore **out of reach**, not merely optimistic, and its `empty` column is not our floor either, because declarations plus pinned public archives plus readable sibling sources sit between them. That middle configuration is unmeasured and is now the number the whole design rests on (section 11).

**Generated sources are the one open question the settled rule leaves, and it is genuinely open.** Annotation processors, `kapt`, KSP, protobuf and gRPC stubs, OpenAPI clients, and dependency-injection component classes all produce types that hand-written code references, and a checkout at rest does not contain them. Without a compile there is no route that manufactures them. Four candidate answers, none chosen:

| Option | What it gives | What it costs |
|---|---|---|
| **A.** Detect the generator from build declarations, disclose the gap, mark affected references expected-missing | honest, cheap, works everywhere, already the required behaviour for every other gap | the references stay unresolved, and in a heavy annotation-processing codebase that is a large share of the graph |
| **B.** Read generated output already on disk | free fidelity where a build ran on that runner at some point; consistent with the no-build rule, since these are files at rest | non-reproducible — two analyses of the same commit can disagree depending on what a previous build left behind. Needs a distinct basis value so a fact can be identified as resting on incidental state |
| **C.** Read committed generated code | some organisations commit protobuf and client stubs deliberately | applies only where they do; nothing to decide, it is ordinary source |
| **D.** Run only the generator, not the build | complete types | violates statement 1 of the scope rule, and a generator is target-authored code with a plugin classpath — the whole execution surface returns for one capability |

**Option A is the floor and is not optional** — whatever else is chosen, the gap must be detectable and disclosed. B is the cheap addition and needs the reproducibility question answered before it is built. Recorded as open in section 11's unmeasured list, because the deciding input is a measurement nobody has: what share of references in an annotation-heavy repository bind only to generated types.

Rung 5 stays outside the product permanently, which keeps two earlier decisions consistent: runtime profiles and hot paths were cut because no goal names performance, and test attribution is an *import* of a report someone else produced by running tests — the coverage tool runs, we never do. Fix verification, likewise, means re-running **analysis** over a named scope, never running the program to see whether it still works.

**And it creates the third question, which is the interesting one.** A static graph cannot see edges that only exist while the program runs: dependency injection, service loaders, reflection, dynamic proxies, annotation-driven dispatch, configuration-named handler classes, `invokedynamic` targets the bytecode tier already loses. These are not unresolved references. An unresolved reference is a known unknown — we saw an identifier and could not bind it. A runtime-wired edge is an *unknown unknown*: nothing at the call site hints that the edge exists at all, so it is invisible rather than unresolved, and a blast radius that omits it silently is exactly the failure section 7 of the scope decision calls worse than no answer.

The store therefore needs a third honesty channel beside resolved facts and the unresolved set: **runtime-wiring sites**. These are statically detectable even when the edge they imply is not — reflection and service-loader calls, injection annotations, proxy factories, class names appearing as configuration string literals. Detect the sites, count them within the affected set, and report the count on every impact answer. The local grammar tool's framework synthesizers, which guess these edges and tag them `heuristic`, are the prior art for the guessing; the discipline we add is that a guess and a count are different products, and an impact answer must carry the count whether or not it carries the guess.

### 5.4 Evidence a checkout carries that is not a graph edge

The graph is not the only thing an at-rest checkout gives us, and the earlier framing quietly ignored three channels that a code-review product lives on.

**Comments are semi-formal type and intent evidence.** JSDoc `@param {Type}` and `@returns`, Python docstring type conventions, KDoc and Javadoc `@param`, and inline `@type` pragmas state types that the language itself does not require. For untyped JavaScript in particular, JSDoc is often the only declared typing in the codebase, and it binds through the same import graph as anything else. It earns its own basis — declared-in-comment — which is weaker than a checked type and much stronger than a name match, and it must be tagged as such rather than laundered into either neighbour.

**The change under review is evidence no static index holds.** A pull request supplies the changed hunks, which localise every question; the title, body, and commit messages, which state intent; and reviewer comments, which state constraints the code cannot. Goals 2 and 3 — find flaws, suggest fixes — consume that directly: a finding inside a changed hunk with the author's stated intent beside it is a different product from the same finding surfaced in a repository sweep. This is review evidence, not graph structure, and the two must not be mixed in the store; but it is why a review product can be useful precisely where the graph is thinnest.

**Whole-repository access enables inference a per-file tool cannot reach.** Because we hold everything at once: a name that is unique within the set reachable through a file's imports resolves without types; test-to-code pairing follows naming and directory convention; the class names in configuration literals can be matched against declarations, which is what turns a runtime-wiring *site* into a named candidate; and version-control history supplies co-change coupling, authorship, and churn. None of these needs a compiler, a build, or an execution.

The discipline stays the one already stated: each of these is a distinct basis, recorded as such. A comment-declared type, a convention-matched test, and a checked type are three different claims, and an answer that presents them as one is the dishonest kind of confident.

### 5.5 Who owns the runner — the axis this document never named

Every claim above was written as "a sandbox **we** own" and "our infrastructure". That silently assumed a vendor-hosted shape: our machines, fetching their checkout. **The product is not shaped that way.** The engine is an installation the customer operates — that is what `docs/operating-the-node.md` describes, and what the single-process design in the scope decision was sized for. The runner is theirs.

Naming the axis changes the answer to the two constraints below, so both are now stated per shape rather than absolutely.

**What a customer-operated runner already has, at zero marginal ask.**

| Present on their machine | Why it is there | What it unlocks |
|---|---|---|
| ~~Private registry credentials~~ | their own build needs them | **no longer used.** The settled rule takes no credential and touches no private registry; this row is struck and kept only to record that the option existed and was declined |
| A warm artifact cache — `~/.m2/repository`, `~/.gradle/caches`, the Go module cache | their build populated it | **files at rest**, so reading it is rung 1 and needs no registry and no credential. It is also the one route by which a *private* artifact can resolve without repository access — see the open question in §5.8 |
| Their toolchain at the version they pin | it is their machine | the per-target-language-version frontend problem for Kotlin becomes a local lookup instead of a resolution step |
| Network reach inside their perimeter | it is their perimeter | internal mirrors, proxies, licence servers |
| ~~A build that reproduces~~ | — | **moot.** Nothing is built |

**Onboarding burden is not build burden, and the scope rule only ever excluded the second.** Installing the engine, or registering a runner, is a one-time act at the organisation level, in the same category as installing an app — which the comparable product requires and nobody counts against it. A plugin in `pom.xml` or a step in `.gitlab-ci.yml` is different in kind: per project, versioned with their code, theirs to maintain forever, and broken whenever their build breaks. The rule stands exactly as written. What changes is the recognition that a customer-operated runner was never on the wrong side of it, and the earlier framing lost that by assuming a shape it never declared.

**The trust posture is stronger this way, not weaker.** Vendor-hosted, we would have to request a registry token, hold it, and be trusted not to leak it — and registry tokens often carry publish rights, which is why section 5.8 refuses to ask. On their runner we hold nothing: the package manager uses the credential, we never read it, and nothing leaves their perimeter.

**Every product that resolves private dependencies does it this way, which is why their requirements read as they do.** Endor Labs' Java scan demands a populated `.m2` cache and a built artifact on disk because it runs where the build ran. CodeQL's `build-mode: none` shells out to Maven or Gradle purely to resolve, and documents needing private-registry credentials for accuracy — GitHub's default Java mode works because it executes inside the customer's own Actions runner. Snyk's CLI reachability path can demand compiled bytecode precisely because the CLI runs on the customer's machine, while its SaaS SCM path — the one that never touches their environment — is the one that cannot. And the vendor-hosted reviewers have no route to a private artifact at all: structural for them, optional for us. (Sources: `docs/specs/2026-08-30-reachability-without-build.md`, `docs/specs/2026-08-30-snyk-without-build.md`.)

**What survives of the two constraints below.** Both were arguments about whether escalation could work. The settled rule does not escalate, so they are kept as the record of why the question was closed rather than as live constraints.

**Private dependencies need credentials — which is why we do not fetch them.** A private Maven repository, an authenticated npm registry, a `GOPRIVATE` proxy, a private index each need a secret. A customer-operated runner *has* those secrets, so this was reachable; it is declined anyway, because holding or using a customer's registry credential makes the engine a credential-bearing component in their supply chain for a benefit their sibling repositories already provide. Private dependencies resolve from source instead (§5.8).

**Build strategies are not reproducible from a checkout, and a customer-operated runner does not fix this in a way we can promise.** A hermetic monorepo build, an internal toolchain distribution, a licence-served compiler are all present on their machine — so a build there would often succeed, and we could never say when. "Often, and we cannot tell you when" is not a property a design should rest on, which is the reliability argument that closed the question.

**The comparable product corroborates this by omission.** It installs dependencies and it reviews private repositories, and it requires no registry credentials from the customer. Both cannot be true in general, so its dependency installation must be best-effort and frequently unsuccessful — which is consistent with what its own documentation admits elsewhere: type-aware rules disabled, deep Java analysis off by default because it "may require compiling more than the changed files". It is not running a full semantic analysis and quietly succeeding; it is running cheap tools broadly and deep tools rarely.

**The design consequence is unchanged, and its justification has now been wrong twice.** The rule still holds — **rung 1 must be sufficient for every feature, and escalation may only make an answer better, never make it possible.** It was first justified by "escalation usually fails", which the customer-owned runner refuted. It was then justified by cold and access-denied runners, which is worse reasoning: a cold runner is warmed, not analysed in (below), and a denied credential is something to report, not to design around (§5.7). Neither is a reason.

The actual reason is a property of the fact model rather than a prediction about environments. **Every fact records the basis on which it was obtained, and every gap is counted and named** (work items 1 and 2). Rung 1 is the tier that requires nothing, so it is the tier that remains when anything above it fails — for any reason, expected or not, including reasons nobody enumerated. A feature permitted to require a higher tier is a feature that returns nothing instead of returning less with a label, and returning nothing is the failure mode this design exists to avoid. The rule is about what a feature owes its caller, not about how often a registry is unreachable.

**What it costs, and this part is not free.**

- ~~Contributor-authored build logic on a credentialed runner~~ — **removed by the settled rule.** No build runs and no credential is held, which deletes this entire class rather than mitigating it. The residue is smaller and stated in §5.6.
- **The engine still runs inside their perimeter**, so read-scoped repository access only, and provenance recorded for every artifact fetched.
- **Fetch failures and repository-read failures become our latency.** Time caps and degradation to the tier below, per work item 13 in its reduced form.

**What it demotes.** The central public-artifact index (work item 17) stops being the answer to private dependencies and becomes a cold-start optimisation — and one whose value depends on how much the runner's own cache (below) already covers. Still worth building, lower priority.

**The runner is something we build, not an environment we inherit — and the previous drafts of this section kept forgetting that.** "Cold ephemeral runner", "cache may be absent", "toolchain may be missing", "cold-start cost is prohibitive" were all written as facts about the world. They are not. They are properties of a component we ship, and each one is a feature request against ourselves:

| Written earlier as a constraint | What the runner we ship can do instead |
|---|---|
| an ephemeral CI runner has no warm artifact cache | **own the cache, and warm it as a step.** A cold runner is not a mode we analyse in; it is a state we leave. Provisioning — fetch the declared archives, build the base-ref store, index the siblings, install the toolchain — is the first step of the first analysis, after which every later one runs warm. Cold therefore costs one-time latency and never costs fidelity, which is why it appears nowhere below as a constraint |
| a fresh clone means re-analysing everything | **keep the store.** The base ref's facts persist on the runner; a pull-request analysis is a delta over them, which is what work item 4's delta application exists for. Re-analysis from zero is a first-run cost, not a per-review cost |
| a sibling repository must be cloned per review to resolve against | **keep sibling indexes warm**, refreshed on their own events rather than rebuilt per review (work item 18) |
| the toolchain might not be installed at the version a target needs | **provision it.** Fetching a pinned JDK, Node, or Go toolchain per target is routine work every CI system does; the Kotlin per-version frontend problem is a download-and-cache problem, not an impossibility |
| a compiler frontend's cold start is multi-second, with minutes of background CPU on a large repository | **stay warm.** A persistent engine process pays that once, not per review. This was recorded during the Kotlin spike as a disqualifying cost for a per-invocation process, and it is not one for a resident one |
| a central public-artifact index needs us to host a service | **ship it as data.** A verifiable published bundle the runner pulls and keeps warm, seeding a local index it then extends with what it sees, needs no service of ours in the request path |

The general rule, since this mistake recurred three times in one document: **when something is missing from the runner, the first question is whether we can put it there.** Only if the answer is no does it become a constraint on the design — and the honest tally is that almost nothing survives that question. A cache, a store, an index, a toolchain, a warm process are all provisioning. The one thing we cannot provision is authority we were not granted, and §5.7 establishes that this is a reporting obligation rather than a design constraint.

**What it promotes, and this is the biggest single change.** The rung-1 Java number — called the most important unmeasured value in this document — is likely far better than the JDT spike's `empty` column, because a warm `~/.m2` plus the POM yields a genuine classpath with no build invoked and no network touched. That is a *third* configuration the spike never measured, sitting between its `full` and `empty` columns and much closer to `full`. Measure exactly that next: warm local cache, declarations parsed, build tool never run.

### 5.6 The contributor is the untrusted party, and reviewing their code is the workload

Section 5.5 establishes that the runner is the customer's — so credentials are present, and caches, indexes, and toolchains are ours to put there. That is only half a design, because it leaves the question of *whose code* we are analysing on that runner. The answer is the one that defines the product: **a review engine exists to review contributions, and a contribution is code the repository owner has not yet accepted.** Untrusted code is not an edge case to guard against; it is the primary input, arriving on every pull request.

Isolation therefore stays, but the settled no-build rule shrinks what it must defend. There is no credential to exfiltrate and no target-authored code to execute, so the credential-theft class is gone by construction rather than by control. What remains is narrower and still real: **a contribution can change which bytes we fetch, and from where.**

**What is still an attack, precisely.** A contributor edits the dependency declarations. Two things can follow. Their edit can point a fetch at a host they control — no secret leaks now, but we become a request generator aimed wherever they choose, and the bytes we then parse are chosen by them. Or their edit can name an artifact whose *content* is hostile to our readers: a malformed archive, a decompression bomb, a pathological identifier stream. Neither is catastrophic; both are avoidable with one rule and one boundary.

**The resolution, in reduced form.** The two-phase split survives because it was always partly about *what a phase is allowed to trust*, not only about credentials:

| | Phase A — resolve | Phase B — analyse |
|---|---|---|
| Purpose | fetch archives and sibling sources | parse, resolve, produce facts |
| Sees the contributor's code | **no** | yes |
| Holds credentials | **none** — public registries and repository read access only | **none** |
| Network | yes, to public registries and the forge, on an operator-configured host allowlist | **none** |
| Inputs it trusts | **coordinates** from the pull request; **hosts** only from the base ref and operator configuration | the phase-A byte set, read-only, treated as hostile data |
| Writes to the shared cache | yes | never — its own scratch, discarded |

Phase A decides *what* to fetch under a host policy the contributor cannot edit; phase B reads bytes with no network at all. The split is cheaper to justify now than when it was carrying credential protection: it is simply the boundary between choosing bytes and trusting them.

**Three rules make the split real, and they are the load-bearing detail.**

- **Coordinates may come from the pull request; hosts may not.** A contribution adding a public dependency is ordinary and should resolve. A contribution that adds, edits, or reorders a *repository, mirror, proxy, or profile* is ignored for fetch purposes: the host allowlist comes from the base ref and operator configuration. A coordinate resolvable only against a contributor-supplied host is reported unresolved.
- **A fetched artifact is verified against the hash the lockfile pins**, where the ecosystem records one. This is the check that makes "public and pinned" mean something stronger than "public", and it is the reason statement 2 of the scope rule says *pinned* rather than merely *declared*.
- **Facts derived from an unaccepted contribution never enter the accepted graph.** The delta application from work item 1 replaces only the facts of the analysis that produced them; that needs a trust dimension as well as a scope one. A pull-request analysis is a separate, discardable overlay over the base ref's facts, and it is promoted only when the contribution is merged. Otherwise a contributor edits the graph the next reviewer reads.

**What this costs, stated plainly.** Almost nothing now. Phase B never compiled anything under the settled rule, so the earlier worry about offline builds is void. The residual cost is that a pull request adding a dependency from a host the operator has not allowlisted resolves no further than its declaration — correct behaviour, reported per §5.7.

**What it improves on.** Withholding secrets from an entire run, which is the forge providers' default, means a fork pull request gets no dependency resolution at all. The phase split withholds secrets from the *phase that touches contributor code* instead, so resolution still happens against the base ref's declarations and a fork contribution gets a resolved review rather than a degraded one. That is a better answer than the platform default, and it is only available because the split is ours to make.

**Two smaller consequences worth recording now.** A hostile contribution is an adversarial resource consumer, so the caps from work item 14 are defences rather than politeness. And a shared runner serves many analyses, so phase B must be ephemeral per analysis — one contribution's scratch state must never be visible to the next.

### 5.7 Missing authority is a report, not a constraint

The one thing the runner cannot be given by us is authority we were not granted: a registry the operator did not configure, a sibling repository the customer did not share, a mirror behind a network boundary we cannot cross. Earlier drafts wrote this as an environment the design must survive. That is the wrong category. **It is a condition to detect, name loudly, and work around — and the workaround is the honest-degradation machinery this document already requires.**

What that obliges, concretely:

- **Do the best available job with what authority exists, and say what the rest would have bought.** A reference into an unfetchable artifact still resolves as far as its declaration allows: the coordinate, the pinned version, the qualified prefix from the import graph, and the fact that nothing beyond that could be read. That is a smaller answer with a correct label, not a failure.
- **Name the specific grant that would close the gap.** Not "some dependencies could not be resolved" but *this registry host, these coordinates, this count of affected references, and this is the read access that would resolve them.* An operator can act on the second and cannot act on the first. The unresolved-reference set (work item 2) already carries the coordinates; what it needs is a per-cause grouping and an operator-facing rendering.
- **Report it where it is actionable, not only where it is observed.** The reviewing model needs the gap in its orientation output so it does not read a thin graph as a complete one. The operator needs it in the engine's own diagnostics, once, not repeated per review. Those are two different audiences and two different renderings of one fact.
- **Never let a missing grant present as a clean result.** A finding suppressed because its rule lacked a basis, and a finding absent because the code is fine, must not look the same. This is the same rule the basis model states for rules; here it applies to the resolution report itself.

**Work item 20** covers the operator-facing side: a resolution-health report per analysis — what authority was available, what was fetched, what was not and why, which coordinates and how many references each shortfall affected, and the exact grant that would fix each one.

### 5.8 What to do about private dependencies, and why not a build plugin

"Unfetchable dependency" is not one bucket, and the design has been treating it as one. Every unresolved cross-boundary reference points at exactly one of three targets:

| Target of the reference | Reachable at rung 1? | How |
|---|---|---|
| **A sibling module in the same checkout** — the monorepo case | **yes, no fetch at all** | the declarations are files we already parsed; this is multi-module resolution, not dependency resolution |
| **A public registry artifact** — Maven Central, npm, PyPI, crates.io, Go proxy | **yes, no credentials** | fetch the declared archive by coordinate and hash from the lockfile, read its declarations, never run a package manager |
| **A private artifact whose source is a repository we read as its reviewer** — the org's own internal library, and the common case | **yes, and with no registry and no credential** | index that repository's source at the ref the lockfile pins and resolve against it. This is the monorepo row extended across repository boundaries, and it is the *only* sanctioned route to a private dependency (work item 18) |
| **A private artifact with no readable source** — vendor-supplied, binary-only, archived, or an org repository we were not granted | **no** | attributed and unresolved: coordinate and pinned version named from the lockfile, references marked expected-missing, and the specific grant that would fix it reported to the operator (§5.7) |

**Only the last bucket is unresolvable, and the settled rule makes its size the most important open number in the design.** Every internal library whose repository we review resolves from source. What remains is genuinely third-party-and-private, which intuition says is small and nobody has measured — work item 15.

**One open question the settled rule surfaces rather than answers.** A private artifact already sitting in the runner's local cache (`~/.m2/repository` and its equivalents) is a *file at rest*, so reading it breaks no rule and costs nothing, and it resolves cases the two sanctioned routes cannot. But it depends on what some earlier build happened to leave on that machine, so two analyses of the same commit can disagree. If it is allowed, it needs its own basis value so a fact resting on incidental machine state is distinguishable from one resting on a pinned artifact or reviewed source. **Undecided**; recorded with the generated-sources question in section 11, which has the same shape.

**Cross-repository resolution is deterministic for us, where a comparable product makes it inferential.** CodeRabbit's multi-repo analysis has an agent research repositories the customer names — free-text `instructions` guiding where to look, a plan-capped count of linked repositories, relationships discovered progressively over many reviews by inferring from import statements and dependency manifests, and results that are explicitly best-effort. We need none of that guessing: **a coordinate in the lockfile that matches the coordinate an org repository publishes *is* the link.** The declarations we already parse name the dependency exactly, so the org's internal dependency graph falls out of data in hand rather than out of accumulated inference, and what it yields is resolved symbols rather than an agent's search of a sibling tree. Work item 18. That measurement is the decision input, and it is cheap: on a real multi-module repository, classify unresolved references by target bucket. The intuition worth testing is that bucket three is small, because internal libraries are a minority of any dependency tree and first-party code — where a diff lives and where blast radius flows — resolves through buckets one and two.

**And bucket three costs least where the graph is worth most.** Private-dependency resolution buys member types and exact overload selection: precision for the deterministic-findings consumer. It buys almost nothing for the orientation consumer of section 5.9, which needs to know which files a change reaches — and reachability runs through first-party code. A reviewer does not need `com.acme.internal.Client`'s member signatures to be told the four files that call the changed method.

**A build plugin is rejected on three grounds, and the settled rule adds a fourth: it would be the only thing in the design that executes anything.**

- **It rebuilds the .NET cliff we documented in section 14.** A language whose resolution comes only from the build inherits that failure mode: without the orchestration, no degraded result — nothing. A plugin makes fidelity binary and installation-dependent instead of graceful.
- **It is a product family, not a feature.** Maven, Gradle, Bazel, sbt, npm, Cargo, MSBuild, each versioned against tool releases we do not control, each a support surface. The whole reason the escalation ladder was attractive was avoiding exactly this.
- **It answers the wrong question.** A plugin would deliver a resolved classpath — bucket three plus the buckets we already have. Paying a permanent distribution and support cost for the smallest and least valuable bucket is a bad trade at any burden level.

**What we accept instead, in priority order.** Sibling modules and public pinned artifacts by construction. Private dependencies from reviewed sibling repositories. Declaration packages and type stubs the ecosystem publishes separately. An index or report the customer already produces, imported when present and never requested. Nothing else — and where nothing else reaches, the gap is reported rather than closed.

**Bucket two is better than "fetch it per analysis", and `docs/specs/2026-08-30-how-they-do-it.md` §5 says why.** A public artifact is byte-identical for every customer, so indexing it once centrally — keyed by the coordinate and hash the lockfile pins — makes every later analysis a lookup instead of a fetch and a parse. That is a shipping pattern, not a hypothesis: Endor Labs states it builds "a call graph per package version, store those call graphs and then, given a client dependency set, we stitch them on the fly". Work item 17. The counter-case is recorded there too: Sourcegraph's indexing is per-tenant with cost scaling in dependency depth, so the sharing is a deliberate architecture rather than a property of indexing.

**And bucket three matters less than assumed, because the resolution most rules need is not resolution at all.** Snyk Code compiles nothing, reads no dependency archive, and still finds taint — because sources and sinks are matched against a *curated library API model* by signature, graded per framework, rather than bound by a type checker (`docs/specs/2026-08-30-how-they-do-it.md` §3). A rule can fire on a modelled source reaching a modelled sink with only import-scoped confidence in the receiver's type. That makes the model a data asset we author, and moves a large share of flaw-finding off the classpath entirely. Work item 18.

### 5.9 The two consumers of the graph

The correction above forces a question the document had not asked: if the resolved tier is bounded, what is the graph *for*? It has two consumers, and they want different things — **but neither of them is a product.**

**Statement 3 of the scope rule, stated precisely, because the loose version is wrong.** It is tempting to say everything pre-model exists to help the model. That mis-describes half the output: a hardcoded credential in a literal, or a dependency pinned to a known-vulnerable version, is *the answer*, not a hint towards one. The accurate form is about destination rather than purpose: **every pre-model step produces evidence that enters a review, and the review is the only product.** No dashboard, no quality gate, no debt rating, no portfolio rollup, no separate findings report with its own lifecycle. That is the whole distinction between mining the specification corpus for capability and reproducing the system it describes — and it is also why the corpus's rule catalogue was cut to a fraction (`docs/specs/2026-08-29-scope-decision.md`): most of those rules exist to feed a gate we are not building.

**Consumer one: deterministic findings.** Facts we can assert without a model — a null dereference on a checked type, a secret in a literal, a duplicated block, a call into a deprecated declaration. Precision is the currency here. A finding we cannot substantiate is worse than silence, which is why the basis field gates which rules may fire: a rule needing checked types stays silent when only `declared` or `import-scoped` facts exist, exactly as the reduced mode in section 14 does.

**Consumer two: orientation for the reviewing model.** This is the one the earlier framing missed. An LLM reviewing a diff can read code perfectly well; what it cannot do is know *which* code to read out of a repository it sees through a keyhole, or know what it is not being shown. The graph's job there is to point: these are the declarations the diff touches, these are the files that import them, these are the callers we could bind and the candidates we could not, this symbol comes from a dependency we could not fetch, these three sites are runtime-wired so the static picture is incomplete here.
That inverts several judgments made earlier in this document:

- **A candidate set is a useful output, not a failed resolution.** Under the precision framing, an import-scoped reference with three reachable candidates was a non-fact. As orientation it is excellent: hand the reviewer all three and say the resolution is ambiguous. Work item 11 should therefore return candidate sets with their size, not only unique hits.
- **Recall and honesty outrank precision for this consumer.** Missing a caller is worse than offering an uncertain one, provided the uncertainty is labelled. That is the opposite of the finding path's bias, and both live in one store, which is why per-fact basis is load-bearing rather than decorative.
- **The unresolved set and the runtime-wiring sites become prompts, not just caveats.** "Fourteen references in this diff bind to a dependency we could not fetch" and "this changed class is named in two configuration literals" are instructions to a reviewer about where its own reading must do the work.
- **Orientation must be cheap and always available.** It sits on the critical path of every review, so it belongs at rung 1 by construction. A capability that only works when a sandbox build succeeds cannot be what tells the reviewer where to look.

The identity boundary from the scope decision survives intact and gets sharper: we own the facts and the pointing; the model owns the judgment and the prose. What changed is that pointing is a first-class product of the graph, ranked beside the findings rather than behind them — and that both are inputs to one review rather than outputs of one system.

## 6. Kotlin: resolved by measurement, not by frontend

This section asked whether Kotlin forces a frontend of our own. **It does not.** All three routes were run against `runtime/` and `persistence/` — 28 files, 2,839 references — and the result is unambiguous. Note what the subject was: our own source, resolved with our own classpath. Section 5.1 states what that does and does not prove about arbitrary targets.

| Route | Refs resolved | Into libraries | Unresolved | Weight | Kotlin version | Verdict |
|---|---:|---:|---:|---|---|---|
| **Kotlin Analysis API standalone (K2)** | 2,839 | **1,119** | **0** | 17 artifacts, 79.7 MiB, no Scala | 2.4.0, which is also our own pin | **adopt, per-version worker** |
| Joern `kotlin2cpg` | 868 non-operator calls | 621 | 0 with classpath | 108 artifacts, 155.7 MiB, Scala 3.8.3 runtime | 2.3.21 embedded | out-of-process fallback |
| scip-java Kotlin plugin | — | — | — | — | 2.2.0 embedded | **disqualified** |

scip-java's Kotlin plugin cannot load into our compiler at all: `AnalyzerRegistrar is incompatible with the current version of the compiler`, caused by `AbstractMethodError: Missing implementation of resolved method 'abstract java.lang.String getPluginId()'`. It is unusable on any Kotlin at or above 2.3.

The Analysis API route is the recommendation on two grounds beyond its numbers, one having survived the correction in section 5.1 and one having been strengthened by it. It brings no second language runtime: the IntelliJ platform classes it needs arrive inside the compiler jar rather than as separate artifacts, so a worker is one directory of jars and a `java` invocation. And with the dependency classpath withheld it degrades exactly as a tier should — 975 unresolved references led by `assertThat` ×72, `Test` ×50, `use` ×31, reproducing the baseline's failure mode and confirming that the classpath, not the compiler, buys the 1,119 library edges. What does **not** survive is version-pin convenience: for an arbitrary target the frontend version must follow the target's Kotlin version, resolved and cached per target, which is why this producer is a per-version worker rather than a library we link once.

One consequence worth stating before it is discovered later: a target whose Kotlin version has no available frontend, or whose classpath cannot be assembled, does not fail the analysis. It falls back to the grammar producer, and its facts carry the bases that need no compiler — `declared`, `import-scoped`, `scope-local`, or `name-matched` where nothing better applies. The basis field is what makes that degradation honest instead of silent.

`kotlin2cpg` stays documented as a fallback with two operational quirks worth remembering: it silently excludes any path containing a `test` segment with no override, and its `--classpath` flag rejects file paths, accepting only a directory of jars.

## 7. What SCIP gives us, and what it does not

The format is worth adopting as the ingestion contract: one protobuf schema, Apache-2.0, now stewarded by an independent organization with a public proposal process, and **readable in-process from the JVM** via `org.scip-code:scip-java-bindings:0.9.0` (plain generated protobuf classes, depending only on `protobuf-java`) or the Kotlin DSL bindings. Parsing an index is one call.

Its symbol grammar gives us the stable key section 7 of the scope decision asked for and could not source:

```
<symbol>     ::= <scheme> ' ' <package> ' ' (<descriptor>)+ | 'local ' <local-id>
<package>    ::= <manager> ' ' <package-name> ' ' <version>
<descriptor> ::= <namespace> | <type> | <term> | <method> | <type-parameter> | <parameter> | <meta> | <macro>
<method>     ::= <name> '(' (<method-disambiguator>)? ').'
```

A key such as `semanticdb maven com.example mylib 1.0.0 com/example/Foo#bar().` is computable, comparable, and stable across runs, and the method disambiguator distinguishes overloads — the thing name matching cannot do.

What the wire format does **not** carry, verified by reading all 962 lines of the schema:

- **no visibility or access modifier** as structured data — only free text inside a rendered signature;
- **no resolution confidence** — the format cannot say whether a symbol was compiler-verified or guessed, so confidence must be assigned per producer on ingest;
- **no usable `calls` role, and neither predicted signal exists** — the spike measured `syntax_kind` as `UnspecifiedSyntaxKind` on 100% of 49,457 occurrences, and `enclosing_range` present only on function and method *definitions*, never on references. The rule that does work is different and cheap: a non-definition occurrence whose descriptor is a method (`name().`) and whose range ends immediately before `(` or `[` is a call. Hand-checked on 95 occurrences across two named samples: 95 correct, recall 94.4% to 98.5%, with the false negatives being calls through function-typed fields. Definition `enclosing_range` is still enough to attribute a caller by interval containment — 3,991 of 3,992 calls got one;
- **no unresolved-reference record, and it cannot be synthesized from occurrences** — this is worse than the first draft assumed. A reference the producer fails to resolve is not a symbol-less occurrence; it is *no occurrence at all*: zero of 22,763 occurrences lacked a symbol. Recovering the unresolved set means re-lexing the source and diffing identifier positions against the index, which the spike did: 24,948 of 65,573 identifier tokens uncovered, of which the genuine residue after removing language predeclared identifiers was 0 in one subject and 96 in the other. The local grammar tool's `unresolved_refs` table with a failed status and retry tail remains the only prior art that records this directly, and is worth copying outright;
- **no delta protocol** — an index is a flat bag of per-file documents; replace-what-changed is ours.

Four operational findings from the round trip that any ingest must handle, none of them visible in the schema:

- **`local` symbols are document-scoped and collide.** Keyed by symbol string alone, 2,262 of 3,849 symbol entries in one subject and 5,931 of 8,517 in the other are lost. Document qualification is mandatory; the spike hit this as a live bug in its own reader.
- **Moniker keys depend on producer configuration.** Two runs on the same revision differing only in the declared language version produced different keys for 174 of 1,828 symbols — 9.5%. The producer's configuration is part of the key's identity and must be recorded with the facts.
- **Multi-module repositories are silently truncated.** One subject lost 38 files and 18.6% of its identifiers to modules outside the root, while the producer's own `missing` check reported nothing missing.
- **An index is platform-specific and does not say so.** Build-constrained files simply have no document: a Windows-only source file is absent from an index produced on another platform, with no marker.

For delta application, the design to mine is Glean's: facts are labelled with a unit, typically a file; a new database stacks new units' facts over a base with changed units' facts hidden, and ownership sets propagate through fact-to-fact references so nothing dangles — reported at roughly 7% storage overhead and under 10% query overhead. We cannot use the runtime (Haskell over C++ and RocksDB, Thrift, no JVM client) but the model answers our contract directly.

## 8. Language servers: interactive tier, never the batch mechanism

Driving language servers to harvest edges was investigated seriously and fails on cost, not capability. The protocol is position-anchored: harvesting a call graph means one round trip per declaration, and call hierarchy is not universally implemented — several current servers do not implement `prepareCallHierarchy` at all. Cold-start cost is the disqualifier for a process that starts per invocation: minutes of background CPU and multi-gigabyte residency on large repositories for one server, with a documented multi-second first-response latency on large projects unless a data directory persists. Bulk enumeration is explicitly refused by server implementations — one type checker's own source declines an empty workspace symbol query because "we'll return too many results".

The production precedent settles it: every batch indexer surveyed calls the compiler library directly and serialises in bulk rather than driving a live server. `lsp4j` remains useful — it is JVM-native and would let an agent ask an occasional authoritative question against a warm session — but that is an opt-in query tier, not how the graph gets populated.

## 9. What we build regardless of every adoption above

1. **The basis model** — every fact records how it was obtained: `checked` (a type checker resolved it), `declared` (the source states the type, including a TypeScript annotation, a Go type, or a Python annotation), `documented` (a comment states it — JSDoc, KDoc, docstring), `import-scoped` (the import graph left exactly one reachable candidate), `scope-local` (binding decided inside one file or scope), `name-matched` (nothing better; a candidate, not a fact), and `synthesized` (a framework or wiring guess). No surveyed candidate carries anything like this; each is single-fidelity or silent, so the vocabulary and its enforcement are ours. This replaces the three-value `resolved` / `name-only` / `heuristic` field, which had no slot for the middle and caused the false cliff corrected in section 5.
2. **The unresolved-reference set as first-class output**, synthesized on ingest.
3. **Edge kind derivation** — `calls`, `instantiates`, `overrides`, `extends` from occurrence roles, syntax kinds, and enclosing ranges.
4. **Delta application** against our own store, on the unit-and-ownership model — with a **trust dimension alongside the ownership one**: facts derived from an unaccepted contribution form a discardable overlay over the base ref's facts and are promoted only on merge, so a contributor cannot edit the graph the next reviewer reads (§5.6).
5. **Persistence and query** — the embedded relational store, recursive reachability, bounded traversal with a truncation marker.
6. **Orchestration** of producers whose runtimes differ, with graceful degradation to the grammar producer when a compiler frontend is absent, mismatched, or fails — never silent substitution of a weaker basis for a stronger one.
7. **Recovery of the unresolved set per producer** — re-lexing and position-diffing where the producer records nothing, per section 7.
8. **Target inspection, dependency resolution, and producer selection** — parse the target's dependency declarations; at rung 1 resolve the archives they name from a cache or a declared repository, at rung 2 let the ecosystem's package manager resolve them inside our sandbox; detect each language's version; choose and cache the matching frontend; and record producer identity, version, configuration, **and the rung used** with every fact.
9. **Worker supervision** — launch a producer with a heap cap and a deadline, contain its crash to one analysis, and degrade to the next tier down on failure rather than reporting a thin graph as complete.
10. **Runtime-wiring site detection** — reflection, service loaders, injection annotations, proxy factories, and class names in configuration literals, counted within any affected set so an impact answer states how much of the program's real wiring a static graph cannot see.
11. **An import-scoped resolver returning candidate sets** — resolve each reference against the declarations reachable through its file's own import edges. A single reachable candidate is a fact; several are a *labelled candidate set*, which section 5.9 establishes as useful output rather than a failure, because a reviewing model can be handed three candidates and told the binding is ambiguous. Record the set and its size either way. Motivating measurement in section 5: 120 references match some declaration by name here, across 676 candidate pairings.
12. **Pinned public artifact fetching** — read the archives named by the target's declarations from public registries, by coordinate and hash, verifying the hash where the ecosystem records one. Never a package manager, never a private registry, never a credential.
13. **The fetch and read policy** — reduced from an escalation policy by the settled rule. Decide per analysis what to fetch and what to read: the host allowlist from base ref and operator configuration, the ref for each sibling repository, time and size caps, and abandon-cheaply on failure with the shortfall reported rather than retried indefinitely.
14. **Worker isolation for hostile data** — reduced from sandbox controls by the settled rule, since nothing executes. Per-analysis worker with a heap cap and a deadline, crash contained to one analysis, no network in the reading phase, and provenance for every artifact fetched. What is *not* needed any more: an execution sandbox, an egress policy for build scripts, and provenance for what was installed or compiled.

15. **Unresolved-reference bucketing** — classify every unresolved cross-boundary reference by target: sibling module in the checkout, public registry artifact, or private artifact. The first two are rung-1 work with no fetch and no credentials respectively; the third is disclosed with its coordinate and pinned version. Section 5.6 makes this classification the input to every remaining question about private dependencies, so it ships with the resolver rather than after it.
16. **A curated library API model** — per-framework sources, sinks, sanitisers, and dangerous signatures, matched by name and shape rather than resolved type, with per-framework coverage graded openly (comprehensive or partial) so a rule can state what its model covers. `docs/specs/2026-08-30-how-they-do-it.md` §3 establishes this as the mechanism that lets flaw-finding work without resolution into dependency code; it is a data asset with its own curation cost, not a rule-authoring detail.
17. **A public-artifact index, shipped as data and extended locally** — declarations, and where cheap the call edges, per public artifact coordinate and hash, with first-party code stitched against it per review (`docs/specs/2026-08-30-how-they-do-it.md` §5). **Not a service in the request path:** a verifiable published bundle the runner pulls and keeps warm, seeding a local index the runner then extends with whatever artifacts it actually encounters. That makes the index a distribution concern rather than an availability dependency, and it means a customer with no egress to us still benefits from whatever their own runner has already seen.

    **The index stores facts, never text, and that is a schema constraint rather than a policy.** Permitted: fully-qualified names, type and member signatures, modifiers and visibility, declaration coordinates, and edges between them. Excluded from the shared index entirely: doc comments, method bodies, and any cached source or bytecode fragment. The excluded fields are the expressive ones; the permitted fields are functional facts about a published interface, which is why the shared index is licence-safe by construction rather than by argument (`docs/specs/2026-08-30-how-they-do-it.md` §10). Where a doc comment is genuinely useful to a reviewer, read it at answer time from the artifact that analysis already has in hand, and keep it out of the shared store.
18. **Cross-repository resolution inside one organisation** — when a dependency coordinate in the lockfile matches a coordinate published by a repository the customer has granted us, resolve against that repository's source instead of hunting the artifact. Deterministic from declarations we already parse, needs no registry credential, and yields resolved symbols rather than an agent's search of a sibling tree (§5.8).

    **Ref selection is the hard part and must be explicit, never implicit.** The sibling repository's default branch is *not* the version the lockfile pins, so resolving against `HEAD` silently answers a different question than the one asked. The rule: resolve against the tag or commit the lockfile pins when the repository carries it; fall back to the default branch only when it does not; and record which ref answered, on every fact, so a reviewer can tell "this breaks the version you depend on" from "this breaks the sibling's current main". A review may also legitimately want the unmerged branch of a coordinated change, which makes the ref a per-analysis input rather than a fixed setting.
19. **The runner's own persistence, and an explicit warm-up step** — a dependency cache keyed by lockfile identity, the fact store for base refs, warm sibling-repository indexes, provisioned toolchains, and a resident engine process so compiler-frontend cold start is paid once rather than per review. **Provisioning is a named first step of the first analysis**, not a condition to detect and degrade under: fetch the declared archives, build the base-ref store, index the siblings, install the toolchain, then analyse (§5.5). Each of these is what makes the tiers above reachable in practice rather than in principle, and each carries the ordinary obligations of a cache: invalidation on identity change, a disk bound, and an eviction policy.
20. **A resolution-health report for the operator** — per analysis: which authorities were available, what was fetched, what was not and why, the coordinates and affected-reference counts per shortfall, and the specific grant that would close each one. Rendered once for the operator rather than repeated per review, and distinct from the reviewer-facing orientation output below (§5.7).
21. **The orientation output** — for a given change set, the declarations it touches, the files importing them, bound callers and labelled candidate sets, external symbols we could not fetch and why, and the runtime-wiring sites inside the affected set. Section 5.6 makes this a first-class product of the graph rather than a by-product of the findings path, and it must work entirely at rung 1.

## 10. Revised cost

Section 7 of the scope decision costed this part **Large**, driven by per-language emitters. None of those emitters has to be written: JDT and the Analysis API are libraries, the SCIP producers are existing tools we can provision in a sandbox, and the grammar tier is an embeddable parser.

**Revised: Medium, with the sandbox off the critical path.** The graph work is unchanged in kind — the store, the basis model, the unresolved-set recovery, the edge-kind derivation, the delta protocol, the queries, the import-scoped resolver with candidate sets, worker supervision, honest degradation. The sandbox and its escalation policy (work items 13 and 14) are real but deferrable: since no feature may depend on them, they can land after the product works, and their absence costs precision on some repositories rather than capability on all of them.

**Amended again by `docs/specs/2026-08-30-how-they-do-it.md`:** two items move in, and one assumption moves out. In: the curated library API model (item 16) and the central public-artifact index (item 17), both genuinely new work with their own curation and operations cost. Out: the assumption that a type checker is on the critical path at all. That document's §8 maps our five goals onto nine question-cost levels and finds **no goal requires the type-checker level to function** — it raises precision on a bounded minority of flaw-finding rules, and goals 4 and 5 bottom out one level below it. Net cost stays Medium, with the mix shifted from resolver depth toward model curation and index operations.

What the reframing in section 5.9 does change is *what to optimise*. The graph's second consumer is the reviewing model, and orientation quality — right files, right declarations, labelled ambiguity, explicit blind spots — is on the critical path of every review while type-inference precision is not. So the priority order is: rung-1 breadth across languages, then orientation quality, then the deterministic-findings path that needs precision, then escalation. Measuring how far rung-1 facts get is therefore the first task, not the fallback plan.

## 11. Spike results

All four ran on 2026-08-29. Full measurements, commands, and failures are in `docs/spikes/`; the decisive numbers are here.

| Spike | Result | Findings |
|---|---|---|
| **JDT for Java** | 203,436 lines of external Java: **99.998%** of 251,399 reference names resolved, **100%** of 78,474 call sites, 51.5% of calls into the JDK or a dependency, 0 semantic errors, ~20 ms/kLOC, 890 MB peak. Without a classpath: 57.7% trustworthy, 42.7% of calls, and zero library edges. Embeddable floor measured at **10 jars, 10.6 MB**. Overload keys are stable and distinct across runs. | `2026-08-29-jdt-java-resolution.md` |
| **Kotlin, three routes** | Analysis API standalone at Kotlin **2.4.0 — our own pinned version** — resolved all 2,839 references with **0 unresolved**, 1,119 into libraries, 17 artifacts, 79.7 MiB, no Scala runtime. `kotlin2cpg` works as an out-of-process fallback at 155.7 MiB with a Scala 3 runtime and a 2.3.21 compiler. scip-java's Kotlin plugin **cannot load into any Kotlin ≥ 2.3**. | `2026-08-29-kotlin-resolution.md` |
| **SCIP round trip** | 44,401 lines indexed in 5.9 s, decoded in-process in **93 ms** via the Maven Central bindings. Every typed edge kind derivable. Both predicted derivation signals absent; a working call rule found and hand-checked at 95/95 with 94–98.5% recall. Unresolved set **not** synthesizable from occurrences. Moniker parse 265–560 ns per symbol. | `2026-08-29-scip-round-trip.md` |
| **Bytecode tier** | **961 resolved call edges from our own bytecode into dependency and platform code** where the source-only baseline had zero, 86% mapped to an exact source file and line, 82 distinct dependency classes, plus 38 annotation references naming `Test` exactly. Rapid-type analysis only: class-hierarchy analysis with the JDK in scope produced 8.2 million edges in 503 s at 11 GB. **Tier cut by the no-build rule** — class files exist only after a compile, and nothing is compiled. Kept as the measured price of that rule. | `2026-08-29-bytecode-tier.md` |

Three results change the design rather than merely confirming it:

1. **Kotlin needs no frontend of ours** — but it needs a frontend *per target language version*, resolved and cached at analysis time rather than pinned at our build time. The measurement proves the route; it does not license the deployment shape it was measured in. See section 5.1.
2. **The unresolved set is ours to recover, not merely to record.** SCIP producers emit no trace of a failed reference, so the recovery pass — re-lex, diff positions, subtract language predeclared identifiers — is a required component of the ingest path, not an optional nicety. It also means confidence tagging cannot be inferred from the index alone.
3. **The bytecode tier quantifies the cost of the no-build rule.** It buys edges no source tier produces — 8.2 million edges in 503 seconds at 11 GB on one configuration, and 961 cross-boundary call edges where the source baseline had zero. It needs class files, so it is cut. Kept as the price tag on statement 1 of the scope rule, and as the argument for revisiting if that statement ever changes.

Carried forward as unmeasured, in priority order under the settled no-build rule:

1. **The Java and Kotlin fidelity of declarations plus pinned public archives plus reviewed sibling sources, with no build tool invoked.** The gating number. The JDT spike bracketed it at 99.998% (build-supplied classpath, now out of reach) and 57.7% (nothing at all); where we actually land decides whether Java is a resolved tier or a declaration tier.
2. **The share of references in an annotation-heavy repository that bind only to generated types.** Decides the generated-sources question in §5.3.
3. **The share of unresolved references pointing at private third-party artifacts with no readable source** (work item 15) — the only permanently unresolvable bucket.
4. **Whether reading the runner's local artifact cache is worth its non-reproducibility** (§5.8).

No longer measured, because the rule removed the question: how often an unfamiliar repository resolves its dependencies or compiles unattended, and what each escalation costs in wall-clock.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| **The product's fidelity is exactly what declarations, pinned public archives, and reviewed sibling sources yield** — there is no escalation to rescue it | measured brackets: with a build-supplied classpath Java resolved 99.998% of names and Kotlin had zero unresolved references; with nothing, Java fell to 57.7% trustworthy and zero library bindings. The settled rule puts us between those and nobody has measured where. **This is the gating measurement of the whole design** (section 11) |
| Kotlin Analysis API offers no compatibility guarantee across Kotlin versions | pin our Kotlin version deliberately and treat an upgrade as a spike; the alternative routes stay documented |
| `kotlin2cpg` pins its own embedded compiler version | if adopted, isolate it out of process rather than sharing a classloader with our toolchain |
| EPL-2.0 (JDT) is weak copyleft | it permits use as an unmodified linked dependency; do not fork it into our tree without re-reading the terms |
| Single-maintainer velocity across the SCIP family despite the independent organization | the format is stable and our reader is ours; a dead producer costs a tier, not the part |
| The Kotlin Analysis API is not on Maven Central and is versioned against IDE bootstrap builds | the coordinate that works, `analysis-api-*-for-ide:2.4.0`, equals our pinned compiler version, so the repository declaration and the version bump are one decision; a Kotlin upgrade re-runs the Kotlin spike before it lands |
| **The private-artifact share of unresolved references is unmeasured** | it is the number that decides whether private dependencies are a real gap or a rounding error, and whether a registry credential is ever worth offering. Measure it with work item 15 on a real multi-module repository before designing anything for bucket three. Until then, assume the honest-disclosure path is the whole answer |
| A private third-party artifact with no readable source cannot be resolved at all | accepted permanently: attribute it from the lockfile, mark affected references expected-missing, report the grant that would help if one exists. Work item 15 measures how often this bites |
| **Generated sources have no route under the no-build rule** | option A of §5.3 is mandatory — detect the generator from the build declarations and disclose the gap. Options B and C may add fidelity; option D is forbidden. **Open**, gated on measuring what share of references in an annotation-heavy repository bind only to generated types |
| SCIP moniker keys shift with producer configuration, and multi-module repositories are silently truncated | record the producer, its version, and its configuration alongside the facts; verify module coverage independently of the producer's own missing-document check, which reported nothing while 18.6% of identifiers were absent |
| Go, TypeScript, JavaScript, and Python never reach type-inference precision | permanent under the settled rule. Their declaration-level facts are reachable — Go modules ship source, TS/JS ship `.d.ts`, Python stubs distribute separately — so the loss is overload selection, generic instantiation, and inheritance-precise dispatch, not attribution or signatures |
| Untrusted input has one kind: hostile data | malformed archives, decompression bombs, pathological nesting, quadratic identifier streams, reaching parsers and archive readers. Contained by worker isolation. The execution kind is gone with the build |
| A target's language version may have no frontend we can obtain | fall back to the bases that need no frontend — declarations, imports, scope-local binding, declared types — and mark the type-inference-dependent facts absent rather than presenting a mismatched frontend's output as checked |
| **Runtime-wired edges are invisible, not unresolved** — dependency injection, service loaders, reflection, proxies, annotation-driven dispatch, configuration-named classes | detect the wiring *sites* statically and report their count within every affected set; a guess about the edge is a separate, `heuristic`-tagged product from the count, and the count ships whether the guess does or not |
| A contribution can choose which bytes we fetch and from where | coordinates may come from the pull request, hosts may not: the allowlist comes from the base ref and operator configuration, and a fetched artifact is verified against the lockfile's pinned hash (§5.6) |
| A private artifact resolvable only from the runner's local cache is non-reproducible | **open** (§5.8): reading it breaks no rule and costs nothing, but two analyses of one commit could disagree. If allowed it needs its own basis value, so a fact resting on incidental machine state is never mistaken for one resting on a pinned artifact |
| Facts from an unaccepted contribution could pollute the graph the next reviewer reads | a pull-request analysis is a discardable overlay over the base ref's facts, promoted only on merge. Delta application needs a trust dimension alongside its scope dimension (§5.6, work item 1) |
| Missing authority — a sibling repository not shared, or a host not allowlisted | the one thing we cannot provision, and therefore reported rather than designed around (§5.7): resolve as far as authority allows, then name the repository or host, the coordinates, the affected-reference count, and the exact grant that would close the gap. Work item 20 |
| A cold runner is a provisioning step, not a degraded mode | warm it first — fetch declared archives, build the base-ref store, index siblings, install the toolchain — then analyse. One-time latency, never a fidelity difference, and never a justification for anything (§5.5) |
| The runner's cache and persistent store are ours to operate, and become ours to get wrong | a cache keyed on lockfile identity must invalidate when that identity changes; a persistent store must not let stale facts outlive the code they describe; disk growth needs a bound and an eviction policy. These are the costs of the answer in §5.5, and they are ordinary engineering rather than open questions |
| A curated library API model is a permanent curation cost, not a one-time build | Snyk grades framework coverage as comprehensive or partial and gates it on having been trained on projects using that framework; coverage decay as frameworks move is inherent. Grade coverage openly per framework and let a rule state what its model covers, so a gap is visible rather than a silent miss (`docs/specs/2026-08-30-how-they-do-it.md` §3) |
| A central public-artifact index must not become a text cache | the copyright question on a facts-only index of published interfaces is settled enough to build on (`docs/specs/2026-08-30-how-they-do-it.md` §10); it stops being settled the moment doc comments, bodies, or source fragments enter the shared store. Enforce it in the schema, not in review: those columns must not exist. The live constraints are operational instead — registry bulk-fetch etiquette and rate limits, storage scale, refresh policy, and exhaustive-versus-popularity-ranked coverage |
| Maven has no lockfile, so the JVM is the industry's worst case and ours | every vendor examined either requires a build for Maven or shells out to Maven purely to resolve; GitHub's `build-mode: none` default for Java does exactly the latter. Our declarations-plus-local-cache path is therefore unexplored rather than known-bad, which is why measuring it is the first task (`docs/specs/2026-08-30-how-they-do-it.md` §2, §6) |
| Cross-repository resolution against the wrong ref answers a different question than the one asked | the sibling repository's `HEAD` is not the version the lockfile pins. Resolve against the pinned tag or commit, fall back to the default branch only when it is absent, and record the ref on every fact so "breaks the version you depend on" stays distinguishable from "breaks the sibling's current main" (§5.8, work item 18) |
| Cross-repository access widens the blast radius of a compromise | reading a sibling repository is read-only SCM access the customer grants per repository, and it must stay per repository rather than org-wide by default. A contribution to repository A must never cause a credentialed operation against repository B beyond that read (§5.6) |
| The graph serves two consumers with opposite biases | deterministic findings want precision and silence when unsure; orientation for the reviewing model wants recall with labelled uncertainty. One store, two consumers, reconciled only by the per-fact basis field — which is why that field is load-bearing rather than decorative (section 5.9) |

## 13. Traps recorded so they are not re-litigated

- **CodeQL** has the best fidelity surveyed and licence terms that forbid exactly our use: a commercial product analyzing codebases that are not open source. Not a negotiation, a prohibition.
- **jQAssistant** is the closest structural match to this part's contract — persisted graph, typed edges, JVM-native, actively maintained — and is GPL-3.0 over an embedded GPLv3 database. Unshippable.
- **Stack graphs** is the algorithm behind a major platform's precise navigation, which reads as proven; it is archived by its owner, has no Go or Kotlin rules, and only its Python ruleset has a production record.
- **Glean** reads as "just run it as a service" until the build requirements appear: a Haskell toolchain, a C++ runtime, RocksDB, Thrift, and no first-party JVM client.
- **OpenGrok** is JVM-native, released this month, and is a text-and-ctags index rather than a typed-edge graph — behind the tools we already have, under a weak-copyleft licence its reputation does not suggest.
- **Spoon's** permissive licence choice does not remove EPL exposure, because its compiler backend is JDT. If JDT's fidelity is what you want, depend on JDT.
- **"It is on Maven Central so it is a library"** — scip-java publishes a jar whose `main` drives an external build. Only the bindings are genuinely embeddable, and they only decode.
- **`workspace/symbol` with an empty query** looks like a bulk enumeration primitive and is refused in practice by the implementations that matter.

## 14. How the upstream product sources resolution inputs, per language

Recorded because the question "does resolution need the target's build?" already has a large, shipped answer, and our own clean-room corpus documents it with provenance. Nothing here comes from reading upstream code; every claim cites a specification in this repository. The pattern matters more than the details: **there is no single mechanism. Each language family gets semantics a different way, and only two families need the target's build at all.**

The frame is a client-side scanner that runs where the environment is — a developer machine or a build agent — walks the tree from configured source roots, classifies each file main or test, invokes analyzers in its own process, collects version-control data, and publishes a report. The server receives facts and never touches the target's source, classpath, or build. That split is what lets environment-dependent work happen where the environment exists. [`specs/integrations/scanner-engine/specification.md` §Sources and tests, §Report steps]

| Family | Where semantics come from | Needs the target's build? |
|---|---|---|
| Java | ECJ parsing plus binding resolution over configured `binaries`, `libraries`, test variants, and a JDK home; a class-to-source index maps binary names back to files | **yes, for full fidelity** — and it degrades rather than fails |
| Kotlin | one standalone K2 Analysis API session per sensor, its library module assembled from the *Java* classpath properties in binaries-then-libraries order, entries accepted only when their first bytes identify a ZIP archive | same as Java |
| JavaScript, TypeScript | a bundled Node runtime driven over a loopback bridge; type information from discovered or configured `tsconfig.json` programs, with orphan files grouped into fallback programs | no build, but installed dependencies supply the types |
| Python | its own parser, a project symbol table with fully qualified module names, an import-relationship index, and **bundled version-filtered type stubs** | no |
| Go | a **bundled native parser binary per platform**, roughly 7.3 to 7.6 MB each, driven per directory batch with module context from `go.mod` | no |
| Anything else | import somebody else's report: SARIF 2.1.0 plus per-language linter formats, failures isolated per file and run | no — the other tool ran |

Four things in that table are worth taking, and one is worth taking as a warning.

**Degradation is explicit, rule-level, and never invented.** With no classpath, Java analysis "continues with binding recovery, emits classpath/unresolved-type warnings, and may produce fewer semantic findings rather than invented symbols"; Kotlin's incomplete classpath "can reduce semantic detections without preventing syntax-only rules"; the TypeScript contract states outright that "missing type information must never be replaced with guessed types; type-dependent rules remain silent." That is the same discipline our confidence field exists to enforce, arrived at independently. [`specs/analyzers/java/specification.md` §14 scenario 5; `specs/analyzers/kotlin/specification.md` §4; `specs/analyzers/typescript/specification.md` §failure behavior]

**There is already a reduced mode for "no build available", and it is not the scanner.** Two layers must not be confused. The *launchers* — a standalone command-line scanner plus build-integrated flavours for Maven, Gradle, .NET, and NPM — are entry points, and our corpus excludes them by decision, covering only the embedded engine they invoke [`specs/integrations/scanner-engine/specification.md` §3; `specs/manifest/component-inventory.md`]. Which launcher runs decides only one thing that matters here: whether the classpath properties get populated automatically. A build-integrated launcher knows the build model and fills them in; the standalone one does not, which is the entire reason JVM analysis is described as living inside the build.

The reduced mode is a layer below that, an internal analyzer flag rather than a product: `sonar.java.internal.batchMode` / `sonar.internal.analysis.autoscan`. When active, main and test files share one batch and the union of their classpaths, the missing-classpath presence and precision warnings are suppressed, and — the important part — `sonar.internal.analysis.autoscan.filtering`, defaulting to true in that mode, **limits the active checks to those that still work without full semantics**. So the answer to a target with no classpath is not a thinner graph presented as complete; it is a smaller, declared set of checks. The corpus marks these keys internal rather than portable public configuration. [`specs/analyzers/java/specification.md` §4.2–4.3, §Classpath and bytecode resolution]

**Two of the three languages we planned to reach through separate indexer tools are solved by bundling the frontend instead.** Go needs no toolchain on the machine because the parser ships as a native binary; Python needs no environment because the type stubs ship with the analyzer. That is a materially different trade from shelling out to an indexer that requires the target's own toolchain, and it is cheaper on the "arbitrary target" axis this document cares about: nothing to install, nothing to resolve, no version negotiation with the target. Section 5's out-of-process SCIP rows should be re-examined against it.

**The execution line sits exactly where we put ours.** The corpus records that a compatible implementation "must parse but never execute project code or Gradle scripts", that resolution "does not require executing project methods or static initializers", and that implementations must "never execute project scripts merely to discover metadata" — that last one refuses even the metadata-discovery shortcut, which is stricter than rung 2 of section 5.3. [`specs/analyzers/kotlin/specification.md` §13; `specs/analyzers/java/specification.md` §13; `specs/analyzers/javascript/specification.md` §trust boundaries]

**The warning: the .NET family is what happens when a language's only path is the build.** Its analysis is orchestrated by the build system with analyzers running inside the compilation, and without that orchestration the sensor imports no results at all — not degraded results, none. Any language whose resolution we can only obtain through the target's build inherits that cliff, which is why our own Java path is a source-plus-classpath resolver first and a build-integrated producer only opportunistically.
