# Code Graph Sourcing: Build, Improve, or Consume

**Date:** 2026-08-29
**Status:** Approved. The four spikes in section 11 ran on 2026-08-29; results are recorded there and in `docs/spikes/`. `platform/code-graph` is now plannable, and **no compiler frontend of our own is required.**
**Amends:** `docs/specs/2026-08-29-scope-decision.md` sections 7 and 12. Section 7 costed `platform/code-graph` as **Large**, driven by "one emitter per language analyzer". That assumption does not survive this evaluation.
**Method:** four parallel source-verified library investigations, every licence read from the project's own licence file, every maintenance claim pinned to a release or commit date observed on 2026-08-29

## 1. The question

Before writing per-language semantic frontends, three cheaper paths were tested: improve the MIT-licensed local indexer we already run, adopt the second local tool, or consume an existing code-graph library — with particular attention to Java and Kotlin, where the ecosystem is richest.

The conclusion, stated first: **stop planning to write frontends; plan to ingest resolved facts from compiler-backed producers, and own the store, the confidence model, and the queries.** Improving either local tool is the wrong investment, for reasons that are about their architecture and their maintainers' stated intent rather than their quality.

## 2. Verdicts

**Trim rule applied 2026-08-29, after the verdicts below were first written:** the product must deliver its full value from a checkout at rest. Nothing that requires a customer to wire us into their build, to have run their build, or to have our toolchain expectations met in their environment is in scope. Where such a producer would have added fidelity, it survives only as an *optional import* of an artifact the customer already produces for their own reasons. Rows changed by that rule say so.

| Candidate | Licence | Last activity | Fidelity | Shape for us | Verdict |
|---|---|---|---|---|---|
| Local grammar indexer (`@colbymchenry/codegraph`) | MIT | release 2026-08-26 | name matching, no classpath | separate process, Node + native addon | keep as dev tooling; do not improve, do not fork |
| Graphify (`graphifyy`) | Apache-2.0 | package current | tree-sitter + path resolution; plus a language-model narrative layer | Python CLI, output format only | keep as comprehension aid; never an input |
| **Eclipse JDT Core** | EPL-2.0 | release 2026-06-09, commit 2026-08-02 | **real ECJ compiler bindings, classpath optional, no build required** | **embeddable JVM library, Maven Central** | **adopt for Java** |
| **SCIP format + JVM bindings** | Apache-2.0 | schema v0.9.0 2026-06-29 | n/a (format) | `org.scip-code:scip-java-bindings`, in-process parse | **adopt as an optional import format** — free fidelity when a customer already produces an index, never a requirement |
| scip-go | Apache-2.0 | commit 2026-08-14 | compiler-backed (`go/packages`) | separate process, emits SCIP | **not a required producer** — needs a Go toolchain and module resolution in the customer's environment; import only, and see section 14 on bundling a frontend instead |
| scip-java (Java) | Apache-2.0 | release v0.13.1 2026-07-02 | compiler-backed `javac` plugin; **requires a successful build** | separate process driving Gradle/Maven/Bazel | **cut by the trim rule** — it needs the customer's build |
| scip-java (Kotlin) | Apache-2.0 | same | cannot load into any Kotlin ≥ 2.3, measured | separate process | **cut** — disqualified on both counts |
| scip-typescript | Apache-2.0 | commit 2025-10-03 | compiler-backed (`tsc`) | Node CLI, emits SCIP | **not a required producer** — needs the customer's installed dependency tree; import its output if they already emit it |
| scip-python | MIT | commit 2025-09-05 | compiler-backed (Pyright inference) | Node CLI, emits SCIP | **not a required producer** — same reason; import only |
| Joern `kotlin2cpg` / flatgraph | Apache-2.0 | commits 2026-08-28 | **embeds `kotlin-compiler-embeddable`** — genuinely compiler-backed Kotlin | Scala library, pinned compiler version | spike for Kotlin only |
| Kotlin Analysis API (K2 standalone) | Apache-2.0 | tracks Kotlin releases | real K2/FIR resolution without Gradle | JVM library, **not on Maven Central**, no stability guarantee | spike for Kotlin only |
| SootUp | LGPL-2.1 | release 2026-03-19 | bytecode, sound for its algorithm; **needs compiled classes** | embeddable JVM library, pure Java | **cut as a tier by the trim rule.** Keep the library only for reading dependency archives as classpath metadata, which needs no build |
| WALA | EPL-2.0 | release 2026-07-01 | bytecode | embeddable JVM library | out of scope with the bytecode tier |
| tree-sitter (`io.github.treesitter:jtreesitter`) | MIT | current | parse only, no resolution | **embeddable JVM library** | adopt as breadth substrate |
| JavaParser symbol solver | Apache-2.0 / LGPL-3.0 | release 2026-06-01 | hand-written approximation of compiler semantics | embeddable JVM library | reject — JDT is higher fidelity at equal cost |
| Spoon | CeCILL-C / MIT | release 2026-07-14 | JDT underneath | embeddable JVM library | reject — depend on JDT directly |
| OPAL | BSD-2-Clause | commit 2026-01-19 | bytecode | JVM library, pulls a Scala runtime | out of scope with the bytecode tier |
| Depends | MIT | commit 2026-04-20 | ANTLR grammars, no build | pure-Java, runnable jar | spike for the non-Tier-1 breadth gap |
| Kythe | Apache-2.0 | release 2026-07-16 | compiler-backed, **requires a successful build** | CLI extractors per language | **cut by the trim rule** |
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

