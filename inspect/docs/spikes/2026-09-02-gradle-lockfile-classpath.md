# Spike: Gradle classpaths from lockfiles and catalogs

**Date:** 2026-09-02
**Question:** Can a compile and test classpath for a Gradle Java/Kotlin checkout be reconstructed from committed data — `gradle.lockfile` and `gradle/libs.versions.toml` — without executing Gradle, and how does that compare to an isolated Gradle CLI oracle?
**Verdict:** Yes for the *set* of jars, when a lockfile is present and the cache already holds the artifacts. The DataDog workshop subject at `e33ebdd` matched the isolated Gradle 8.7 oracle exactly on content: 36 compile jars and 61 test-compile jars, after omitting pom-only BOM modules. Order is not in the lockfile. Gradle itself is not a Maven-shaped embed: there is no "resolve without running the project." Isolated user-home and `--offline` only drop operator init scripts; they do not skip target configuration. The product worker therefore parses lockfiles and catalogs and never invokes `./gradlew`, the Tooling API, or `buildSrc`.

## Subject

| Subject | Revision | Why included |
|---|---|---|
| `DataDog/vulnerable-java-application` | `e33ebdd5e719fe768abd9c9db88bc8fcc84e9dad` | Public Spring Boot Java app that commits `gradle.lockfile` with `lockAllConfigurations()`, including compile-only Lombok and test-only JUnit. Single project, no version catalog, no included builds. |

Later HEAD of that repository (`0d1c353`) still carries the same lockfile while `build.gradle` has moved to Spring Boot 3.5.16 and Lombok 1.18.46. The worker would keep reconstructing the *locked* graph. That is a property of lockfiles, not a reason to run Gradle.

Resolver in the product: none. The worker reads the lockfile, maps `compileClasspath` / `testCompileClasspath` coordinates onto a caller-owned Maven-layout cache, and skips modules that have a POM but no JAR. Isolated Gradle CLI is the test oracle and cache provisioner only.

Oracle toolchain: Temurin JDK 21.0.12 and the subject's Gradle 8.7 wrapper, with a fresh `GRADLE_USER_HOME`. Gradle 8.7 cannot run on JDK 26 (class-file major version 70). The measured worker itself runs on the host JDK and never starts Gradle.

## Comparison

| Analysis unit | Lockfile modules | Worker jars | Gradle oracle jars | Missing | Extra | Order exact |
|---|---:|---:|---:|---:|---:|---|
| compileClasspath | 37 | 36 | 36 | 0 jars (`jackson-bom` is pom-only) | 0 | no |
| testCompileClasspath | 63 | 61 | 61 | 0 jars (`jackson-bom`, `junit-bom` pom-only) | 0 | no |

The worker ran under `bwrap --unshare-net`. It did not execute Gradle.

Lockfile order is alphabetical by coordinate. Gradle's configuration order is resolution order. The sets match; the sequences do not. Health reporting therefore compares content, not order.

## Miss classes

These are structural. They are recorded on the analysis when they apply; `lockfile-order` is always true of this method and is not a per-project flag.

| Class | When | What we do |
|---|---|---|
| **missing-lockfile** | No `gradle.lockfile` in the project directory | Empty classpaths. A present `gradle/libs.versions.toml` is recorded on the tuple but does not invent configurations or transitives. |
| **dynamic-versions** | No lockfile, and the catalog uses `+`, `latest.*`, or a version range | Recorded. Versions are not guessed. |
| **unpublished-catalogs** | `settings.gradle(.kts)` pulls a catalog by Maven coordinate (`from("g:a:v")`) | Recorded. The default checkout file `gradle/libs.versions.toml` is not this class. |
| **included-builds** | `includeBuild` in `settings.gradle` or `settings.gradle.kts` (Kotlin or Groovy spelling) | Recorded. Substituted included-build outputs are not in the lockfile as Maven coordinates. |
| **pom-only modules** | Locked BOM / `<packaging>pom</packaging>` | Omitted from the classpath. A cached POM whose packaging is not `pom` and whose JAR is missing is a cache miss, not a skip. |
| **lockfile-order** | Always, for this method | Content is compared as a set. Do not claim Gradle's resolution order. |
| **stale lockfile** | Declarations moved, lockfile did not | The worker trusts the lockfile. Detecting drift would mean parsing Groovy/Kotlin DSL, which is out of scope. |
| **runtime-only artifacts** | e.g. `junit-jupiter-engine` on `testRuntimeClasspath` only | Test classpath is `testCompileClasspath`, the compile graph JDT needs, not Maven's `test` scope (which includes runtime). |
| **classifiers / non-default artifacts** | Lockfile stores module versions, not artifact classifiers | Default JAR only. |
| **missing cache artifact** | Locked module has no JAR, and no POM with packaging `pom` | `MissingLockedArtifactException`. Incomplete cache is not silently dropped. |
| **multi-project / project() deps** | `gradle.lockfile` is per subproject; settings and catalogs live at the build root | Follow-up, same as Maven reactors in #1. This spike measured a single-project subject. |

Out of scope, unchanged: reviewing Gradle DSL, invoking target Gradle, the Tooling API against the customer's tree, executing `buildSrc`, treating Gradle as a Maven-shaped embed.

## Worker shape

Same health record as the Maven worker (`ClasspathAnalysis`):

- tuple: `gradle.lockfile` or `none`, plus `libs.versions.toml` or `none`
- profiles: the configurations read (`compileClasspath`, `testCompileClasspath`)
- repository policy: offline, target repositories discarded, Central identity for cache recognition only
- ordered lists of repository-relative JARs (lockfile order)
- `missClasses` for the situational rows above

`WorkerMain --project <dir> --local-repo <cache> --output <file>` is the Gradle entry. `--pom` remains the Maven entry. Neither path starts Gradle.

## Decision

Ship the data-only worker. Do not embed Gradle, and do not run it in production to discover metadata. A lockfile is sufficient for jar-set parity on the measured subject; a catalog without a lockfile is not. Approved remote fetching stays the outer provisioning boundary already named for Maven, not this worker. Multi-project reactors are a follow-up, as they were for Maven.
