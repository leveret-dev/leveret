# Spike: Kotlin resolution — three routes, one measurement

**Date:** 2026-08-29
**Question:** Run the Analysis API standalone route, `kotlin2cpg`, and scip-java's Kotlin plugin against `runtime/` and `persistence/`. Compare resolved reference counts against the 359-semantic-edge, 120-possible-miss baseline in section 12 of the scope decision, and record dependency weight and version-coupling risk for each.
**Verdict:** Adopt the **Kotlin Analysis API standalone (K2)** route — 2,839 references resolved with 0 unresolved, of which **1,119 resolve into libraries and the platform**, for 17 artifacts / 79.7 MiB, no Scala runtime, and an artifact version that equals the Kotlin version we already pin (2.4.0); `kotlin2cpg` is a viable out-of-process fallback, and scip-java's Kotlin plugin **cannot run on our compiler at all**.

## Setup

Toolchain: JDK 26.0.2.1 (Homebrew), Gradle 9.7.1, Maven 3.9.16, protoc 36.0, coursier 2.1.24 (downloaded). Subject revision: `leveret-inspect` @ `ad3d3ec` — 28 `.kt` files, 750 lines main + 684 test; product Kotlin from `gradle/libs.versions.toml`: **2.4.0**.
All work outside the product tree, under `/Users/andre/git/leveret-spike/kotlin/`: `proj/` (faithful Gradle copy
of both modules, same version catalog), `proj-k22/` (same at `kotlin = "2.2.0"`, JVM target 21 — Route C only),
`proj-all/` (flattened, test dirs renamed `*-spec/` — Route B only, see Failures), `k2/` (Route A classpath +
`Walk.kt`), `k2cpg/` (CPG + Joern query `q.sc`), `scip/` (scip-java classpath, `index.scip`, protoc decode).

Subject dependency classpath (16 jars: logback, slf4j, h2, HikariCP, junit-jupiter, assertj, kotlin-stdlib …)
dumped from Gradle via a `dumpCp` task added to the scratch copy only: `gradle --no-daemon -q dumpCp` →
`entries=13` (runtime), `entries=14` (persistence).

Route A classpath, assembled by hand after POM resolution failed (see Failures) — 17 jars:
`analysis-api-{for-ide,impl-base-for-ide,platform-interface-for-ide,k2-for-ide,standalone-for-ide}:2.4.0`,
`low-level-api-fir-for-ide:2.4.0`, `symbol-light-classes-for-ide:2.4.0` (all from
`https://packages.jetbrains.team/maven/p/ij/intellij-dependencies/`), `kotlin-{compiler,stdlib,reflect}:2.4.0`,
`caffeine:3.2.0`, `guava:33.5.0-jre`, `trove4j:1.0.20200330`, `kotlinx-serialization-{core,json}-jvm:1.9.0`,
`annotations:13.0`, and `com.intellij.platform:kotlinx-coroutines-core-jvm:1.10.1-intellij-5` (JetBrains fork —
the upstream artifact is not enough).

## Measurements

| # | Measurement | A · Analysis API K2 standalone | B · Joern `kotlin2cpg` 4.0.614 | C · scip-java 0.13.1 |
|---|---|---|---|---|
| 1 | Files analysed | 28 | 28 (only after renaming test dirs) | 28 |
| 1 | Resolved refs — **into these two modules** | **1,033** symbols + 237 packages | 248 call edges | 1,205 symbols + 237 packages |
| 1 | Resolved refs — **into library / platform** | **1,119** symbols + 436 packages | **620** call edges | **1,063** symbols + 455 packages |
| 1 | Resolved calls (intra / lib) | 808 (242 / 566) | 868 (248 / 620) | — (SCIP has no `calls` role) |
| 2 | Unresolved | **0** | **0** with classpath, 43 without | 0 observable — **unrepresentable** |
| 3 | Cold wall clock, both modules | **5.1 s** (5.09 / 5.52 / 8.77) | 6.7–7.3 s + ~6 s to query | 42.2 s (includes full Gradle build) |
| 3 | Peak resident set | 856 MB | 789 MB | 1,109 MB |
| 4 | Resolved artifacts / total size | **17 / 79.7 MiB** | 108 / 155.7 MiB (CLI dist 1.9 GB) | 74 / 82.1 MiB |
| 4 | Second runtime dragged in | none | **Scala** — scala-library + scala3-compiler 3.8.3 (24.6 MB) | none |
| 4 | IntelliJ platform | 4,168 `com/intellij/` classes, all inside `kotlin-compiler-2.4.0.jar` | no | no |
| 5 | Kotlin compiler pinned | **2.4.0 — our version** | `kotlin-compiler-embeddable` **2.3.21** | `kotlin-compiler-embeddable` **2.2.0** |
| 5 | Runs against our Kotlin 2.4.0? | yes | yes (second compiler in-process) | **no — hard failure** |