### The tier model, per language

**Two rules govern this table.** The analysis target is somebody else's codebase, not ours — every spike measured a producer against source the engine happens to share a JVM with, so section 5.1 states what that does and does not prove. And after the trim rule in section 2, every row must work from a checkout at rest: no customer build integration, no requirement that their build has run, no expectation that our toolchains exist in their environment.

| Tier | Producer | Runs where | Confidence | Requires from the target | Languages |
|---|---|---|---|---|---|
| A | Eclipse JDT Core | worker process | `resolved` | dependency declarations plus the archives they name, resolved from a local artifact cache or a declared repository — never a build | Java |
| A | Kotlin Analysis API standalone | worker process, **one per target language version** | `resolved` | the same classpath, plus a compiler frontend matching the target's Kotlin version | Kotlin |
| C | tree-sitter via `jtreesitter` | in-process | `name-only` | nothing but source text | everything else, including Go, TypeScript, JavaScript, and Python until a bundled frontend lands |
| Import | any SCIP or SARIF artifact the customer already produces | in-process reader | as the producer earned it, recorded per producer | nothing — the artifact either exists or it does not | whatever the producer covered |

Tier C is the only tier inside the service process: it needs nothing but bytes, cannot execute anything, and is bounded by parse cost. It is also the floor every other tier degrades to.

Three rows that were here before the trim are gone, and what each cost us is worth stating rather than hiding:

- **The bytecode tier (SootUp, WALA, OPAL).** It needed compiled class files, which means the customer's build has run. Cut. The measured loss is real and specific: 961 resolved call edges into dependency and platform code, where the source tiers produce none, 86% of them mapped to an exact source file and line. That capability now has no home, and blast radius stops at the library boundary. The library survives in the dependency list for one narrow purpose that needs no build — reading dependency archives as classpath metadata for Tier A. Evidence retained in `docs/spikes/2026-08-29-bytecode-tier.md`.
- **scip-java.** It drives the customer's Gradle, Maven, or Bazel build and executes their build logic. Cut outright; JDT covers Java from a classpath alone.
- **scip-go, scip-typescript, scip-python as required producers.** Each needs the customer's language toolchain and a resolved dependency tree. They stay as import paths only. The consequence is blunt: **Go, TypeScript, JavaScript, and Python drop to the name-only tier today.** Section 14 records the alternative that keeps them semantic without touching the customer's environment — bundle the frontend, as a comparable product does with a native Go parser, a Node runtime, and shipped Python type stubs. That is now the highest-value open item in this document.

### 5.1 Self-analysis is not the product

The spikes answered "can this producer resolve references", and they answered it well. They did not answer "can this producer resolve references *in an arbitrary target*", and three of their conclusions need correcting on that axis.

**The Kotlin recommendation loses one of its three pillars.** Its numbers stand: 2,839 references, zero unresolved, 1,119 into libraries, 17 jars, no second language runtime. But "the artifact version equals the Kotlin version we already pin" was only true because the target *was us*. A target on Kotlin 1.9 or 2.0 needs a frontend for its language version; one embedded compiler resolves one language level well and degrades on others. So the Analysis API stays the recommendation, with a different deployment: a **per-version worker**, with the required compiler frontend resolved and cached per target rather than pinned once at our build time. That also removes the in-process objection — a target's compiler frontend never enters the service's classloader.

