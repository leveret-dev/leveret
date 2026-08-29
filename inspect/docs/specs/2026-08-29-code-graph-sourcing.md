# Code Graph Sourcing: Build, Improve, or Consume

**Date:** 2026-08-29
**Status:** Approved. The four spikes in section 11 ran on 2026-08-29; results are recorded there and in `docs/spikes/`. `platform/code-graph` is now plannable, and **no compiler frontend of our own is required.**
**Amends:** `docs/specs/2026-08-29-scope-decision.md` sections 7 and 12. Section 7 costed `platform/code-graph` as **Large**, driven by "one emitter per language analyzer". That assumption does not survive this evaluation.
**Method:** four parallel source-verified library investigations, every licence read from the project's own licence file, every maintenance claim pinned to a release or commit date observed on 2026-08-29

## 1. The question

Before writing per-language semantic frontends, three cheaper paths were tested: improve the MIT-licensed local indexer we already run, adopt the second local tool, or consume an existing code-graph library — with particular attention to Java and Kotlin, where the ecosystem is richest.

The conclusion, stated first: **stop planning to write frontends; plan to ingest resolved facts from compiler-backed producers, and own the store, the confidence model, and the queries.** Improving either local tool is the wrong investment, for reasons that are about their architecture and their maintainers' stated intent rather than their quality.

## 2. Verdicts

| Candidate | Licence | Last activity | Fidelity | Shape for us | Verdict |
|---|---|---|---|---|---|
| Local grammar indexer (`@colbymchenry/codegraph`) | MIT | release 2026-08-26 | name matching, no classpath | separate process, Node + native addon | keep as dev tooling; do not improve, do not fork |
| Graphify (`graphifyy`) | Apache-2.0 | package current | tree-sitter + path resolution; plus a language-model narrative layer | Python CLI, output format only | keep as comprehension aid; never an input |
| **Eclipse JDT Core** | EPL-2.0 | release 2026-06-09, commit 2026-08-02 | **real ECJ compiler bindings, classpath optional, no build required** | **embeddable JVM library, Maven Central** | **adopt for Java** |
| **SCIP format + JVM bindings** | Apache-2.0 | schema v0.9.0 2026-06-29 | n/a (format) | `org.scip-code:scip-java-bindings`, in-process parse | **adopt as the ingestion format** |
| **scip-go** | Apache-2.0 | commit 2026-08-14 | compiler-backed (`go/packages`) | separate process, emits SCIP | **consume output for Go** |
| scip-java (Java) | Apache-2.0 | release v0.13.1 2026-07-02 | compiler-backed `javac` plugin; **requires a successful build** | separate process driving Gradle/Maven/Bazel | consume where the project builds; not the primary path |
| scip-java (Kotlin) | Apache-2.0 | same | compiler-backed but self-rated "less mature", Gradle-only, no Maven, no Android | separate process | spike, do not assume |
| scip-typescript | Apache-2.0 | commit 2025-10-03 | compiler-backed (`tsc`) | Node CLI, emits SCIP | consume output, dormancy risk noted |
| scip-python | MIT | commit 2025-09-05 | compiler-backed (Pyright inference) | Node CLI, emits SCIP | consume output, dormancy risk noted |
| Joern `kotlin2cpg` / flatgraph | Apache-2.0 | commits 2026-08-28 | **embeds `kotlin-compiler-embeddable`** — genuinely compiler-backed Kotlin | Scala library, pinned compiler version | spike for Kotlin only |
| Kotlin Analysis API (K2 standalone) | Apache-2.0 | tracks Kotlin releases | real K2/FIR resolution without Gradle | JVM library, **not on Maven Central**, no stability guarantee | spike for Kotlin only |
| SootUp | LGPL-2.1 | release 2026-03-19 | bytecode, sound for its algorithm; needs compiled classes | embeddable JVM library, pure Java | adopt for the bytecode tier |
| WALA | EPL-2.0 | release 2026-07-01 | bytecode, more precise dispatch analysis | embeddable JVM library, pure Java | spike against SootUp |
| tree-sitter (`io.github.treesitter:jtreesitter`) | MIT | current | parse only, no resolution | **embeddable JVM library** | adopt as breadth substrate |
| JavaParser symbol solver | Apache-2.0 / LGPL-3.0 | release 2026-06-01 | hand-written approximation of compiler semantics | embeddable JVM library | reject — JDT is higher fidelity at equal cost |
| Spoon | CeCILL-C / MIT | release 2026-07-14 | JDT underneath | embeddable JVM library | reject — depend on JDT directly |
| OPAL | BSD-2-Clause | commit 2026-01-19 | bytecode | JVM library, **pulls a Scala runtime** | spike only for its call-graph benchmark work |
| Depends | MIT | commit 2026-04-20 | ANTLR grammars, no build | pure-Java, runnable jar | spike for the non-Tier-1 breadth gap |
| Kythe | Apache-2.0 | release 2026-07-16 | compiler-backed, **requires a successful build** | CLI extractors per language | conditional, never primary |
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

