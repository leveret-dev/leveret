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