**The bytecode tier is cut, not deferred.** Its 961 cross-boundary edges were measured on the one codebase whose classes were already sitting in a build directory. Compiled classes mean the customer's build has run, which the trim rule excludes. The measurement stands as the argument for reviving it if the product ever gains a build-adjacent collector, and the spike document is kept for exactly that reason.

**The Java measurement transfers furthest, and its framing needed one correction — which the trim rule then sharpened into a requirement.** It obtained the classpath in 2.8 seconds without compiling, but by invoking the target's build tool: rung 2 of section 5.3, which executes target-authored build logic. Tier A must instead work at rung 1 — parse the dependency declarations, resolve the named archives from a local artifact cache or a declared repository, and never invoke the build. Whether that reaches the 99.998% the spike measured with a build-tool-supplied classpath is now the single most important unmeasured number in this document, because it is the difference between Java being a resolved tier and Java being a name-only tier.

### 5.2 Why analysis runs in worker processes

The single-process decision in the scope decision cut a supervised topology whose purpose was scaling a web tier apart from a worker tier. It did not license running compiler frontends over untrusted input inside the process that serves queries. Four reasons, three of them already measured:

- **Resource blowups are routine, not exceptional.** The bytecode spike reached 8.2 million edges, 503 seconds, and 11 GB on one configuration of a 750-line input. The Java spike peaked at 890 MB on 203k lines. In-process, those are the product dying rather than one analysis failing. A worker takes `-Xmx` and a deadline; the service survives the kill.
- **Target input is hostile until proven otherwise.** Parsers, class readers, and archive readers over attacker-influenced input are a well-known failure surface — malformed archives, pathological nesting, adversarial identifiers. Per-file failure isolation, which the analyzer specifications already require, is only credible if a crash is contained.
- **Version multiplicity is inherent.** Different targets need different compiler frontends, and a service that analyzes several targets cannot hold conflicting compiler versions in one classloader. Worker processes make version selection a launch argument instead of a classloading problem — which is why the classloader-isolation machinery cut from the plugin runtime does not need to come back.
- **Nothing under analysis executes.** Reading a class file is not running it, so isolation is about containing crashes and resource blowups rather than sandboxing code. After the trim rule no in-scope producer executes target-authored logic at all — the one that did, scip-java, is cut.

The service process keeps what it always kept: settings, logging, the store, the queries, and the name-only tier. Resolution runs beside it and reports facts over a pipe or a file.

### 5.3 Nothing under analysis ever runs

The target is a checkout at rest. We read source text, dependency metadata, and class files as bytes; we never load a target class into a classloader, never instantiate anything, never execute the program or its tests. That is worth stating because it settles two questions and creates a third.

**It settles what "untrusted input" means.** The risk is malformed and adversarial *data* fed to parsers, class readers, and archive readers — stack exhaustion, pathological nesting, decompression bombs, quadratic identifier handling — not target code executing in our process. Worker isolation is about containing a crash and a resource blowup, not about sandboxing execution, because there is no execution to sandbox.

**It settles the escalation ladder.** Four rungs, and after the trim rule the product lives on the first one only:

| Rung | What it touches | Executes target-authored code? | Policy |
|---|---|---|---|
| 1. Files at rest | source text, dependency declarations, lockfiles, archives named by those declarations, and any index or report the customer already produced | no | **the product's entire guarantee** |
| 2. Build-tool query | invoking the target's build tool to print a resolved classpath | **yes — build scripts, plugins, and extensions run** | out of scope; revisit only as an explicitly requested convenience with the execution stated |
| 3. Full build | compiling the target for class files and generated sources | yes | out of scope |
| 4. Program or test execution | running the target or its suite | yes | **never us** |

The Java spike sat on rung 2 and called itself build-free, which is true about compilation and false about execution: the classpath came from invoking the target's build tool in 2.8 seconds, and a build file is a program. Rung 1 must therefore carry Tier A on its own — parse the declarations, resolve the named archives from a local artifact cache or a declared repository. That is the load-bearing unmeasured question named in section 5.1.

Rung 3's exclusion has a specific consequence on the JVM that no measurement here exercised: **generated sources do not exist in a checkout at rest.** Annotation processors and code generators — the JVM ecosystem is full of them — produce types that hand-written code references. Without a build those references have no declaration to bind to, so they land in the unresolved set for a reason that is neither a producer defect nor hostile input; the target's source is simply incomplete until something runs. Detect the generator from the build declarations and say so on the answer rather than reporting a confidently thin graph. This is now a permanent characteristic of the product, not a temporary gap.

