# Code Graph Sourcing: Build, Improve, or Consume

**Date:** 2026-08-29
**Status:** Approved. The four spikes in section 11 ran on 2026-08-29; results are recorded there and in `docs/spikes/`. `platform/code-graph` is now plannable, and **no compiler frontend of our own is required.**
**Amends:** `docs/specs/2026-08-29-scope-decision.md` sections 7 and 12. Section 7 costed `platform/code-graph` as **Large**, driven by "one emitter per language analyzer". That assumption does not survive this evaluation.
**Method:** four parallel source-verified library investigations, every licence read from the project's own licence file, every maintenance claim pinned to a release or commit date observed on 2026-08-29

## 1. The question

Before writing per-language semantic frontends, three cheaper paths were tested: improve the MIT-licensed local indexer we already run, adopt the second local tool, or consume an existing code-graph library — with particular attention to Java and Kotlin, where the ecosystem is richest.

The conclusion, stated first: **stop planning to write frontends; plan to ingest resolved facts from compiler-backed producers, and own the store, the confidence model, and the queries.** Improving either local tool is the wrong investment, for reasons that are about their architecture and their maintainers' stated intent rather than their quality.

## 2. Verdicts

**Scope rule, final form 2026-08-29.** The product is complete at **rung 1** — source, dependency declarations, lockfiles, whatever archives it can fetch without credentials, and whatever index or report the customer already produced. Resolving dependencies or compiling inside a sandbox we own (rungs 2 and 3) is **opportunistic: allowed, never assumed, and never a prerequisite for any feature**, because on a private codebase it usually cannot succeed at all — section 5.5 gives the two reasons. Out of scope permanently: anything the customer must add, and running the target program or its tests.

This rule went through two wrong intermediate forms in one day, both recorded because the reasoning matters more than the conclusion. First "nothing executes, ever", which cut producers on a rule the owner never set. Then "sandbox execution is free because it imposes no customer burden", which ignored that a sandbox cannot reach a private artifact registry or reproduce a non-standard build. What survives is narrower and more useful: escalation is a bonus on the repositories where it happens to work, and the design may not lean on it.

| Candidate | Licence | Last activity | Fidelity | Shape for us | Verdict |
|---|---|---|---|---|---|
| Local grammar indexer (`@colbymchenry/codegraph`) | MIT | release 2026-08-26 | name matching, no classpath | separate process, Node + native addon | keep as dev tooling; do not improve, do not fork |
| Graphify (`graphifyy`) | Apache-2.0 | package current | tree-sitter + path resolution; plus a language-model narrative layer | Python CLI, output format only | keep as comprehension aid; never an input |
| **Eclipse JDT Core** | EPL-2.0 | release 2026-06-09, commit 2026-08-02 | **real ECJ compiler bindings, classpath optional, no build required** | **embeddable JVM library, Maven Central** | **adopt for Java** |
| **SCIP format + JVM bindings** | Apache-2.0 | schema v0.9.0 2026-06-29 | n/a (format) | `org.scip-code:scip-java-bindings`, in-process parse | **adopt as an optional import format** — free fidelity when a customer already produces an index, never a requirement |
| scip-go | Apache-2.0 | commit 2026-08-14 | compiler-backed (`go/packages`) | separate process, emits SCIP | **in scope at rung 2** — provision a Go toolchain and resolve modules in our sandbox; also importable when the customer already emits an index |
| scip-java (Java) | Apache-2.0 | release v0.13.1 2026-07-02 | compiler-backed `javac` plugin | drives Gradle/Maven/Bazel in our sandbox | **in scope at rung 3**, second to JDT: JDT still answers when compilation fails, which is why it stays primary |
| scip-java (Kotlin) | Apache-2.0 | same | cannot load into any Kotlin ≥ 2.3, measured | separate process | **cut** — disqualified on both counts |
| scip-typescript | Apache-2.0 | commit 2025-10-03 | compiler-backed (`tsc`) | Node CLI, emits SCIP | **in scope at rung 2** — install declared packages in our sandbox; dormancy risk noted below |
| scip-python | MIT | commit 2025-09-05 | compiler-backed (Pyright inference) | Node CLI, emits SCIP | **in scope at rung 2** — same shape; dormancy risk noted below |
| Joern `kotlin2cpg` / flatgraph | Apache-2.0 | commits 2026-08-28 | **embeds `kotlin-compiler-embeddable`** — genuinely compiler-backed Kotlin | Scala library, pinned compiler version | spike for Kotlin only |
| Kotlin Analysis API (K2 standalone) | Apache-2.0 | tracks Kotlin releases | real K2/FIR resolution without Gradle | JVM library, **not on Maven Central**, no stability guarantee | spike for Kotlin only |
| SootUp | LGPL-2.1 | release 2026-03-19 | bytecode, sound for its algorithm; needs compiled classes | embeddable JVM library, pure Java | **restored: in scope at rung 3.** Measured at 961 resolved call edges into dependency and platform code, 86% mapped to file and line. Also reads dependency archives as classpath metadata at rung 1 |
| WALA | EPL-2.0 | release 2026-07-01 | bytecode, more precise dispatch analysis | embeddable JVM library | spike against SootUp once the bytecode tier is live |
| tree-sitter (`io.github.treesitter:jtreesitter`) | MIT | current | parse only, no resolution | **embeddable JVM library** | adopt as breadth substrate |
| JavaParser symbol solver | Apache-2.0 / LGPL-3.0 | release 2026-06-01 | hand-written approximation of compiler semantics | embeddable JVM library | reject — JDT is higher fidelity at equal cost |
| Spoon | CeCILL-C / MIT | release 2026-07-14 | JDT underneath | embeddable JVM library | reject — depend on JDT directly |
| OPAL | BSD-2-Clause | commit 2026-01-19 | bytecode | JVM library, pulls a Scala runtime | behind SootUp and WALA; the Scala runtime is the tiebreaker against it |
| Depends | MIT | commit 2026-04-20 | ANTLR grammars, no build | pure-Java, runnable jar | spike for the non-Tier-1 breadth gap |
| Kythe | Apache-2.0 | release 2026-07-16 | compiler-backed, requires compilation | CLI extractors per language | possible at rung 3, but behind scip-java and JDT on every axis we care about; no reason to reach for it first |
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