Route A, full run (the decisive output):

```
$ java -Djava.awt.headless=true -cp "$CP" WalkKt "<4 source roots>" subject-cp.txt "$JDK_HOME"
FILES=28
REFS_TOTAL=2839                 REFS_UNRESOLVED=0        REFS_ERROR=0
REFS_RESOLVED_INTRA=1033        REFS_RESOLVED_LIB=1119   REFS_RESOLVED_LOCAL=14
REFS_RESOLVED_PKG_INTRA=237     REFS_RESOLVED_PKG_LIB=436    REFS_SKIPPED_OPERATORS=78
CALLS_TOTAL=808  CALLS_RESOLVED=808  CALLS_RESOLVED_INTRA=242  CALLS_RESOLVED_LIB=566  CALLS_UNRESOLVED=0
--- library buckets --- kotlin. 348  java. 330  org.assertj. 197  ch.qos.logback. 113
  ?(constructors) 77  org.slf4j. 20  org.junit. 20  com.zaxxer.hikari. 8  javax. 6
--- sample library-resolved call targets ---
  com.zaxxer.hikari.HikariDataSource.<init>(com/zaxxer/hikari/HikariConfig!)
  org.assertj.core.api.Assertions.assertThat(java/nio/file/Path!)
HEAP_USED_MB=212  SESSION_BUILD_MS=770  TOTAL_MS=4697
        5.09 real   855506944  maximum resident set size
```

Route A **control, dependency jars removed** (the JDK module stays, hence 461 surviving library refs) — proof the 1,119 come from actually reading those jars, and a near-replica of the baseline's failure profile:

```
REFS_RESOLVED_INTRA=966  REFS_RESOLVED_LIB=461  REFS_UNRESOLVED=975
CALLS_TOTAL=808  CALLS_RESOLVED=382  CALLS_UNRESOLVED=426
--- top 10 unresolved names ---
  assertThat x72   Test x50   api x39   to x37   use x31
  TempDir x28      core x27   qos x24   logback x24   ch x24
```

Route B, CPG build then query (`k2cpg/q.sc`, run via `joern --script … --command exec|callee`):

```
$ ./kotlin2cpg /…/proj-all -o subject-all2.cpg.bin --classpath /…/k2cpg/cp
INFO  Found 16 jars in the specified classpath.
INFO  Pass …AstCreationPass completed … from 28 parts.
CALLS_TOTAL=1582  CALLS_OPERATOR=714  CALLS_RESOLVED_NONOP=868  CALLS_UNRESOLVED=0
CALLS_RESOLVED_INTRA=247  CALLS_RESOLVED_LIB=621   IDENTIFIERS=1058  IDENT_TYPED=1044  IDENT_UNTYPED=14
NONOP_WITH_CALLEE_EDGE=868  CALLEE_INTERNAL=248  CALLEE_EXTERNAL=620  NONOP_NO_CALLEE=0  DISTINCT_EXT_TARGETS=210
--- resolved-lib prefixes --- kotlin. 213  java. 209  org.assertj. 159  ch.qos.logback. 27  org.slf4j. 10  hikari 3
--- sample library-resolved calls ---
  assertThat -> org.assertj.core.api.Assertions.assertThat:org.assertj.core.api.ListAssert(java.util.List)
  containsExactly -> org.assertj.core.api.ListAssert.containsExactly:org.assertj.core.api.ListAssert(java.lang.Object[])
```

Without `--classpath` the same 16 main files degrade to `CALLS_UNRESOLVED=43`, `IDENT_UNTYPED=66`, and
every dependency call collapses to `<unresolvedNamespace>.getLogger:<unresolvedSignature>(1)`.

Route C, only after downgrading the scratch project to Kotlin 2.2.0:

