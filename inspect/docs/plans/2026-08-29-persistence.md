# Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the relational persistence layer for Leveret Inspect — database configuration, pooled writer and read-only sessions, dialect-aware DDL generation, a forward-only migration engine with durable history, charset verification, and SQL trace profiling.

**Architecture:** One Gradle module `persistence/` depending on `runtime`, with behavior-named packages (`config`, `dialect`, `pool`, `session`, `profiling`, `schema`, `migration`, `charset`). Sessions are thin JDBC wrappers, not an object-relational mapper: this part owns the connection, transaction, DDL, and migration contracts, while each later part contributes its own tables, migration steps, and SQL.

**Tech Stack:** Kotlin/JVM (bytecode target JDK 25), Gradle Kotlin DSL, HikariCP, H2, PostgreSQL JDBC, SLF4J, JUnit 5, AssertJ.

**Spec:** `specs/platform/persistence/specification.md` and the derived design `docs/specs/2026-08-29-persistence-design.md`

## Global Constraints

- Target baseline is release `26.8.0.126808`; no behavior from later releases.
- Java package root is `com.leveret.inspect.db`. Product naming is Leveret Inspect everywhere.
- Property prefix is `leveret.` only. Settings loading, precedence, and environment naming belong to `platform/process-runtime`; this module contributes keys, defaults, and validation.
- Supported provider tokens and dialect identifiers are exactly `h2` and `postgresql`. Any other token fails configuration; no builder emits a statement for an unknown dialect.
- History table is `schema_migrations` with one nonnullable `version` column of length 255. Migration numbers are `YYYY_MM_NNN`, compared as decimal integers, nonnegative and unique.
- Identifier limits: table names at most 25 characters, constraint and index names at most 30, lowercase ASCII letters, digits, and underscores, no leading digit or underscore, reserved keywords rejected with no exemptions. Varchar limit 4000; standard identifier field 40.
- Default primary-key constraint name is `pk_<table>`. Auto-increment is allowed only on a nonnullable numeric column named `id`, at most one per table.
- Pool defaults: `maxActive` 60, `minIdle` 10, `maxWait` 8000 ms, `idleTimeout` 600000 ms, `keepaliveTime` 180000 ms, `maxLifetime` 1800000 ms, `validationTimeout` 5000 ms. `maxActive` must be 1 through 2147483647; `maxWait` 0 maps to the 2147483647 sentinel and other values must be at least 250.
- Embedded database is H2 on loopback, port default 9092, database named `leveret` under the data directory. It is not a production target.
- Batch upserts default to 250 rows and commit per batch. Oversized input collections partition at 1000 elements.
- SQL trace logger is `sql`; profiling activates only when that logger is trace-enabled. Parameters render to at most 500 characters with a distinct null representation.
- Not implemented by decision, because Leveret Inspect will not use them: the Oracle and SQL Server dialects with their identity emulation, bounded `IN`-list partitioning, nullability retry transformations, character-set probe, and collation repair; the historical migration catalog and the direct-upgrade floor; the fixed 117-table canonical inventory; driver directory discovery and driver-path handoff; reserved-keyword exemptions and the embedded keyword-compatibility URL option; reverse migrations.
- No implementation may consult upstream source. The specification and this plan are the only inputs.
- Every task ends green: `./gradlew :persistence:test` passes before its commit. Task 2 also requires `./gradlew :runtime:test`.

---

### Task 1: Module skeleton and dialect resolution

**Files:**
- Modify: `settings.gradle.kts`
- Modify: `gradle/libs.versions.toml`
- Create: `persistence/build.gradle.kts`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/dialect/Dialect.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/dialect/DialectTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Gradle project `:persistence` with `implementation(project(":runtime"))`, HikariCP, H2, PostgreSQL JDBC, SLF4J, and the shared test dependencies; `./gradlew :persistence:test` runs JUnit 5 tests.
  - `interface Dialect` with `val id: String`, `fun quote(identifier: String): String`, `fun booleanLiteral(value: Boolean): String`, `fun identityClause(): String`, `fun limitOffset(limit: Int, offset: Int): String`, `fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String`.
  - `object H2Dialect : Dialect` and `object PostgresDialect : Dialect`.
  - `object Dialects { fun of(provider: String): Dialect }`, throwing `IllegalArgumentException` for any other token.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.dialect

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DialectTest {
    @Test
    fun `only h2 and postgresql resolve`() {
        assertThat(Dialects.of("h2")).isSameAs(H2Dialect)
        assertThat(Dialects.of("POSTGRESQL")).isSameAs(PostgresDialect)
        listOf("oracle", "mssql", "sqlserver", "mysql", "").forEach { token ->
            assertThatThrownBy { Dialects.of(token) }
                .isInstanceOf(IllegalArgumentException::class.java)
                .hasMessageContaining(token)
        }
    }

    @Test
    fun `statement differences are dialect owned`() {
        assertThat(H2Dialect.quote("issues")).isEqualTo("\"ISSUES\"")
        assertThat(PostgresDialect.quote("issues")).isEqualTo("\"issues\"")
        assertThat(H2Dialect.identityClause()).isEqualTo("integer generated always as identity")
        assertThat(PostgresDialect.identityClause()).isEqualTo("serial")
        assertThat(H2Dialect.limitOffset(10, 20)).isEqualTo("limit 10 offset 20")
        assertThat(PostgresDialect.booleanLiteral(true)).isEqualTo("true")
    }

    @Test
    fun `upsert targets the conflict columns`() {
        val sql = PostgresDialect.upsert("metrics", listOf("uuid", "name"), listOf("uuid"))
        assertThat(sql).isEqualTo(
            "insert into metrics (uuid, name) values (?, ?) " +
                "on conflict (uuid) do update set name = excluded.name",
        )
        assertThat(H2Dialect.upsert("metrics", listOf("uuid", "name"), listOf("uuid")))
            .isEqualTo("merge into metrics (uuid, name) key (uuid) values (?, ?)")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test`
Expected: FAIL — project `:persistence` does not exist.

- [ ] **Step 3: Write minimal implementation**

`settings.gradle.kts` gains one line after `include("runtime")`:

```kotlin
include("persistence")
```

`gradle/libs.versions.toml` gains versions and libraries:

```toml
hikari = "6.3.0"
h2 = "2.3.232"
postgresql = "42.7.7"
```

```toml
hikari = { module = "com.zaxxer:HikariCP", version.ref = "hikari" }
h2 = { module = "com.h2database:h2", version.ref = "h2" }
postgresql = { module = "org.postgresql:postgresql", version.ref = "postgresql" }
```

`persistence/build.gradle.kts`:

```kotlin
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(project(":runtime"))
    implementation(libs.slf4j.api)
    implementation(libs.hikari)
    implementation(libs.h2)
    implementation(libs.postgresql)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.platform.launcher)
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_25)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
```

`Dialect.kt`:

```kotlin
package com.leveret.inspect.db.dialect

/**
 * Every statement difference between supported databases lives behind this contract, so a builder
 * never has to know which database it is generating for. Adding a database means adding one
 * implementation, not editing call sites.
 */
interface Dialect {
    val id: String

    fun quote(identifier: String): String

    fun booleanLiteral(value: Boolean): String = value.toString()

    /** Column type clause for the single allowed auto-increment column. */
    fun identityClause(): String

    fun limitOffset(limit: Int, offset: Int): String = "limit $limit offset $offset"

    fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String
}

object H2Dialect : Dialect {
    override val id = "h2"

    override fun quote(identifier: String) = "\"${identifier.uppercase()}\""

    override fun identityClause() = "integer generated always as identity"

    override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String {
        val placeholders = columns.joinToString(", ") { "?" }
        return "merge into $table (${columns.joinToString(", ")}) " +
            "key (${conflictColumns.joinToString(", ")}) values ($placeholders)"
    }
}

object PostgresDialect : Dialect {
    override val id = "postgresql"

    override fun quote(identifier: String) = "\"${identifier.lowercase()}\""

    override fun identityClause() = "serial"

    override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String {
        val placeholders = columns.joinToString(", ") { "?" }
        val updates = columns.filterNot { it in conflictColumns }
            .joinToString(", ") { "$it = excluded.$it" }
        return "insert into $table (${columns.joinToString(", ")}) values ($placeholders) " +
            "on conflict (${conflictColumns.joinToString(", ")}) do update set $updates"
    }
}

object Dialects {
    private val byId = listOf(H2Dialect, PostgresDialect).associateBy { it.id }

