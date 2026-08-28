# Process Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the supervised-node process runtime for Leveret Inspect — settings loading, runtime directories, process identities, local command file, dependency-ordered launch and readiness, restart and shutdown, and per-process logging.

**Architecture:** One Gradle module `runtime/` with behavior-named packages (`config`, `fs`, `ipc`, `proc`, `supervise`, `log`) and three entry points in the same artifact: the monitor (`App`), the standalone hard-stop requester (`Shutdowner`), and the reusable child host (`ChildEntryPoint`). Children are separate operating-system processes coordinated through a memory-mapped command file; the monitor never shares memory objects with them.

**Tech Stack:** Kotlin/JVM (bytecode target JDK 25, current LTS), Gradle Kotlin DSL, SLF4J + Logback, JUnit 5, AssertJ.

**Spec:** `specs/platform/process-runtime/specification.md` and the derived design `docs/specs/2026-08-28-process-runtime-design.md`

## Global Constraints

- Target baseline is release `26.8.0.126808`; no behavior from later releases.
- Java package root is `com.leveret.inspect.runtime`. Product naming is Leveret Inspect everywhere.
- Property prefix is `leveret.` only. No alias prefix is accepted anywhere: not in the configuration file, environment names, application arguments, or system properties.
- Base configuration file is `conf/leveret.properties`. There is no second file name.
- Process keys and indexes: `app` 0, `search` 1, `web` 2, `ce` 3. Five slots reserved; indexes outside 0 through 4 are rejected.
- Log files are `leveret.log`, `search.log`, `web.log`, `ce.log`. Supported levels are `INFO`, `DEBUG`, `TRACE`.
- Not implemented by decision, because Leveret Inspect will not use them: an alias property prefix, a second configuration file name, multi-node clustering in any form (no cluster setting, no restart-rejection branch, no cluster node name in log records), suppression of the upstream search engine's external-options environment variable, and the upstream hard-stop helper's working-directory quirk. Suppression of generic JVM tool options is kept. Tasks 3, 5, 7, 9, and 10 were executed before this decision and were amended afterwards; Tasks 11 through 14 below already reflect it.
- Timing constants: readiness poll 500 ms; search health retry 100 ms up to 600 attempts per check; child hard-stop deadline 1 s; supervisor hard-stop wait 1 min; child graceful timeout is configured value plus 30 s; supervisor graceful wait is configured value plus 60 s.
- Default graceful timeouts: web `240000` ms, compute `21600000` ms; both must parse as integers of at least 1.
- No implementation may consult upstream source. The specification and this plan are the only inputs.
- Every task ends green: `./gradlew :runtime:test` passes before its commit.

---

### Task 1: Module skeleton and toolchain