```
$ cd proj-k22 && java -cp "$CP" org.scip_code.scip_java.ScipJava index --output=…/index-k22.scip
BUILD SUCCESSFUL in 41s    42.16 real   1109344256 maximum resident set size   index-k22.scip = 416315 bytes

$ protoc --decode=scip.Index --proto_path=/tmp /tmp/scip.proto < index-k22.scip > index-k22.txt   # counted below by an indentation-aware parse of that text
DOCUMENTS 28   OCCURRENCES_TOTAL 3486   OCC_WITHOUT_SYMBOL 0   SYMBOL_INFORMATION 581
OCC_INTRA_SYMBOL 1205  OCC_LIB_SYMBOL 1063  OCC_PKG_INTRA 237  OCC_PKG_LIB 455  OCC_LOCAL 526
library breakdown: kotlin/ 376  java/ 307  org/assertj/ 178  ch/qos/ 140  org/junit/ 20  com/zaxxer/ 18  org/slf4j/ 14  javax/ 10
```

**Against the baseline.** The baseline produced 359 semantic edges, 740 unresolved references, and **zero**
resolved into a library. Route A resolves **1,119 + 436 = 1,555** references into libraries and the platform,
Route B **620** call edges into external declarations, Route C **1,063 + 455**. Route A and Route C — two
independent compiler-backed producers — agree within 5% on library-resolved references (1,119 vs 1,063) and
*exactly* on intra-project package references (237 vs 237): the strongest available confirmation both are real.
The 120-possible-internal-miss ceiling is exceeded ~9× by library resolution alone, and the control run reproduces
the baseline's failure profile (`assertThat`, `Test`, `use`, `TempDir`) the moment the classpath is removed.

## What this means for `platform/code-graph`

Kotlin belongs in **Tier A, in-process**, beside Eclipse JDT for Java, and its facts carry `resolved`: the
Analysis API returns a `KaSymbol` from real K2/FIR resolution or nothing, and with a classpath it returned nothing
zero times, so resolved-versus-absent is a clean binary the ingest layer can trust. It supplies what section 6
feared we would have to write — overload-discriminated call targets into dependency code
(`Assertions.assertThat(java/nio/file/Path!)`), cross-file and cross-module references, PSI ranges for every one
— at 79.7 MiB with no second language runtime. It does **not** supply the unresolved set, edge kinds, or a stable
cross-run key: we synthesize the unresolved set from `KtSimpleNameExpression` nodes resolving to nothing (the
control run is exactly that signal), derive `calls`/`instantiates`/`overrides` from `KaCallInfo` plus PSI shape,
and compute our own key from `ClassId`/`CallableId` rather than borrowing SCIP's, which Route C showed is not
reliably global. **No Kotlin frontend of our own is required; the amended Medium cost for this part stands.**

## Failures and limits

**Route A — the published POM does not resolve.** `analysis-api-standalone-for-ide:2.4.0` declares three
dependencies that do not exist anywhere:

```
$ cs fetch -r central -r https://packages.jetbrains.team/maven/p/ij/intellij-dependencies/ \
    org.jetbrains.kotlin:analysis-api-standalone-for-ide:2.4.0
Resolution error: Error downloading org.jetbrains.kotlin:analysis-api-standalone-base:2.4.0
  not found: https://repo1.maven.org/maven2/org/jetbrains/kotlin/analysis-api-standalone-base/2.4.0/…pom
  not found: https://packages.jetbrains.team/…/analysis-api-standalone-base/2.4.0/…pom
Error downloading org.jetbrains.kotlin:analysis-api-standalone:2.4.0             (same, both repos)
Error downloading org.jetbrains.kotlin:analysis-api-fir-standalone-base:2.4.0    (same, both repos)
```

The `-for-ide` jars are shaded and self-contained; the classpath must be listed by hand, jar by jar. Four further
undocumented requirements surfaced only at runtime, each as a bare failure:
`Cannot resolve /META-INF/analysis-api/analysis-api-fir.xml` (needs `analysis-api-k2-for-ide` — the artifact
formerly named `analysis-api-fir-for-ide`, which 404s at 2.4.0), then `NoClassDefFoundError` for
`kotlinx/serialization/KSerializer`, `com/github/benmanes/caffeine/cache/Caffeine`, and
`kotlinx/coroutines/internal/intellij/IntellijCoroutines` — the last existing only in JetBrains' coroutines fork,
also off Maven Central. Module availability churns across Kotlin versions (`analysis-api-for-ide` 404 at 2.0.0,
`low-level-api-fir-for-ide` 404 at 2.1.0, both 200 at 2.2.0–2.4.0), so an upgrade re-derives the jar list rather
than bumping a version. The process also never exits: non-daemon IntelliJ threads survive `Disposer.dispose`, so
`exitProcess(0)` is mandatory — a first timing run hung 181 s after printing. `KaFirConstructorSymbol` has no
`callableId`, so 77 constructor references sit in an unattributed bucket above; resolved, just unlabelled.