No row asks the customer for anything. Rung-1 rows are the product: they must carry every feature on their own. Rung-2 and rung-3 rows run inside a sandbox we own and **only work when every dependency is publicly reachable and the build is reproducible without the customer's environment** (section 5.5), so they improve answers where they succeed and are absent everywhere else. Every row is measured against somebody else's codebase, not ours — section 5.1 says what the spikes do and do not prove.

| Producer | Rung | Runs where | Facts it earns | Needs |
|---|---|---|---|---|
| Grammar parse plus our own resolver — `jtreesitter` | 1 | in-process | declarations, imports, scope binding, import-scoped cross-file binding, declared and annotated types | source text only |
| The same, plus fetched dependency declarations | 1 | in-process, network to registries | adds external symbol attribution and signatures | dependency declarations and reachable artifacts |
| Eclipse JDT Core | 1, better at 2 | worker process | type-inference precision for Java | a classpath: declared archives at rung 1, package-manager-resolved at rung 2 |
| Kotlin Analysis API standalone | 1, better at 2 | worker, one per target language version | the same for Kotlin | the same classpath, plus a matching compiler frontend |
| scip-go, scip-typescript, scip-python | 2, opportunistic | sandbox tool process | compiler-backed resolution for Go, TypeScript, JavaScript, Python | a provisioned toolchain **and publicly resolvable dependencies** |
| scip-java | 3, opportunistic | sandbox build | compiler-backed Java, plus generated sources as a by-product | a compile that succeeds without the customer's environment |
| SootUp bytecode tier | 3, opportunistic | worker over compiled output | resolved call edges into dependency and platform code — measured at 961, 86% mapped to file and line | class files from a compile that succeeded |
| Any SCIP or SARIF artifact the customer already produced | import | in-process reader | whatever that producer earned, recorded against it | nothing; it exists or it does not |

**Escalation is opportunistic, and attempting it must be cheap to abandon.** Try rung 1 always; it is the only tier that always works. Attempt rung 2 for a language when its rung-1 facts leave a gap that matters and the dependency set looks publicly resolvable; abandon on the first authentication failure rather than prompting for credentials. Attempt rung 3 only where compilation plausibly succeeds unattended and buys something rung 2 cannot — generated sources, or the bytecode tier's edges. Record which rung produced each fact, and treat a failed escalation as ordinary, not exceptional: on a private codebase it is the expected outcome.

One producer stays cut on its own merits rather than on scope: **scip-java's Kotlin plugin**, which cannot load into any Kotlin at or above 2.3.

### 5.1 Self-analysis is not the product

The spikes answered "can this producer resolve references", and they answered it well. They did not answer "can this producer resolve references *in an arbitrary target*", and three of their conclusions need correcting on that axis.

**The Kotlin recommendation loses one of its three pillars.** Its numbers stand: 2,839 references, zero unresolved, 1,119 into libraries, 17 jars, no second language runtime. But "the artifact version equals the Kotlin version we already pin" was only true because the target *was us*. A target on Kotlin 1.9 or 2.0 needs a frontend for its language version; one embedded compiler resolves one language level well and degrades on others. So the Analysis API stays the recommendation, with a different deployment: a **per-version worker**, with the required compiler frontend resolved and cached per target rather than pinned once at our build time. That also removes the in-process objection — a target's compiler frontend never enters the service's classloader.

