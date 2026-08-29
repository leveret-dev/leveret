package com.leveret.inspect.db.config

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class DatabaseSettingsTest {
    private fun settings(home: Path, vararg extra: Pair<String, String>) = Settings(
        DatabaseKeys.defaults + mapOf(PropertyKeys.PATH_HOME to home.toString()) + extra,
    )

    @Test
    fun `the store lives in the runtime data directory`(@TempDir home: Path) {
        val resolved = DatabaseSettings.from(settings(home))
        assertThat(resolved.url).isEqualTo("jdbc:h2:file:${home.resolve("data").resolve("leveret")}")
    }

    @Test
    fun `a relocated data directory moves the store with it`(@TempDir home: Path) {
        val resolved = DatabaseSettings.from(settings(home, PropertyKeys.PATH_DATA to "store"))
        assertThat(resolved.url).isEqualTo("jdbc:h2:file:${home.resolve("store").resolve("leveret")}")
    }

    @Test
    fun `an explicit url overrides the derived location`(@TempDir home: Path) {
        val resolved = DatabaseSettings.from(settings(home, DatabaseKeys.URL to " jdbc:h2:mem:probe "))
        assertThat(resolved.url).isEqualTo("jdbc:h2:mem:probe")
    }

    @Test
    fun `a blank url is no override at all`(@TempDir home: Path) {
        val resolved = DatabaseSettings.from(settings(home, DatabaseKeys.URL to "   "))
        assertThat(resolved.url).startsWith("jdbc:h2:file:")
    }

    @Test
    fun `the pool size defaults and is configurable`(@TempDir home: Path) {
        assertThat(DatabaseSettings.from(settings(home)).poolSize).isEqualTo(8)
        assertThat(DatabaseSettings.from(settings(home, DatabaseKeys.POOL_SIZE to "3")).poolSize)
            .isEqualTo(3)
    }

    @Test
    fun `a pool that cannot hold a connection is rejected`(@TempDir home: Path) {
        assertThatThrownBy { DatabaseSettings.from(settings(home, DatabaseKeys.POOL_SIZE to "0")) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining(DatabaseKeys.POOL_SIZE)
    }
}