**Read the "runs where" column carefully: the analysis target is somebody else's codebase, not ours.** Every spike measured a producer against source the engine happens to share a JVM with — our own Kotlin modules, our own compiled classes, one external Java checkout. Section 5.1 corrects what that means for each tier; the table already reflects the correction.

| Tier | Producer | Runs where | Confidence | Requires from the target | Languages |
|---|---|---|---|---|---|
| A | Eclipse JDT Core | worker process | `resolved` | a classpath; a build tool able to resolve one | Java |
| A | Kotlin Analysis API standalone | worker process, **one per target language version** | `resolved` | a classpath, and a compiler frontend matching the target's Kotlin version | Kotlin |
| A | scip-go, scip-typescript, scip-python | separate tool process | `resolved` | a resolvable dependency tree per language | Go, TypeScript, JavaScript, Python |
| A | scip-java | the target's own build | `resolved` | **a successful build, executing the target's build logic** | Java, opportunistic only |
| B | SootUp | worker process | `resolved` at bytecode granularity | **compiled classes, so a successful build** | any JVM language, opportunistic only |
| C | tree-sitter via `jtreesitter` | in-process | `name-only` | nothing but source text | everything else |

Tier C is the only tier that belongs in the service process: it needs nothing but bytes, cannot execute anything, and is bounded by parse cost. It is also the floor every other tier degrades to.

### 5.1 Self-analysis is not the product

The spikes answered "can this producer resolve references", and they answered it well. They did not answer "can this producer resolve references *in an arbitrary target*", and three of their conclusions need correcting on that axis.

**The Kotlin recommendation loses one of its three pillars.** Its numbers stand: 2,839 references, zero unresolved, 1,119 into libraries, 17 jars, no second language runtime. But "the artifact version equals the Kotlin version we already pin" was only true because the target *was us*. A target on Kotlin 1.9 or 2.0 needs a frontend for its language version; one embedded compiler resolves one language level well and degrades on others. So the Analysis API stays the recommendation, with a different deployment: a **per-version worker**, with the required compiler frontend resolved and cached per target rather than pinned once at our build time. That also removes the in-process objection — a target's compiler frontend never enters the service's classloader.

**The bytecode tier was measured on the one codebase whose classes were already sitting in a build directory.** Its 961 cross-boundary edges are real and its verdict holds, but its requirement is now stated honestly: compiled classes mean a successful build, which is the same barrier that made scip-java opportunistic. Both are opportunistic together. A checkout that does not build gets Tier A source resolution where a classpath can be assembled, and Tier C where it cannot.

**The Java measurement is the one that transfers**, because it ran against an external checkout with a classpath obtained from the target's own build metadata in 2.8 seconds without compiling. That is the shape all Tier A producers should have: read the target's dependency declarations, resolve a classpath, never execute the target's build.

### 5.2 Why analysis runs in worker processes

The single-process decision in the scope decision cut a supervised topology whose purpose was scaling a web tier apart from a worker tier. It did not license running compiler frontends over untrusted input inside the process that serves queries. Four reasons, three of them already measured:

- **Resource blowups are routine, not exceptional.** The bytecode spike reached 8.2 million edges, 503 seconds, and 11 GB on one configuration of a 750-line input. The Java spike peaked at 890 MB on 203k lines. In-process, those are the product dying rather than one analysis failing. A worker takes `-Xmx` and a deadline; the service survives the kill.
- **Target input is hostile until proven otherwise.** Parsers, class readers, and archive readers over attacker-influenced input are a well-known failure surface — malformed archives, pathological nesting, adversarial identifiers. Per-file failure isolation, which the analyzer specifications already require, is only credible if a crash is contained.
- **Version multiplicity is inherent.** Different targets need different compiler frontends, and a service that analyzes several targets cannot hold conflicting compiler versions in one classloader. Worker processes make version selection a launch argument instead of a classloading problem — which is why the classloader-isolation machinery cut from the plugin runtime does not need to come back.
- **We never execute target code.** Reading a class file is not running it. This rules Tier A and B in and marks scip-java's compiler-plugin route, which runs the target's own build logic, as the highest-trust-cost producer we have — usable when a user asks for it on a project they trust, never as a default.