**The bytecode tier's requirement was misread, not its value.** Its 961 cross-boundary edges were measured on the one codebase whose classes were already sitting in a build directory, and compiled classes do mean a build has run — but the build can be ours, in our own sandbox, which asks the customer for nothing. The tier is therefore in scope at rung 3 — opportunistically, since that compile frequently will not succeed on a private codebase (section 5.5) — and the spike stands as its justification wherever it does.

**The Java measurement transfers furthest, and its framing needed one correction.** It obtained the classpath in 2.8 seconds without compiling, but by invoking the target's build tool — rung 2, which executes target-authored build logic and is in scope inside our sandbox. So the 99.998% figure describes the lucky case — a target whose dependencies are publicly reachable and whose build runs unattended — not the general one. What decides the product's actual fidelity is the rung-1 path underneath it: declarations plus archives resolved from a cache or a public repository with no package manager invoked. That is the number to measure first, because it is the one every customer gets.

### 5.2 Why analysis runs in worker processes

The single-process decision in the scope decision cut a supervised topology whose purpose was scaling a web tier apart from a worker tier. It did not license running compiler frontends over untrusted input inside the process that serves queries. Four reasons, three of them already measured:

- **Resource blowups are routine, not exceptional.** The bytecode spike reached 8.2 million edges, 503 seconds, and 11 GB on one configuration of a 750-line input. The Java spike peaked at 890 MB on 203k lines. In-process, those are the product dying rather than one analysis failing. A worker takes `-Xmx` and a deadline; the service survives the kill.
- **Target input is hostile until proven otherwise.** Parsers, class readers, and archive readers over attacker-influenced input are a well-known failure surface — malformed archives, pathological nesting, adversarial identifiers. Per-file failure isolation, which the analyzer specifications already require, is only credible if a crash is contained.
- **Version multiplicity is inherent.** Different targets need different compiler frontends, and a service that analyzes several targets cannot hold conflicting compiler versions in one classloader. Worker processes make version selection a launch argument instead of a classloading problem — which is why the classloader-isolation machinery cut from the plugin runtime does not need to come back.
- **The target program never executes; its build may.** Reading a class file is not running it, so a rung-1 worker needs crash and resource containment rather than a code sandbox. Rungs 2 and 3 are different: resolving dependencies or compiling runs target-authored build logic, which belongs in the isolated sandbox of work item 14, never in a worker sharing anything with the service. Section 5.3 draws that line.

The service process keeps what it always kept: settings, logging, the store, the queries, and the name-only tier. Resolution runs beside it and reports facts over a pipe or a file.

### 5.3 What runs, where, and on whose behalf

The target program never runs. Its build may, inside a sandbox we own. Those are different statements, and collapsing them is the mistake this section previously made.

**What "untrusted input" means, given that.** At rung 1 the risk is malformed and adversarial *data* — stack exhaustion, pathological nesting, decompression bombs, quadratic identifier handling — and worker isolation contains a crash rather than sandboxing code. At rungs 2 and 3 the risk changes kind: a build file is a program, an install script is a program, and both now execute on our infrastructure. That is a supply-chain and egress problem, not a parser-robustness problem, and it needs the controls named in work item 14.

**It settles the escalation ladder — but the ladder was conflating two independent axes**, and a comparable review product demonstrates the distinction (`docs/specs/2026-08-29-coderabbit-approach.md`). One axis is **who bears the burden**: does the customer have to change their repository, their build, or their pipeline? The other is **where execution happens**: does target-authored code run at all, and if so, in whose environment? The trim rule the owner set concerns the first axis only.

| Rung | What it touches | Customer burden | Executes target-authored code | Policy |
|---|---|---|---|---|
| 1. Files at rest | source, dependency declarations, lockfiles, archives named by those declarations, indexes or reports the customer already produced | none | no | **in scope, the baseline guarantee** |
| 2. Dependency resolution in our own sandbox | fetching declared artifacts, and optionally letting a package manager resolve them | none — but it only works when every dependency is publicly reachable | possibly: a build file or install script is a program | **opportunistic bonus**; no feature may require it |
| 3. Compilation in our own sandbox | producing class files or generated sources from the fetched checkout | none — but it only works when the build is reproducible without the customer's environment | yes | **opportunistic bonus**; no feature may require it |
| 4. Customer build integration | a plugin, a CI step, or an artifact the customer must produce for us | **real, and the trim rule excludes it** | yes, in their environment | out of scope |
| 5. Program or test execution | running the target or its suite | — | yes | **never us** |

**What the comparison shows, and its limit.** The product examined in that document asks the customer for nothing but an app installation and still installs the target's declared dependencies inside a sandbox it controls; its FAQ states it "can execute shell commands". So rungs 2 and 3 do exist with zero customer burden. But they exist *conditionally*, and section 5.5 explains why that condition fails on exactly the codebases a paying customer has.