**Files:**
- Create: `settings.gradle.kts`
- Create: `build.gradle.kts`
- Create: `runtime/build.gradle.kts`
- Create: `gradle/libs.versions.toml`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/ToolchainTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: Gradle project `:runtime` with Kotlin JVM toolchain 21, `slf4j-api`, `logback-classic`, `junit-jupiter`, `assertj-core` on the appropriate configurations; `./gradlew :runtime:test` runs JUnit 5 platform tests.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ToolchainTest {
  @Test
  fun `runs on java 21 or later`() {
    assertThat(Runtime.version().feature()).isGreaterThanOrEqualTo(21)
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test`
Expected: FAIL — no Gradle project, no wrapper, or unresolved `assertj`.

- [ ] **Step 3: Write minimal implementation**

`settings.gradle.kts`:

```kotlin
rootProject.name = "leveret-inspect"
include("runtime")
```

`gradle/libs.versions.toml`:

```toml
[versions]
kotlin = "2.0.21"
slf4j = "2.0.16"
logback = "1.5.12"
junit = "5.11.3"
assertj = "3.26.3"

[libraries]
slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }
logback-classic = { module = "ch.qos.logback:logback-classic", version.ref = "logback" }
junit-jupiter = { module = "org.junit.jupiter:junit-jupiter", version.ref = "junit" }
junit-platform-launcher = { module = "org.junit.platform:junit-platform-launcher", version = "1.11.3" }
assertj-core = { module = "org.assertj:assertj-core", version.ref = "assertj" }

[plugins]
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
```

`build.gradle.kts`:

```kotlin
plugins {
  alias(libs.plugins.kotlin.jvm) apply false
}
```

`runtime/build.gradle.kts`:

```kotlin
plugins {
  alias(libs.plugins.kotlin.jvm)
  application
}

kotlin { jvmToolchain(21) }

dependencies {
  implementation(libs.slf4j.api)
  implementation(libs.logback.classic)
  testImplementation(libs.junit.jupiter)
  testImplementation(libs.assertj.core)
  testRuntimeOnly(libs.junit.platform.launcher)
}

application { mainClass.set("com.leveret.inspect.runtime.AppKt") }

tasks.test { useJUnitPlatform() }
```

Generate the wrapper: `gradle wrapper --gradle-version 8.11.1` (or copy an existing wrapper).

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add settings.gradle.kts build.gradle.kts runtime gradle gradlew gradlew.bat
git commit -m "build: add runtime module with kotlin 21 toolchain"
```

---

### Task 2: Process identities

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ProcessId.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/ProcessIdTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `enum class ProcessId(val key: String, val index: Int, val logPrefix: String, val displayName: String)` with entries `APP("app", 0, "leveret", "Leveret Inspect")`, `SEARCH("es", 1, "es", "Search")`, `WEB("web", 2, "web", "Web Server")`, `COMPUTE("ce", 3, "ce", "Compute Engine")`.
  - `companion object { const val MAX_PROCESSES = 5; fun fromKey(key: String): ProcessId; fun fromIndex(index: Int): ProcessId }`, both throwing `IllegalArgumentException` on unknown input.
  - `val ProcessId.logFileName: String` returning `"$logPrefix.log"`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime.proc

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ProcessIdTest {
  @Test
  fun `identities are release coupled`() {
    assertThat(ProcessId.entries.map { Triple(it.key, it.index, it.logPrefix) })
      .containsExactly(
        Triple("app", 0, "leveret"),
        Triple("es", 1, "es"),
        Triple("web", 2, "web"),
        Triple("ce", 3, "ce"),
      )
    assertThat(ProcessId.MAX_PROCESSES).isEqualTo(5)
    assertThat(ProcessId.WEB.logFileName).isEqualTo("web.log")
  }

  @Test
  fun `lookup rejects unknown key and out of range index`() {
    assertThat(ProcessId.fromKey("ce")).isEqualTo(ProcessId.COMPUTE)
    assertThat(ProcessId.fromIndex(1)).isEqualTo(ProcessId.SEARCH)
    assertThatThrownBy { ProcessId.fromKey("search") }.isInstanceOf(IllegalArgumentException::class.java)
    assertThatThrownBy { ProcessId.fromIndex(4) }.isInstanceOf(IllegalArgumentException::class.java)
    assertThatThrownBy { ProcessId.fromIndex(-1) }.isInstanceOf(IllegalArgumentException::class.java)
  }
}
```

Note: index 4 is a reserved but unassigned slot, so `fromIndex(4)` has no identity and throws; slot allocation in Task 5 still accepts 0 through 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test --tests '*ProcessIdTest'`
Expected: FAIL — unresolved reference `ProcessId`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.runtime.proc

enum class ProcessId(
  val key: String,
  val index: Int,
  val logPrefix: String,
  val displayName: String,
) {
  APP("app", 0, "leveret", "Leveret Inspect"),
  SEARCH("es", 1, "es", "Search"),
  WEB("web", 2, "web", "Web Server"),
  COMPUTE("ce", 3, "ce", "Compute Engine");

  val logFileName: String get() = "$logPrefix.log"

  companion object {
    const val MAX_PROCESSES = 5

    fun fromKey(key: String): ProcessId =
      entries.firstOrNull { it.key == key } ?: throw IllegalArgumentException("Unknown process key: $key")

    fun fromIndex(index: Int): ProcessId =
      entries.firstOrNull { it.index == index } ?: throw IllegalArgumentException("Unknown process index: $index")
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test --tests '*ProcessIdTest'`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ProcessId.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/ProcessIdTest.kt
git commit -m "feat: add process identities"
```

---

### Task 3: Settings, aliases, and precedence

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/Settings.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/PropertyKeys.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/CommandLineParser.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/SettingsLoader.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsLoaderTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/config/CommandLineParserTest.kt`

**Interfaces:**
- Consumes: `ProcessId` (for per-process log-level and JVM-option key names).
- Produces:
  - `class Settings(private val values: Map<String, String>)` with `fun optional(key: String): String?`, `fun required(key: String): String`, `fun value(key: String, fallback: String): String`, `fun intValue(key: String, fallback: Int): Int`, `fun boolValue(key: String, fallback: Boolean): Boolean`, `fun asMap(): Map<String, String>`, and `val keys: Set<String>`. Keys stored canonical.
  - `object PropertyKeys` with `const val PATH_HOME = "leveret.path.home"`, `PATH_DATA`, `PATH_LOGS`, `PATH_TEMP`, `PATH_WEB`, `ENABLE_STOP_COMMAND = "leveret.enableStopCommand"`, `CLUSTER_ENABLED = "leveret.cluster.enabled"`, `JDBC_URL = "leveret.jdbc.url"`, `LOG_LEVEL = "leveret.log.level"`, `LOG_CONSOLE`, `LOG_JSON`, `LOG_ROLLING_POLICY`, `LOG_MAX_FILES`, `SEARCH_HOST`, `SEARCH_PORT`, plus `fun javaOpts(id: ProcessId): String`, `fun javaAdditionalOpts(id: ProcessId): String`, `fun gracefulStopTimeout(id: ProcessId): String`, `fun logLevel(id: ProcessId): String`, `val defaults: Map<String, String>`, `fun canonical(key: String): String`, `fun envName(key: String): String`.
  - `object CommandLineParser { fun parse(args: Array<String>): Map<String, String> }` throwing `IllegalArgumentException` on any argument not matching `-Dkey=value`.
  - `class SettingsLoader(private val homeSupplier: () -> Path, private val env: Map<String, String>, private val systemProperties: Map<String, String>, private val warn: (String) -> Unit)` with `fun load(args: Array<String>): Settings`.

Key naming: canonical JVM-option keys are `leveret.search.javaOpts`, `leveret.web.javaOpts`, `leveret.ce.javaOpts` (search uses the word `search`, not the process key `es`); per-process log levels use the process key: `leveret.log.level.app`, `.es`, `.web`, `.ce`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.config

import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class SettingsLoaderTest {
  private fun home(@TempDir dir: Path, vararg lines: String): Path {
    Files.createDirectories(dir.resolve("conf"))
    Files.writeString(dir.resolve("conf/leveret.properties"), lines.joinToString("\n"))
    return dir
  }

  @Test
  fun `system property beats argument beats environment beats file`(@TempDir dir: Path) {
    val h = home(dir, "leveret.log.level=DEBUG")
    val loader = SettingsLoader(
      homeSupplier = { h },
      env = mapOf("LEVERET_LOG_LEVEL" to "TRACE"),
      systemProperties = mapOf("leveret.log.level" to "INFO"),
      warn = {},
    )
    assertThat(loader.load(arrayOf("-Dleveret.log.level=DEBUG")).required("leveret.log.level")).isEqualTo("INFO")

    val withoutSysProp = SettingsLoader({ h }, mapOf("LEVERET_LOG_LEVEL" to "TRACE"), emptyMap(), {})
    assertThat(withoutSysProp.load(arrayOf("-Dleveret.log.level=DEBUG")).required("leveret.log.level")).isEqualTo("DEBUG")
    assertThat(withoutSysProp.load(emptyArray()).required("leveret.log.level")).isEqualTo("TRACE")

    val fileOnly = SettingsLoader({ h }, emptyMap(), emptyMap(), {})
    assertThat(fileOnly.load(emptyArray()).required("leveret.log.level")).isEqualTo("DEBUG")
  }

  @Test
  fun `home is runtime owned and absolute`(@TempDir dir: Path) {
    val h = home(dir, "leveret.path.home=/somewhere/else")
    val settings = SettingsLoader({ h }, emptyMap(), emptyMap(), {}).load(emptyArray())
    assertThat(settings.required(PropertyKeys.PATH_HOME)).isEqualTo(h.toAbsolutePath().toString())
  }

  @Test
  fun `legacy prefix resolves to canonical key and conflict warns`(@TempDir dir: Path) {
    val h = home(dir, "sonar.log.level=TRACE")
    val warnings = mutableListOf<String>()
    val settings = SettingsLoader({ h }, emptyMap(), emptyMap(), warnings::add).load(emptyArray())
    assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
    assertThat(warnings).isEmpty()

    val h2 = home(dir, "sonar.log.level=TRACE", "leveret.log.level=DEBUG")
    val conflicts = mutableListOf<String>()
    val resolved = SettingsLoader({ h2 }, emptyMap(), emptyMap(), conflicts::add).load(emptyArray())
    assertThat(resolved.required("leveret.log.level")).isEqualTo("DEBUG")
    assertThat(conflicts).anySatisfy { assertThat(it).contains("sonar.log.level").contains("leveret.log.level") }
  }

  @Test
  fun `legacy environment name is accepted`(@TempDir dir: Path) {
    val h = home(dir, "leveret.log.level=DEBUG")
    val settings = SettingsLoader({ h }, mapOf("SONAR_LOG_LEVEL" to "TRACE"), emptyMap(), {}).load(emptyArray())
    assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
  }

  @Test
  fun `missing file warns and defaults still apply`(@TempDir dir: Path) {
    val warnings = mutableListOf<String>()
    val settings = SettingsLoader({ dir }, emptyMap(), emptyMap(), warnings::add).load(emptyArray())
    assertThat(warnings).isNotEmpty()
    assertThat(settings.required(PropertyKeys.LOG_LEVEL)).isEqualTo("INFO")
    assertThat(settings.required(PropertyKeys.gracefulStopTimeout(com.leveret.inspect.runtime.proc.ProcessId.WEB)))
      .isEqualTo("240000")
    assertThat(settings.required(PropertyKeys.gracefulStopTimeout(com.leveret.inspect.runtime.proc.ProcessId.COMPUTE)))
      .isEqualTo("21600000")
  }

  @Test
  fun `unreadable existing file fails loading`(@TempDir dir: Path) {
    Files.createDirectories(dir.resolve("conf/leveret.properties"))
    assertThatThrownBy { SettingsLoader({ dir }, emptyMap(), emptyMap(), {}).load(emptyArray()) }
      .isInstanceOf(IllegalStateException::class.java)
  }

  @Test
  fun `legacy file is used when canonical file is absent`(@TempDir dir: Path) {
    Files.createDirectories(dir.resolve("conf"))
    Files.writeString(dir.resolve("conf/sonar.properties"), "leveret.log.level=TRACE")
    val settings = SettingsLoader({ dir }, emptyMap(), emptyMap(), {}).load(emptyArray())
    assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
  }
}
```

```kotlin
package com.leveret.inspect.runtime.config

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class CommandLineParserTest {
  @Test
  fun `parses well formed definitions`() {
    assertThat(CommandLineParser.parse(arrayOf("-Da=1", "-Db=x=y")))
      .containsExactlyInAnyOrderEntriesOf(mapOf("a" to "1", "b" to "x=y"))
  }

  @Test
  fun `rejects malformed arguments`() {
    listOf("a=1", "-Da", "-D=1", "").forEach { arg ->
      assertThatThrownBy { CommandLineParser.parse(arrayOf(arg)) }
        .isInstanceOf(IllegalArgumentException::class.java)
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*config*'`
Expected: FAIL — unresolved references `SettingsLoader`, `PropertyKeys`, `CommandLineParser`.

- [ ] **Step 3: Write minimal implementation**

`PropertyKeys` holds the canonical names, the default map, `canonical(key)` (rewrites a leading `sonar.` to `leveret.`), and `envName(key)` (uppercase, dots and dashes to underscores). Defaults:

```kotlin
val defaults: Map<String, String> = mapOf(
  PATH_DATA to "data",
  PATH_LOGS to "logs",
  PATH_TEMP to "temp",
  PATH_WEB to "web",
  LOG_LEVEL to "INFO",
  LOG_CONSOLE to "false",
  LOG_JSON to "false",
  LOG_ROLLING_POLICY to "time:yyyy-MM-dd",
  LOG_MAX_FILES to "7",
  SEARCH_HOST to "127.0.0.1",
  SEARCH_PORT to "9001",
  javaOpts(ProcessId.SEARCH) to "-Xmx512m -Xms512m -XX:MaxDirectMemorySize=256m -XX:+HeapDumpOnOutOfMemoryError",
  javaOpts(ProcessId.WEB) to "-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError",
  javaOpts(ProcessId.COMPUTE) to "-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError",
  javaAdditionalOpts(ProcessId.SEARCH) to "",
  javaAdditionalOpts(ProcessId.WEB) to "",
  javaAdditionalOpts(ProcessId.COMPUTE) to "",
  gracefulStopTimeout(ProcessId.WEB) to "240000",
  gracefulStopTimeout(ProcessId.COMPUTE) to "21600000",
)
```

`SettingsLoader.load` performs, in order: read the base file (canonical name, else legacy name; missing produces `warn` and an empty map; an existing unreadable path throws `IllegalStateException`); canonicalize and conflict-check every file key; overlay environment values for eligible keys (a key is eligible when it is declared in `defaults` or present in the file), accepting both canonical and legacy environment names; overlay parsed arguments; overlay system properties whose names start with either prefix; set `PATH_HOME` to the absolute home; finally fill absent keys from `defaults`. Conflict checking applies per source: when both a canonical key and its alias appear in the same source with unequal values, keep the canonical value and call `warn` with both names.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*config*'`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/config runtime/src/test/kotlin/com/leveret/inspect/runtime/config
git commit -m "feat: add settings loading with alias resolution and precedence"
```

---

### Task 4: Runtime filesystem

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/fs/RuntimeFileSystem.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/fs/RuntimeFileSystemTest.kt`

**Interfaces:**
- Consumes: `Settings`, `PropertyKeys`.
- Produces:
  - `class RuntimeFileSystem(settings: Settings)` with `val home: Path`, `val dataDir: Path`, `val logsDir: Path`, `val tempDir: Path`, `val webDir: Path`, `fun reset()`, and `fun cleanTempDir(retain: Set<Path>)`.
  - `reset()` creates every directory when absent, throws `IllegalStateException` when a configured path exists as a non-directory or cannot be created, and cleans the temporary directory one level deep.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime.fs

import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class RuntimeFileSystemTest {
  private fun settings(home: Path, extra: Map<String, String> = emptyMap()) = Settings(
    mapOf(
      "leveret.path.home" to home.toString(),
      "leveret.path.data" to "data",
      "leveret.path.logs" to "logs",
      "leveret.path.temp" to "temp",
      "leveret.path.web" to "web",
    ) + extra,
  )

  @Test
  fun `creates directories and resolves relative paths against home`(@TempDir home: Path) {
    val fs = RuntimeFileSystem(settings(home))
    fs.reset()
    assertThat(fs.dataDir).isEqualTo(home.resolve("data")).isDirectory()
    assertThat(fs.tempDir).isEqualTo(home.resolve("temp")).isDirectory()
    assertThat(fs.tempDir.isAbsolute).isTrue()
  }

  @Test
  fun `absolute configured path is honoured`(@TempDir home: Path, @TempDir other: Path) {
    val fs = RuntimeFileSystem(settings(home, mapOf("leveret.path.data" to other.resolve("d").toString())))
    fs.reset()
    assertThat(fs.dataDir).isEqualTo(other.resolve("d")).isDirectory()
  }

  @Test
  fun `existing non directory path aborts`(@TempDir home: Path) {
    Files.writeString(home.resolve("data"), "file")
    assertThatThrownBy { RuntimeFileSystem(settings(home)).reset() }
      .isInstanceOf(IllegalStateException::class.java)
  }

  @Test
  fun `temp is cleaned one level while data and logs survive`(@TempDir home: Path) {
    val fs = RuntimeFileSystem(settings(home))
    fs.reset()
    Files.writeString(fs.dataDir.resolve("keep.db"), "x")
    Files.writeString(fs.logsDir.resolve("keep.log"), "x")
    Files.writeString(fs.tempDir.resolve("stale.properties"), "x")
    Files.createDirectories(fs.tempDir.resolve("nested/deeper"))
    Files.writeString(fs.tempDir.resolve("nested/deeper/x"), "x")
    val retained = fs.tempDir.resolve("sharedmemory")
    Files.writeString(retained, "x")

    fs.cleanTempDir(retain = setOf(retained))

    assertThat(fs.dataDir.resolve("keep.db")).exists()
    assertThat(fs.logsDir.resolve("keep.log")).exists()
    assertThat(fs.tempDir.resolve("stale.properties")).doesNotExist()
    assertThat(fs.tempDir.resolve("nested")).doesNotExist()
    assertThat(retained).exists()
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test --tests '*RuntimeFileSystemTest'`
Expected: FAIL — unresolved reference `RuntimeFileSystem`.

- [ ] **Step 3: Write minimal implementation**

Resolve each directory property against `home`, normalize to absolute. `reset()` validates and creates each directory, then calls `cleanTempDir(emptySet())`. `cleanTempDir(retain)` walks the immediate children of `tempDir`, skipping retained paths, deleting files directly and directories recursively. Any input-output failure becomes `IllegalStateException` naming the path.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test --tests '*RuntimeFileSystemTest'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/fs runtime/src/test/kotlin/com/leveret/inspect/runtime/fs
git commit -m "feat: add runtime filesystem preparation and temp cleaning"
```

---

### Task 5: Command file and process command views

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/ipc/CommandFile.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/ipc/ProcessCommands.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/ipc/CommandFileTest.kt`

**Interfaces:**
- Consumes: `ProcessId.MAX_PROCESSES`.
- Produces:
  - `class CommandFile(directory: Path) : AutoCloseable` with `companion object { const val FILE_NAME = "sharedmemory"; const val SLOT_SIZE = 513; const val MAX_URL_BYTES = 500 }`, `fun clearAll()`, `fun view(index: Int): ProcessCommands` (rejects index outside 0 until `ProcessId.MAX_PROCESSES`), `fun mainView(index: Int): ProcessCommands` (clears that slot first), `override fun close()`.
  - `interface ProcessCommands` with `var up: Boolean`, `var operational: Boolean`, `var askedForStop: Boolean`, `var askedForHardStop: Boolean`, `var askedForRestart: Boolean`, `fun acknowledgeRestart()`, `var systemInfoUrl: String?`, `fun ping(): Long`, `fun clear()`.
  - Flag byte offsets within a slot: 0 `up`, 1 hard stop, 2 graceful stop, 3 restart, 4 operational; ping occupies bytes 5 through 12; URL occupies bytes 13 through 512 as ASCII, zero-padded, empty meaning absent.
  - `systemInfoUrl` setter throws `IllegalArgumentException` when the encoded value exceeds `MAX_URL_BYTES`.
  - `acknowledgeRestart()` clears the restart flag; the requester keeps its request set until it observes the cleared flag.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime.ipc

import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CommandFileTest {
  @Test
  fun `file layout reserves one slot per process`(@TempDir dir: Path) {
    CommandFile(dir).use { it.clearAll() }
    assertThat(Files.size(dir.resolve(CommandFile.FILE_NAME)))
      .isEqualTo((CommandFile.SLOT_SIZE * ProcessId.MAX_PROCESSES).toLong())
  }

  @Test
  fun `flags and url round trip per slot without bleeding`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      val web = file.view(ProcessId.WEB.index)
      val compute = file.view(ProcessId.COMPUTE.index)
      web.up = true
      web.operational = true
      web.systemInfoUrl = "http://127.0.0.1:9000/api/system/info"

      assertThat(web.up).isTrue()
      assertThat(web.operational).isTrue()
      assertThat(web.systemInfoUrl).isEqualTo("http://127.0.0.1:9000/api/system/info")
      assertThat(compute.up).isFalse()
      assertThat(compute.operational).isFalse()
      assertThat(compute.systemInfoUrl).isNull()
    }
  }

  @Test
  fun `restart request survives until acknowledged`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      val child = file.view(ProcessId.CE_INDEX_FOR_TEST)
      child.askedForRestart = true
      assertThat(child.askedForRestart).isTrue()
      file.view(ProcessId.CE_INDEX_FOR_TEST).acknowledgeRestart()
      assertThat(child.askedForRestart).isFalse()
    }
  }

  @Test
  fun `oversized url is rejected`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      assertThatThrownBy { file.view(0).systemInfoUrl = "u".repeat(CommandFile.MAX_URL_BYTES + 1) }
        .isInstanceOf(IllegalArgumentException::class.java)
    }
  }

  @Test
  fun `index outside reserved range is rejected`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      assertThat(file.view(4)).isNotNull()
      assertThatThrownBy { file.view(5) }.isInstanceOf(IllegalArgumentException::class.java)
      assertThatThrownBy { file.view(-1) }.isInstanceOf(IllegalArgumentException::class.java)
    }
  }

  @Test
  fun `clearAll and mainView drop stale state`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      file.view(ProcessId.WEB.index).apply { up = true; operational = true }
    }
    CommandFile(dir).use { file ->
      assertThat(file.view(ProcessId.WEB.index).up).isTrue()
      file.clearAll()
      assertThat(file.view(ProcessId.WEB.index).up).isFalse()

      file.view(ProcessId.COMPUTE.index).operational = true
      assertThat(file.mainView(ProcessId.COMPUTE.index).operational).isFalse()
    }
  }
}
```

Replace `ProcessId.CE_INDEX_FOR_TEST` with `ProcessId.COMPUTE.index`; it is written here only to flag that the test must use the compute slot.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test --tests '*CommandFileTest'`
Expected: FAIL — unresolved reference `CommandFile`.

- [ ] **Step 3: Write minimal implementation**

Open the file with `FileChannel.open(path, CREATE, READ, WRITE)`, map `SLOT_SIZE * ProcessId.MAX_PROCESSES` bytes as a single `MappedByteBuffer`, and back each view with an absolute offset into that buffer. Flag writes store 1 or 0. The ping field stores `System.currentTimeMillis()` on `ping()` and returns the stored value. URL writes encode US-ASCII, zero-fill the remainder, and reject oversized input before writing. `close()` closes the channel; the mapping is released by the garbage collector.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test --tests '*CommandFileTest'`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/ipc runtime/src/test/kotlin/com/leveret/inspect/runtime/ipc
git commit -m "feat: add memory mapped command file"
```

---

### Task 6: Lifecycle state machines

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise/NodeLifecycle.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ChildLifecycle.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise/NodeLifecycleTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/ChildLifecycleTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class NodeLifecycle` with `enum class State { INIT, STARTING, OPERATIONAL, RESTARTING, STOPPING, HARD_STOPPING, FINALIZE_STOPPING, STOPPED }`, `val state: State`, `fun tryToMoveTo(target: State): Boolean`.
  - `class ChildLifecycle` with `enum class State { INIT, STARTING, STARTED, OPERATIONAL, STOPPING, HARD_STOPPING, FINALIZE_STOPPING, STOPPED }`, `val state: State`, `fun tryToMoveTo(target: State): Boolean`.
  - Both are synchronized; a rejected transition returns `false` and leaves state unchanged.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.supervise.NodeLifecycle.State
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class NodeLifecycleTest {
  @Test
  fun `follows the specified transition table`() {
    val node = NodeLifecycle()
    assertThat(node.state).isEqualTo(State.INIT)
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(node.tryToMoveTo(State.STARTING)).isTrue()
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isTrue()
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(node.tryToMoveTo(State.STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.HARD_STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.FINALIZE_STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.STOPPED)).isTrue()
    assertThat(node.tryToMoveTo(State.STARTING)).isFalse()
  }

  @Test
  fun `restarting returns to starting`() {
    val node = NodeLifecycle()
    node.tryToMoveTo(State.STARTING)
    node.tryToMoveTo(State.OPERATIONAL)
    assertThat(node.tryToMoveTo(State.RESTARTING)).isTrue()
    assertThat(node.tryToMoveTo(State.STARTING)).isTrue()
  }

  @Test
  fun `stopping cannot skip finalize`() {
    val node = NodeLifecycle()
    node.tryToMoveTo(State.STARTING)
    node.tryToMoveTo(State.STOPPING)
    assertThat(node.tryToMoveTo(State.STOPPED)).isFalse()
  }
}
```

```kotlin
package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.proc.ChildLifecycle.State
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ChildLifecycleTest {
  @Test
  fun `started precedes operational and stop is terminal`() {
    val child = ChildLifecycle()
    assertThat(child.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(child.tryToMoveTo(State.STARTING)).isTrue()
    assertThat(child.tryToMoveTo(State.STARTED)).isTrue()
    assertThat(child.tryToMoveTo(State.OPERATIONAL)).isTrue()
    assertThat(child.tryToMoveTo(State.STOPPING)).isTrue()
    assertThat(child.tryToMoveTo(State.FINALIZE_STOPPING)).isTrue()
    assertThat(child.tryToMoveTo(State.STOPPED)).isTrue()
    assertThat(child.tryToMoveTo(State.STARTING)).isFalse()
  }

  @Test
  fun `hard stopping is reachable from every live state`() {
    listOf(State.STARTING, State.STARTED, State.OPERATIONAL, State.STOPPING).forEach { from ->
      val child = ChildLifecycle()
      val path = listOf(State.STARTING, State.STARTED, State.OPERATIONAL, State.STOPPING)
      for (step in path) {
        child.tryToMoveTo(step)
        if (step == from) break
      }
      assertThat(child.tryToMoveTo(State.HARD_STOPPING)).isTrue()
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*LifecycleTest'`
Expected: FAIL — unresolved references.

- [ ] **Step 3: Write minimal implementation**

Each class holds an `EnumMap<State, Set<State>>` transition table and a `synchronized` `tryToMoveTo` that returns `false` when the target is absent from the current state's set. Node table exactly as the Global Constraints and design section 8 list. Child table: `INIT` to `STARTING`; `STARTING` to `STARTED`, `STOPPING`, `HARD_STOPPING`, `FINALIZE_STOPPING`; `STARTED` to `OPERATIONAL`, `STOPPING`, `HARD_STOPPING`, `FINALIZE_STOPPING`; `OPERATIONAL` to `STOPPING`, `HARD_STOPPING`, `FINALIZE_STOPPING`; `STOPPING` to `HARD_STOPPING`, `FINALIZE_STOPPING`; `HARD_STOPPING` to `FINALIZE_STOPPING`; `FINALIZE_STOPPING` to `STOPPED`; `STOPPED` terminal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*LifecycleTest'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise/NodeLifecycle.kt runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ChildLifecycle.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise/NodeLifecycleTest.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/ChildLifecycleTest.kt
git commit -m "feat: add node and child lifecycle state machines"
```

---

### Task 7: JVM options and command construction

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/JvmOptions.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/CommandFactory.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/JvmOptionsTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/CommandFactoryTest.kt`

**Interfaces:**
- Consumes: `Settings`, `PropertyKeys`, `ProcessId`, `RuntimeFileSystem`.
- Produces:
  - `class JvmOptions(private val mandatory: Map<String, String>)` with `fun addFromSettings(settings: Settings, id: ProcessId): JvmOptions`, `fun add(option: String): JvmOptions`, `fun toList(): List<String>`. Rejects an empty option, an option not starting with `-`, and any option that assigns a different value to a mandatory property prefix; accepts an exact restatement of a mandatory option. Exact duplicates collapse, insertion order preserved, mandatory options first.
  - `data class ChildCommand(val id: ProcessId, val arguments: List<String>, val environmentAdditions: Map<String, String>, val suppressedEnvironment: Set<String>, val settingsFile: Path?)`.
  - `class CommandFactory(private val settings: Settings, private val fs: RuntimeFileSystem, private val javaExecutable: String)` with `fun createFor(id: ProcessId, mainClass: String, classpath: String): ChildCommand`.
  - `createFor` writes the effective settings to a temporary properties file for web and compute, adding the internal keys `process.key`, `process.index`, `process.gracefulStopTimeout` (configured value plus 30000), `process.sharedDir`; suppresses the search external-options variable and generic JVM tool options; propagates system proxy properties unless the process option list already sets the same property name.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.config.Settings
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class JvmOptionsTest {
  private val mandatory = mapOf("-Dfile.encoding=" to "UTF-8", "-Djava.awt.headless=" to "true")

  @Test
  fun `mandatory options come first and duplicates collapse`() {
    val options = JvmOptions(mandatory).add("-Xmx512m").add("-Xmx512m").toList()
    assertThat(options).startsWith("-Dfile.encoding=UTF-8", "-Djava.awt.headless=true")
    assertThat(options.filter { it == "-Xmx512m" }).hasSize(1)
  }

  @Test
  fun `invalid options are rejected`() {
    listOf("", " ", "Xmx512m").forEach { bad ->
      assertThatThrownBy { JvmOptions(mandatory).add(bad) }.isInstanceOf(IllegalArgumentException::class.java)
    }
  }

  @Test
  fun `mandatory option cannot be overridden but may be restated`() {
    assertThatThrownBy { JvmOptions(mandatory).add("-Dfile.encoding=ISO-8859-1") }
      .isInstanceOf(IllegalArgumentException::class.java)
    assertThat(JvmOptions(mandatory).add("-Dfile.encoding=UTF-8").toList())
      .containsOnlyOnce("-Dfile.encoding=UTF-8")
  }

  @Test
  fun `settings supply primary and additional options in order`() {
    val settings = Settings(
      mapOf(
        "leveret.web.javaOpts" to "-Xmx512m -Xms128m",
        "leveret.web.javaAdditionalOpts" to "-XX:+UseG1GC",
      ),
    )
    assertThat(JvmOptions(mandatory).addFromSettings(settings, ProcessId.WEB).toList())
      .containsSubsequence("-Xmx512m", "-Xms128m", "-XX:+UseG1GC")
  }
}
```

```kotlin
package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CommandFactoryTest {
  private fun fs(home: Path): RuntimeFileSystem {
    val settings = Settings(
      mapOf(
        "leveret.path.home" to home.toString(),
        "leveret.path.data" to "data",
        "leveret.path.logs" to "logs",
        "leveret.path.temp" to "temp",
        "leveret.path.web" to "web",
      ),
    )
    return RuntimeFileSystem(settings).also { it.reset() }
  }

  @Test
  fun `child receives settings handoff file with internal keys`(@TempDir home: Path) {
    val fileSystem = fs(home)
    val settings = Settings(
      mapOf(
        "leveret.path.home" to home.toString(),
        "leveret.path.data" to "data",
        "leveret.path.logs" to "logs",
        "leveret.path.temp" to "temp",
        "leveret.path.web" to "web",
        "leveret.web.gracefulStopTimeOutInMs" to "240000",
      ),
    )
    val command = CommandFactory(settings, fileSystem, "java")
      .createFor(ProcessId.WEB, "com.example.Main", "app.jar")

    assertThat(command.arguments.first()).isEqualTo("java")
    assertThat(command.arguments).contains("com.example.Main")
    val handoff = requireNotNull(command.settingsFile)
    assertThat(handoff).exists().hasParent(fileSystem.tempDir)
    val loaded = Properties().apply { Files.newInputStream(handoff).use { load(it) } }
    assertThat(loaded.getProperty("process.key")).isEqualTo("web")
    assertThat(loaded.getProperty("process.index")).isEqualTo("2")
    assertThat(loaded.getProperty("process.gracefulStopTimeout")).isEqualTo("270000")
    assertThat(loaded.getProperty("process.sharedDir")).isEqualTo(fileSystem.tempDir.toString())
  }

  @Test
  fun `search command suppresses external options variable`(@TempDir home: Path) {
    val fileSystem = fs(home)
    val settings = Settings(mapOf("leveret.path.home" to home.toString(), "leveret.path.temp" to "temp"))
    val command = CommandFactory(settings, fileSystem, "java")
      .createFor(ProcessId.SEARCH, "com.example.Search", "search.jar")
    assertThat(command.suppressedEnvironment).contains("ES_JAVA_OPTS")
  }

  @Test
  fun `web command suppresses generic jvm tool options`(@TempDir home: Path) {
    val fileSystem = fs(home)
    val settings = Settings(mapOf("leveret.path.home" to home.toString(), "leveret.path.temp" to "temp"))
    val command = CommandFactory(settings, fileSystem, "java")
      .createFor(ProcessId.WEB, "com.example.Main", "app.jar")
    assertThat(command.suppressedEnvironment).contains("JAVA_TOOL_OPTIONS")
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*JvmOptionsTest' --tests '*CommandFactoryTest'`
Expected: FAIL — unresolved references `JvmOptions`, `CommandFactory`.

- [ ] **Step 3: Write minimal implementation**

`JvmOptions` keeps a `LinkedHashSet<String>` seeded with the rendered mandatory options. `add` validates, then checks each mandatory prefix: if the candidate starts with that prefix and does not equal the mandatory rendering, throw. `addFromSettings` splits the primary and additional option strings on whitespace and adds each.

`CommandFactory.createFor` builds mandatory options per process — UTF-8 encoding, headless mode, the temporary directory system property, and required module access — then process options from settings. For web and compute it writes the handoff properties file into the temporary directory using `Files.createTempFile(tempDir, id.key + "-", ".properties")` and passes its path as the child argument after the main class. Search receives no handoff file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*JvmOptionsTest' --tests '*CommandFactoryTest'`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/JvmOptions.kt runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/CommandFactory.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/JvmOptionsTest.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/CommandFactoryTest.kt
git commit -m "feat: add jvm option validation and child command construction"
```

---

### Task 8: Logging configuration

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/log/LogConfig.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/log/JsonLayout.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/log/PlainLayout.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/log/LogConfigTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/log/JsonLayoutTest.kt`

**Interfaces:**
- Consumes: `Settings`, `PropertyKeys`, `ProcessId`, `RuntimeFileSystem`.
- Produces:
  - `object LogConfig` with `fun levelFor(settings: Settings, id: ProcessId): Level` (per-process key beats global, default `INFO`, unsupported value throws `IllegalArgumentException`), `fun rollingPolicy(settings: Settings): RollingPolicy` and `fun configure(settings: Settings, fs: RuntimeFileSystem, id: ProcessId)`.
  - `sealed interface RollingPolicy { data class Time(val datePattern: String, val maxFiles: Int); data class Size(val maxFileSize: String, val maxFiles: Int); data object None }`, parsed from `time:`, `size:`, `none`; any other form throws `IllegalArgumentException`.
  - `class JsonLayout(private val processKey: String, private val nodeName: String?)` with `fun render(event: ILoggingEvent): String` producing one terminated record with fields `nodename` when present, `process`, non-excluded diagnostic-context entries, `timestamp`, `severity`, `logger`, `message`, and `stacktrace` as an array when a throwable exists; newlines in the message are normalized to spaces.
  - `class PlainLayout(private val processKey: String, private val nodeName: String?)` with the same `render` signature, emitting timestamp, severity, optional node name, process key, thread identity, shortened logger name, and message.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.log

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.proc.ProcessId
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class LogConfigTest {
  @Test
  fun `process level beats global level`() {
    val settings = Settings(mapOf("leveret.log.level" to "DEBUG", "leveret.log.level.web" to "TRACE"))
    assertThat(LogConfig.levelFor(settings, ProcessId.WEB).toString()).isEqualTo("TRACE")
    assertThat(LogConfig.levelFor(settings, ProcessId.COMPUTE).toString()).isEqualTo("DEBUG")
    assertThat(LogConfig.levelFor(Settings(emptyMap()), ProcessId.APP).toString()).isEqualTo("INFO")
  }

  @Test
  fun `unsupported level fails configuration`() {
    assertThatThrownBy { LogConfig.levelFor(Settings(mapOf("leveret.log.level" to "WARN")), ProcessId.APP) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }

  @Test
  fun `rolling policies parse with defaults`() {
    assertThat(LogConfig.rollingPolicy(Settings(emptyMap())))
      .isEqualTo(RollingPolicy.Time("yyyy-MM-dd", 7))
    assertThat(LogConfig.rollingPolicy(Settings(mapOf("leveret.log.rollingPolicy" to "size:50MB", "leveret.log.maxFiles" to "3"))))
      .isEqualTo(RollingPolicy.Size("50MB", 3))
    assertThat(LogConfig.rollingPolicy(Settings(mapOf("leveret.log.rollingPolicy" to "none"))))
      .isEqualTo(RollingPolicy.None)
    assertThatThrownBy { LogConfig.rollingPolicy(Settings(mapOf("leveret.log.rollingPolicy" to "weekly"))) }
      .isInstanceOf(IllegalArgumentException::class.java)
  }
}
```

```kotlin
package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.LoggingEvent
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class JsonLayoutTest {
  private fun event(message: String, throwable: Throwable? = null): LoggingEvent {
    val context = LoggerContext()
    val logger = context.getLogger("com.leveret.inspect.runtime.Example")
    return LoggingEvent("m", logger, Level.INFO, message, throwable, emptyArray())
  }

  @Test
  fun `json record carries the specified fields on one line`() {
    val rendered = JsonLayout("web", nodeName = null).render(event("started\nsecond line"))
    assertThat(rendered.trimEnd()).doesNotContain("\n")
    assertThat(rendered).contains("\"process\":\"web\"")
      .contains("\"severity\":\"INFO\"")
      .contains("\"logger\":\"com.leveret.inspect.runtime.Example\"")
      .contains("\"timestamp\":")
      .contains("started second line")
      .doesNotContain("\"nodename\"")
      .doesNotContain("\"stacktrace\"")
  }

  @Test
  fun `node name and stacktrace appear when present`() {
    val rendered = JsonLayout("ce", nodeName = "node-1").render(event("boom", IllegalStateException("bad")))
    assertThat(rendered).contains("\"nodename\":\"node-1\"")
      .contains("\"stacktrace\":[")
      .contains("IllegalStateException")
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*log*'`
Expected: FAIL — unresolved references `LogConfig`, `RollingPolicy`, `JsonLayout`.

- [ ] **Step 3: Write minimal implementation**

`LogConfig.levelFor` reads the per-process key then the global key, maps `INFO`, `DEBUG`, `TRACE` to Logback levels and throws otherwise. `rollingPolicy` parses the prefix before the first colon. `configure` builds a `LoggerContext`, attaches one file appender targeting `fs.logsDir.resolve(id.logFileName)` with the selected layout and policy, sets the root level, and adds a console appender for the monitor when console logging is enabled. Layouts render fields by hand; the JSON writer escapes quotes, backslashes, and control characters and replaces newlines in the message with spaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*log*'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/log runtime/src/test/kotlin/com/leveret/inspect/runtime/log
git commit -m "feat: add process log configuration and layouts"
```

---

### Task 9: Child entry point

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/ChildEntryPoint.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/ChildEntryPointTest.kt`

**Interfaces:**
- Consumes: `CommandFile`, `ProcessCommands`, `ChildLifecycle`, `Settings`, `ProcessId`.
- Produces:
  - `interface MonitoredComponent { fun start(); fun isUp(): Boolean; fun isOperational(): Boolean; fun stop(); fun hardStop() }`.
  - `class ChildEntryPoint(private val settings: Settings, private val commands: ProcessCommands, private val component: MonitoredComponent)` with `fun launch()`, `companion object { fun fromHandoffFile(path: Path): ChildEntryPoint }` reading `process.key`, `process.index`, `process.gracefulStopTimeout`, `process.sharedDir`.
  - `launch()` starts the component, publishes `up` once the component is no longer down, publishes `operational` once the component reports operational, then polls the command slot every 500 ms; on a graceful-stop flag it calls `stop()` within the handoff timeout, on a hard-stop flag it calls `hardStop()` with a one-second deadline, and returns after the component halts.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ChildEntryPointTest {
  private class FakeComponent : MonitoredComponent {
    val started = AtomicBoolean(false)
    val operationalNow = AtomicBoolean(false)
    val stopped = CountDownLatch(1)
    val hardStopped = AtomicBoolean(false)
    override fun start() { started.set(true) }
    override fun isUp() = started.get()
    override fun isOperational() = operationalNow.get()
    override fun stop() { stopped.countDown() }
    override fun hardStop() { hardStopped.set(true); stopped.countDown() }
  }

  @Test
  fun `publishes up then operational and stops on command`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      val commands = file.mainView(ProcessId.WEB.index)
      val component = FakeComponent()
      val entryPoint = ChildEntryPoint(
        Settings(mapOf("process.gracefulStopTimeout" to "5000")),
        commands,
        component,
      )
      val thread = Thread { entryPoint.launch() }.apply { isDaemon = true; start() }

      await().atMost(5, TimeUnit.SECONDS).untilAsserted {
        assertThat(commands.up).isTrue()
        assertThat(commands.operational).isFalse()
      }
      component.operationalNow.set(true)
      await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(commands.operational).isTrue() }

      commands.askedForStop = true
      assertThat(component.stopped.await(5, TimeUnit.SECONDS)).isTrue()
      thread.join(5_000)
      assertThat(component.hardStopped).isFalse()
    }
  }

  @Test
  fun `hard stop command bypasses graceful stop`(@TempDir dir: Path) {
    CommandFile(dir).use { file ->
      val commands = file.mainView(ProcessId.COMPUTE.index)
      val component = FakeComponent()
      val thread = Thread {
        ChildEntryPoint(Settings(mapOf("process.gracefulStopTimeout" to "5000")), commands, component).launch()
      }.apply { isDaemon = true; start() }

      await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(commands.up).isTrue() }
      commands.askedForHardStop = true
      assertThat(component.stopped.await(5, TimeUnit.SECONDS)).isTrue()
      assertThat(component.hardStopped).isTrue()
      thread.join(5_000)
    }
  }
}
```

Add `testImplementation("org.awaitility:awaitility:4.2.2")` to `runtime/build.gradle.kts` and a matching `awaitility` entry in `gradle/libs.versions.toml` as part of this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test --tests '*ChildEntryPointTest'`
Expected: FAIL — unresolved references `ChildEntryPoint`, `MonitoredComponent`.

- [ ] **Step 3: Write minimal implementation**

`launch()` calls `component.start()`, then loops at 500 ms: set `up` once when `isUp()` first returns true; set `operational` once when `isOperational()` first returns true; check `askedForHardStop` first, then `askedForStop`. Graceful stop runs `component.stop()` on the calling thread bounded by the handoff timeout; exceeding it escalates to `hardStop()`. Hard stop runs `component.hardStop()` with a one-second bound. Return once the component has halted.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test --tests '*ChildEntryPointTest'`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/ChildEntryPoint.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/ChildEntryPointTest.kt runtime/build.gradle.kts gradle/libs.versions.toml
git commit -m "feat: add reusable child entry point"
```

---

### Task 10: Launcher, output draining, and readiness probes

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ProcessLauncher.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/StreamDrain.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/SearchHealth.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/proc/ChildHandler.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/ProcessLauncherTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/proc/SearchHealthTest.kt`

**Interfaces:**
- Consumes: `ChildCommand`, `CommandFile`, `ChildLifecycle`, `Settings`.
- Produces:
  - `interface ManagedProcess { val id: ProcessId; fun start(); fun isAlive(): Boolean; fun isOperational(): Boolean; fun askForStop(); fun askForHardStop(); fun waitForStop(timeout: Duration): Boolean; fun destroyForcibly(); val exitCode: Int? }`.
  - `class ProcessLauncher(private val consoleOutput: Boolean, private val logLine: (ProcessId, String) -> Unit)` with `fun launch(command: ChildCommand): Process`, merging standard error into standard output and draining output on a daemon thread; drain failures are suppressed.
  - `interface SearchHealth { fun status(): Status }` and `enum class Status { GREEN, YELLOW, RED, UNAVAILABLE }`; `class HttpSearchHealth(private val host: String, private val port: Int, private val retryDelay: Duration = Duration.ofMillis(100), private val maxAttempts: Int = 600) : SearchHealth`, retrying only connection refusal, treating GREEN and YELLOW as operational.
  - `class ChildHandler(val id: ProcessId, private val process: ManagedProcess, private val pollInterval: Duration = Duration.ofMillis(500), private val onOperational: (ProcessId) -> Unit, private val onUnexpectedExit: (ProcessId) -> Unit)` with `val lifecycle: ChildLifecycle`, `fun start()`, `fun awaitOperational(timeout: Duration): Boolean`, `fun stopGracefully(timeout: Duration): Boolean`, `fun hardStop(timeout: Duration)`, `fun finalizeStop()`. `onOperational` fires exactly once per child.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.proc

import java.nio.file.Path
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ProcessLauncherTest {
  @Test
  fun `merges child output and drains both streams`(@TempDir dir: Path) {
    val lines = ConcurrentLinkedQueue<String>()
    val script = dir.resolve("emit.sh")
    java.nio.file.Files.writeString(script, "echo out-line\n>&2 echo err-line\n")
    script.toFile().setExecutable(true)

    val command = ChildCommand(
      id = ProcessId.WEB,
      arguments = listOf("/bin/sh", script.toString()),
      environmentAdditions = emptyMap(),
      suppressedEnvironment = emptySet(),
      settingsFile = null,
    )
    val process = ProcessLauncher(consoleOutput = false) { _, line -> lines.add(line) }.launch(command)
    assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue()
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(lines).contains("out-line", "err-line")
    }
  }

  @Test
  fun `suppressed environment entries are removed from the child`(@TempDir dir: Path) {
    val lines = ConcurrentLinkedQueue<String>()
    val script = dir.resolve("env.sh")
    java.nio.file.Files.writeString(script, "echo \"seen=[\$JAVA_TOOL_OPTIONS]\"\n")
    script.toFile().setExecutable(true)

    val command = ChildCommand(
      id = ProcessId.WEB,
      arguments = listOf("/bin/sh", script.toString()),
      environmentAdditions = mapOf("JAVA_TOOL_OPTIONS" to "-verbose"),
      suppressedEnvironment = setOf("JAVA_TOOL_OPTIONS"),
      settingsFile = null,
    )
    val process = ProcessLauncher(consoleOutput = false) { _, line -> lines.add(line) }.launch(command)
    assertThat(process.waitFor(10, TimeUnit.SECONDS)).isTrue()
    await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(lines).contains("seen=[]") }
  }
}
```

```kotlin
package com.leveret.inspect.runtime.proc

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Duration
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class SearchHealthTest {
  private fun server(body: String): HttpServer =
    HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
      createContext("/") { exchange ->
        val bytes = body.toByteArray()
        exchange.sendResponseHeaders(200, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
      }
      start()
    }

  @Test
  fun `yellow and green are operational, red is not`() {
    listOf("yellow" to SearchHealth.Status.YELLOW, "green" to SearchHealth.Status.GREEN, "red" to SearchHealth.Status.RED)
      .forEach { (reported, expected) ->
        val http = server("""{"status":"$reported"}""")
        try {
          val health = HttpSearchHealth("127.0.0.1", http.address.port, Duration.ofMillis(1), 2)
          assertThat(health.status()).isEqualTo(expected)
        } finally {
          http.stop(0)
        }
      }
  }

  @Test
  fun `refused connection is retried then reported unavailable`() {
    val closed = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val port = closed.address.port
    closed.stop(0)
    val health = HttpSearchHealth("127.0.0.1", port, Duration.ofMillis(1), 3)
    assertThat(health.status()).isEqualTo(SearchHealth.Status.UNAVAILABLE)
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*ProcessLauncherTest' --tests '*SearchHealthTest'`
Expected: FAIL — unresolved references.

- [ ] **Step 3: Write minimal implementation**

`ProcessLauncher.launch` builds a `ProcessBuilder`, applies `environmentAdditions`, removes `suppressedEnvironment`, calls `redirectErrorStream(true)`, starts the process, and reads its merged output on a daemon thread that forwards each line to `logLine` and, when `consoleOutput` is set, to standard output. All drain exceptions are caught and discarded.

`HttpSearchHealth.status()` issues a `GET` to the cluster health path on the configured host and port using `java.net.http.HttpClient`, maps the reported colour, retries only `ConnectException` at the configured delay up to the configured attempts, and returns `UNAVAILABLE` when attempts are exhausted or the response cannot be interpreted.

`ChildHandler` owns a `ChildLifecycle`, installs a watcher thread that observes process exit and calls `onUnexpectedExit` when no stop is in progress, and polls readiness at `pollInterval`, firing `onOperational` exactly once. Search children use the `SearchHealth`-backed `ManagedProcess`; web and compute children use the command-slot-backed one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*ProcessLauncherTest' --tests '*SearchHealthTest'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/proc runtime/src/test/kotlin/com/leveret/inspect/runtime/proc
git commit -m "feat: add child launcher, output draining, and readiness probes"
```

---

### Task 11: Scheduler, reload, and stop escalation

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise/Scheduler.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise/Reloader.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise/StopWatchers.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise/SchedulerTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise/ReloaderTest.kt`

**Interfaces:**
- Consumes: `ChildHandler`, `ManagedProcess`, `NodeLifecycle`, `Settings`, `SettingsLoader`, `ProcessCommands`.
- Produces:
  - `class Scheduler(private val settings: Settings, private val children: Map<ProcessId, ChildHandler>, private val monitorCommands: ProcessCommands, private val reloader: Reloader, private val clock: Clock = Clock.systemUTC())` with `val lifecycle: NodeLifecycle`, `fun schedule()`, `fun awaitTermination()`, `fun stop()`, `fun hardStop()`, `fun requestRestart()`, `fun enabledProcesses(): List<ProcessId>`, `val startOrder: List<ProcessId>` = search, web, compute, `val stopOrder: List<ProcessId>` = compute, web, search.
  - `class Reloader(private val loader: SettingsLoader)` with `fun reload(current: Settings, args: Array<String>): Settings`, throwing `IllegalStateException` naming the offending key when any of `leveret.path.data`, `leveret.path.web`, `leveret.path.logs`, `leveret.path.temp` changed.
  - `class StopWatchers(private val monitorCommands: ProcessCommands, private val scheduler: Scheduler, private val stopCommandEnabled: Boolean)` with `fun start()`, `fun stop()`, and a registered shutdown hook that stops the watchers and performs a blocking graceful node stop.
  - Gating rules: web is scheduled only after search is operational; compute only after web and search are operational; an unexpected child exit with no stop or restart in progress hard-stops every remaining child; the node reaches `OPERATIONAL` only after every enabled child has emitted its operational event.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.proc.ProcessId
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test

class SchedulerTest {
  @Test
  fun `web waits for search and compute waits for both`() {
    val harness = SchedulerHarness()
    harness.scheduler.schedule()

    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH)
    }
    harness.markOperational(ProcessId.SEARCH)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH, ProcessId.WEB)
    }
    harness.markOperational(ProcessId.WEB)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH, ProcessId.WEB, ProcessId.COMPUTE)
    }
    harness.markOperational(ProcessId.COMPUTE)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
    }
  }

  @Test
  fun `node never becomes operational while search stays unhealthy`() {
    val harness = SchedulerHarness()
    harness.scheduler.schedule()
    Thread.sleep(1_500)
    assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH)
    assertThat(harness.scheduler.lifecycle.state).isNotEqualTo(NodeLifecycle.State.OPERATIONAL)
  }

  @Test
  fun `unexpected child exit hard stops the node`() {
    val harness = SchedulerHarness()
    harness.scheduler.schedule()
    harness.markOperational(ProcessId.SEARCH)
    harness.markOperational(ProcessId.WEB)
    harness.markOperational(ProcessId.COMPUTE)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
    }

    harness.killUnexpectedly(ProcessId.WEB)

    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.hardStopped()).contains(ProcessId.SEARCH, ProcessId.COMPUTE)
      assertThat(harness.scheduler.lifecycle.state)
        .isIn(NodeLifecycle.State.HARD_STOPPING, NodeLifecycle.State.FINALIZE_STOPPING, NodeLifecycle.State.STOPPED)
    }
  }

  @Test
  fun `graceful stop follows reverse dependency order`() {
    val harness = SchedulerHarness()
    harness.scheduler.schedule()
    ProcessId.entries.filter { it != ProcessId.APP }.forEach(harness::markOperational)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
    }

    harness.scheduler.stop()

    assertThat(harness.stopOrderObserved())
      .containsExactly(ProcessId.COMPUTE, ProcessId.WEB, ProcessId.SEARCH)
    assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.STOPPED)
  }

  @Test
  fun `restart is acknowledged and reschedules children`() {
    val harness = SchedulerHarness()
    harness.scheduler.schedule()
    ProcessId.entries.filter { it != ProcessId.APP }.forEach(harness::markOperational)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
    }

    assertThat(harness.scheduler.requestRestart()).isTrue()

    assertThat(harness.stopOrderObserved())
      .containsExactly(ProcessId.COMPUTE, ProcessId.WEB, ProcessId.SEARCH)
    await().atMost(5, TimeUnit.SECONDS).untilAsserted {
      assertThat(harness.startedProcesses()).contains(ProcessId.SEARCH)
    }
  }
}
```

`SchedulerHarness` is a test fixture created in this task at `runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise/SchedulerHarness.kt`. It builds three `ChildHandler` instances over fake `ManagedProcess` objects that record `start`, `askForStop`, `askForHardStop`, and `destroyForcibly` calls with timestamps, expose `markOperational(id)`, and expose `killUnexpectedly(id)` which flips liveness to false and fires the handler's unexpected-exit callback.

```kotlin
package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.Settings
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ReloaderTest {
  private fun settings(vararg pairs: Pair<String, String>) = Settings(mapOf(*pairs))

  @Test
  fun `reloadable property change is accepted`() {
    val loader = FixedSettingsLoader(settings("leveret.path.temp" to "/t", "leveret.log.level" to "DEBUG"))
    val reloaded = Reloader(loader).reload(settings("leveret.path.temp" to "/t", "leveret.log.level" to "INFO"), emptyArray())
    assertThat(reloaded.required("leveret.log.level")).isEqualTo("DEBUG")
  }

  @Test
  fun `immutable path change is rejected by name`() {
    val loader = FixedSettingsLoader(settings("leveret.path.temp" to "/other"))
    assertThatThrownBy { Reloader(loader).reload(settings("leveret.path.temp" to "/t"), emptyArray()) }
      .isInstanceOf(IllegalStateException::class.java)
      .hasMessageContaining("leveret.path.temp")
  }
}
```

`FixedSettingsLoader` is a small test double created in this task that returns a preset `Settings` from `load`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*SchedulerTest' --tests '*ReloaderTest'`
Expected: FAIL — unresolved references `Scheduler`, `Reloader`.

