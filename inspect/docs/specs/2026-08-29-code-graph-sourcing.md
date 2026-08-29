# Code Graph Sourcing: Build, Improve, or Consume

**Date:** 2026-08-29
**Status:** Proposed — the spike in section 11 must run before `platform/code-graph` is planned
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

**For Java, a compiler-backed resolver runs in our own process, needs no build, and is on Maven Central today.** Eclipse JDT Core's `ASTParser` with `setResolveBindings(true)` yields real ECJ bindings — `ITypeBinding`, `IMethodBinding`, `IVariableBinding` — from a plain list of classpath entries, with unresolved names surfacing as null or recovered bindings, which is exactly the signal our confidence tiers need. Pure Java, no second language runtime, EPL-2.0 file-scope copyleft that is safe to embed unmodified.

That single fact reframes `platform/code-graph`: it is not a part that writes semantic frontends. It is a part that **ingests resolved facts from producers of differing fidelity, records how each fact was obtained, and answers reachability questions over the result.**

### The tier model, per language

| Tier | Producer | Confidence | Requires | Languages |
|---|---|---|---|---|
| A, in-process | Eclipse JDT Core | `resolved` | a classpath, optional | Java |
| A, in-process | Kotlin — unresolved, see section 6 | `resolved` | to be determined | Kotlin |
| A, out-of-process | scip-go, scip-typescript, scip-python | `resolved` | a resolvable dependency tree per language | Go, TypeScript, JavaScript, Python |
| A, out-of-process | scip-java | `resolved` | **a successful build** | Java, when the project builds |
| B, in-process | SootUp or WALA | `resolved` at bytecode granularity | compiled classes | any JVM language |
| C, in-process | tree-sitter via `jtreesitter` plus our own scope rules | `name-only` | nothing but source text | everything else |

Tier C is the floor and is what both local tools already are — the difference is that owning it in-process removes a Node dependency and lets one confidence model span all tiers. Tier B is additive, never a substitute: it resolves calls into dependency and platform code that no source frontend sees, which is exactly where blast radius currently stops at a library boundary. It costs source-level detail (parameter names without debug info, exact ranges) and applies only to JVM targets.

## 6. Kotlin is the real gap, and it is ours

Every other Tier-1 language has a compiler-backed producer we can consume. Kotlin has none we can simply adopt:

- **scip-java's Kotlin support** is self-described as "less mature", Gradle-only, with no Maven and no Android support.
- **Joern's `kotlin2cpg`** embeds `kotlin-compiler-embeddable` and is genuinely compiler-backed — but pins a specific compiler version per release, arrives with a Scala runtime, and risks classloader collision with our own Kotlin toolchain inside one process. That is the two-compiler-versions problem the single-process decision cut classloader isolation to avoid.
- **The Kotlin Analysis API in standalone mode** is the official route to real K2/FIR resolution without a Gradle build, Apache-2.0 — but is published only to a JetBrains repository rather than Maven Central, carries an explicit no-stability statement from JetBrains, and has large parts marked experimental. A first-party JetBrains consumer reports ongoing issues against the same API.

This matters more than any other line in this document, because Leveret Inspect is itself Kotlin and must be able to answer "what does this change break" about its own source. The honest position: **Kotlin resolution is the one frontend-shaped investment that may be unavoidable**, and which of the three routes it takes is a question for measurement, not argument.

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
- **no distinct `calls` role** — a call and a bare mention are both an occurrence with a symbol; distinguishing them means correlating the occurrence's syntax kind with its enclosing range, which is our logic to write;
- **no unresolved-reference record** — an indexer that fails simply omits the symbol, so the unresolved set must be synthesized from identifier-shaped occurrences that carry none. This is the one place the local grammar tool is ahead of the entire precise-indexing ecosystem: its `unresolved_refs` table with a failed status and a retry tail is prior art worth copying outright;
- **no delta protocol** — an index is a flat bag of per-file documents; replace-what-changed is ours.

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
7. **A Kotlin resolution route**, per section 6.

## 10. Revised cost

Section 7 costed this part **Large**, driven by per-language emitters. With Java resolved in-process by an existing library, Go, TypeScript, and Python resolved by existing producers behind one format, and breadth resolved by an embeddable parser, the frontend work collapses to Kotlin alone.