**One calibration worth keeping in view before assuming depth follows from a sandbox:** that product installs dependencies and still declines type-checked analysis. Type-aware rules in its flagship JavaScript path are documented as disabled, and its one Java tool capable of deeper analysis is off by default precisely "because Java analysis may require compiling more than the changed files". Having the capability is not the same as spending it at review latency.

The Java spike sat on rung 2 and called itself build-free, which is true about compilation and false about execution: the classpath came from invoking the target's build tool, and a build file is a program. Whether rung 1 alone can carry Java and Kotlin — declarations plus archives resolved from a cache or repository, no package manager invoked — remains the load-bearing unmeasured question from section 5.1, and it is exactly the question rung 2 would make moot.

Rung 3 earns its place partly on a consequence no measurement here exercised: **generated sources do not exist in a checkout at rest.** Annotation processors and code generators, which the JVM ecosystem is full of, produce types that hand-written code references, and without compilation those references have no declaration to bind to. At rung 1 they land in the unresolved set for a reason that is neither a producer defect nor hostile input — the target's source is simply incomplete until something runs — and the honest behaviour is to detect the generator from the build declarations and say so. Compiling in our sandbox removes the gap where it works, which is the clearest case where escalation pays — but disclosure is the behaviour that must always be correct, since the compile is the part we cannot promise.

Rung 5 stays outside the product permanently, which keeps two earlier decisions consistent: runtime profiles and hot paths were cut because no goal names performance, and test attribution is an *import* of a report someone else produced by running tests — the coverage tool runs, we never do. Fix verification, likewise, means re-running **analysis** over a named scope, never running the program to see whether it still works.

**And it creates the third question, which is the interesting one.** A static graph cannot see edges that only exist while the program runs: dependency injection, service loaders, reflection, dynamic proxies, annotation-driven dispatch, configuration-named handler classes, `invokedynamic` targets the bytecode tier already loses. These are not unresolved references. An unresolved reference is a known unknown — we saw an identifier and could not bind it. A runtime-wired edge is an *unknown unknown*: nothing at the call site hints that the edge exists at all, so it is invisible rather than unresolved, and a blast radius that omits it silently is exactly the failure section 7 of the scope decision calls worse than no answer.

The store therefore needs a third honesty channel beside resolved facts and the unresolved set: **runtime-wiring sites**. These are statically detectable even when the edge they imply is not — reflection and service-loader calls, injection annotations, proxy factories, class names appearing as configuration string literals. Detect the sites, count them within the affected set, and report the count on every impact answer. The local grammar tool's framework synthesizers, which guess these edges and tag them `heuristic`, are the prior art for the guessing; the discipline we add is that a guess and a count are different products, and an impact answer must carry the count whether or not it carries the guess.

### 5.4 Evidence a checkout carries that is not a graph edge

The graph is not the only thing an at-rest checkout gives us, and the earlier framing quietly ignored three channels that a code-review product lives on.

**Comments are semi-formal type and intent evidence.** JSDoc `@param {Type}` and `@returns`, Python docstring type conventions, KDoc and Javadoc `@param`, and inline `@type` pragmas state types that the language itself does not require. For untyped JavaScript in particular, JSDoc is often the only declared typing in the codebase, and it binds through the same import graph as anything else. It earns its own basis — declared-in-comment — which is weaker than a checked type and much stronger than a name match, and it must be tagged as such rather than laundered into either neighbour.

**The change under review is evidence no static index holds.** A pull request supplies the changed hunks, which localise every question; the title, body, and commit messages, which state intent; and reviewer comments, which state constraints the code cannot. Goals 2 and 3 — find flaws, suggest fixes — consume that directly: a finding inside a changed hunk with the author's stated intent beside it is a different product from the same finding surfaced in a repository sweep. This is review evidence, not graph structure, and the two must not be mixed in the store; but it is why a review product can be useful precisely where the graph is thinnest.

**Whole-repository access enables inference a per-file tool cannot reach.** Because we hold everything at once: a name that is unique within the set reachable through a file's imports resolves without types; test-to-code pairing follows naming and directory convention; the class names in configuration literals can be matched against declarations, which is what turns a runtime-wiring *site* into a named candidate; and version-control history supplies co-change coupling, authorship, and churn. None of these needs a compiler, a build, or an execution.

The discipline stays the one already stated: each of these is a distinct basis, recorded as such. A comment-declared type, a convention-matched test, and a checked type are three different claims, and an answer that presents them as one is the dishonest kind of confident.

### 5.5 Why escalation cannot be the foundation

Two constraints make rungs 2 and 3 unreliable on precisely the repositories that matter, and neither is solvable by engineering on our side.