    fun of(provider: String): Dialect = byId[provider.lowercase()]
        ?: throw IllegalArgumentException(
            "Unsupported database provider '$provider'; supported providers are ${byId.keys.sorted()}",
        )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add settings.gradle.kts gradle/libs.versions.toml persistence
git commit -m "build: add persistence module with database dialects"
```

---

### Task 2: Database settings, defaults, and embedded selection

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/config/DatabaseKeys.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/config/DatabaseSettings.kt`
- Modify: `runtime/src/main/kotlin/com/leveret/inspect/runtime/config/SettingsValidator.kt:11`
- Modify: `runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsValidatorTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/config/DatabaseSettingsTest.kt`

**Interfaces:**
- Consumes: `Dialects`, `runtime.config.Settings`, `runtime.config.PropertyKeys.JDBC_URL`.
- Produces:
  - `object DatabaseKeys` with `const val URL = PropertyKeys.JDBC_URL`, `USERNAME = "leveret.jdbc.username"`, `PASSWORD = "leveret.jdbc.password"`, `EMBEDDED_PORT = "leveret.embeddedDatabase.port"`, `MAX_ACTIVE = "leveret.jdbc.maxActive"`, `MIN_IDLE = "leveret.jdbc.minIdle"`, `MAX_WAIT = "leveret.jdbc.maxWait"`, `IDLE_TIMEOUT = "leveret.jdbc.idleTimeout"`, `KEEPALIVE = "leveret.jdbc.keepaliveTime"`, `MAX_LIFETIME = "leveret.jdbc.maxLifetime"`, `VALIDATION_TIMEOUT = "leveret.jdbc.validationTimeout"`, `AUTO_UPGRADE = "leveret.autoDatabaseUpgrade"`, plus `const val DEFAULT_EMBEDDED_PORT = 9092`, `const val EMBEDDED_DATABASE_NAME = "leveret"`, `const val MAX_WAIT_SENTINEL = 2147483647`, and `val defaults: Map<String, String>`.
  - `data class PoolSettings(val maxActive: Int, val minIdle: Int, val maxWaitMs: Int, val idleTimeoutMs: Long, val keepaliveMs: Long, val maxLifetimeMs: Long, val validationTimeoutMs: Long)`.
  - `data class DatabaseSettings(val url: String, val username: String, val password: String, val embedded: Boolean, val pool: PoolSettings)` with `val provider: String`, `val dialect: Dialect`, `val autoUpgrade: Boolean` and `companion object { fun from(settings: Settings, warn: (String) -> Unit): DatabaseSettings }`.
- Narrowed: `SettingsValidator.PROVIDERS` becomes `setOf("h2", "postgresql")`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.config

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import com.leveret.inspect.runtime.config.Settings
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DatabaseSettingsTest {
    private fun settings(vararg pairs: Pair<String, String>) =
        Settings(DatabaseKeys.defaults + pairs.toMap())

    @Test
    fun `absent url and port select the embedded database`() {
        val resolved = DatabaseSettings.from(settings()) {}
        assertThat(resolved.embedded).isTrue()
        assertThat(resolved.url).isEqualTo("jdbc:h2:tcp://127.0.0.1:9092/leveret")
        assertThat(resolved.dialect).isSameAs(H2Dialect)
    }

    @Test
    fun `explicit embedded port beats a configured url and warns`() {
        val warnings = mutableListOf<String>()
        val resolved = DatabaseSettings.from(
            settings(
                DatabaseKeys.EMBEDDED_PORT to "9500",
                DatabaseKeys.URL to "jdbc:postgresql://db.internal/leveret",
            ),
        ) { warnings += it }
        assertThat(resolved.embedded).isTrue()
        assertThat(resolved.url).isEqualTo("jdbc:h2:tcp://127.0.0.1:9500/leveret")
        assertThat(warnings).singleElement().asString()
            .contains(DatabaseKeys.URL, "ignored", resolved.url)
    }

    @Test
    fun `external url selects its provider dialect`() {
        val resolved = DatabaseSettings.from(
            settings(DatabaseKeys.URL to "jdbc:postgresql://db.internal/leveret"),
        ) {}
        assertThat(resolved.embedded).isFalse()
        assertThat(resolved.provider).isEqualTo("postgresql")
        assertThat(resolved.dialect).isSameAs(PostgresDialect)
    }

    @Test
    fun `unsupported provider fails before any connection`() {
        assertThatThrownBy {
            DatabaseSettings.from(settings(DatabaseKeys.URL to "jdbc:oracle:thin:@db:1521/x")) {}
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("oracle")
    }

    @Test
    fun `pool defaults and documented rejections hold`() {
        val pool = DatabaseSettings.from(settings()) {}.pool
        assertThat(pool).isEqualTo(PoolSettings(60, 10, 8000, 600000, 180000, 1800000, 5000))

        assertThat(DatabaseSettings.from(settings(DatabaseKeys.MAX_WAIT to "0")) {}.pool.maxWaitMs)
            .isEqualTo(DatabaseKeys.MAX_WAIT_SENTINEL)

        listOf(
            DatabaseKeys.MAX_ACTIVE to "0",
            DatabaseKeys.MAX_ACTIVE to "-1",
            DatabaseKeys.MAX_WAIT to "-1",
            DatabaseKeys.MAX_WAIT to "249",
        ).forEach { pair ->
            assertThatThrownBy { DatabaseSettings.from(settings(pair)) {} }
                .describedAs("%s=%s", pair.first, pair.second)
                .isInstanceOf(IllegalArgumentException::class.java)
                .hasMessageContaining(pair.first)
        }
    }
}
```

Add to `runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsValidatorTest.kt`:

```kotlin
    @Test
    fun `only implemented providers are accepted`() {
        assertThat(SettingsValidator.PROVIDERS).containsExactlyInAnyOrder("h2", "postgresql")
        listOf("oracle", "sqlserver").forEach { provider ->
            assertThatThrownBy {
                SettingsValidator.validate(Settings(mapOf(PropertyKeys.JDBC_URL to "jdbc:$provider:x")))
            }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test :runtime:test`
Expected: FAIL — unresolved reference `DatabaseKeys`; runtime assertion sees four providers.

- [ ] **Step 3: Write minimal implementation**

`DatabaseKeys.kt`:

```kotlin
package com.leveret.inspect.db.config

import com.leveret.inspect.runtime.config.PropertyKeys

/** Database property names and their defaults. Loading and precedence belong to the process runtime. */
object DatabaseKeys {
    const val URL = PropertyKeys.JDBC_URL
    const val USERNAME = "leveret.jdbc.username"
    const val PASSWORD = "leveret.jdbc.password"
    const val EMBEDDED_PORT = "leveret.embeddedDatabase.port"
    const val MAX_ACTIVE = "leveret.jdbc.maxActive"
    const val MIN_IDLE = "leveret.jdbc.minIdle"
    const val MAX_WAIT = "leveret.jdbc.maxWait"
    const val IDLE_TIMEOUT = "leveret.jdbc.idleTimeout"
    const val KEEPALIVE = "leveret.jdbc.keepaliveTime"
    const val MAX_LIFETIME = "leveret.jdbc.maxLifetime"
    const val VALIDATION_TIMEOUT = "leveret.jdbc.validationTimeout"
    const val AUTO_UPGRADE = "leveret.autoDatabaseUpgrade"

    const val DEFAULT_EMBEDDED_PORT = 9092
    const val EMBEDDED_DATABASE_NAME = "leveret"

    /** A configured zero wait is this finite sentinel, never an indefinite wait. */
    const val MAX_WAIT_SENTINEL = 2147483647

    const val MIN_MAX_WAIT = 250

    val defaults: Map<String, String> = mapOf(
        USERNAME to "",
        PASSWORD to "",
        MAX_ACTIVE to "60",
        MIN_IDLE to "10",
        MAX_WAIT to "8000",
        IDLE_TIMEOUT to "600000",
        KEEPALIVE to "180000",
        MAX_LIFETIME to "1800000",
        VALIDATION_TIMEOUT to "5000",
        AUTO_UPGRADE to "false",
    )
}
```

`DatabaseSettings.kt`:

```kotlin
package com.leveret.inspect.db.config

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.Dialects
import com.leveret.inspect.runtime.config.Settings

data class PoolSettings(
    val maxActive: Int,
    val minIdle: Int,
    val maxWaitMs: Int,
    val idleTimeoutMs: Long,
    val keepaliveMs: Long,
    val maxLifetimeMs: Long,
    val validationTimeoutMs: Long,
)

data class DatabaseSettings(
    val url: String,
    val username: String,
    val password: String,
    val embedded: Boolean,
    val pool: PoolSettings,
    val autoUpgrade: Boolean = false,
) {
    val provider: String = url.removePrefix(JDBC_PREFIX).substringBefore(':').lowercase()

    val dialect: Dialect = Dialects.of(provider)

    companion object {
        private const val JDBC_PREFIX = "jdbc:"
        private const val LOOPBACK = "127.0.0.1"

        fun from(settings: Settings, warn: (String) -> Unit): DatabaseSettings {
            val configuredUrl = settings.optional(DatabaseKeys.URL)?.trim()?.takeIf { it.isNotEmpty() }
            val configuredPort = settings.optional(DatabaseKeys.EMBEDDED_PORT)?.trim()
                ?.takeIf { it.isNotEmpty() }
            val embedded = configuredPort != null || configuredUrl == null
            val url = if (embedded) {
                val port = configuredPort?.toIntOrNull()
                    ?: DatabaseKeys.DEFAULT_EMBEDDED_PORT.takeIf { configuredPort == null }
                    ?: throw IllegalArgumentException(
                        "${DatabaseKeys.EMBEDDED_PORT} must be an integer, was '$configuredPort'",
                    )
                embeddedUrl(port).also { generated ->
                    if (configuredUrl != null) {
                        val relation = if (configuredUrl == generated) "matched" else "did not match"
                        warn(
                            "${DatabaseKeys.URL} is ignored because ${DatabaseKeys.EMBEDDED_PORT} " +
                                "selects the embedded database; the effective URL is $generated and " +
                                "the configured URL $relation it",
                        )
                    }
                }
            } else {
                requireNotNull(configuredUrl)
            }
            require(url.startsWith(JDBC_PREFIX) && url.removePrefix(JDBC_PREFIX).contains(':')) {
                "${DatabaseKeys.URL} must be a jdbc:<provider>: URL, was '$url'"
            }
            return DatabaseSettings(
                url = url,
                username = settings.value(DatabaseKeys.USERNAME, ""),
                password = settings.value(DatabaseKeys.PASSWORD, ""),
                embedded = embedded,
                pool = pool(settings),
                autoUpgrade = settings.boolValue(DatabaseKeys.AUTO_UPGRADE, false),
            )
        }

        fun embeddedUrl(port: Int): String =
            "jdbc:h2:tcp://$LOOPBACK:$port/${DatabaseKeys.EMBEDDED_DATABASE_NAME}"

        private fun pool(settings: Settings): PoolSettings {
            val maxActive = settings.intValue(DatabaseKeys.MAX_ACTIVE, 60)
            require(maxActive >= 1) {
                "${DatabaseKeys.MAX_ACTIVE} must be at least 1, was $maxActive"
            }
            val configuredWait = settings.intValue(DatabaseKeys.MAX_WAIT, 8000)
            require(configuredWait == 0 || configuredWait >= DatabaseKeys.MIN_MAX_WAIT) {
                "${DatabaseKeys.MAX_WAIT} must be 0 or at least ${DatabaseKeys.MIN_MAX_WAIT} ms, " +
                    "was $configuredWait"
            }
            return PoolSettings(
                maxActive = maxActive,
                minIdle = settings.intValue(DatabaseKeys.MIN_IDLE, 10),
                maxWaitMs = if (configuredWait == 0) DatabaseKeys.MAX_WAIT_SENTINEL else configuredWait,
                idleTimeoutMs = settings.intValue(DatabaseKeys.IDLE_TIMEOUT, 600000).toLong(),
                keepaliveMs = settings.intValue(DatabaseKeys.KEEPALIVE, 180000).toLong(),
                maxLifetimeMs = settings.intValue(DatabaseKeys.MAX_LIFETIME, 1800000).toLong(),
                validationTimeoutMs = settings.intValue(DatabaseKeys.VALIDATION_TIMEOUT, 5000).toLong(),
            )
        }
    }
}
```

In `SettingsValidator.kt`, narrow the provider set to the implemented dialects and say so:

```kotlin
    /** Only implemented dialects are accepted; Oracle and SQL Server are not implemented by decision. */
    val PROVIDERS = setOf("h2", "postgresql")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test :runtime:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add persistence/src runtime/src/main/kotlin/com/leveret/inspect/runtime/config/SettingsValidator.kt runtime/src/test/kotlin/com/leveret/inspect/runtime/config/SettingsValidatorTest.kt
git commit -m "feat: add database settings and narrow accepted providers"
```

---

### Task 3: Pooled data sources and pool observations

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/pool/Database.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/pool/DatabaseTest.kt`

**Interfaces:**
- Consumes: `DatabaseSettings`, `PoolSettings`, `Dialect`.
- Produces:
  - `data class PoolStats(val active: Int, val total: Int, val idle: Int, val maxActive: Int, val minIdle: Int, val maxLifetimeMs: Long, val maxWaitMs: Int)`.
  - `class Database(private val settings: DatabaseSettings) : AutoCloseable` with `val dialect: Dialect`, `fun start()`, `val writer: DataSource`, `val readOnly: DataSource`, `fun stats(): PoolStats`, `override fun close()`.
  - Accessing `writer` or `readOnly` before `start()` throws `IllegalStateException`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import java.sql.SQLTransientConnectionException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DatabaseTest {
    private fun settings(pool: PoolSettings) = DatabaseSettings(
        url = "jdbc:h2:mem:pool-${System.nanoTime()};DB_CLOSE_DELAY=-1",
        username = "",
        password = "",
        embedded = true,
        pool = pool,
    )

    private val defaultPool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000)

    @Test
    fun `sessions are unavailable before start`() {
        Database(settings(defaultPool)).use { database ->
            assertThatThrownBy { database.writer }.isInstanceOf(IllegalStateException::class.java)
        }
    }

    @Test
    fun `writer and read only sources both work and report configured counts`() {
        Database(settings(defaultPool)).use { database ->
            database.start()
            database.writer.connection.use { connection ->
                connection.createStatement().use { it.execute("create table probe (id int)") }
            }
            database.readOnly.connection.use { connection ->
                connection.createStatement().use { statement ->
                    assertThat(statement.executeQuery("select count(*) from probe").next()).isTrue()
                }
            }
            val stats = database.stats()
            assertThat(stats.maxActive).isEqualTo(4)
            assertThat(stats.minIdle).isEqualTo(1)
            assertThat(stats.maxWaitMs).isEqualTo(1000)
            assertThat(stats.total).isGreaterThanOrEqualTo(1)
        }
    }

    @Test
    fun `exhaustion fails after the configured wait instead of exceeding the maximum`() {
        val pool = PoolSettings(1, 1, 250, 600000, 180000, 1800000, 5000)
        Database(settings(pool)).use { database ->
            database.start()
            database.writer.connection.use {
                val start = System.nanoTime()
                assertThatThrownBy { database.writer.connection }
                    .isInstanceOf(SQLTransientConnectionException::class.java)
                assertThat(System.nanoTime() - start).isGreaterThanOrEqualTo(250_000_000L)
                assertThat(database.stats().active).isEqualTo(1)
            }
        }
    }

    @Test
    fun `stats report zero counts when no pool is live`() {
        val stats = Database(settings(defaultPool)).stats()
        assertThat(stats.active).isZero()
        assertThat(stats.total).isZero()
        assertThat(stats.idle).isZero()
        assertThat(stats.maxActive).isEqualTo(4)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test --tests '*DatabaseTest'`
Expected: FAIL — unresolved reference `Database`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.dialect.Dialect
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import javax.sql.DataSource

/** Pool counts and configured limits. Publication belongs to the telemetry part. */
data class PoolStats(
    val active: Int,
    val total: Int,
    val idle: Int,
    val maxActive: Int,
    val minIdle: Int,
    val maxLifetimeMs: Long,
    val maxWaitMs: Int,
)

/**
 * Owns the writer and read-only pools. The pool itself enforces the documented ranges, so an invalid
 * configuration fails here rather than degrading into an unbounded wait.
 */
class Database(private val settings: DatabaseSettings) : AutoCloseable {
    val dialect: Dialect = settings.dialect

    private var writerSource: HikariDataSource? = null
    private var readOnlySource: HikariDataSource? = null

    val writer: DataSource
        get() = checkNotNull(writerSource) { "Database is not started" }

    val readOnly: DataSource
        get() = checkNotNull(readOnlySource) { "Database is not started" }

    fun start() {
        if (writerSource != null) return
        writerSource = HikariDataSource(config("leveret-writer", readOnly = false))
        readOnlySource = HikariDataSource(config("leveret-reader", readOnly = true))
    }

    fun stats(): PoolStats {
        val pool = writerSource?.hikariPoolMXBean
        return PoolStats(
            active = pool?.activeConnections ?: 0,
            total = pool?.totalConnections ?: 0,
            idle = pool?.idleConnections ?: 0,
            maxActive = settings.pool.maxActive,
            minIdle = settings.pool.minIdle,
            maxLifetimeMs = settings.pool.maxLifetimeMs,
            maxWaitMs = settings.pool.maxWaitMs,
        )
    }

    override fun close() {
        readOnlySource?.close()
        writerSource?.close()
        readOnlySource = null
        writerSource = null
    }

    private fun config(poolName: String, readOnly: Boolean) = HikariConfig().apply {
        jdbcUrl = settings.url
        username = settings.username
        password = settings.password
        this.poolName = poolName
        this.isReadOnly = readOnly
        isAutoCommit = false
        maximumPoolSize = settings.pool.maxActive
        minimumIdle = settings.pool.minIdle
        connectionTimeout = settings.pool.maxWaitMs.toLong()
        idleTimeout = settings.pool.idleTimeoutMs
        keepaliveTime = settings.pool.keepaliveMs
        maxLifetime = settings.pool.maxLifetimeMs
        validationTimeout = settings.pool.validationTimeoutMs
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test --tests '*DatabaseTest'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add pooled writer and read-only data sources"
```

---

### Task 4: SQL normalization and trace profiling

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/profiling/SqlLogFormatter.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/profiling/SqlProfiler.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/profiling/SqlLogFormatterTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/profiling/SqlProfilerTest.kt`
- Modify: `persistence/build.gradle.kts` — add `testImplementation(libs.logback.classic)`, which the trace assertions need for a list appender on logger `sql`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `object SqlLogFormatter` with `const val PARAM_MAX_LENGTH = 500`, `const val NULL_RENDERING = "[null]"`, `fun normalize(sql: String): String`, `fun render(value: Any?): String`, `fun render(values: List<Any?>): String`.
  - `class SqlProfiler(private val logger: Logger = LoggerFactory.getLogger("sql"))` with `val enabled: Boolean`, `fun prepare(connection: Connection, sql: String): PreparedStatement`, `fun statement(connection: Connection): Statement`.
- Later tasks: `DbSession` obtains every statement through `SqlProfiler`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.db.profiling

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class SqlLogFormatterTest {
    @Test
    fun `normalization collapses layout whitespace`() {
        assertThat(SqlLogFormatter.normalize("select a\n\tfrom  t\n where a =  ?"))
            .isEqualTo("select a from t where a = ?")
    }

    @Test
    fun `parameters render bounded with a distinct null and escaped newlines`() {
        assertThat(SqlLogFormatter.render(null)).isEqualTo("[null]")
        assertThat(SqlLogFormatter.render("a\nb")).isEqualTo("a\\nb")
        val long = "x".repeat(SqlLogFormatter.PARAM_MAX_LENGTH + 10)
        val rendered = SqlLogFormatter.render(long)
        assertThat(rendered).hasSize(SqlLogFormatter.PARAM_MAX_LENGTH + 3).endsWith("...")
        assertThat(SqlLogFormatter.render(listOf(1, null, "b"))).isEqualTo("[1, [null], b]")
    }
}
```

```kotlin
package com.leveret.inspect.db.profiling

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import java.sql.DriverManager
import java.sql.SQLException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory

class SqlProfilerTest {
    private val traceLogger = LoggerFactory.getLogger(SqlProfiler.LOGGER_NAME) as ch.qos.logback.classic.Logger
    private val records = ListAppender<ILoggingEvent>().apply { start() }

    private fun tracing(): SqlProfiler {
        traceLogger.level = Level.TRACE
        traceLogger.addAppender(records)
        return SqlProfiler(traceLogger)
    }

    @AfterEach
    fun detach() {
        traceLogger.detachAppender(records)
        traceLogger.level = null
    }

    private fun messages() = records.list.map { it.formattedMessage }

    @Test
    fun `profiled execution preserves results and exceptions while tracing`() {
        val profiler = tracing()
        assertThat(profiler.enabled).isTrue()
        DriverManager.getConnection("jdbc:h2:mem:profiler-${System.nanoTime()}").use { connection ->
            profiler.statement(connection).use {
                it.execute("create table t (id int primary key, label varchar(10))")
            }

            profiler.prepare(connection, "insert into t (id, label)\n values (?, ?)").use { statement ->
                statement.setInt(1, 7)
                statement.setString(2, "label")
                assertThat(statement.executeUpdate()).isEqualTo(1)
            }
            assertThat(messages().last())
                .contains("insert into t (id, label) values (?, ?)")
                .contains("[7, label]")
                .containsPattern("\\d+ ms")

            // The failing execution must fail at execute time, not at prepare time: H2 rejects an
            // unknown column while preparing, which would never reach the timing wrapper.
            profiler.prepare(connection, "insert into t (id, label) values (?, ?)").use { statement ->
                statement.setInt(1, 7)
                statement.setString(2, "duplicate")
                assertThatThrownBy { statement.executeUpdate() }.isInstanceOf(SQLException::class.java)
            }
            assertThat(messages().last())
                .contains("insert into t (id, label) values (?, ?)")
                .contains("[7, duplicate]")
        }
    }

    @Test
    fun `pass through mode returns plain statements`() {
        val silent = LoggerFactory.getLogger("sql.silent") as ch.qos.logback.classic.Logger
        silent.level = Level.DEBUG
        val profiler = SqlProfiler(silent)
        assertThat(profiler.enabled).isFalse()
        DriverManager.getConnection("jdbc:h2:mem:plain-${System.nanoTime()}").use { connection ->
            profiler.prepare(connection, "select 1").use { statement ->
                assertThat(statement.javaClass.name).doesNotContain("Proxy")
            }
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*Sql*Test'`
Expected: FAIL — unresolved references `SqlLogFormatter` and `SqlProfiler`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.profiling

/** Statement and parameter rendering for the SQL trace channel. */
object SqlLogFormatter {
    const val PARAM_MAX_LENGTH = 500
    const val NULL_RENDERING = "[null]"

    private val whitespace = Regex("\\s+")

    fun normalize(sql: String): String = sql.replace(whitespace, " ").trim()

    fun render(value: Any?): String {
        if (value == null) return NULL_RENDERING
        val text = value.toString().replace("\n", "\\n").replace("\r", "\\r")
        return if (text.length <= PARAM_MAX_LENGTH) text else text.take(PARAM_MAX_LENGTH) + "..."
    }

    fun render(values: List<Any?>): String = values.joinToString(", ", "[", "]") { render(it) }
}
```

```kotlin
package com.leveret.inspect.db.profiling

import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.Statement
import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Statements are created here so trace profiling can wrap them without touching the pool. Wrapping is
 * decided per statement from the logger's level, and a wrapped statement keeps the exact return value
 * or exception of the statement it wraps.
 */
class SqlProfiler(private val logger: Logger = LoggerFactory.getLogger(LOGGER_NAME)) {
    val enabled: Boolean get() = logger.isTraceEnabled

    fun prepare(connection: Connection, sql: String): PreparedStatement {
        val delegate = connection.prepareStatement(sql)
        if (!enabled) return delegate
        return Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(PreparedStatement::class.java),
            TimingHandler(delegate, sql, logger, captureParameters = true),
        ) as PreparedStatement
    }

    fun statement(connection: Connection): Statement {
        val delegate = connection.createStatement()
        if (!enabled) return delegate
        return Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(Statement::class.java),
            TimingHandler(delegate, sql = null, logger = logger, captureParameters = false),
        ) as Statement
    }

    private class TimingHandler(
        private val delegate: Statement,
        private val sql: String?,
        private val logger: Logger,
        private val captureParameters: Boolean,
    ) : InvocationHandler {
        private val parameters = sortedMapOf<Int, Any?>()

        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            val arguments = args ?: emptyArray()
            if (captureParameters && method.name.startsWith("set") && arguments.size >= 2) {
                (arguments[0] as? Int)?.let { parameters[it] = arguments[1] }
            }
            if (!method.name.startsWith("execute")) return call(method, arguments)
            val started = System.nanoTime()
            try {
                return call(method, arguments)
            } finally {
                val millis = (System.nanoTime() - started) / 1_000_000
                val statementSql = SqlLogFormatter.normalize(sql ?: arguments.firstOrNull()?.toString() ?: "")
                val rendered = if (parameters.isEmpty()) "" else " ${SqlLogFormatter.render(parameters.values.toList())}"
                logger.trace("$millis ms | $statementSql$rendered")
            }
        }

        private fun call(method: Method, arguments: Array<out Any?>): Any? =
            try {
                method.invoke(delegate, *arguments)
            } catch (failure: InvocationTargetException) {
                throw failure.targetException
            }
    }

    companion object {
        const val LOGGER_NAME = "sql"
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test --tests '*Sql*Test'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add sql trace profiling"
```

---

### Task 5: Sessions, transactions, batching, and partitioning

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/session/DbSession.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/session/SessionFactory.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/session/LargeInputs.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/session/DbSessionTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/session/LargeInputsTest.kt`

**Interfaces:**
- Consumes: `Database`, `Dialect`, `SqlProfiler`.
- Produces:
  - `class DbSession(private val connection: Connection, val dialect: Dialect, private val profiler: SqlProfiler) : AutoCloseable` with `fun commit()`, `fun rollback()`, `fun execute(sql: String)`, `fun update(sql: String, bind: (PreparedStatement) -> Unit = {}): Int`, `fun <T> select(sql: String, bind: (PreparedStatement) -> Unit = {}, row: (ResultSet) -> T): List<T>`, `fun prepare(sql: String): PreparedStatement`, `fun <T> batch(sql: String, rows: Iterable<T>, batchSize: Int = DEFAULT_BATCH_SIZE, bind: (PreparedStatement, T) -> Unit): Int`, `fun relaxIsolationIfSupported()`, and `companion object { const val DEFAULT_BATCH_SIZE = 250 }`.
  - `class SessionFactory(private val database: Database, private val profiler: SqlProfiler = SqlProfiler())` with `fun openWriter(): DbSession` and `fun openReadOnly(): DbSession`.
  - `object LargeInputs` with `const val PARTITION_SIZE = 1000`, `fun <I, O> read(input: Collection<I>, block: (List<I>) -> Collection<O>): List<O>`, `fun <I> update(input: Collection<I>, block: (List<I>) -> Int): Int`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.db.session

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.pool.Database
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class DbSessionTest {
    private lateinit var database: Database
    private lateinit var sessions: SessionFactory

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:session-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        sessions = SessionFactory(database)
        sessions.openWriter().use { session ->
            session.execute("create table claims (id int primary key, state varchar(20), body clob)")
            session.commit()
        }
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `rollback discards and commit persists`() {
        sessions.openWriter().use { session ->
            session.update("insert into claims (id, state) values (?, ?)") { it.setInt(1, 1); it.setString(2, "PENDING") }
            session.rollback()
            assertThat(count()).isZero()

            session.update("insert into claims (id, state) values (?, ?)") { it.setInt(1, 1); it.setString(2, "PENDING") }
            session.commit()
        }
        assertThat(count()).isEqualTo(1)
    }

    @Test
    fun `conditional claim reports affected rows so a lost race is visible`() {
        sessions.openWriter().use { session ->
            session.update("insert into claims (id, state) values (1, 'PENDING')")
            session.commit()
        }
        val claim = { sessions.openWriter().use { session ->
            val changed = session.update(
                "update claims set state = 'IN_PROGRESS' where id = 1 and state = 'PENDING'",
            )
            session.commit()
            changed
        } }
        assertThat(claim()).isEqualTo(1)
        assertThat(claim()).isZero()
    }

    @Test
    fun `batch commits per batch and leaves earlier batches durable`() {
        sessions.openWriter().use { session ->
            val written = session.batch(
                "insert into claims (id, state) values (?, ?)",
                rows = (1..250).toList(),
                batchSize = 100,
            ) { statement, id -> statement.setInt(1, id); statement.setString(2, "PENDING") }
            assertThat(written).isEqualTo(250)
        }
        assertThat(count()).isEqualTo(250)
    }

    @Test
    fun `streamed values persist through a prepared statement`() {
        val body = "x".repeat(100_000)
        sessions.openWriter().use { session ->
            session.prepare("insert into claims (id, state, body) values (?, ?, ?)").use { statement ->
                statement.setInt(1, 1)
                statement.setString(2, "PENDING")
                statement.setCharacterStream(3, body.reader(), body.length.toLong())
                statement.executeUpdate()
            }
            session.commit()
        }
        sessions.openReadOnly().use { session ->
            val stored = session.select("select body from claims where id = 1") { it.getString(1) }
            assertThat(stored).containsExactly(body)
        }
    }

    private fun count(): Int = sessions.openReadOnly().use { session ->
        session.select("select count(*) from claims") { it.getInt(1) }.single()
    }
}
```

```kotlin
package com.leveret.inspect.db.session

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class LargeInputsTest {
    @Test
    fun `oversized inputs are partitioned and results concatenated`() {
        val input = (1..2500).toList()
        val partitions = mutableListOf<Int>()
        val read = LargeInputs.read(input) { partition ->
            partitions += partition.size
            partition.map { it * 2 }
        }
        assertThat(partitions).containsExactly(1000, 1000, 500)
        assertThat(read.first()).isEqualTo(2)
        assertThat(read).hasSize(2500)

        assertThat(LargeInputs.update(input) { it.size }).isEqualTo(2500)
        assertThat(LargeInputs.read<Int, Int>(emptyList()) { error("never called") }).isEmpty()
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*Session*' --tests '*LargeInputs*'`
Expected: FAIL — unresolved references `SessionFactory`, `LargeInputs`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.session

/**
 * Statement parameter limits and planner behavior degrade with very large `in` lists, so an oversized
 * input collection is split and the results concatenated.
 */
object LargeInputs {
    const val PARTITION_SIZE = 1000

    fun <I, O> read(input: Collection<I>, block: (List<I>) -> Collection<O>): List<O> =
        input.chunked(PARTITION_SIZE).flatMap(block)

    fun <I> update(input: Collection<I>, block: (List<I>) -> Int): Int =
        input.chunked(PARTITION_SIZE).sumOf(block)
}
```

```kotlin
package com.leveret.inspect.db.session

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.profiling.SqlProfiler
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet

/**
 * One connection with autocommit disabled. Ordinary work stays inside the caller's transaction: the
 * session commits only when told to, so a part that needs a narrower boundary declares it instead of
 * inheriting an assumed all-or-nothing transaction.
 */
class DbSession(
    private val connection: Connection,
    val dialect: Dialect,
    private val profiler: SqlProfiler,
) : AutoCloseable {
    fun commit() = connection.commit()

    fun rollback() = connection.rollback()

    fun execute(sql: String) = profiler.statement(connection).use { it.execute(sql) }

    fun prepare(sql: String): PreparedStatement = profiler.prepare(connection, sql)

    fun update(sql: String, bind: (PreparedStatement) -> Unit = {}): Int =
        prepare(sql).use { statement ->
            bind(statement)
            statement.executeUpdate()
        }

    fun <T> select(sql: String, bind: (PreparedStatement) -> Unit = {}, row: (ResultSet) -> T): List<T> =
        prepare(sql).use { statement ->
            bind(statement)
            statement.executeQuery().use { results ->
                val rows = mutableListOf<T>()
                while (results.next()) rows += row(results)
                rows
            }
        }

    /** Commits each full batch and the final partial batch, so earlier batches survive a later failure. */
    fun <T> batch(
        sql: String,
        rows: Iterable<T>,
        batchSize: Int = DEFAULT_BATCH_SIZE,
        bind: (PreparedStatement, T) -> Unit,
    ): Int {
        require(batchSize >= 1) { "batchSize must be at least 1, was $batchSize" }
        var pending = 0
        var written = 0
        prepare(sql).use { statement ->
            rows.forEach { row ->
                bind(statement, row)
                statement.addBatch()
                pending++
                if (pending == batchSize) {
                    written += statement.executeBatch().size
                    commit()
                    pending = 0
                }
            }
            if (pending > 0) {
                written += statement.executeBatch().size
                commit()
            }
        }
        return written
    }

    /** Migration readers ask for relaxed isolation, which is applied only where the driver reports it. */
    fun relaxIsolationIfSupported() {
        if (connection.metaData.supportsTransactionIsolationLevel(Connection.TRANSACTION_READ_UNCOMMITTED)) {
            connection.transactionIsolation = Connection.TRANSACTION_READ_UNCOMMITTED
        }
    }

    override fun close() = connection.close()

    companion object {
        const val DEFAULT_BATCH_SIZE = 250
    }
}
```

```kotlin
package com.leveret.inspect.db.session

import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.profiling.SqlProfiler

class SessionFactory(
    private val database: Database,
    private val profiler: SqlProfiler = SqlProfiler(),
) {
    fun openWriter(): DbSession = open(database.writer.connection)

    fun openReadOnly(): DbSession = open(database.readOnly.connection)

    private fun open(connection: java.sql.Connection): DbSession {
        connection.autoCommit = false
        return DbSession(connection, database.dialect, profiler)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test --tests '*Session*' --tests '*LargeInputs*'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add database sessions with batching and partitioning"
```

---

### Task 6: Identifier validation and the column model

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/schema/Identifiers.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/schema/ColumnDef.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/schema/IdentifiersTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/schema/ColumnDefTest.kt`

**Interfaces:**
- Consumes: `Dialect`, `H2Dialect`, `PostgresDialect`.
- Produces:
  - `object Identifiers` with `const val MAX_TABLE_LENGTH = 25`, `const val MAX_CONSTRAINT_LENGTH = 30`, `val RESERVED: Set<String>`, `fun table(name: String): String`, `fun column(name: String): String`, `fun constraint(name: String): String`, `fun index(name: String): String`, `fun existing(name: String): String`.
  - `enum class ColumnType { VARCHAR, TEXT, BINARY, BOOLEAN, TINY, SMALL, INTEGER, BIGINT, DECIMAL, TIMESTAMP }`.
  - `data class ColumnDef(val name: String, val type: ColumnType, val nullable: Boolean = true, val limit: Int? = null, val default: Any? = null, val autoIncrement: Boolean = false)` with `fun render(dialect: Dialect): String` and `companion object { const val VARCHAR_MAX_LENGTH = 4000; const val IDENTIFIER_LENGTH = 40 }`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.db.schema

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class IdentifiersTest {
    @Test
    fun `new identifiers follow the shared convention`() {
        assertThat(Identifiers.table("issue_changes")).isEqualTo("issue_changes")
        assertThat(Identifiers.constraint("pk_issue_changes")).isEqualTo("pk_issue_changes")
    }

    @Test
    fun `length shape and keywords are rejected without exemptions`() {
        val rejected: List<() -> Unit> = listOf(
            { Identifiers.table("a".repeat(26)) },
            { Identifiers.constraint("c".repeat(31)) },
            { Identifiers.table("1issues") },
            { Identifiers.table("_issues") },
            { Identifiers.table("Issues") },
            { Identifiers.column("issue-key") },
            { Identifiers.table("groups") },
            { Identifiers.column("value") },
            { Identifiers.column("select") },
            { Identifiers.table("second") },
            { Identifiers.column("year") },
        )
        rejected.forEach { call ->
            assertThatThrownBy(call).isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `existing names are accepted case insensitively`() {
        assertThat(Identifiers.existing("Arch_Models_UUID")).isEqualTo("Arch_Models_UUID")
        assertThatThrownBy { Identifiers.existing("has space") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }
}
```

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ColumnDefTest {
    @Test
    fun `nullability is explicit and defaults are dialect rendered`() {
        assertThat(ColumnDef("uuid", ColumnType.VARCHAR, nullable = false, limit = 40).render(PostgresDialect))
            .isEqualTo("uuid varchar(40) not null")
        assertThat(ColumnDef("enabled", ColumnType.BOOLEAN, nullable = false, default = true).render(PostgresDialect))
            .isEqualTo("enabled boolean not null default true")
        assertThat(ColumnDef("state", ColumnType.VARCHAR, limit = 20, default = "PENDING").render(PostgresDialect))
            .isEqualTo("state varchar(20) null default 'PENDING'")
    }

    @Test
    fun `large types differ per dialect`() {
        assertThat(ColumnDef("body", ColumnType.TEXT).render(H2Dialect)).isEqualTo("body clob null")
        assertThat(ColumnDef("body", ColumnType.TEXT).render(PostgresDialect)).isEqualTo("body text null")
        assertThat(ColumnDef("payload", ColumnType.BINARY).render(PostgresDialect)).isEqualTo("payload bytea null")
    }

    @Test
    fun `varchar limits are enforced`() {
        assertThatThrownBy { ColumnDef("t", ColumnType.VARCHAR, limit = 4001).render(PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("4000")
        assertThatThrownBy { ColumnDef("t", ColumnType.VARCHAR).render(PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("limit")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*Identifiers*' --tests '*ColumnDef*'`
Expected: FAIL — unresolved references `Identifiers`, `ColumnDef`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.schema

/**
 * Generated identifiers are validated at construction: a name that reaches DDL generation has already
 * been proven safe, which is also what keeps the migration builders free of injection surface.
 */
object Identifiers {
    const val MAX_TABLE_LENGTH = 25
    const val MAX_CONSTRAINT_LENGTH = 30

    /**
     * Reserved words rejected with no exemptions, taken from the strictest supported dialect so a name
     * that validates here needs no quoting on any of them. H2 reserves temporal unit words such as
     * `second` and `year` that PostgreSQL accepts, and an unquoted table named after one fails only at
     * migration time otherwise.
     */
    val RESERVED = setOf(
        "all", "alter", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "between",
        "by", "case", "cast", "check", "column", "constraint", "create", "cross", "current_catalog",
        "current_date", "current_path", "current_role", "current_schema", "current_time",
        "current_timestamp", "current_user", "day", "default", "delete", "desc", "distinct", "drop",
        "else", "end", "except", "exists", "false", "fetch", "filter", "for", "foreign", "from", "full",
        "group", "groups", "having", "hour", "if", "ilike", "in", "index", "inner", "insert",
        "intersect", "interval", "into", "is", "join", "key", "leading", "left", "like", "limit",
        "localtime", "localtimestamp", "minus", "minute", "month", "natural", "not", "null", "offset",
        "on", "or", "order", "outer", "over", "partition", "primary", "qualify", "range", "references",
        "regexp", "right", "row", "rownum", "second", "select", "session_user", "set", "some",
        "symmetric", "system_user", "table", "then", "to", "top", "trailing", "true", "uescape",
        "union", "unique", "unknown", "update", "user", "using", "value", "values", "when", "where",
        "window", "with", "year",
    )

    private val shape = Regex("[a-z][a-z0-9_]*")
    private val existingShape = Regex("[A-Za-z][A-Za-z0-9_]*")

    fun table(name: String): String = validate(name, MAX_TABLE_LENGTH, "table")

    fun column(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "column")

    fun constraint(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "constraint")

    fun index(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "index")

    /** Accepts an already existing mixed-case name, the one case where case is not normalized. */
    fun existing(name: String): String {
        require(existingShape.matches(name) && name.length <= MAX_CONSTRAINT_LENGTH) {
            "Existing identifier '$name' must be alphanumeric with underscores and at most " +
                "$MAX_CONSTRAINT_LENGTH characters"
        }
        return name
    }

    private fun validate(name: String, maxLength: Int, kind: String): String {
        require(name.length <= maxLength) {
            "New $kind name '$name' exceeds $maxLength characters"
        }
        require(shape.matches(name)) {
            "New $kind name '$name' must be lowercase letters, digits, and underscores, starting with " +
                "a letter"
        }
        require(name !in RESERVED) { "New $kind name '$name' is a reserved SQL keyword" }
        return name
    }
}
```

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

enum class ColumnType { VARCHAR, TEXT, BINARY, BOOLEAN, TINY, SMALL, INTEGER, BIGINT, DECIMAL, TIMESTAMP }

/** One logical column. The dialect decides the physical type; nullability is always explicit. */
data class ColumnDef(
    val name: String,
    val type: ColumnType,
    val nullable: Boolean = true,
    val limit: Int? = null,
    val default: Any? = null,
    val autoIncrement: Boolean = false,
) {
    init {
        Identifiers.column(name)
    }

    fun render(dialect: Dialect): String {
        val parts = mutableListOf(name, typeClause(dialect))
        parts += if (nullable) "null" else "not null"
        default?.let { parts += "default ${literal(it, dialect)}" }
        return parts.joinToString(" ")
    }

    private fun typeClause(dialect: Dialect): String = when (type) {
        ColumnType.VARCHAR -> {
            val size = requireNotNull(limit) { "Column '$name' of type VARCHAR requires a limit" }
            require(size in 1..VARCHAR_MAX_LENGTH) {
                "Column '$name' varchar limit $size exceeds $VARCHAR_MAX_LENGTH"
            }
            "varchar($size)"
        }
        ColumnType.TEXT -> if (dialect.id == "postgresql") "text" else "clob"
        ColumnType.BINARY -> if (dialect.id == "postgresql") "bytea" else "blob"
        ColumnType.BOOLEAN -> "boolean"
        ColumnType.TINY -> "smallint"
        ColumnType.SMALL -> "smallint"
        ColumnType.INTEGER -> if (autoIncrement) dialect.identityClause() else "integer"
        ColumnType.BIGINT -> "bigint"
        ColumnType.DECIMAL -> "decimal(38,20)"
        ColumnType.TIMESTAMP -> "timestamp"
    }

    private fun literal(value: Any, dialect: Dialect): String = when (value) {
        is Boolean -> dialect.booleanLiteral(value)
        is Number -> value.toString()
        else -> "'${value.toString().replace("'", "''")}'"
    }

    companion object {
        const val VARCHAR_MAX_LENGTH = 4000
        const val IDENTIFIER_LENGTH = 40
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test --tests '*Identifiers*' --tests '*ColumnDef*'`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add identifier validation and column model"
```

---

### Task 7: Table, index, and alter DDL builders

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/schema/CreateTableBuilder.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/schema/SchemaStatements.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/schema/CreateTableBuilderTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/schema/SchemaStatementsTest.kt`

**Interfaces:**
- Consumes: `Identifiers`, `ColumnDef`, `ColumnType`, `Dialect`.
- Produces:
  - `class CreateTableBuilder(private val table: String, private val dialect: Dialect)` with `fun column(column: ColumnDef): CreateTableBuilder`, `fun primaryKey(vararg columns: String): CreateTableBuilder`, `fun primaryKeyName(name: String): CreateTableBuilder`, `fun build(): List<String>`.
  - `object SchemaStatements` with `fun createIndex(table: String, name: String, columns: List<String>, unique: Boolean = false): String`, `fun dropIndex(table: String, name: String, dialect: Dialect): String`, `fun renameIndex(from: String, to: String, dialect: Dialect): String`, `fun addColumn(table: String, column: ColumnDef, dialect: Dialect): String`, `fun dropColumn(table: String, column: String): String`, `fun setNullable(table: String, column: ColumnDef, dialect: Dialect): List<String>`, `fun renameTable(from: String, to: String): String`, `fun renameConstraint(table: String, from: String, to: String, dialect: Dialect): String`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class CreateTableBuilderTest {
    @Test
    fun `primary key defaults to the shared naming rule and keeps column order`() {
        val statements = CreateTableBuilder("issue_changes", PostgresDialect)
            .column(ColumnDef("issue_key", ColumnType.VARCHAR, nullable = false, limit = 40))
            .column(ColumnDef("change_key", ColumnType.VARCHAR, nullable = false, limit = 40))
            .column(ColumnDef("created_at", ColumnType.BIGINT, nullable = false))
            .primaryKey("issue_key", "change_key")
            .build()
        assertThat(statements).containsExactly(
            "create table issue_changes (" +
                "issue_key varchar(40) not null, " +
                "change_key varchar(40) not null, " +
                "created_at bigint not null, " +
                "constraint pk_issue_changes primary key (issue_key, change_key))",
        )
    }

    @Test
    fun `auto increment is one nonnullable numeric id column`() {
        val statements = CreateTableBuilder("events", H2Dialect)
            .column(ColumnDef("id", ColumnType.INTEGER, nullable = false, autoIncrement = true))
            .primaryKey("id")
            .build()
        assertThat(statements.single())
            .contains("id integer generated always as identity not null")
            .contains("constraint pk_events primary key (id)")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("seq", ColumnType.INTEGER, nullable = false, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("id")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("id", ColumnType.INTEGER, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("nonnullable")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("id", ColumnType.VARCHAR, nullable = false, limit = 40, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("numeric")
    }

    @Test
    fun `a table needs columns and a validated name`() {
        assertThatThrownBy { CreateTableBuilder("issues", PostgresDialect).build() }
            .isInstanceOf(IllegalStateException::class.java)
        assertThatThrownBy { CreateTableBuilder("Issues", PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }
}
```

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class SchemaStatementsTest {
    @Test
    fun `index statements are dialect aware`() {
        assertThat(SchemaStatements.createIndex("issues", "issues_component_uuid", listOf("component_uuid")))
            .isEqualTo("create index issues_component_uuid on issues (component_uuid)")
        assertThat(
            SchemaStatements.createIndex("issues", "issues_kee", listOf("kee"), unique = true),
        ).isEqualTo("create unique index issues_kee on issues (kee)")
        assertThat(SchemaStatements.dropIndex("issues", "issues_kee", PostgresDialect))
            .isEqualTo("drop index issues_kee")
        assertThat(SchemaStatements.dropIndex("issues", "issues_kee", H2Dialect))
            .isEqualTo("drop index issues_kee")
        assertThat(SchemaStatements.renameIndex("arch_intended_uuid", "arch_models_uuid", PostgresDialect))
            .isEqualTo("alter index arch_intended_uuid rename to arch_models_uuid")
    }

    @Test
    fun `column and table changes are generated per dialect`() {
        val column = ColumnDef("producer", ColumnType.VARCHAR, limit = 40)
        assertThat(SchemaStatements.addColumn("issues", column, PostgresDialect))
            .isEqualTo("alter table issues add column producer varchar(40) null")
        assertThat(SchemaStatements.dropColumn("issues", "producer"))
            .isEqualTo("alter table issues drop column producer")
        assertThat(
            SchemaStatements.setNullable(
                "a3s_contexts",
                ColumnDef("branch_name", ColumnType.VARCHAR, nullable = true, limit = 255),
                PostgresDialect,
            ),
        ).containsExactly("alter table a3s_contexts alter column branch_name drop not null")
        assertThat(
            SchemaStatements.setNullable(
                "a3s_contexts",
                ColumnDef("branch_name", ColumnType.VARCHAR, nullable = false, limit = 255),
                H2Dialect,
            ),
        ).containsExactly("alter table a3s_contexts alter column branch_name set not null")
        assertThat(SchemaStatements.renameTable("arch_intended", "arch_models"))
            .isEqualTo("alter table arch_intended rename to arch_models")
        assertThat(SchemaStatements.renameConstraint("arch_models", "pk_arch_intended", "pk_arch_models", PostgresDialect))
            .isEqualTo("alter table arch_models rename constraint pk_arch_intended to pk_arch_models")
    }

    @Test
    fun `generated names are validated`() {
        assertThatThrownBy {
            SchemaStatements.createIndex("issues", "Issues_Index", listOf("kee"))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*CreateTableBuilder*' --tests '*SchemaStatements*'`
Expected: FAIL — unresolved references.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

/**
 * Builds one table's DDL. The builder owns the naming rules that make a schema comparable across
 * databases: one primary-key naming convention, declared column order, and a single auto-increment
 * column.
 */
class CreateTableBuilder(table: String, private val dialect: Dialect) {
    private val table = Identifiers.table(table)
    private val columns = mutableListOf<ColumnDef>()
    private var primaryKeyColumns = emptyList<String>()
    private var constraintName: String? = null

    fun column(column: ColumnDef): CreateTableBuilder = apply { columns += column }

    fun primaryKey(vararg columns: String): CreateTableBuilder = apply {
        primaryKeyColumns = columns.map(Identifiers::column)
    }

    fun primaryKeyName(name: String): CreateTableBuilder = apply {
        constraintName = Identifiers.constraint(name)
    }

    fun build(): List<String> {
        check(columns.isNotEmpty()) { "Table $table declares no column" }
        val generated = columns.filter { it.autoIncrement }
        require(generated.size <= 1) { "Table $table declares ${generated.size} auto-increment columns" }
        generated.forEach { column ->
            require(column.name == "id") {
                "Auto-increment column '${column.name}' in $table must be named id"
            }
            require(!column.nullable) { "Auto-increment column id in $table must be nonnullable" }
            require(column.type in NUMERIC_TYPES) { "Auto-increment column id in $table must be numeric" }
        }
        val body = columns.map { it.render(dialect) }.toMutableList()
        if (primaryKeyColumns.isNotEmpty()) {
            val name = constraintName ?: Identifiers.constraint("pk_$table")
            body += "constraint $name primary key (${primaryKeyColumns.joinToString(", ")})"
        }
        return listOf("create table $table (${body.joinToString(", ")})")
    }

    private companion object {
        val NUMERIC_TYPES = setOf(ColumnType.INTEGER, ColumnType.BIGINT)
    }
}
```

```kotlin
package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

/** Index, column, and rename statements. Every name passes identifier validation first. */
object SchemaStatements {
    fun createIndex(table: String, name: String, columns: List<String>, unique: Boolean = false): String {
        val target = Identifiers.table(table)
        val index = Identifiers.index(name)
        val kind = if (unique) "create unique index" else "create index"
        return "$kind $index on $target (${columns.map(Identifiers::column).joinToString(", ")})"
    }

    fun dropIndex(table: String, name: String, dialect: Dialect): String {
        Identifiers.table(table)
        return "drop index ${Identifiers.existing(name)}"
    }

    fun renameIndex(from: String, to: String, dialect: Dialect): String =
        "alter index ${Identifiers.existing(from)} rename to ${Identifiers.index(to)}"

    fun addColumn(table: String, column: ColumnDef, dialect: Dialect): String =
        "alter table ${Identifiers.table(table)} add column ${column.render(dialect)}"

    fun dropColumn(table: String, column: String): String =
        "alter table ${Identifiers.table(table)} drop column ${Identifiers.column(column)}"

    fun setNullable(table: String, column: ColumnDef, dialect: Dialect): List<String> {
        val action = if (column.nullable) "drop not null" else "set not null"
        return listOf(
            "alter table ${Identifiers.table(table)} alter column ${column.name} $action",
        )
    }

    fun renameTable(from: String, to: String): String =
        "alter table ${Identifiers.table(from)} rename to ${Identifiers.table(to)}"

    fun renameConstraint(table: String, from: String, to: String, dialect: Dialect): String =
        "alter table ${Identifiers.table(table)} rename constraint ${Identifiers.existing(from)} " +
            "to ${Identifiers.constraint(to)}"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test --tests '*CreateTableBuilder*' --tests '*SchemaStatements*'`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add schema ddl builders"
```

---

### Task 8: Migration numbers, steps, and registry

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationNumber.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationStep.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationRegistry.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/migration/MigrationRegistryTest.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/migration/MigrationStepTest.kt`

**Interfaces:**
- Consumes: `Database`, `SessionFactory`, `DbSession`, `Dialect`.
- Produces:
  - `object MigrationNumber { fun parse(text: String): Long; fun format(number: Long): String }`; `parse` accepts `YYYY_MM_NNN`, rejects anything else, and returns the digits as a decimal number.
  - `class MigrationContext(private val sessions: SessionFactory, val dialect: Dialect)` with `fun ddl(statements: List<String>)`, `fun <T> read(block: (DbSession) -> T): T`, `fun write(block: (DbSession) -> Unit)`.
  - `interface MigrationStep { fun execute(context: MigrationContext) }`.
  - `abstract class DdlChange : MigrationStep` with `abstract fun statements(dialect: Dialect): List<String>` and a final `execute` committing after each statement.
  - `data class Migration(val number: Long, val description: String, val step: MigrationStep)`.
  - `class MigrationRegistry` with `fun register(number: String, description: String, step: MigrationStep): MigrationRegistry`, `fun all(): List<Migration>`, `fun above(recorded: Long?): List<Migration>`, `val maximum: Long?`.

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.dialect.Dialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class MigrationRegistryTest {
    private object NoopStep : MigrationStep {
        override fun execute(context: MigrationContext) = Unit
    }

    @Test
    fun `numbers parse from the dated form and compare numerically`() {
        assertThat(MigrationNumber.parse("2026_09_001")).isEqualTo(2026_09_001L)
        assertThat(MigrationNumber.format(2026_09_001L)).isEqualTo("2026_09_001")
        assertThat(MigrationNumber.parse("2026_09_002")).isGreaterThan(MigrationNumber.parse("2026_09_001"))
        listOf("2026-09-001", "2026_9_1", "abc", "", "-2026_09_001").forEach { text ->
            assertThatThrownBy { MigrationNumber.parse(text) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `registry orders numerically and rejects duplicates and empty descriptions`() {
        val registry = MigrationRegistry()
            .register("2026_09_002", "create metrics", NoopStep)
            .register("2026_09_001", "create projects", NoopStep)
        assertThat(registry.all().map { it.number })
            .containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(registry.maximum).isEqualTo(2026_09_002L)

        assertThatThrownBy { registry.register("2026_09_001", "again", NoopStep) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("2026_09_001")
        assertThatThrownBy { registry.register("2026_09_003", " ", NoopStep) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("description")
    }

    @Test
    fun `selection starts above the recorded maximum`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "one", NoopStep)
            .register("2026_09_002", "two", NoopStep)
            .register("2026_09_003", "three", NoopStep)
        assertThat(MigrationRegistry().maximum).isNull()
        assertThat(registry.above(null).map { it.number }).hasSize(3)
        assertThat(registry.above(2026_09_001L).map { it.number })
            .containsExactly(2026_09_002L, 2026_09_003L)
        assertThat(registry.above(2026_09_003L)).isEmpty()
    }
}
```

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MigrationStepTest {
    private lateinit var database: Database
    private lateinit var context: MigrationContext

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:step-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        context = MigrationContext(SessionFactory(database), database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `a multi statement ddl step commits per statement so a later failure keeps earlier work`() {
        val step = object : DdlChange() {
            override fun statements(dialect: Dialect) = listOf(
                "create table alpha (id int)",
                "create table beta (id int)",
                "create table beta (id int)",
            )
        }
        assertThatThrownBy { step.execute(context) }.isInstanceOf(Exception::class.java)
        assertThat(tables()).contains("ALPHA", "BETA")
    }

    @Test
    fun `data steps read and write through separate sessions`() {
        object : DdlChange() {
            override fun statements(dialect: Dialect) = listOf("create table counts (id int, total int)")
        }.execute(context)

        context.write { session ->
            session.update("insert into counts (id, total) values (1, 10)")
            session.commit()
        }
        val total = context.read { session -> session.select("select total from counts") { it.getInt(1) } }
        assertThat(total).containsExactly(10)
    }

    private fun tables(): List<String> = context.read { session ->
        session.select(
            "select table_name from information_schema.tables where table_schema = 'PUBLIC'",
        ) { it.getString(1) }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*Migration*'`
Expected: FAIL — unresolved references `MigrationNumber`, `MigrationRegistry`, `MigrationContext`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.migration

/** Migration numbers are `YYYY_MM_NNN` in text and a decimal number in comparisons and history. */
object MigrationNumber {
    private val shape = Regex("(\\d{4})_(\\d{2})_(\\d{3})")

    fun parse(text: String): Long {
        val match = shape.matchEntire(text)
            ?: throw IllegalArgumentException("Migration number '$text' must have the form YYYY_MM_NNN")
        return match.groupValues.drop(1).joinToString("").toLong()
    }

    fun format(number: Long): String {
        require(number >= 0) { "Migration number $number must be nonnegative" }
        val text = number.toString().padStart(9, '0')
        return "${text.substring(0, 4)}_${text.substring(4, 6)}_${text.substring(6)}"
    }
}
```

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.session.DbSession
import com.leveret.inspect.db.session.SessionFactory

/**
 * The database handles a step is allowed to use. Schema work commits per statement, so a step that
 * emits several statements is deliberately not atomic as a whole; data work gets a separate reader and
 * writer.
 */
class MigrationContext(private val sessions: SessionFactory, val dialect: Dialect) {
    fun ddl(statements: List<String>) {
        sessions.openWriter().use { session ->
            statements.forEach { statement ->
                session.execute(statement)
                session.commit()
            }
        }
    }

    fun <T> read(block: (DbSession) -> T): T = sessions.openReadOnly().use { session ->
        session.relaxIsolationIfSupported()
        block(session)
    }

    fun write(block: (DbSession) -> Unit) = sessions.openWriter().use(block)
}

interface MigrationStep {
    fun execute(context: MigrationContext)
}

/** Schema change expressed as generated statements, committed one by one. */
abstract class DdlChange : MigrationStep {
    abstract fun statements(dialect: Dialect): List<String>

    final override fun execute(context: MigrationContext) = context.ddl(statements(context.dialect))
}

data class Migration(val number: Long, val description: String, val step: MigrationStep)
```

```kotlin
package com.leveret.inspect.db.migration

/**
 * Steps register themselves here; ordering is numeric, never declaration order. The registry ships
 * empty: each part contributes the steps that build its own tables.
 */
class MigrationRegistry {
    private val migrations = sortedMapOf<Long, Migration>()

    fun register(number: String, description: String, step: MigrationStep): MigrationRegistry = apply {
        val parsed = MigrationNumber.parse(number)
        require(parsed !in migrations) { "Migration number $number is already registered" }
        require(description.isNotBlank()) { "Migration $number needs a nonempty description" }
        migrations[parsed] = Migration(parsed, description, step)
    }

    fun all(): List<Migration> = migrations.values.toList()

    fun above(recorded: Long?): List<Migration> =
        if (recorded == null) all() else migrations.tailMap(recorded + 1).values.toList()

    val maximum: Long? get() = migrations.keys.maxOrNull()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test --tests '*Migration*'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add migration numbers, steps, and registry"
```

---

### Task 9: Migration history and database version state

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationHistory.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/DatabaseVersion.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/migration/MigrationHistoryTest.kt`

**Interfaces:**
- Consumes: `SessionFactory`, `Dialect`, `MigrationRegistry`.
- Produces:
  - `class MigrationHistory(private val sessions: SessionFactory, private val dialect: Dialect)` with `fun ensureTable()`, `fun recordedNumbers(): List<Long>`, `fun maximum(): Long?`, `fun record(number: Long)`, and `companion object { const val TABLE = "schema_migrations"; const val COLUMN = "version"; const val COLUMN_LENGTH = 255 }`.
  - `enum class VersionState { FRESH_INSTALL, UP_TO_DATE, REQUIRES_UPGRADE, REQUIRES_DOWNGRADE }`.
  - `object DatabaseVersion { fun state(recordedMaximum: Long?, registryMaximum: Long?): VersionState }`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MigrationHistoryTest {
    private lateinit var database: Database
    private lateinit var history: MigrationHistory

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:history-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        history = MigrationHistory(SessionFactory(database), database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `history table is created once and idempotently`() {
        history.ensureTable()
        history.ensureTable()
        assertThat(history.recordedNumbers()).isEmpty()
        assertThat(history.maximum()).isNull()
    }

    @Test
    fun `recorded numbers are durable and the maximum is current`() {
        history.ensureTable()
        history.record(2026_09_002L)
        history.record(2026_09_001L)
        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(history.maximum()).isEqualTo(2026_09_002L)
    }

    @Test
    fun `version state compares recorded and registry maxima`() {
        assertThat(DatabaseVersion.state(null, 2026_09_002L)).isEqualTo(VersionState.FRESH_INSTALL)
        assertThat(DatabaseVersion.state(2026_09_002L, 2026_09_002L)).isEqualTo(VersionState.UP_TO_DATE)
        assertThat(DatabaseVersion.state(2026_09_001L, 2026_09_002L)).isEqualTo(VersionState.REQUIRES_UPGRADE)
        assertThat(DatabaseVersion.state(2026_09_003L, 2026_09_002L)).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
        assertThat(DatabaseVersion.state(null, null)).isEqualTo(VersionState.FRESH_INSTALL)
        assertThat(DatabaseVersion.state(2026_09_001L, null)).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test --tests '*MigrationHistoryTest'`
Expected: FAIL — unresolved reference `MigrationHistory`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.session.SessionFactory

/**
 * Privileged control state: one row per successfully completed step. A number is written only after
 * its step returns, and never to suppress an error.
 */
class MigrationHistory(private val sessions: SessionFactory, private val dialect: Dialect) {
    fun ensureTable() {
        sessions.openWriter().use { session ->
            session.execute(
                "create table if not exists $TABLE ($COLUMN varchar($COLUMN_LENGTH) not null)",
            )
            session.commit()
        }
    }

    fun recordedNumbers(): List<Long> = sessions.openReadOnly().use { session ->
        session.select("select $COLUMN from $TABLE") { it.getString(1) }
            .map(MigrationNumber::parse)
            .sorted()
    }

    fun maximum(): Long? = recordedNumbers().maxOrNull()

    /** Uses its own committed connection, so history survives a later failure in the same run. */
    fun record(number: Long) {
        sessions.openWriter().use { session ->
            session.update("insert into $TABLE ($COLUMN) values (?)") {
                it.setString(1, MigrationNumber.format(number))
            }
            session.commit()
        }
    }

    companion object {
        const val TABLE = "schema_migrations"
        const val COLUMN = "version"
        const val COLUMN_LENGTH = 255
    }
}
```

```kotlin
package com.leveret.inspect.db.migration

enum class VersionState { FRESH_INSTALL, UP_TO_DATE, REQUIRES_UPGRADE, REQUIRES_DOWNGRADE }

/** A schema newer than this build is never treated as current; no reverse migration exists. */
object DatabaseVersion {
    fun state(recordedMaximum: Long?, registryMaximum: Long?): VersionState = when {
        recordedMaximum == null -> VersionState.FRESH_INSTALL
        registryMaximum == null -> VersionState.REQUIRES_DOWNGRADE
        recordedMaximum == registryMaximum -> VersionState.UP_TO_DATE
        recordedMaximum < registryMaximum -> VersionState.REQUIRES_UPGRADE
        else -> VersionState.REQUIRES_DOWNGRADE
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test --tests '*MigrationHistoryTest'`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add migration history and version state"
```

---

### Task 10: Migration engine, status, and progress

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationState.kt`
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/migration/MigrationEngine.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/migration/MigrationEngineTest.kt`

**Interfaces:**
- Consumes: `MigrationRegistry`, `MigrationHistory`, `MigrationContext`, `DatabaseVersion`.
- Produces:
  - `enum class MigrationStatus { NO_MIGRATION, MIGRATION_RUNNING, MIGRATION_FAILED, MIGRATION_SUCCEEDED, NOT_SUPPORTED, MIGRATION_REQUIRED }`.
  - `class MigrationState(private val clock: Clock = Clock.systemUTC())`, single-threaded, with `val status: MigrationStatus`, `val startedAt: Instant?`, `val error: Throwable?`, `val completed: Int`, `val total: Int`, `fun expectedFinish(): Instant?`, `fun required()`, `fun notSupported()`, `fun start(total: Int)`, `fun stepCompleted()`, `fun failed(error: Throwable)`, `fun succeeded()`.
  - `class MigrationEngine(private val registry: MigrationRegistry, private val history: MigrationHistory, private val context: MigrationContext, val state: MigrationState = MigrationState())` with `fun run()` and `fun version(): VersionState`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.migration

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MigrationEngineTest {
    private lateinit var database: Database
    private lateinit var history: MigrationHistory
    private lateinit var context: MigrationContext

    private fun table(name: String) = object : DdlChange() {
        override fun statements(dialect: Dialect) = listOf("create table $name (id int)")
    }

    private val failing = object : MigrationStep {
        override fun execute(context: MigrationContext) = throw IllegalStateException("step failed")
    }

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:engine-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        val sessions = SessionFactory(database)
        history = MigrationHistory(sessions, database.dialect)
        context = MigrationContext(sessions, database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `a fresh database runs every step in order and records each success`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "create beta", table("beta"))
        val engine = MigrationEngine(registry, history, context)
        assertThat(engine.version()).isEqualTo(VersionState.FRESH_INSTALL)

        engine.run()

        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
        assertThat(engine.state.completed).isEqualTo(2)
        assertThat(engine.state.total).isEqualTo(2)
        assertThat(engine.version()).isEqualTo(VersionState.UP_TO_DATE)
    }

    @Test
    fun `execution stops at the first failure and a retry reselects it`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "fail", failing)
            .register("2026_09_003", "create gamma", table("gamma"))
        val engine = MigrationEngine(registry, history, context)

        assertThatThrownBy { engine.run() }.hasMessageContaining("step failed")

        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L)
        assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_FAILED)
        assertThat(engine.state.error).isInstanceOf(IllegalStateException::class.java)
        assertThat(engine.version()).isEqualTo(VersionState.REQUIRES_UPGRADE)

        val repaired = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "now works", table("beta"))
            .register("2026_09_003", "create gamma", table("gamma"))
        val retry = MigrationEngine(repaired, history, context)
        retry.run()
        assertThat(history.recordedNumbers())
            .containsExactly(2026_09_001L, 2026_09_002L, 2026_09_003L)
        assertThat(retry.state.total).isEqualTo(2)
    }

    @Test
    fun `an empty selection reports no migration and a newer schema runs nothing`() {
        val registry = MigrationRegistry().register("2026_09_001", "create alpha", table("alpha"))
        MigrationEngine(registry, history, context).run()

        val again = MigrationEngine(registry, history, context)
        again.run()
        assertThat(again.state.status).isEqualTo(MigrationStatus.NO_MIGRATION)

        history.record(2026_09_009L)
        val newer = MigrationEngine(registry, history, context)
        assertThat(newer.version()).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
        newer.run()
        assertThat(newer.state.status).isEqualTo(MigrationStatus.NOT_SUPPORTED)
        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_009L)
    }

    @Test
    fun `progress exposes counts and an estimate only after a step completes`() {
        val state = MigrationState()
        assertThat(state.status).isEqualTo(MigrationStatus.NO_MIGRATION)
        state.start(4)
        assertThat(state.status).isEqualTo(MigrationStatus.MIGRATION_RUNNING)
        assertThat(state.expectedFinish()).isNull()
        state.stepCompleted()
        assertThat(state.completed).isEqualTo(1)
        assertThat(state.expectedFinish()).isNotNull()
        state.succeeded()
        assertThat(state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test --tests '*MigrationEngineTest'`
Expected: FAIL — unresolved references `MigrationEngine`, `MigrationState`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.migration

import java.time.Clock
import java.time.Duration
import java.time.Instant

enum class MigrationStatus {
    NO_MIGRATION,
    MIGRATION_RUNNING,
    MIGRATION_FAILED,
    MIGRATION_SUCCEEDED,
    NOT_SUPPORTED,
    MIGRATION_REQUIRED,
}

/**
 * Operator-visible migration progress. Deliberately single-threaded: migration is serialized by
 * startup leadership, so this object is never shared between concurrent runs.
 */
class MigrationState(private val clock: Clock = Clock.systemUTC()) {
    var status: MigrationStatus = MigrationStatus.NO_MIGRATION
        private set
    var startedAt: Instant? = null
        private set
    var error: Throwable? = null
        private set
    var completed: Int = 0
        private set
    var total: Int = 0
        private set

    fun required() {
        status = MigrationStatus.MIGRATION_REQUIRED
    }

    fun notSupported() {
        status = MigrationStatus.NOT_SUPPORTED
    }

    fun start(total: Int) {
        this.total = total
        completed = 0
        error = null
        startedAt = clock.instant()
        status = MigrationStatus.MIGRATION_RUNNING
    }

    fun stepCompleted() {
        completed++
    }

    fun failed(error: Throwable) {
        this.error = error
        status = MigrationStatus.MIGRATION_FAILED
    }

    fun succeeded() {
        status = MigrationStatus.MIGRATION_SUCCEEDED
    }

    /** Available only while running and only after one step has provided a rate. */
    fun expectedFinish(): Instant? {
        val started = startedAt ?: return null
        if (status != MigrationStatus.MIGRATION_RUNNING || completed == 0) return null
        val elapsed = Duration.between(started, clock.instant())
        val remaining = (total - completed).toLong()
        return clock.instant().plus(elapsed.dividedBy(completed.toLong()).multipliedBy(remaining))
    }
}
```

```kotlin
package com.leveret.inspect.db.migration

import org.slf4j.LoggerFactory

/**
 * Runs the selected steps in numeric order, recording each success before starting the next step, and
 * stops at the first failure so the failing number stays selectable on the next run.
 */
class MigrationEngine(
    private val registry: MigrationRegistry,
    private val history: MigrationHistory,
    private val context: MigrationContext,
    val state: MigrationState = MigrationState(),
) {
    private val log = LoggerFactory.getLogger(MigrationEngine::class.java)

    fun version(): VersionState {
        history.ensureTable()
        return DatabaseVersion.state(history.maximum(), registry.maximum)
    }

    fun run() {
        history.ensureTable()
        val recorded = history.maximum()
        if (DatabaseVersion.state(recorded, registry.maximum) == VersionState.REQUIRES_DOWNGRADE) {
            state.notSupported()
            log.error(
                "Database schema {} is newer than this release, which supplies no reverse migration",
                recorded?.let(MigrationNumber::format),
            )
            return
        }
        val selected = registry.above(recorded)
        if (selected.isEmpty()) return
        state.start(selected.size)
        log.info("Running {} database migrations", selected.size)
        selected.forEach { migration ->
            val number = MigrationNumber.format(migration.number)
            val started = System.nanoTime()
            try {
                migration.step.execute(context)
            } catch (failure: Exception) {
                state.failed(failure)
                log.error("Migration {} '{}' failed", number, migration.description, failure)
                throw failure
            }
            history.record(migration.number)
            state.stepCompleted()
            log.info(
                "Migration {} '{}' completed in {} ms",
                number,
                migration.description,
                (System.nanoTime() - started) / 1_000_000,
            )
        }
        state.succeeded()
        log.info("All {} database migrations completed", selected.size)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test --tests '*MigrationEngineTest'`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add migration engine with progress state"
```

---

### Task 11: Charset and collation verification

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/charset/CharsetChecker.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/charset/CharsetCheckerTest.kt`

**Interfaces:**
- Consumes: `Dialect`, `H2Dialect`, `PostgresDialect`, `DbSession`.
- Produces:
  - `enum class CheckerState { FRESH_INSTALL, UPGRADE, STARTUP }`.
  - `interface CharsetHandler { fun check(session: DbSession, state: CheckerState, tables: Collection<String>) }`.
  - `object NoCharsetCheck : CharsetHandler` for H2.
  - `class PostgresCharsetHandler : CharsetHandler`, failing on a non-UTF-8 database encoding in every state and, in `UPGRADE` and `STARTUP`, on any varchar column of the supplied tables whose collation is neither inherited nor UTF-8.
  - `object CharsetChecker { fun handlerFor(dialect: Dialect): CharsetHandler }`, throwing `IllegalArgumentException` for any other dialect.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.charset

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

class CharsetCheckerTest {
    private object UnknownDialect : Dialect {
        override val id = "unknown"
        override fun quote(identifier: String) = identifier
        override fun identityClause() = "identity"
        override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>) = ""
    }

    @Test
    fun `h2 needs no check and an unsupported dialect fails`() {
        assertThat(CharsetChecker.handlerFor(H2Dialect)).isSameAs(NoCharsetCheck)
        assertThat(CharsetChecker.handlerFor(PostgresDialect)).isInstanceOf(PostgresCharsetHandler::class.java)
        assertThatThrownBy { CharsetChecker.handlerFor(UnknownDialect) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("unknown")
    }

    @Test
    fun `postgresql accepts a utf8 database and reports the encoding it found`() {
        val url = System.getenv("LEVERET_TEST_POSTGRES_URL")
        assumeTrue(url != null, "LEVERET_TEST_POSTGRES_URL is not configured")
        Database(
            DatabaseSettings(
                url = url!!,
                username = System.getenv("LEVERET_TEST_POSTGRES_USER") ?: "",
                password = System.getenv("LEVERET_TEST_POSTGRES_PASSWORD") ?: "",
                embedded = false,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        ).use { database ->
            database.start()
            val sessions = SessionFactory(database)
            sessions.openWriter().use { session ->
                session.execute("create table if not exists charset_probe (label varchar(40) not null)")
                session.commit()
                CharsetChecker.handlerFor(database.dialect)
                    .check(session, CheckerState.STARTUP, listOf("charset_probe"))
            }
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test --tests '*CharsetCheckerTest'`
Expected: FAIL — unresolved reference `CharsetChecker`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.charset

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import com.leveret.inspect.db.session.DbSession

enum class CheckerState { FRESH_INSTALL, UPGRADE, STARTUP }

/**
 * Text comparison and storage must behave identically across databases, so encoding is verified rather
 * than assumed. Nonconforming columns fail: silently rewriting an operator's database is worse than
 * refusing to start.
 */
interface CharsetHandler {
    fun check(session: DbSession, state: CheckerState, tables: Collection<String>)
}

object NoCharsetCheck : CharsetHandler {
    override fun check(session: DbSession, state: CheckerState, tables: Collection<String>) = Unit
}

class PostgresCharsetHandler : CharsetHandler {
    override fun check(session: DbSession, state: CheckerState, tables: Collection<String>) {
        val encoding = session
            .select("select pg_encoding_to_char(encoding) from pg_database where datname = current_database()") {
                it.getString(1)
            }
            .firstOrNull()
            .orEmpty()
        require(encoding.uppercase().replace("-", "") == "UTF8") {
            "Database encoding must be UTF-8 capable, was '$encoding'"
        }
        if (state == CheckerState.FRESH_INSTALL || tables.isEmpty()) return

        val offending = session.select(
            """
            select table_name, column_name, collation_name
            from information_schema.columns
            where table_schema = current_schema()
              and data_type in ('character varying', 'character')
              and collation_name is not null
              and upper(replace(collation_name, '-', '')) not like '%UTF8%'
            """.trimIndent(),
        ) { Triple(it.getString(1), it.getString(2), it.getString(3)) }
            .filter { (table, _, _) -> table in tables }

        require(offending.isEmpty()) {
            "Columns must inherit the default collation or use a UTF-8 collation: " +
                offending.joinToString(", ") { (table, column, collation) -> "$table.$column ($collation)" }
        }
    }
}

object CharsetChecker {
    fun handlerFor(dialect: Dialect): CharsetHandler = when (dialect) {
        H2Dialect -> NoCharsetCheck
        PostgresDialect -> PostgresCharsetHandler()
        else -> throw IllegalArgumentException(
            "No charset handler for dialect '${dialect.id}'",
        )
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test --tests '*CharsetCheckerTest'`
Expected: PASS, with the PostgreSQL test reported as skipped unless `LEVERET_TEST_POSTGRES_URL` is set.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add charset and collation verification"
```

---

### Task 12: Embedded database server

**Files:**
- Create: `persistence/src/main/kotlin/com/leveret/inspect/db/pool/EmbeddedDatabase.kt`
- Test: `persistence/src/test/kotlin/com/leveret/inspect/db/pool/EmbeddedDatabaseTest.kt`

**Interfaces:**
- Consumes: `DatabaseKeys`, `DatabaseSettings.embeddedUrl`.
- Produces:
  - `class EmbeddedDatabase(private val port: Int = DatabaseKeys.DEFAULT_EMBEDDED_PORT, private val baseDir: Path) : AutoCloseable` with `fun start()`, `val url: String`, `override fun close()`. The server binds loopback only and refuses to start twice.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import java.nio.file.Path
import java.sql.DriverManager
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EmbeddedDatabaseTest {
    @Test
    fun `embedded server serves the node database on loopback`(@TempDir dataDir: Path) {
        val port = freePort()
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            assertThat(embedded.url).isEqualTo(DatabaseSettings.embeddedUrl(port))
            DriverManager.getConnection(embedded.url, "", "").use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute("create table probe (id int)")
                    assertThat(statement.executeQuery("select count(*) from probe").next()).isTrue()
                }
            }
        }
        assertThat(dataDir.toFile().list()).isNotEmpty()
    }

    @Test
    fun `a second start is refused`(@TempDir dataDir: Path) {
        val port = freePort()
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            org.assertj.core.api.Assertions.assertThatThrownBy { embedded.start() }
                .isInstanceOf(IllegalStateException::class.java)
        }
    }

    private fun freePort(): Int = java.net.ServerSocket(0).use { it.localPort }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :persistence:test --tests '*EmbeddedDatabaseTest'`
Expected: FAIL — unresolved reference `EmbeddedDatabase`.

- [ ] **Step 3: Write minimal implementation**

```kotlin
package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.config.DatabaseSettings
import java.nio.file.Path
import org.h2.tools.Server
import org.slf4j.LoggerFactory

/**
 * The embedded database is a loopback server because web and compute are separate processes sharing
 * one database. It is an evaluation and test target, never a production one.
 */
class EmbeddedDatabase(
    private val port: Int = DatabaseKeys.DEFAULT_EMBEDDED_PORT,
    private val baseDir: Path,
) : AutoCloseable {
    private val log = LoggerFactory.getLogger(EmbeddedDatabase::class.java)
    private var server: Server? = null

    val url: String = DatabaseSettings.embeddedUrl(port)

    fun start() {
        check(server == null) { "Embedded database is already started on port $port" }
        server = Server.createTcpServer(
            "-tcpPort", port.toString(),
            "-baseDir", baseDir.toAbsolutePath().toString(),
            "-ifNotExists",
        ).start()
        log.info("Embedded database listening on {}", url)
    }

    override fun close() {
        server?.stop()
        server = null
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :persistence:test --tests '*EmbeddedDatabaseTest'`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add persistence/src
git commit -m "feat: add embedded database server"
```

---

### Task 13: Acceptance scenarios and operator template

**Files:**
- Create: `persistence/src/test/kotlin/com/leveret/inspect/db/acceptance/PersistenceAcceptanceTest.kt`
- Modify: `runtime/src/main/assembly/conf/leveret.properties`
- Modify: `runtime/src/test/kotlin/com/leveret/inspect/runtime/DistributionTest.kt`
- Modify: `docs/operating-the-node.md`

**Interfaces:**
- Consumes: every unit from Tasks 1 through 12.
- Produces: no new production types. The operator template documents every database key with its default, and the distribution test asserts the database keys appear.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.leveret.inspect.db.acceptance

import com.leveret.inspect.db.charset.CharsetChecker
import com.leveret.inspect.db.charset.CheckerState
import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.migration.DdlChange
import com.leveret.inspect.db.migration.MigrationContext
import com.leveret.inspect.db.migration.MigrationEngine
import com.leveret.inspect.db.migration.MigrationHistory
import com.leveret.inspect.db.migration.MigrationRegistry
import com.leveret.inspect.db.migration.MigrationStatus
import com.leveret.inspect.db.migration.VersionState
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.pool.EmbeddedDatabase
import com.leveret.inspect.db.schema.ColumnDef
import com.leveret.inspect.db.schema.ColumnType
import com.leveret.inspect.db.schema.CreateTableBuilder
import com.leveret.inspect.db.session.SessionFactory
import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/** The specification's acceptance scenarios, end to end against a real embedded database. */
class PersistenceAcceptanceTest {
    private val claims = object : DdlChange() {
        override fun statements(dialect: Dialect) = CreateTableBuilder("claims", dialect)
            .column(ColumnDef("uuid", ColumnType.VARCHAR, nullable = false, limit = ColumnDef.IDENTIFIER_LENGTH))
            .column(ColumnDef("state", ColumnType.VARCHAR, nullable = false, limit = 20))
            .primaryKey("uuid")
            .build()
    }

    @Test
    fun `scenario 1 and 2 embedded selection and its precedence`() {
        val defaults = Settings(DatabaseKeys.defaults)
        assertThat(DatabaseSettings.from(defaults) {}.url).isEqualTo("jdbc:h2:tcp://127.0.0.1:9092/leveret")

        val warnings = mutableListOf<String>()
        val withBoth = Settings(
            DatabaseKeys.defaults + mapOf(
                DatabaseKeys.EMBEDDED_PORT to "9600",
                DatabaseKeys.URL to "jdbc:postgresql://db.internal/leveret",
            ),
        )
        assertThat(DatabaseSettings.from(withBoth) { warnings += it }.embedded).isTrue()
        assertThat(warnings).hasSize(1)
    }

    @Test
    fun `scenario 6 7 8 and 9 migration lifecycle over a real database`(@TempDir dataDir: Path) {
        val port = java.net.ServerSocket(0).use { it.localPort }
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            val settings = Settings(
                DatabaseKeys.defaults + mapOf(DatabaseKeys.EMBEDDED_PORT to port.toString()),
            )
            Database(DatabaseSettings.from(settings) {}).use { database ->
                database.start()
                val sessions = SessionFactory(database)
                val history = MigrationHistory(sessions, database.dialect)
                val context = MigrationContext(sessions, database.dialect)
                val registry = MigrationRegistry().register("2026_09_001", "create claims", claims)

                val engine = MigrationEngine(registry, history, context)
                assertThat(engine.version()).isEqualTo(VersionState.FRESH_INSTALL)
                engine.run()
                assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
                assertThat(engine.version()).isEqualTo(VersionState.UP_TO_DATE)

                CharsetChecker.handlerFor(database.dialect).let { handler ->
                    sessions.openReadOnly().use { handler.check(it, CheckerState.STARTUP, listOf("claims")) }
                }

                sessions.openWriter().use { session ->
                    session.update("insert into claims (uuid, state) values ('u1', 'PENDING')")
                    session.commit()
                }
                val claim = {
                    sessions.openWriter().use { session ->
                        val changed = session.update(
                            "update claims set state = 'IN_PROGRESS' where uuid = 'u1' and state = 'PENDING'",
                        )
                        session.commit()
                        changed
                    }
                }
                assertThat(claim()).isEqualTo(1)
                assertThat(claim()).isZero()

                history.record(2026_12_001L)
                val newer = MigrationEngine(registry, history, context)
                assertThat(newer.version()).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
                newer.run()
                assertThat(newer.state.status).isEqualTo(MigrationStatus.NOT_SUPPORTED)

                assertThat(database.stats().maxActive).isEqualTo(60)
            }
        }
    }
}
```

Extend `runtime/src/test/kotlin/com/leveret/inspect/runtime/DistributionTest.kt`:

```kotlin
    @Test
    fun `template documents the database keys`() {
        val text = Files.readString(Path.of("src/main/assembly/conf/leveret.properties"))
        listOf(
            "leveret.jdbc.username",
            "leveret.jdbc.maxActive",
            "leveret.jdbc.maxWait",
            "leveret.embeddedDatabase.port",
            "leveret.autoDatabaseUpgrade",
        ).forEach { key -> assertThat(text).contains(key) }
        assertThat(text).doesNotContain("oracle", "sqlserver")
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./gradlew :persistence:test --tests '*PersistenceAcceptanceTest' :runtime:test --tests '*DistributionTest'`
Expected: FAIL — acceptance class missing; template lacks the database keys.

- [ ] **Step 3: Write minimal implementation**

Add a database section to `runtime/src/main/assembly/conf/leveret.properties`, keeping the existing comment style: every key above with its default value, the note that an absent URL and port select the embedded database on port 9092, the supported provider tokens `h2` and `postgresql`, the sizing guidance of roughly 1.2 times the maximum HTTP worker count for `leveret.jdbc.maxActive`, the note that `leveret.jdbc.maxWait=0` means the finite `2147483647` ms sentinel, and the warning that the embedded database is for evaluation only.

Add a "Database" section to `docs/operating-the-node.md` documenting: embedded versus external selection, the two supported providers, credential handling, pool sizing, the forward-only migration contract with `leveret.autoDatabaseUpgrade`, what `REQUIRES_DOWNGRADE` means for recovery, and that SQL trace logging through logger `sql` is privileged diagnostic output.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./gradlew :persistence:test :runtime:test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add persistence/src runtime/src docs/operating-the-node.md
git commit -m "test: add persistence acceptance scenarios and operator template"
```

---

## Self-Review

**Spec coverage.** Section 4 supported databases: Tasks 1 and 2, with Oracle and SQL Server recorded as decisions. Section 4.2 driver discovery: dropped by decision, drivers are build dependencies. Section 5 configuration: Task 2. Section 6 aggregates: the mapper-registration model is replaced by sessions in Task 5; domain aggregates belong to their owning parts. Section 7 transactions: Tasks 5 and 8. Section 8.1 identifier and type rules: Tasks 6 and 7. Section 8.2 canonical inventory: dropped by decision; charset checking takes the caller's table set. Section 8.3 charset: Task 11, PostgreSQL only. Section 9 migration states, history, processing: Tasks 8, 9, and 10; the historical catalog is dropped by decision. Section 10 dialect behavior: Task 1 plus per-builder use in Tasks 6 and 7. Section 11 profiling and observability: Tasks 3 and 4; JMX publication deferred to telemetry. Section 12 failure behavior: Tasks 2, 3, 10, and 11. Section 13 security: identifier validation in Task 6, bound parameters in Task 5, privileged history in Task 9, trace warning in Task 13. Section 14 limits: Global Constraints. Section 15 acceptance scenarios: Task 13, with scenarios 5 and the SQL Server parts of 3 recorded as decisions.

**Placeholder scan.** Every code step contains complete Kotlin. Task 13's template and documentation steps enumerate the exact keys and topics to write rather than deferring content.

**Type consistency.** `Dialect`, `Dialects`, `DatabaseKeys`, `DatabaseSettings`, `PoolSettings`, `Database`, `PoolStats`, `SqlLogFormatter`, `SqlProfiler`, `DbSession`, `SessionFactory`, `LargeInputs`, `Identifiers`, `ColumnDef`, `ColumnType`, `CreateTableBuilder`, `SchemaStatements`, `MigrationNumber`, `MigrationContext`, `MigrationStep`, `DdlChange`, `Migration`, `MigrationRegistry`, `MigrationHistory`, `VersionState`, `DatabaseVersion`, `MigrationStatus`, `MigrationState`, `MigrationEngine`, `CheckerState`, `CharsetHandler`, `NoCharsetCheck`, `PostgresCharsetHandler`, `CharsetChecker`, and `EmbeddedDatabase` are each defined once and used with the same names and signatures downstream. `DatabaseSettings.embeddedUrl` is defined in Task 2 and reused in Task 12. `DbSession.relaxIsolationIfSupported` is defined in Task 5 and used by `MigrationContext.read` in Task 8.