**Revised: Medium, plus one Kotlin spike whose outcome sets the remaining cost.** The store, the confidence model, the unresolved set, the delta protocol, and the queries are unchanged in scope — they were always the part nobody else supplies.

## 11. Spike before planning

Four timeboxed questions, in dependency order. Each ends in a measurement recorded here, not an opinion.

1. **JDT against this repository's Java-free reality.** We have no Java yet, so measure JDT on an external Java project of moderate size: resolved binding rate with and without a classpath, wall-clock per thousand lines, and whether recovered bindings are a usable `name-only` signal. Acceptance: a resolved-edge count and a rate, plus the failure mode when a dependency is missing.
2. **Kotlin, three routes, one measurement.** Run the Analysis API standalone route, `kotlin2cpg`, and scip-java's Kotlin plugin against `runtime/` and `persistence/`. Compare resolved reference counts against the 359-semantic-edge, 120-possible-miss baseline in section 12 of the scope decision, and record dependency weight and version-coupling risk for each. Acceptance: one route recommended with numbers, or an explicit finding that all three fail and a frontend is required.
3. **SCIP round trip.** Produce an index with scip-go on a real Go repository, parse it in-process with the Maven Central bindings, and derive typed edges plus an unresolved set from occurrences. Acceptance: our schema populated from SCIP, with the derivation rules for `calls` versus `references` written down.
4. **Bytecode tier value.** Build a call graph over our own compiled classes with SootUp and count edges that cross into dependency or platform code — edges no source tier can produce. Acceptance: a number that either justifies the tier or kills it.

Until 1 and 2 report, `platform/code-graph` is not plannable: the Kotlin answer determines whether this part is an ingestion layer or an ingestion layer plus a compiler frontend.

## 12. Risk register

| Risk | Mitigation |
|---|---|
| scip-typescript and scip-python have had no commits in roughly a year while looking current | their resolution engines are maintained upstream independently; treat the emission layer as code we may have to maintain, and degrade to Tier C if it breaks |
| scip-java requires a successful build, and goal 1 implies analyzing checkouts that do not build | JDT in-process is the primary Java path precisely because it needs only a classpath; scip-java is the opportunistic higher-fidelity path when a build exists |
| Kotlin Analysis API offers no compatibility guarantee across Kotlin versions | pin our Kotlin version deliberately and treat an upgrade as a spike; the alternative routes stay documented |
| `kotlin2cpg` pins its own embedded compiler version | if adopted, isolate it out of process rather than sharing a classloader with our toolchain |
| EPL-2.0 (JDT, WALA) and LGPL-2.1 (SootUp) are weak copyleft | both permit use as unmodified linked dependencies; do not fork either into our tree without re-reading the terms |
| Single-maintainer velocity across the SCIP family despite the independent organization | the format is stable and our reader is ours; a dead producer costs a tier, not the part |

## 13. Traps recorded so they are not re-litigated

- **CodeQL** has the best fidelity surveyed and licence terms that forbid exactly our use: a commercial product analyzing codebases that are not open source. Not a negotiation, a prohibition.
- **jQAssistant** is the closest structural match to this part's contract — persisted graph, typed edges, JVM-native, actively maintained — and is GPL-3.0 over an embedded GPLv3 database. Unshippable.
- **Stack graphs** is the algorithm behind a major platform's precise navigation, which reads as proven; it is archived by its owner, has no Go or Kotlin rules, and only its Python ruleset has a production record.
- **Glean** reads as "just run it as a service" until the build requirements appear: a Haskell toolchain, a C++ runtime, RocksDB, Thrift, and no first-party JVM client.
- **OpenGrok** is JVM-native, released this month, and is a text-and-ctags index rather than a typed-edge graph — behind the tools we already have, under a weak-copyleft licence its reputation does not suggest.
- **Spoon's** permissive licence choice does not remove EPL exposure, because its compiler backend is JDT. If JDT's fidelity is what you want, depend on JDT.
- **"It is on Maven Central so it is a library"** — scip-java publishes a jar whose `main` drives an external build. Only the bindings are genuinely embeddable, and they only decode.
- **`workspace/symbol` with an empty query** looks like a bulk enumeration primitive and is refused in practice by the implementations that matter.