Rung 4 stays outside the product permanently, which keeps two earlier decisions consistent: runtime profiles and hot paths were cut because no goal names performance, and test attribution is an *import* of a report someone else produced by running tests — the coverage tool runs, we never do. Fix verification, likewise, means re-running **analysis** over a named scope, never running the program to see whether it still works.

**And it creates the third question, which is the interesting one.** A static graph cannot see edges that only exist while the program runs: dependency injection, service loaders, reflection, dynamic proxies, annotation-driven dispatch, configuration-named handler classes, `invokedynamic` targets the bytecode tier already loses. These are not unresolved references. An unresolved reference is a known unknown — we saw an identifier and could not bind it. A runtime-wired edge is an *unknown unknown*: nothing at the call site hints that the edge exists at all, so it is invisible rather than unresolved, and a blast radius that omits it silently is exactly the failure section 7 of the scope decision calls worse than no answer.

The store therefore needs a third honesty channel beside resolved facts and the unresolved set: **runtime-wiring sites**. These are statically detectable even when the edge they imply is not — reflection and service-loader calls, injection annotations, proxy factories, class names appearing as configuration string literals. Detect the sites, count them within the affected set, and report the count on every impact answer. The local grammar tool's framework synthesizers, which guess these edges and tag them `heuristic`, are the prior art for the guessing; the discipline we add is that a guess and a count are different products, and an impact answer must carry the count whether or not it carries the guess.

## 6. Kotlin: resolved by measurement, not by frontend

This section asked whether Kotlin forces a frontend of our own. **It does not.** All three routes were run against `runtime/` and `persistence/` — 28 files, 2,839 references — and the result is unambiguous. Note what the subject was: our own source, resolved with our own classpath. Section 5.1 states what that does and does not prove about arbitrary targets.

| Route | Refs resolved | Into libraries | Unresolved | Weight | Kotlin version | Verdict |
|---|---:|---:|---:|---|---|---|
| **Kotlin Analysis API standalone (K2)** | 2,839 | **1,119** | **0** | 17 artifacts, 79.7 MiB, no Scala | 2.4.0, which is also our own pin | **adopt, per-version worker** |
| Joern `kotlin2cpg` | 868 non-operator calls | 621 | 0 with classpath | 108 artifacts, 155.7 MiB, Scala 3.8.3 runtime | 2.3.21 embedded | out-of-process fallback |
| scip-java Kotlin plugin | — | — | — | — | 2.2.0 embedded | **disqualified** |

scip-java's Kotlin plugin cannot load into our compiler at all: `AnalyzerRegistrar is incompatible with the current version of the compiler`, caused by `AbstractMethodError: Missing implementation of resolved method 'abstract java.lang.String getPluginId()'`. It is unusable on any Kotlin at or above 2.3.

The Analysis API route is the recommendation on two grounds beyond its numbers, one having survived the correction in section 5.1 and one having been strengthened by it. It brings no second language runtime: the IntelliJ platform classes it needs arrive inside the compiler jar rather than as separate artifacts, so a worker is one directory of jars and a `java` invocation. And with the dependency classpath withheld it degrades exactly as a tier should — 975 unresolved references led by `assertThat` ×72, `Test` ×50, `use` ×31, reproducing the baseline's failure mode and confirming that the classpath, not the compiler, buys the 1,119 library edges. What does **not** survive is version-pin convenience: for an arbitrary target the frontend version must follow the target's Kotlin version, resolved and cached per target, which is why this producer is a per-version worker rather than a library we link once.

One consequence worth stating before it is discovered later: a target whose Kotlin version has no available frontend, or whose classpath cannot be assembled, does not fail the analysis. It falls to Tier C and its facts are tagged `name-only`. The confidence field is what makes that degradation honest instead of silent.

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

1. **The confidence model** — `resolved`, `name-only`, `heuristic` assigned per producer on ingest. No candidate carries it; every one either omits failures silently or is single-fidelity.
2. **The unresolved-reference set as first-class output**, synthesized on ingest.
3. **Edge kind derivation** — `calls`, `instantiates`, `overrides`, `extends` from occurrence roles, syntax kinds, and enclosing ranges.
4. **Delta application** against our own store, on the unit-and-ownership model.
5. **Persistence and query** — the embedded relational store, recursive reachability, bounded traversal with a truncation marker.
6. **Orchestration** of producers whose runtimes differ, with graceful degradation to Tier C when a producer is absent, unbuildable, or stale.
7. **Recovery of the unresolved set per producer** — re-lexing and position-diffing where the producer records nothing, per section 7.
8. **Target inspection, classpath resolution, and producer selection** — parse the target's dependency declarations, resolve the archives they name from a local artifact cache or a declared repository **without invoking the build**, detect each language's version, choose and cache the matching frontend, and record producer identity, version, and configuration with every fact. This is the item the trim rule made load-bearing: it is now the only path to a resolved tier.
9. **Worker supervision** — launch a producer with a heap cap and a deadline, contain its crash to one analysis, and degrade to the next tier down on failure rather than reporting a thin graph as complete.
10. **Runtime-wiring site detection** — reflection, service loaders, injection annotations, proxy factories, and class names in configuration literals, counted within any affected set so an impact answer states how much of the program's real wiring a static graph cannot see.