The service process keeps what it always kept: settings, logging, the store, the queries, and the name-only tier. Resolution runs beside it and reports facts over a pipe or a file. That is a smaller change than it sounds — the producers in the table are already separate processes in three of six rows, and the two in-process rows were the ones this correction moved.

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
8. **Target inspection and producer selection** — read the target's build declarations, resolve a classpath without executing its build, detect each language's version, choose and cache the matching producer, and record producer identity, version, and configuration with every fact.
9. **Worker supervision** — launch a producer with a heap cap and a deadline, contain its crash to one analysis, and degrade to the next tier down on failure rather than reporting a thin graph as complete.

## 10. Revised cost

Section 7 of the scope decision costed this part **Large**, driven by per-language emitters. Every one of those emitters now has an existing producer: Java in-process through JDT, Kotlin in-process through the Analysis API at the version we already pin, Go and TypeScript and Python out-of-process behind one format, breadth through an embeddable parser, and an additive bytecode tier.

**Revised: Medium. No compiler frontend of our own is in scope.** What remains is what nobody supplies and always was the real work: the store, the confidence model, the unresolved-set recovery, the edge-kind derivation, the delta protocol, the queries, and the orchestration across producers with graceful degradation.

Two costs the spikes did not price, both consequences of the target being somebody else's code: producer selection with classpath resolution per target, and worker supervision with heap caps, deadlines, and tier degradation on crash. Neither is large, and both were always implied by "analyze source code" meaning code we did not write. They are items 8 and 9 of section 9.

## 11. Spike results

All four ran on 2026-08-29. Full measurements, commands, and failures are in `docs/spikes/`; the decisive numbers are here.

| Spike | Result | Findings |
|---|---|---|
| **JDT for Java** | 203,436 lines of external Java: **99.998%** of 251,399 reference names resolved, **100%** of 78,474 call sites, 51.5% of calls into the JDK or a dependency, 0 semantic errors, ~20 ms/kLOC, 890 MB peak. Without a classpath: 57.7% trustworthy, 42.7% of calls, and zero library edges. Embeddable floor measured at **10 jars, 10.6 MB**. Overload keys are stable and distinct across runs. | `2026-08-29-jdt-java-resolution.md` |
| **Kotlin, three routes** | Analysis API standalone at Kotlin **2.4.0 — our own pinned version** — resolved all 2,839 references with **0 unresolved**, 1,119 into libraries, 17 artifacts, 79.7 MiB, no Scala runtime. `kotlin2cpg` works as an out-of-process fallback at 155.7 MiB with a Scala 3 runtime and a 2.3.21 compiler. scip-java's Kotlin plugin **cannot load into any Kotlin ≥ 2.3**. | `2026-08-29-kotlin-resolution.md` |
| **SCIP round trip** | 44,401 lines indexed in 5.9 s, decoded in-process in **93 ms** via the Maven Central bindings. Every typed edge kind derivable. Both predicted derivation signals absent; a working call rule found and hand-checked at 95/95 with 94–98.5% recall. Unresolved set **not** synthesizable from occurrences. Moniker parse 265–560 ns per symbol. | `2026-08-29-scip-round-trip.md` |
| **Bytecode tier** | **961 resolved call edges from our own bytecode into dependency and platform code** where the source-only baseline had zero, 86% mapped to an exact source file and line, 82 distinct dependency classes, plus 38 annotation references naming `Test` exactly. Rapid-type analysis only: class-hierarchy analysis with the JDK in scope produced 8.2 million edges in 503 s at 11 GB. | `2026-08-29-bytecode-tier.md` |

Three results change the design rather than merely confirming it:

1. **Kotlin needs no frontend of ours** — but it needs a frontend *per target language version*, resolved and cached at analysis time rather than pinned at our build time. The measurement proves the route; it does not license the deployment shape it was measured in. See section 5.1.
2. **The unresolved set is ours to recover, not merely to record.** SCIP producers emit no trace of a failed reference, so the recovery pass — re-lex, diff positions, subtract language predeclared identifiers — is a required component of the ingest path, not an optional nicety. It also means confidence tagging cannot be inferred from the index alone.
3. **The bytecode tier is confirmed, bounded, and opportunistic.** It buys exactly the edges the baseline could not see, and it must run with rapid-type analysis and the JDK excluded from scope — class-hierarchy analysis at JDK scope is not a tuning choice, it is unusable. Its requirement is a successful build of the target, which puts it in the same opportunistic bracket as scip-java rather than the always-available bracket its measurement on our own build directory suggested.