**Private dependencies need credentials we must not ask for.** A private Maven repository, an authenticated npm registry, a `GOPRIVATE` module proxy, a private package index, a git submodule over SSH — each needs a secret to resolve. Asking the customer for registry credentials is exactly the "extra setup" the scope rule excludes, and it is a far heavier ask than a build plugin: registry tokens frequently carry publish rights, so the request is "give our sandbox the ability to push artifacts into your supply chain". No amount of sandbox hygiene makes that a reasonable default. Without those credentials a private dependency is simply unfetchable, and the resolution that depended on it does not happen.

**Build strategies are not reproducible from a checkout.** A monorepo driven by a hermetic build system, a custom toolchain pinned by an internal distribution, code generation wired into the build graph, native components needing platform SDKs, base images from a private registry, environment-specific configuration, a license server for a proprietary compiler: any one of these turns "compile the target" into "reproduce the customer's engineering environment". That is not a sandbox feature, it is their whole build platform. Escalation succeeds on a public-registry, single-module, standard-layout project — a demo — and fails where the money is.

**The comparable product corroborates this by omission.** It installs dependencies and it reviews private repositories, and it requires no registry credentials from the customer. Both cannot be true in general, so its dependency installation must be best-effort and frequently unsuccessful — which is consistent with what its own documentation admits elsewhere: type-aware rules disabled, deep Java analysis off by default because it "may require compiling more than the changed files". It is not running a full semantic analysis and quietly succeeding; it is running cheap tools broadly and deep tools rarely.

The design consequence is simple and it is now a rule: **rung 1 must be sufficient for every feature, and escalation may only make an answer better, never make it possible.**

### 5.6 What to do about private dependencies, and why not a build plugin

"Unfetchable dependency" is not one bucket, and the design has been treating it as one. Every unresolved cross-boundary reference points at exactly one of three targets:

| Target of the reference | Reachable at rung 1? | How |
|---|---|---|
| **A sibling module in the same checkout** — the monorepo case | **yes, no fetch at all** | the declarations are files we already parsed; this is multi-module resolution, not dependency resolution |
| **A public registry artifact** — Maven Central, npm, PyPI, crates.io, Go proxy | **yes, no credentials** | fetch the declared archive by coordinate and hash from the lockfile, read its declarations, never run a package manager |
| **A private artifact** — the org's internal library, an authenticated registry | no | attributed and unresolved: name the coordinate and pinned version from the lockfile, mark the references expected-missing |

**Only the third bucket is the problem, and nobody has measured how big it is.** That measurement is the decision input, and it is cheap: on a real multi-module repository, classify unresolved references by target bucket. The intuition worth testing is that bucket three is small, because internal libraries are a minority of any dependency tree and first-party code — where a diff lives and where blast radius flows — resolves through buckets one and two.

**And bucket three costs least where the graph is worth most.** Private-dependency resolution buys member types and exact overload selection: precision for the deterministic-findings consumer. It buys almost nothing for the orientation consumer of section 5.7, which needs to know which files a change reaches — and reachability runs through first-party code. A reviewer does not need `com.acme.internal.Client`'s member signatures to be told the four files that call the changed method.

**A build plugin is rejected on three grounds, not on burden alone.**

- **It rebuilds the .NET cliff we documented in section 14.** A language whose resolution comes only from the build inherits that failure mode: without the orchestration, no degraded result — nothing. A plugin makes fidelity binary and installation-dependent instead of graceful.
- **It is a product family, not a feature.** Maven, Gradle, Bazel, sbt, npm, Cargo, MSBuild, each versioned against tool releases we do not control, each a support surface. The whole reason the escalation ladder was attractive was avoiding exactly this.
- **It answers the wrong question.** A plugin would deliver a resolved classpath — bucket three plus the buckets we already have. Paying a permanent distribution and support cost for the smallest and least valuable bucket is a bad trade at any burden level.

**What we accept instead, in priority order.** Buckets one and two at rung 1, by construction. Artifacts already lying in the checkout — vendored trees, committed `.d.ts` and type stubs, `go.sum` hashes — read for free. An index or report the customer already produces for their own reasons, imported when present and never requested (section 7). Sandbox escalation where it happens to work. A customer-supplied read-only registry credential is the last option and stays *offered, never assumed*: it may only raise precision on a repository that already works without it, and it may be built only if the bucket-three measurement says it earns the trust cost.

### 5.7 The two consumers of the graph

The correction above forces a question the document had not asked: if the resolved tier is conditional, what is the graph *for*? It has two consumers, and they want different things.

**Consumer one: deterministic findings.** Facts we can assert without a model — a null dereference on a checked type, a secret in a literal, a duplicated block, a call into a deprecated declaration. Precision is the currency here. A finding we cannot substantiate is worse than silence, which is why the basis field gates which rules may fire: a rule needing checked types stays silent when only `declared` or `import-scoped` facts exist, exactly as the reduced mode in section 14 does.

