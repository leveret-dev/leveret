# Spike: Bytecode tier value (SootUp)

> **Scope status, 2026-08-29 (final):** briefly cut, then **restored at rung 3 as an opportunistic tier** — we compile the target in a sandbox we own rather than asking the customer to build, so the class files are ours to produce when the compile succeeds (`docs/specs/2026-08-29-code-graph-sourcing.md` §2, §5.3, §5.5). It frequently will not: private dependencies need credentials we refuse to request, and non-standard build strategies are not reproducible from a checkout. The numbers below justify the tier wherever it fires; no feature may depend on it firing.

**Date:** 2026-08-29
**Question:** Build a call graph over our own compiled classes with SootUp and count edges that cross into dependency or platform code — edges no source tier can produce. Acceptance: a number that either justifies the tier or kills it.
**Verdict:** The tier earns its place — **961 resolved call edges from our own bytecode into dependency and platform code** (482 from main source alone), 86% of them mapped to an exact source file and line, against zero such edges from the source-only baseline — but only with rapid-type analysis, because class-hierarchy analysis is unusable at any scope that includes the JDK.

## Setup

Scratch: `/Users/andre/git/leveret-spike/bytecode` (Maven project, `src/main/java/Spike.java`, ~280 lines). Nothing in the product repository was built or modified.

- **SootUp 3.0.1**, LGPL-2.1, published to Maven Central 2026-08-07 (`last-modified: Fri, 07 Aug 2026 09:00:17 GMT`) — newer than the 2026-03-19 release the sourcing document records. Four artifacts needed: `sootup.core`, `sootup.java.core`, `sootup.java.bytecode.frontend`, `sootup.callgraph`. **Note the rename:** `sootup.java.bytecode` stopped at 1.3.0; from 2.0.0 the artifact is `sootup.java.bytecode.frontend`.
- **Toolchain:** JDK 26.0.2.1 (Homebrew), Maven 3.9.16. No WALA fallback was needed; SootUp worked on the first attempt.
- **Classes under analysis:** copied from `runtime/build/classes/kotlin/main` and `persistence/build/classes/kotlin/main` (24 class files) and `.../kotlin/test` (13 class files). Fresh, not stale: class dirs written 2026-08-29 06:12, no `.kt` under `*/src/main` newer. Bytecode is **class-file major 69 (Java 25)**; ASM 9.10.1 in SootUp's closure read it with no version workaround.
- **Repository revision:** `ad3d3ec`, 750 lines of main Kotlin — the same corpus as the section-12 baseline.
- **Dependency jars** gathered from `~/.gradle/caches/modules-2/files-2.1` by exact version read from `gradle/libs.versions.toml`: `slf4j-api-2.0.17`, `logback-classic/core-1.5.18`, `HikariCP-6.3.0`, `h2-2.3.232`, `kotlin-stdlib-2.4.0`; plus for test scope `assertj-core-3.27.3`, `junit-jupiter*-5.13.4`, `opentest4j-1.3.0`, `apiguardian-api-1.1.2`. JDK platform classes came from `JrtFileSystemAnalysisInputLocation` over the running JDK.

```
mvn -q -B dependency:build-classpath -Dmdep.outputFile=cp.txt
javac -cp "$(cat cp.txt)" -d out src/main/java/Spike.java
/usr/bin/time -l java -Xmx8g -cp "out:$(cat cp.txt)" Spike . [--no-jrt] [--lib-as-app] [--test-scope] [--rta-only]
```

Entry points are every method declared in the two modules (122 main, 228 main+test; all have bodies).

## Measurements

### The decisive number — direct call-site enumeration, no dispatch algorithm

Every `invoke` in our own method bodies, classified by the statically declared target class. Exact; no algorithm choice involved.

| Scope | Call sites | → our modules | **→ dependency/platform** | → `invokedynamic` (lost) | of dep edges: need a dispatch choice | exact (static+special) | distinct dep classes |
|---|---:|---:|---:|---:|---:|---:|---:|
| main only (24 classes, 122 methods) | 621 | 115 | **482** | 23 | 246 | 236 | 66 |
| main + test (37 classes, 228 methods) | 1347 | 317 | **961** | 65 | 437 | 524 | 82 |

```
===== A. DIRECT CALL SITES IN OUR OWN BYTECODE =====   (main only)
call sites: 621 total in 1300 ms; with line number: 536 (86.3%)
by target bucket: {DEP=482, OTHER=24, OURS=115}
OTHER-bucket target classes (outside the six named prefixes): {javax.sql.DataSource=1, sootup.dummy.InvokeDynamic=23}
DEP/platform edges by dispatch kind: {interface=136, special=55, static=181, virtual=110}
DEP/platform edges needing a dispatch choice (virtual+interface+dynamic): 246
distinct dependency/platform classes called: 66
```