- [ ] **Step 3: Write minimal implementation**

`Scheduler.schedule()` moves the node to `STARTING`, then starts children on a single scheduling thread that re-evaluates gates whenever a child publishes an operational event. `stop()` moves to `STOPPING`, iterates `stopOrder`, gives each child its configured timeout plus 60 s, escalates a survivor through `hardStop`, then `FINALIZE_STOPPING` and `STOPPED`. `hardStop()` follows the same order with the 1-minute bound and forcible destruction. `requestRestart()` returns `false` when cluster activation is set; otherwise it acknowledges the request, moves to `RESTARTING`, stops children, reloads through `Reloader`, resets temporary state, and schedules again; a reload or reschedule failure logs and converts to `hardStop()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*SchedulerTest' --tests '*ReloaderTest'`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/supervise runtime/src/test/kotlin/com/leveret/inspect/runtime/supervise
git commit -m "feat: add scheduler, reload, and stop escalation"
```

---

### Task 12: Monitor entry point, validation, and hard-stop requester

**Files:**
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/App.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/Shutdowner.kt`
- Create: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/SettingsValidator.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsValidatorTest.kt`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/ShutdownerTest.kt`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `object SettingsValidator { val PROVIDERS = setOf("h2", "sqlserver", "oracle", "postgresql"); fun validate(settings: Settings) }` throwing `IllegalArgumentException` for a connection URL that is present but not a `jdbc:<provider>:` form with a recognized, case-normalized provider. No other pre-guard validation.
  - `fun main(args: Array<String>)` in `App.kt`: load settings, validate, configure monitor logging, prepare directories and clear every command slot, then enter the guarded phase that schedules children and awaits termination. Pre-guard failures print to standard error and exit nonzero. Guarded-phase failures are logged and the monitor exits 0.
  - `fun main(args: Array<String>)` in `Shutdowner.kt`: read `conf/leveret.properties` from the derived installation home, resolve a relative temporary path against that home, write the monitor hard-stop flag, and on a detected configuration or input-output failure print to standard error and exit 1.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.runtime.config