**Consumer two: orientation for the reviewing model.** This is the one the earlier framing missed. An LLM reviewing a diff can read code perfectly well; what it cannot do is know *which* code to read out of a repository it sees through a keyhole, or know what it is not being shown. The graph's job there is to point: these are the declarations the diff touches, these are the files that import them, these are the callers we could bind and the candidates we could not, this symbol comes from a dependency we could not fetch, these three sites are runtime-wired so the static picture is incomplete here.

That inverts several judgments made earlier in this document:

- **A candidate set is a useful output, not a failed resolution.** Under the precision framing, an import-scoped reference with three reachable candidates was a non-fact. As orientation it is excellent: hand the reviewer all three and say the resolution is ambiguous. Work item 11 should therefore return candidate sets with their size, not only unique hits.
- **Recall and honesty outrank precision for this consumer.** Missing a caller is worse than offering an uncertain one, provided the uncertainty is labelled. That is the opposite of the finding path's bias, and both live in one store, which is why per-fact basis is load-bearing rather than decorative.
- **The unresolved set and the runtime-wiring sites become prompts, not just caveats.** "Fourteen references in this diff bind to a dependency we could not fetch" and "this changed class is named in two configuration literals" are instructions to a reviewer about where its own reading must do the work.
- **Orientation must be cheap and always available.** It sits on the critical path of every review, so it belongs at rung 1 by construction. A capability that only works when a sandbox build succeeds cannot be what tells the reviewer where to look.

The identity boundary from the scope decision survives this intact and gets sharper: we own the facts and the pointing; the model owns the judgment and the prose. What changes is that pointing is now a first-class product of the graph, ranked beside the findings rather than behind them.

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
4. **Delta application** against our own store, on the unit-and-ownership model.
5. **Persistence and query** — the embedded relational store, recursive reachability, bounded traversal with a truncation marker.
6. **Orchestration** of producers whose runtimes differ, with graceful degradation to the grammar producer when a compiler frontend is absent, mismatched, or fails — never silent substitution of a weaker basis for a stronger one.
7. **Recovery of the unresolved set per producer** — re-lexing and position-diffing where the producer records nothing, per section 7.
8. **Target inspection, dependency resolution, and producer selection** — parse the target's dependency declarations; at rung 1 resolve the archives they name from a cache or a declared repository, at rung 2 let the ecosystem's package manager resolve them inside our sandbox; detect each language's version; choose and cache the matching frontend; and record producer identity, version, configuration, **and the rung used** with every fact.
9. **Worker supervision** — launch a producer with a heap cap and a deadline, contain its crash to one analysis, and degrade to the next tier down on failure rather than reporting a thin graph as complete.
10. **Runtime-wiring site detection** — reflection, service loaders, injection annotations, proxy factories, and class names in configuration literals, counted within any affected set so an impact answer states how much of the program's real wiring a static graph cannot see.
11. **An import-scoped resolver returning candidate sets** — resolve each reference against the declarations reachable through its file's own import edges. A single reachable candidate is a fact; several are a *labelled candidate set*, which section 5.7 establishes as useful output rather than a failure, because a reviewing model can be handed three candidates and told the binding is ambiguous. Record the set and its size either way. Motivating measurement in section 5: 120 references match some declaration by name here, across 676 candidate pairings.
12. **Dependency declaration fetching** — read the archives named by the target's dependency declarations, from a local artifact cache or a declared repository, and index the declarations inside them. Already accepted for the JVM classpath; extended by section 5 to Go module source, package type declarations for TypeScript and JavaScript, and Python stubs. This is what raises external symbols from unattributed to typed, for every ecosystem whose distribution carries declarations.
13. **The escalation policy** — decide whether to attempt rung 2 or rung 3 for a given analysis and language, and abandon cheaply when it fails. Inputs: what the question needs, what rung-1 facts already cover, whether the dependency set looks publicly resolvable, the declared build system, and a latency budget. Two hard rules: never prompt for registry credentials, and never let a failed escalation degrade an answer below what rung 1 already produced. Record which rung produced each fact, because "why is this blast radius incomplete" and "which rung answered" are the same question.
14. **Sandbox controls, whenever rungs 2 and 3 are attempted** — an isolated, ephemeral environment per analysis; egress restricted to public package registries and denied to internal networks; no credentials reachable from it, ours or the customer's; resource and wall-clock caps; a cache with a stated lifetime; and a record of what was fetched, installed, and compiled. Deferrable with the escalation itself, since no feature depends on it, but mandatory the moment it is switched on.

15. **Unresolved-reference bucketing** — classify every unresolved cross-boundary reference by target: sibling module in the checkout, public registry artifact, or private artifact. The first two are rung-1 work with no fetch and no credentials respectively; the third is disclosed with its coordinate and pinned version. Section 5.6 makes this classification the input to every remaining question about private dependencies, so it ships with the resolver rather than after it.
16. **The orientation output** — for a given change set, the declarations it touches, the files importing them, bound callers and labelled candidate sets, external symbols we could not fetch and why, and the runtime-wiring sites inside the affected set. Section 5.6 makes this a first-class product of the graph rather than a by-product of the findings path, and it must work entirely at rung 1.