**Route B — test sources are silently dropped and cannot be re-enabled.** The first run reported
`AstCreationPass completed … from 16 parts` against 28 files, with no warning. `SourceFilesPicker$.class` in
`io.joern.kotlin2cpg-4.0.614.jar` holds the string set `src/test`, `test`, `androidTest`, `commonTest`,
`integrationTest`, `jvmTest`, `sharedTest`, `build`, and no CLI flag overrides it; renaming
`runtime-tests/` → `runtime-spec/` moved the count to 28 parts, which is how the Route B row was obtained — a
workaround, not a supported configuration. `--classpath` also rejects file paths despite its help text ("Add entry
to classpath"): 16 repeated `--classpath <jar>` arguments produced `WARN No jars found in the specified
classpath`; only a single directory argument worked (`INFO Found 16 jars in the specified classpath`).
`io.joern:kotlin2cpg_3:4.0.614` does not resolve from Maven Central alone — `org.gradle:gradle-tooling-api:8.3`
needs `https://repo.gradle.org/gradle/libs-releases`. Both compiler-version risks in the risk register are real:
the frontend ships `kotlin-compiler-embeddable-2.3.21.jar` beside our 2.4.0 toolchain, plus `scala3-compiler_3-3.8.3`.

**Route C — will not run on our Kotlin version, at any version of scip-java.** Against `proj/` at Kotlin 2.4.0:

```
e: org.jetbrains.kotlin.cli.jvm.plugins.PluginCliParser$PluginProcessingError: Plugin
   org.scip_code.scip_java.kotlinc.AnalyzerRegistrar is incompatible with the current version of the compiler.
Caused by: java.lang.AbstractMethodError: Missing implementation of resolved method
   'abstract java.lang.String getPluginId()' of abstract class
   org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar
Execution failed for task ':runtime:compileKotlin' … BUILD FAILED in 1m 5s
```

Root cause, measured directly against three compilers:

```
$ javap -cp kotlin-compiler-embeddable-<v>.jar org.jetbrains.kotlin.compiler.plugin.CompilerPluginRegistrar
2.2.0:  registerExtensions, getSupportsK2
2.3.21: getPluginId, registerExtensions, getSupportsK2
2.4.0:  getPluginId, registerExtensions, getSupportsK2
$ javap -cp scip-kotlinc.jar org.scip_code.scip_java.kotlinc.AnalyzerRegistrar
  registerExtensions, getSupportsK2          # no getPluginId
```

`getPluginId()` became abstract in Kotlin 2.3; the plugin embedded as `scip-kotlinc.jar` inside
`scip-java-0.13.1.jar` was built against 2.2.0 and cannot load into **any** Kotlin ≥ 2.3 compiler. Central
publishes only `0.13.0` and `0.13.1` under `org.scip-code:scip-java`, so there is nothing newer. The Gradle-only
claim is confirmed from the artifact: `GradleBuildTool.class` carries `project.ext["scipKotlincJar"]`,
`MavenBuildTool.class` carries none. Two limits apply even to the Kotlin 2.2.0 numbers: **374 of 376 Kotlin stdlib
occurrences are emitted with package `. .`** (`scip-java maven . . kotlin/use().`), colliding with our own
namespace and breaking the stable-global-key property section 7 relies on; and the unresolved set is
unrepresentable — `OCC_WITHOUT_SYMBOL 0` means a failed reference emits no occurrence at all, as predicted.

**Caveats on every number.** The corpus is 28 files / 1,434 lines; nothing here predicts behaviour at 10⁵ lines,
and each route ran once per configuration (Route A three times for wall clock: 5.09 / 5.52 / 8.77 s). Peak
resident set is `/usr/bin/time -l` for the whole JVM, so it includes ~50 MB of JVM baseline. The routes count
different things — Route A `KtSimpleNameExpression` resolutions, Route B CPG `CALL` nodes, Route C SCIP
occurrences including 581 definitions and 526 function-locals — so columns compare in magnitude and in the
intra-versus-library split, not term for term. Route C's row came from `proj-k22/` (Kotlin 2.2.0, JVM target 21),
which is **not** the product's configuration.