## 10. Revised cost

Section 7 of the scope decision costed this part **Large**, driven by per-language emitters. Two of those emitters exist as libraries we drive from a checkout at rest — JDT for Java, the Analysis API for Kotlin — and the rest are covered at name-only fidelity by an embeddable parser, with any customer-produced index imported for free.

**Revised: Medium, and narrower than before the trim.** Removed from the estimate: a bytecode tier, orchestration of three external toolchain-dependent indexers, and everything that would have driven a customer build. Added: rung-1 classpath resolution, which is now the difference between Java and Kotlin being resolved tiers or name-only ones.

What remains is what nobody supplies and always was the real work: the store, the confidence model, the unresolved-set recovery, the edge-kind derivation, the delta protocol, the queries, worker supervision, and honest degradation.

The open item the trim creates is not a cost, it is a decision: **Go, TypeScript, JavaScript, and Python are name-only until we bundle a frontend for them.** Section 14 shows that bundling — a native parser binary, a runtime plus its type checker, shipped type stubs — is the shape a comparable product uses precisely because it demands nothing of the customer's environment. Pricing that is the next piece of work, and it is the only remaining route to semantic coverage for those languages under the trim rule.

## 11. Spike results

All four ran on 2026-08-29. Full measurements, commands, and failures are in `docs/spikes/`; the decisive numbers are here.

| Spike | Result | Findings |
|---|---|---|
| **JDT for Java** | 203,436 lines of external Java: **99.998%** of 251,399 reference names resolved, **100%** of 78,474 call sites, 51.5% of calls into the JDK or a dependency, 0 semantic errors, ~20 ms/kLOC, 890 MB peak. Without a classpath: 57.7% trustworthy, 42.7% of calls, and zero library edges. Embeddable floor measured at **10 jars, 10.6 MB**. Overload keys are stable and distinct across runs. | `2026-08-29-jdt-java-resolution.md` |
| **Kotlin, three routes** | Analysis API standalone at Kotlin **2.4.0 — our own pinned version** — resolved all 2,839 references with **0 unresolved**, 1,119 into libraries, 17 artifacts, 79.7 MiB, no Scala runtime. `kotlin2cpg` works as an out-of-process fallback at 155.7 MiB with a Scala 3 runtime and a 2.3.21 compiler. scip-java's Kotlin plugin **cannot load into any Kotlin ≥ 2.3**. | `2026-08-29-kotlin-resolution.md` |
| **SCIP round trip** | 44,401 lines indexed in 5.9 s, decoded in-process in **93 ms** via the Maven Central bindings. Every typed edge kind derivable. Both predicted derivation signals absent; a working call rule found and hand-checked at 95/95 with 94–98.5% recall. Unresolved set **not** synthesizable from occurrences. Moniker parse 265–560 ns per symbol. | `2026-08-29-scip-round-trip.md` |
| **Bytecode tier** | **961 resolved call edges from our own bytecode into dependency and platform code** where the source-only baseline had zero, 86% mapped to an exact source file and line, 82 distinct dependency classes, plus 38 annotation references naming `Test` exactly. Rapid-type analysis only: class-hierarchy analysis with the JDK in scope produced 8.2 million edges in 503 s at 11 GB. **Result retained, tier cut** — it needs the customer's build. | `2026-08-29-bytecode-tier.md` |

Three results change the design rather than merely confirming it:

1. **Kotlin needs no frontend of ours** — but it needs a frontend *per target language version*, resolved and cached at analysis time rather than pinned at our build time. The measurement proves the route; it does not license the deployment shape it was measured in. See section 5.1.
2. **The unresolved set is ours to recover, not merely to record.** SCIP producers emit no trace of a failed reference, so the recovery pass — re-lex, diff positions, subtract language predeclared identifiers — is a required component of the ingest path, not an optional nicety. It also means confidence tagging cannot be inferred from the index alone.
3. **The bytecode tier measured well and is cut anyway.** It buys exactly the edges the baseline could not see, at rapid-type analysis with the JDK excluded from scope, and it needs compiled classes — which means the customer's build has run. The trim rule excludes it. The number is kept because it is the argument for reviving the tier if a build-adjacent collector is ever offered as an option, and it quantifies what blast radius loses at the library boundary in the meantime.

Carried forward as unmeasured, in priority order after the trim: whether a rung-1 classpath — declarations plus a local artifact cache, no build invocation — reaches anything like the 99.998% measured with a build-tool-supplied classpath; what a bundled frontend costs for Go, TypeScript, and Python; a target whose Kotlin version differs from any frontend we ship; a target whose dependency tree does not resolve; a multi-language repository; a repository large enough for cold-start cost to matter; and delta re-analysis of a single changed file.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| **Rung-1 classpath resolution may not match a build-tool-supplied one** — this replaced both risks about build-dependent producers when they were cut, and it is now the largest single risk in the document | measured contrast: with a classpath, Java resolves 99.998% of names and Kotlin has zero unresolved references; without one, Java drops to 57.7% trustworthy with zero library bindings and Kotlin to 975 unresolved. Everything therefore rests on resolving declared archives from a local artifact cache or a declared repository. Measure it before planning; if it falls short, Java and Kotlin are name-only tiers and the product's fidelity story changes |
| Kotlin Analysis API offers no compatibility guarantee across Kotlin versions | pin our Kotlin version deliberately and treat an upgrade as a spike; the alternative routes stay documented |
| `kotlin2cpg` pins its own embedded compiler version | if adopted, isolate it out of process rather than sharing a classloader with our toolchain |
| EPL-2.0 (JDT) is weak copyleft | it permits use as an unmodified linked dependency; do not fork it into our tree without re-reading the terms |
| Single-maintainer velocity across the SCIP family despite the independent organization | the format is stable and our reader is ours; a dead producer costs a tier, not the part |
| The Kotlin Analysis API is not on Maven Central and is versioned against IDE bootstrap builds | the coordinate that works, `analysis-api-*-for-ide:2.4.0`, equals our pinned compiler version, so the repository declaration and the version bump are one decision; a Kotlin upgrade re-runs the Kotlin spike before it lands |
| The bytecode tier's cut leaves blast radius stopping at the library boundary | accepted, quantified at 961 edges on our own code, and recorded in the spike so the trade can be revisited if a build-adjacent collector is ever offered |
| SCIP moniker keys shift with producer configuration, and multi-module repositories are silently truncated | record the producer, its version, and its configuration alongside the facts; verify module coverage independently of the producer's own missing-document check, which reported nothing while 18.6% of identifiers were absent |
| Go, TypeScript, JavaScript, and Python are name-only after the trim | the only in-scope route back to semantics is a bundled frontend per section 14; until then, say so on every answer for those languages rather than letting a name-only graph read as resolved |
| **Every spike measured a target the engine shares a JVM with; the product analyzes code it did not write** | producers run in worker processes with a heap cap and a deadline, selected per target language version. The measurements transfer as fidelity ceilings, not as deployment shapes — see section 5.1 |
| Target source, archives, and imported reports are untrusted input to parsers, archive readers, and decoders | contain a crash to one worker and one analysis; nothing in scope executes target-authored code, and no producer that would is in scope |
| A target's language version may have no frontend we can obtain | degrade to the name-only tier and tag the facts, rather than reporting a resolved-looking graph built from a mismatched frontend |
| Producer identity becomes part of the data's meaning | store producer, version, and configuration with every fact; the SCIP moniker drift already proves that two runs of one producer can disagree about a symbol's key |
| **Runtime-wired edges are invisible, not unresolved** — dependency injection, service loaders, reflection, proxies, annotation-driven dispatch, configuration-named classes | detect the wiring *sites* statically and report their count within every affected set; a guess about the edge is a separate, `heuristic`-tagged product from the count, and the count ships whether the guess does or not |
| Generated sources do not exist in a checkout at rest, and the JVM ecosystem generates heavily | detect generators from the build declarations and state their presence on the answer; their absent types land in the unresolved set for a reason that is neither a producer defect nor hostile input |
| Rung 2 looks free and is not — invoking a build tool executes target-authored build logic | out of scope by the trim rule; if it ever returns as a convenience it must be explicitly requested per target and stated in the answer's provenance |

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