## 10. Revised cost

Section 7 of the scope decision costed this part **Large**, driven by per-language emitters. None of those emitters has to be written: JDT and the Analysis API are libraries, the SCIP producers are existing tools we can provision in a sandbox, and the grammar tier is an embeddable parser.

**Revised: Medium, with the sandbox off the critical path.** The graph work is unchanged in kind — the store, the basis model, the unresolved-set recovery, the edge-kind derivation, the delta protocol, the queries, the import-scoped resolver with candidate sets, worker supervision, honest degradation. The sandbox and its escalation policy (work items 13 and 14) are real but deferrable: since no feature may depend on them, they can land after the product works, and their absence costs precision on some repositories rather than capability on all of them.

What the reframing in section 5.7 does change is *what to optimise*. The graph's second consumer is the reviewing model, and orientation quality — right files, right declarations, labelled ambiguity, explicit blind spots — is on the critical path of every review while type-inference precision is not. So the priority order is: rung-1 breadth across languages, then orientation quality, then the deterministic-findings path that needs precision, then escalation. Measuring how far rung-1 facts get is therefore the first task, not the fallback plan.

## 11. Spike results

All four ran on 2026-08-29. Full measurements, commands, and failures are in `docs/spikes/`; the decisive numbers are here.

| Spike | Result | Findings |
|---|---|---|
| **JDT for Java** | 203,436 lines of external Java: **99.998%** of 251,399 reference names resolved, **100%** of 78,474 call sites, 51.5% of calls into the JDK or a dependency, 0 semantic errors, ~20 ms/kLOC, 890 MB peak. Without a classpath: 57.7% trustworthy, 42.7% of calls, and zero library edges. Embeddable floor measured at **10 jars, 10.6 MB**. Overload keys are stable and distinct across runs. | `2026-08-29-jdt-java-resolution.md` |
| **Kotlin, three routes** | Analysis API standalone at Kotlin **2.4.0 — our own pinned version** — resolved all 2,839 references with **0 unresolved**, 1,119 into libraries, 17 artifacts, 79.7 MiB, no Scala runtime. `kotlin2cpg` works as an out-of-process fallback at 155.7 MiB with a Scala 3 runtime and a 2.3.21 compiler. scip-java's Kotlin plugin **cannot load into any Kotlin ≥ 2.3**. | `2026-08-29-kotlin-resolution.md` |
| **SCIP round trip** | 44,401 lines indexed in 5.9 s, decoded in-process in **93 ms** via the Maven Central bindings. Every typed edge kind derivable. Both predicted derivation signals absent; a working call rule found and hand-checked at 95/95 with 94–98.5% recall. Unresolved set **not** synthesizable from occurrences. Moniker parse 265–560 ns per symbol. | `2026-08-29-scip-round-trip.md` |
| **Bytecode tier** | **961 resolved call edges from our own bytecode into dependency and platform code** where the source-only baseline had zero, 86% mapped to an exact source file and line, 82 distinct dependency classes, plus 38 annotation references naming `Test` exactly. Rapid-type analysis only: class-hierarchy analysis with the JDK in scope produced 8.2 million edges in 503 s at 11 GB. **Tier restored at rung 3** — our own sandbox compiles the target, so the class files it needs are ours to produce. | `2026-08-29-bytecode-tier.md` |

Three results change the design rather than merely confirming it:

1. **Kotlin needs no frontend of ours** — but it needs a frontend *per target language version*, resolved and cached at analysis time rather than pinned at our build time. The measurement proves the route; it does not license the deployment shape it was measured in. See section 5.1.
2. **The unresolved set is ours to recover, not merely to record.** SCIP producers emit no trace of a failed reference, so the recovery pass — re-lex, diff positions, subtract language predeclared identifiers — is a required component of the ingest path, not an optional nicety. It also means confidence tagging cannot be inferred from the index alone.
3. **The bytecode tier is restored, bounded, and conditional.** It buys exactly the edges no source tier produces, it must run with rapid-type analysis and the JDK excluded from scope — 8.2 million edges in 503 seconds at 11 GB says class-hierarchy analysis at JDK scope is not a tuning choice — and it needs class files, which at rung 3 our own sandbox produces. What remains unmeasured is the thing that decides whether it ever runs on a real target: how often a repository we did not write compiles in a sandbox we control, without human help.