import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class SettingsValidatorTest {
  @Test
  fun `recognized providers pass in any case`() {
    listOf("jdbc:h2:tcp://127.0.0.1:9092/sonar", "jdbc:PostgreSQL://db/inspect", "jdbc:oracle:thin:@host:1521/x")
      .forEach { url ->
        assertThatCode { SettingsValidator.validate(Settings(mapOf("leveret.jdbc.url" to url))) }
          .doesNotThrowAnyException()
      }
  }

  @Test
  fun `unknown provider and malformed url fail`() {
    listOf("jdbc:mysql://db/x", "postgresql://db/x", "jdbc:", "")
      .forEach { url ->
        assertThatThrownBy { SettingsValidator.validate(Settings(mapOf("leveret.jdbc.url" to url))) }
          .isInstanceOf(IllegalArgumentException::class.java)
      }
  }

  @Test
  fun `absent url is accepted`() {
    assertThatCode { SettingsValidator.validate(Settings(emptyMap())) }.doesNotThrowAnyException()
  }
}
```

```kotlin
package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ShutdownerTest {
  @Test
  fun `writes monitor hard stop flag in the configured temp directory`(@TempDir home: Path) {
    Files.createDirectories(home.resolve("conf"))
    val temp = home.resolve("temp")
    Files.createDirectories(temp)
    Files.writeString(home.resolve("conf/leveret.properties"), "leveret.path.temp=$temp")

    Shutdowner.requestHardStop(home, workingDirectory = home)

    CommandFile(temp).use { assertThat(it.view(ProcessId.APP.index).askedForHardStop).isTrue() }
  }

  @Test
  fun `relative temp resolves against installation home from any working directory`(@TempDir home: Path, @TempDir elsewhere: Path) {
    Files.createDirectories(home.resolve("conf"))
    Files.writeString(home.resolve("conf/leveret.properties"), "leveret.path.temp=temp")
    Files.createDirectories(home.resolve("temp"))

    Shutdowner.requestHardStop(home, workingDirectory = elsewhere)

    CommandFile(home.resolve("temp")).use {
      assertThat(it.view(ProcessId.APP.index).askedForHardStop).isTrue()
    }
    assertThat(elsewhere.resolve("temp")).doesNotExist()
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*SettingsValidatorTest' --tests '*ShutdownerTest'`
Expected: FAIL — unresolved references `SettingsValidator`, `Shutdowner`.

- [ ] **Step 3: Write minimal implementation**

`SettingsValidator.validate` returns early when the URL key is absent; otherwise it requires the `jdbc:` prefix, extracts the token up to the next colon, lowercases it, and requires membership in `PROVIDERS`. `Shutdowner` exposes `requestHardStop(home: Path, workingDirectory: Path)`, where `workingDirectory` is accepted only to prove it does not influence resolution, and a `main` that derives home from the running artifact. `App.main` follows the two-phase structure: everything up to and including directory preparation and command-slot clearing runs unguarded; the scheduling call is wrapped so that its failures are logged before exiting 0.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :runtime:test --tests '*SettingsValidatorTest' --tests '*ShutdownerTest'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/kotlin/com/leveret/inspect/runtime/App.kt runtime/src/main/kotlin/com/leveret/inspect/runtime/Shutdowner.kt runtime/src/main/kotlin/com/leveret/inspect/runtime/config/SettingsValidator.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsValidatorTest.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/ShutdownerTest.kt
git commit -m "feat: add monitor entry point, settings validation, and hard stop requester"
```

---

### Task 13: End-to-end acceptance scenarios

**Files:**
- Create: `runtime/src/test/kotlin/com/leveret/inspect/runtime/acceptance/NodeAcceptanceTest.kt`
- Create: `runtime/src/test/kotlin/com/leveret/inspect/runtime/acceptance/TestNode.kt`
- Create: `runtime/src/test/kotlin/com/leveret/inspect/runtime/acceptance/StubChildMain.kt`
- Create: `runtime/src/test/kotlin/com/leveret/inspect/runtime/acceptance/StubSearchMain.kt`

**Interfaces:**
- Consumes: `App`, `Scheduler`, `CommandFile`, `ChildEntryPoint`, `HttpSearchHealth`.
- Produces: `class TestNode(private val home: Path)` with `fun writeConfig(vararg lines: String)`, `fun start(vararg args: String)`, `fun awaitOperational(timeout: Duration)`, `fun logLines(id: ProcessId): List<String>`, `fun commands(id: ProcessId): ProcessCommands`, `fun stopGracefully()`, `fun exitCode(): Int`. `StubChildMain` hosts a `MonitoredComponent` through `ChildEntryPoint`, becoming operational after a configurable delay; `StubSearchMain` serves a configurable health colour on a configured port.

- [ ] **Step 1: Write the failing acceptance tests**

Write one test method per specification scenario, all through `TestNode`:

```kotlin
package com.leveret.inspect.runtime.acceptance

import com.leveret.inspect.runtime.proc.ProcessId
import java.time.Duration
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class NodeAcceptanceTest {
  @Test
  fun `scenario 1 standalone startup reaches operational state`(@TempDir home: Path) {
    val node = TestNode(home)
    node.writeConfig("leveret.search.health=green")
    node.start()
    node.awaitOperational(Duration.ofSeconds(60))

    val monitorLog = node.logLines(ProcessId.APP)
    assertThat(monitorLog).anySatisfy { assertThat(it).contains("Waiting for", "Search") }
    assertThat(indexOfProcessUp(monitorLog, ProcessId.SEARCH))
      .isLessThan(indexOfProcessUp(monitorLog, ProcessId.WEB))
      .isLessThan(indexOfProcessUp(monitorLog, ProcessId.COMPUTE))
    assertThat(monitorLog).anySatisfy { assertThat(it).contains("operational") }
    node.stopGracefully()
  }

  @Test
  fun `scenario 3 search never becomes ready`(@TempDir home: Path) {
    val node = TestNode(home)
    node.writeConfig("leveret.search.health=red")
    node.start()
    Thread.sleep(5_000)
    assertThat(node.logLines(ProcessId.WEB)).isEmpty()
    assertThat(node.logLines(ProcessId.COMPUTE)).isEmpty()
    assertThat(node.logLines(ProcessId.APP)).noneSatisfy { assertThat(it).contains("operational") }
    node.stopGracefully()
  }

  @Test
  fun `scenario 5 graceful stop preserves reverse dependency order`(@TempDir home: Path) {
    val node = TestNode(home)
    node.writeConfig("leveret.search.health=green", "leveret.enableStopCommand=true")
    node.start()
    node.awaitOperational(Duration.ofSeconds(60))

    node.stopGracefully()

    val stops = node.logLines(ProcessId.APP).filter { it.contains("stopped") }
    assertThat(stops.indexOfFirst { it.contains("Compute Engine") })
      .isLessThan(stops.indexOfFirst { it.contains("Web Server") })
      .isLessThan(stops.indexOfFirst { it.contains("Search") })
    assertThat(node.exitCode()).isZero()
  }

  @Test
  fun `scenario 9 command state is reset across monitors`(@TempDir home: Path) {
    val node = TestNode(home)
    node.writeConfig("leveret.search.health=green")
    node.seedStaleCommands(operational = true, restart = true)
    node.start()
    node.awaitOperational(Duration.ofSeconds(60))
    assertThat(node.logLines(ProcessId.APP)).noneSatisfy { assertThat(it).contains("Restarting") }
    node.stopGracefully()
  }

  private fun indexOfProcessUp(lines: List<String>, id: ProcessId): Int =
    lines.indexOfFirst { it.contains(id.displayName) && it.contains("is up") }
}
```

Add the remaining scenario methods in the same file and style: scenario 2 precedence through `start("-Dleveret.log.level=DEBUG")` against a config file and environment value; scenario 4 by killing the web child process and asserting the remaining children die without restart; scenario 6 by having the stub child set its restart flag and asserting reload plus rescheduling; scenario 7 by changing the temporary path before that restart and asserting the node hard-stops with the property named in the monitor log; scenario 8 by asserting file names, default plain records with daily rotation and seven retained periods, then a JSON run with the documented field set and a per-process threshold; scenario 10 by invoking the hard-stop requester from a foreign working directory with a relative temporary path and asserting the running node stops.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :runtime:test --tests '*NodeAcceptanceTest'`
Expected: FAIL — unresolved reference `TestNode`.

- [ ] **Step 3: Write the harness and close remaining gaps**

`TestNode` lays out `conf/`, `data/`, `logs/`, `temp/`, `web/` under the temporary home; builds the monitor classpath from the test runtime classpath; starts the monitor with `ProcessHandle`-visible arguments; and points the search, web, and compute commands at `StubSearchMain`, `StubChildMain`, and `StubChildMain`. Implement whatever production behavior these tests expose as missing — most likely monitor log wording and the restart acknowledgement path — until every scenario passes.

- [ ] **Step 4: Run the full suite**

Run: `./gradlew :runtime:test`
Expected: PASS, all unit and acceptance tests.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/test/kotlin/com/leveret/inspect/runtime/acceptance
git commit -m "test: add process runtime acceptance scenarios"
```

---

### Task 14: Distribution layout and operator template

**Files:**
- Create: `runtime/src/main/assembly/conf/leveret.properties`
- Create: `docs/operating-the-node.md`
- Modify: `runtime/build.gradle.kts`
- Test: `runtime/src/test/kotlin/com/leveret/inspect/runtime/DistributionTest.kt`

**Interfaces:**
- Consumes: `PropertyKeys.defaults`.
- Produces: an operator configuration template whose commented keys are exactly the canonical keys this part recognizes, and a distribution task that places the template under `conf/`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.PropertyKeys
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class DistributionTest {
  @Test
  fun `template documents every recognized key with its default`() {
    val template = Path.of("src/main/assembly/conf/leveret.properties")
    val text = Files.readString(template)
    PropertyKeys.defaults.forEach { (key, default) ->
      assertThat(text).contains(key)
      if (default.isNotEmpty()) assertThat(text).contains(default)
    }
    assertThat(text).doesNotContain("sonar.")
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :runtime:test --tests '*DistributionTest'`
Expected: FAIL — template file missing.

- [ ] **Step 3: Write minimal implementation**

Write the template with one commented block per recognized key showing its default value, and a distribution `Sync` task in `runtime/build.gradle.kts` that copies the template into the built layout under `conf/`. Write `docs/operating-the-node.md` describing directories, the precedence order, readiness, stop and hard stop, and log locations.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :runtime:test --tests '*DistributionTest'`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/main/assembly runtime/build.gradle.kts docs/operating-the-node.md runtime/src/test/kotlin/com/leveret/inspect/runtime/DistributionTest.kt
git commit -m "feat: add operator configuration template and node documentation"
```

---

## Self-Review

**Spec coverage.** Specification sections map to tasks as follows: §4.1 directories to Task 4; §4.2 precedence to Task 3; §4.3 JVM options to Task 7; §5 identities and topology to Tasks 2, 7, 10, 11; §6 lifecycle and readiness to Tasks 6, 9, 10, 11; §7 command contract to Task 5; §8 restart and shutdown to Tasks 11 and 12; §9 logging to Task 8; §10 failure behavior to Tasks 11 and 12; §11 security boundaries are honored by Task 4 (temporary cleaning), Task 5 (local-only command file), and Task 7 (handoff file in the temporary directory); §12 limits are asserted in Tasks 2 and 5; §13 all ten acceptance scenarios in Task 13. The connection-provider check named in §10 lives in Task 12.

**Placeholder scan.** No task defers work with vague wording. Task 13 step 3 explicitly names the expected gap-closing work rather than leaving it unstated.

**Type consistency.** `ProcessId`, `Settings`, `PropertyKeys`, `RuntimeFileSystem`, `CommandFile`, `ProcessCommands`, `ChildLifecycle`, `NodeLifecycle`, `JvmOptions`, `ChildCommand`, `CommandFactory`, `ProcessLauncher`, `SearchHealth`, `ChildHandler`, `Scheduler`, `Reloader`, `StopWatchers`, `MonitoredComponent`, `ChildEntryPoint`, `SettingsValidator`, `Shutdowner` are each defined once and referenced with the same names and signatures downstream. The test placeholder `ProcessId.CE_INDEX_FOR_TEST` in Task 5 is called out in that task as shorthand for `ProcessId.COMPUTE.index`.