The baseline's unresolved set was dominated by `assertThat` ×60 and `Test` ×38. Adding the compiled tests resolves the first exactly, along with the whole fluent chain that name matching cannot reach at all:

```
===== A. DIRECT CALL SITES IN OUR OWN BYTECODE =====   (main + test)
call sites: 1347 total in 3867 ms; with line number: 1196 (88.8%)
by target bucket: {DEP=961, OTHER=69, OURS=317}
top target classes:
    141  kotlin.jvm.internal.Intrinsics
     67  org.assertj.core.api.Assertions          <- baseline's assertThat x60
     57  kotlin.jdk7.AutoCloseableKt
     56  java.nio.file.Path
     52  java.lang.Object
     41  java.lang.StringBuilder
     41  kotlin.collections.MapsKt
     40  org.assertj.core.api.AbstractStringAssert
     37  kotlin.TuplesKt
     36  java.util.Iterator
     28  java.nio.file.Files
     18  java.sql.PreparedStatement
```

The baseline's *other* dominant name, `Test` ×38, is an annotation, so no call graph can supply it — but the same bytecode does, as a resolved type reference:

```
===== E. ANNOTATION USAGES (resolved references, not call edges) =====
total: 122 -> {kotlin.Metadata=37, kotlin.jvm.internal.SourceDebugExtension=12,
  org.jetbrains.annotations.NotNull=31, org.jetbrains.annotations.Nullable=1,
  org.junit.jupiter.api.AfterEach=2, org.junit.jupiter.api.BeforeEach=1,
  org.junit.jupiter.api.Test=38}                       <- baseline's Test x38, exactly
```

Both of the baseline's top two unresolved names are therefore resolved exactly from bytecode: `assertThat` ×60 as 67 `calls` edges to `org.assertj.core.api.Assertions`, and `Test` ×38 as 38 annotation references to `org.junit.jupiter.api.Test`. Read via `JavaSootClass.getAnnotations()` / `JavaSootMethod.getAnnotations()`; 41 of the 122 usages are cross-boundary, the rest Kotlin compiler metadata and JetBrains nullability annotations.

### Per-algorithm edge counts — precision versus cost

`SourceType.Library` silently means depth-1: `AbstractCallGraphAlgorithm` gates body exploration on `!SootClass.isLibraryClass()` (verified by `javap`, below). `--lib-as-app` promotes the jars and the JDK to `Application` to force transitive expansion.

| Scope | Algo | Reachable methods | Total edges | → modules | → dep/platform | → other | ours→dep needing a choice | Algo ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| main, jars only, depth-1 | CHA | 351 | 737 | 138 | 598 | 1 | 344 | 140 |
| main, jars only, depth-1 | RTA | 286 | 611 | 136 | 474 | 1 | 220 | **22** |
| main, jars + JDK, depth-1 | CHA | 4,500 | 46,467 | 150 | 17,199 | **29,118** | 16,896 | 935 |
| main, jars + JDK, depth-1 | RTA | 322 | 1,094 | 148 | 946 | **0** | 643 | 136 |
| main+test, jars + JDK, depth-1 | CHA | 4,826 | 75,652 | 405 | 27,989 | **47,258** | 27,290 | 1,234 |
| main+test, jars + JDK, depth-1 | RTA | 500 | 2,411 | 405 | 2,006 | **0** | 1,307 | 380 |
| main, jars, transitive | CHA | 4,475 | 16,140 | 148 | 15,650 | 342 | 344 | 752 |
| main, jars, transitive | RTA | 1,140 | 3,004 | 136 | 2,711 | 157 | 223 | 28 |
| main, jars + JDK, transitive | RTA | 20,535 | 305,137 | 382 | 241,392 | 63,363 | 6,737 | 28,068 cold / 8,284 warm |
| main, jars + JDK, transitive | CHA | 160,949 | **8,216,279** | 1,564 | 3,934,611 | 4,280,104 | 16,896 | **503,779** |

Edge counts are identical between the two RTA runs; only the time differs, because SootUp's class cache is populated by whichever algorithm runs first. 28,068 ms is RTA alone (`--rta-only`); 8,284 ms is RTA after CHA warmed the view in the same process. Every other `Algo ms` in this table is a warm CHA-then-RTA figure, so treat CHA's numbers as cold and RTA's as warm.

That last row is the whole precision-versus-cost trade: from 750 lines of main Kotlin, CHA produces **27× the edges of RTA in 18–61× the time** (8.2 M edges / 504 s versus 305 K edges / 8.3–28 s), needing 11,043 MB of heap against RTA's 8,604 MB.

CHA's surplus is noise. With the JDK in scope it resolves `Object.toString()` and `Iterator.next()` against every implementer in the JDK image:

```
===== C. CHA =====                        (main, jars + JDK, transitive)
CHA: 160949 reachable methods, 8216279 call edges, 503779 ms
  all edges by target bucket:  {DEP=3934611, OTHER=4280104, OURS=1564}
  OTHER-bucket targets by package (top 10):
    1264143  com.sun        259185  javax.swing     110720  jdk.vm
     651689  jdk.internal   167212  jdk.jpackage     93225  javax.management
     338940  sun.security   136270  sun.jvm          89084  sun.awt / 88231 sun.nio
  peak heap used so far: 11043 MB

===== C. RTA =====                        (same scope)
RTA: 20535 reachable methods, 305137 call edges, 8284 ms
  peak heap used so far: 8604 MB

===== C. RTA =====                        (main, jars + JDK, depth-1)
RTA: 322 reachable methods, 1094 call edges, 136 ms
  all edges by target bucket:  {DEP=946, OURS=148}      <- OTHER bucket empty
```

### Cost

| Configuration | Wall clock | Peak RSS |
|---|---:|---:|
| main, jars only, depth-1, CHA+RTA+all sections | 1.21 s | 441 MiB |
| main, jars only, transitive, CHA+RTA | 4.48 s | 573 MiB |
| main, jars + JDK, depth-1, CHA+RTA | 4.57 s | 3,107 MiB |
| main+test, jars + JDK, depth-1, CHA+RTA | 7.59 s | 2,762 MiB |
| main, jars + JDK, transitive, RTA only | 34.8 s | 4,140 MiB heap |
| main, jars + JDK, transitive, CHA+RTA | **529 s** | 11,043 MiB heap (`-Xmx12g`) |

Embedding weight: **26 jars, 8.6 MB** total; SootUp's own 6 jars are **0.8 MB**. The rest is Guava 33.6.0-jre, ASM 9.10.1 (×5), jgrapht, graph4j, jheaps, commons-lang3/text/io, gson, apfloat, jspecify, error_prone_annotations. Licence: LGPL-2.1 (`sootup-3.0.1.pom`).

### Source fidelity — can an edge be mapped back to a source range?

**Yes for file and line; no for column; parameter names survive.**

| Fact | Available? | How |
|---|---|---|
| source file | yes, 37/37 classes | `SourceFile` attribute, read with ASM `visitSource` — **SootUp does not expose it** |
| statement line | yes, 86.3% of call sites (88.8% with tests) | `Stmt.getPositionInfo().getStmtPosition().getFirstLine()` |
| column offset | **no** | `Position.getFirstCol()` unpopulated; line granularity only |
| class / method declaration range | **no** | `getPosition()` returns `-1..-1` for both |
| parameter names | yes, for methods with bodies | `LocalVariableTable`; `MethodParameters` is absent (0 occurrences) |

```
===== D. EDGE -> SOURCE FILE:LINE =====
SourceFile attribute present on 24/24 of our classes
dependency/platform edges mapped to <sourceFile>:<line>: 417; unmappable: 65 (13.5%)
  com/leveret/inspect/db/config/DatabaseKeys.kt:20  ->  kotlin.TuplesKt#to()  [static]
  com/leveret/inspect/db/config/DatabaseSettings.kt:16  ->  java.lang.CharSequence#length()  [interface]
  com/leveret/inspect/db/acceptance/PersistenceAcceptanceTest.kt:43  ->  org.assertj.core.api.Assertions#assertThat()  [static]
  com/leveret/inspect/db/acceptance/PersistenceAcceptanceTest.kt:45  ->  org.assertj.core.api.AbstractPathAssert#exists()  [virtual]

===== B. SOURCE FIDELITY =====
probe method: <com.leveret.inspect.runtime.config.SettingsLoader: ... load(java.lang.String[])>
  class position (first..last line): -1..-1
  class source path from SootClassSource: classes/runtime/.../SettingsLoader.class
  method position: -1..-1
  parameter locals (names from SootUp): args
  first 6 invoke stmts with line numbers:
    line -1 : staticinvoke <kotlin.jvm.internal.Intrinsics: void checkNotNullParameter(...)>(args, "args")
    line 21 : $stack14 = interfaceinvoke $stack13.<kotlin.jvm.functions.Function0: java.lang.Object invoke()>()
    line 21 : $stack16 = interfaceinvoke $stack15.<java.nio.file.Path: java.nio.file.Path toAbsolutePath()>()
    line 21 : home = interfaceinvoke $stack16.<java.nio.file.Path: java.nio.file.Path normalize()>()
    line 22 : fileValues = specialinvoke this.<...SettingsLoader: java.util.Map readBaseFile(java.nio.file.Path)>(home)
```

Verified against `runtime/src/main/kotlin/.../SettingsLoader.kt` line 21 — `val home = homeSupplier().toAbsolutePath().normalize()` — and line 20, `fun load(args: Array<String>)`. Three distinct dependency edges on line 21, the parameter named `args`, both exact.