Carried forward as unmeasured, in priority order after the rung 2–3 decision: how often a repository we did not write resolves its dependencies, and then compiles, inside our sandbox without human help; what each escalation costs in wall-clock on a realistic repository; how far rung-1 facts get before escalation is worth it, including whether a declarations-plus-cache classpath approaches the 99.998% measured with a package-manager-supplied one; a target whose Kotlin version differs from any frontend we ship; a multi-language repository; a repository large enough for cold-start cost to matter; and delta re-analysis of a single changed file.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| **Rung-1 fidelity is the product's fidelity** — escalation cannot be relied on, so whatever rung 1 reaches is what customers get | measured brackets: with a classpath, Java resolves 99.998% of names and Kotlin has zero unresolved references; with none, Java drops to 57.7% trustworthy with zero library bindings and Kotlin to 975 unresolved. The product sits wherever declarations-plus-public-archives lands between those, and that is the first thing to measure. If it lands low, the answer is better orientation and honest labelling, not a sandbox we cannot depend on |
| Kotlin Analysis API offers no compatibility guarantee across Kotlin versions | pin our Kotlin version deliberately and treat an upgrade as a spike; the alternative routes stay documented |
| `kotlin2cpg` pins its own embedded compiler version | if adopted, isolate it out of process rather than sharing a classloader with our toolchain |
| EPL-2.0 (JDT) is weak copyleft | it permits use as an unmodified linked dependency; do not fork it into our tree without re-reading the terms |
| Single-maintainer velocity across the SCIP family despite the independent organization | the format is stable and our reader is ours; a dead producer costs a tier, not the part |
| The Kotlin Analysis API is not on Maven Central and is versioned against IDE bootstrap builds | the coordinate that works, `analysis-api-*-for-ide:2.4.0`, equals our pinned compiler version, so the repository declaration and the version bump are one decision; a Kotlin upgrade re-runs the Kotlin spike before it lands |
| **The private-artifact share of unresolved references is unmeasured** | it is the number that decides whether private dependencies are a real gap or a rounding error, and whether a registry credential is ever worth offering. Measure it with work item 15 on a real multi-module repository before designing anything for bucket three. Until then, assume the honest-disclosure path is the whole answer |
| **Private dependencies defeat rungs 2 and 3, and rung 1's fetch step too** | a private registry, an authenticated package index, or a submodule over SSH needs a credential we will not ask for. The honest degradation: the symbol stays *attributed* — "this comes from `com.acme:internal-lib` at the version the lockfile pins" — and *unresolved*, which is still orientation. Lockfiles give exact versions and hashes even when the artifact is unreachable |
| Non-standard build strategies defeat rung 3 specifically | hermetic monorepo builds, internal toolchain distributions, build-graph code generation, native SDKs, private base images, licence-served compilers. Attempt cheaply, abandon on first failure, and treat failure as the expected case on a private codebase rather than an incident |
| SCIP moniker keys shift with producer configuration, and multi-module repositories are silently truncated | record the producer, its version, and its configuration alongside the facts; verify module coverage independently of the producer's own missing-document check, which reported nothing while 18.6% of identifiers were absent |
| Go, TypeScript, JavaScript, and Python reach type-inference precision only at rung 2 | their rung-1 facts are already substantial — declarations, import graph, scope-local binding, declared types, external signatures from fetched declarations. Escalation adds checked resolution via existing tools rather than a frontend of ours. Tag every fact with its basis so an answer states which kind it rests on |
| Untrusted input now has two kinds | at rung 1, malformed data against parsers, archive readers, and decoders — contained per worker. At rungs 2 and 3, target-authored build and install scripts executing on our infrastructure — contained by the sandbox controls in work item 14. Do not let the first kind's mitigations be mistaken for the second's |
| A target's language version may have no frontend we can obtain | fall back to the bases that need no frontend — declarations, imports, scope-local binding, declared types — and mark the type-inference-dependent facts absent rather than presenting a mismatched frontend's output as checked |
| **Runtime-wired edges are invisible, not unresolved** — dependency injection, service loaders, reflection, proxies, annotation-driven dispatch, configuration-named classes | detect the wiring *sites* statically and report their count within every affected set; a guess about the edge is a separate, `heuristic`-tagged product from the count, and the count ships whether the guess does or not |
| Generated sources are absent at rung 1 and present at rung 3 | detection and disclosure at rung 1 is the load-bearing behaviour: name the generator from the build declarations and mark the affected references as expected-missing rather than reporting a confidently thin graph. Rung 3 removes the gap where it succeeds, which is a bonus, not the mitigation |
| Rungs 2 and 3, when attempted, execute target-authored build and install scripts on our infrastructure | isolated ephemeral sandbox, egress limited to public registries, internal network denied, no credentials reachable, resource and wall-clock caps, provenance for everything fetched or executed. Work item 14, mandatory the moment escalation is switched on and deferrable until then |
| The graph serves two consumers with opposite biases | deterministic findings want precision and silence when unsure; orientation for the reviewing model wants recall with labelled uncertainty. One store, two consumers, reconciled only by the per-fact basis field — which is why that field is load-bearing rather than decorative (section 5.7) |

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