Carried forward as unmeasured, and now the more important gap: every number above came from a target that was either our own source, our own compiled classes, or one well-behaved external checkout. Unmeasured are a target whose Kotlin version differs from any frontend we ship, a target whose dependency tree does not resolve, a target that does not build, a multi-language repository, a repository large enough for cold-start cost to matter, and delta re-analysis of a single changed file. Also unmeasured: WALA against SootUp.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| scip-typescript and scip-python have had no commits in roughly a year while looking current | their resolution engines are maintained upstream independently; treat the emission layer as code we may have to maintain, and degrade to Tier C if it breaks |
| scip-java requires a successful build, and goal 1 implies analyzing checkouts that do not build | JDT in-process is the primary Java path precisely because it needs only a classpath; scip-java is the opportunistic higher-fidelity path when a build exists |
| Kotlin Analysis API offers no compatibility guarantee across Kotlin versions | pin our Kotlin version deliberately and treat an upgrade as a spike; the alternative routes stay documented |
| `kotlin2cpg` pins its own embedded compiler version | if adopted, isolate it out of process rather than sharing a classloader with our toolchain |
| EPL-2.0 (JDT, WALA) and LGPL-2.1 (SootUp) are weak copyleft | both permit use as unmodified linked dependencies; do not fork either into our tree without re-reading the terms |
| Single-maintainer velocity across the SCIP family despite the independent organization | the format is stable and our reader is ours; a dead producer costs a tier, not the part |
| The Kotlin Analysis API is not on Maven Central and is versioned against IDE bootstrap builds | the coordinate that works, `analysis-api-*-for-ide:2.4.0`, equals our pinned compiler version, so the repository declaration and the version bump are one decision; a Kotlin upgrade re-runs the Kotlin spike before it lands |
| A classpath, not a build, is what buys library edges — and assembling one may itself need a build tool | measured: withholding the classpath costs Kotlin 975 unresolved references and Java all 35,287 dependency bindings. Where a classpath cannot be assembled, degrade to Tier C and tag the facts `name-only` rather than reporting a thin graph as complete |
| Class-hierarchy analysis on the bytecode tier is unusable at JDK scope | measured at 8.2 million edges, 503 s, 11 GB. Rapid-type analysis with the JDK excluded is the only supported configuration; treat the algorithm and the scope as one setting, not two knobs |
| SCIP moniker keys shift with producer configuration, and multi-module repositories are silently truncated | record the producer, its version, and its configuration alongside the facts; verify module coverage independently of the producer's own missing-document check, which reported nothing while 18.6% of identifiers were absent |
| `invokedynamic` targets are lost on the bytecode tier | measured at 23 of 621 main edges, 7 of them genuine Kotlin lambda edges; the source tier covers these, which is one more reason the bytecode tier is additive only |
| **Every spike measured a target the engine shares a JVM with; the product analyzes code it did not write** | producers run in worker processes with a heap cap and a deadline, selected per target language version. The measurements transfer as fidelity ceilings, not as deployment shapes — see section 5.1 |
| Target source, archives, and class files are untrusted input to parsers and class readers | contain a crash to one worker and one analysis, never execute target code, and treat archive reading as a hostile-input surface. A producer that runs the target's own build (scip-java) is opt-in per project and never a default |
| A target's language version may have no frontend we can obtain | degrade to the name-only tier and tag the facts, rather than reporting a resolved-looking graph built from a mismatched frontend |
| Producer identity becomes part of the data's meaning | store producer, version, and configuration with every fact; the SCIP moniker drift already proves that two runs of one producer can disagree about a symbol's key |

## 13. Traps recorded so they are not re-litigated

- **CodeQL** has the best fidelity surveyed and licence terms that forbid exactly our use: a commercial product analyzing codebases that are not open source. Not a negotiation, a prohibition.
- **jQAssistant** is the closest structural match to this part's contract — persisted graph, typed edges, JVM-native, actively maintained — and is GPL-3.0 over an embedded GPLv3 database. Unshippable.
- **Stack graphs** is the algorithm behind a major platform's precise navigation, which reads as proven; it is archived by its owner, has no Go or Kotlin rules, and only its Python ruleset has a production record.
- **Glean** reads as "just run it as a service" until the build requirements appear: a Haskell toolchain, a C++ runtime, RocksDB, Thrift, and no first-party JVM client.
- **OpenGrok** is JVM-native, released this month, and is a text-and-ctags index rather than a typed-edge graph — behind the tools we already have, under a weak-copyleft licence its reputation does not suggest.
- **Spoon's** permissive licence choice does not remove EPL exposure, because its compiler backend is JDT. If JDT's fidelity is what you want, depend on JDT.
- **"It is on Maven Central so it is a library"** — scip-java publishes a jar whose `main` drives an external build. Only the bindings are genuinely embeddable, and they only decode.
- **`workspace/symbol` with an empty query** looks like a bulk enumeration primitive and is refused in practice by the implementations that matter.