## What this means for `platform/code-graph`

This is Tier B in the sourcing document's model, and the measured yield is what section 5 predicted: **961 resolved `calls` edges into dependency and platform code, plus 41 cross-boundary annotation references, against 359 semantic edges and zero cross-boundary edges in the section-12 baseline.** It resolves both names that baseline failed on most — `assertThat` ×60 and `Test` ×38 — exactly, and it reaches library API the baseline could not name at all (`AbstractStringAssert`, `PreparedStatement`, `ILoggingEvent`).

Only the **524 statically exact edges** (`invokestatic`, `invokespecial`) deserve the `resolved` confidence tag. The **437 that required a dispatch choice** are a set of possible targets, not a fact, and belong at `heuristic` with the algorithm and the analysis scope both recorded on the edge: the same 246 ambiguous main-source call sites yield 220, 643, or 6,737 targets depending only on scope and algorithm, and CHA disagrees with RTA by 42× at depth 1. An edge kind of `calls` with no algorithm provenance would be a lie in this tier.

The tier supplies a source file and a **line**, never a column, so it cannot populate the contract's per-edge source *range* at the same precision as JDT or SCIP — the store must admit line-only edges or the tier's facts must be marked as such. It supplies nothing at all for a file that does not compile, and it collapses every `invokedynamic` site — including all seven Kotlin lambda instantiations — into an unresolvable placeholder, which for a Kotlin product is a standing gap only a source tier can close. Adopt it as additive enrichment behind RTA, scoped to the dependency jars and deliberately **excluding the JDK image**; never as the tier that answers "what does this change break" on its own.

## Failures and limits

- **Transitive CHA over jars + JDK is not a candidate, though it does terminate.** 8,216,279 edges, 160,949 reachable methods, 503,779 ms, 11,043 MB heap — from 750 lines of Kotlin. 4,280,104 of those edges target `com.sun`, `jdk.internal`, `sun.security`, `javax.swing`, `jdk.jpackage`, `sun.awt`. Measured with `start=$(date +%s); timeout 900 java -Xmx12g ... Spike . --lib-as-app` → `exit=0 elapsed=529s`. An earlier attempt at this configuration was cancelled prematurely; the 529 s figure is the completed run, not an extrapolation. **CHA is usable only when the scope excludes the JDK, and even then its surplus over RTA is noise.**
- **`SourceType.Library` silently truncates the graph to depth 1.** A setup that looks like whole-program analysis stops at the first library frame:
  ```
  $ javap -p -c -cp "$CP" sootup.callgraph.AbstractCallGraphAlgorithm | grep -A6 SourceType
       1: invokeinterface #650,  1   // InterfaceMethod sootup/core/model/SootClass.isLibraryClass:()Z
       6: ifne  13
  ```
- **`invokedynamic` targets are lost.** 23 of 621 main call sites (65 of 1,347 with tests) resolve to the placeholder `sootup.dummy.InvokeDynamic`. Bootstrap breakdown by `javap -v`: **16 `makeConcatWithConstants`** (string interpolation — no interesting target) and **7 `LambdaMetafactory.invoke`** (Kotlin lambda instantiation — a genuinely lost call-site-to-lambda-body edge).
- **13.5% of dependency edges have no line number** (65 of 482; 131 of 961 with tests). All are Kotlin's synthetic null-check prologue, `Intrinsics.checkNotNullParameter`, which the compiler emits with no `LineNumberTable` entry — visible as `line -1` in section B. Harmless here, but it means "every edge has a source position" is false.
- **Precision degrades as scope grows, on the same call sites.** Our 246 ambiguous main-source call sites yield 220 targets (RTA, jars-only depth-1), 643 (RTA, jars+JDK depth-1), or 6,737 (RTA, transitive jars+JDK). A cross-boundary edge count is meaningless without the scope and algorithm stated alongside it.
- **Edges are recorded to classes absent from the scope.** Transitive analysis over the six jars produced targets in `io.micrometer` (51), `com.codahale` (48), `io.dropwizard` (41), `io.prometheus` (54) — HikariCP and logback optional integrations that are not on the classpath at all.
- **The `OTHER` bucket proves the six named prefixes undercount "platform".** CHA's 29,118 surplus edges target `com.sun`, `jdk.internal`, `sun.security`, `jdk.jpackage`, `javax.swing`. Any production classification must treat the whole JDK image as platform, not a prefix list.
- **The tier requires compiled classes.** These were present and fresh; nothing here says what happens when they are not, and no build was run to find out.
- **Not measured:** WALA, since SootUp did not resist; incremental/delta re-analysis of a single changed class; any codebase larger than 750 lines of main Kotlin, so all absolute counts scale with the corpus and none of them is a throughput figure.
