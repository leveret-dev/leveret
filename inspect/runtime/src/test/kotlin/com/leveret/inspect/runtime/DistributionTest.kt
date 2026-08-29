package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.PropertyKeys
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class DistributionTest {
    @Test
    fun `template documents every recognized key with its default`() {
        val text = Files.readString(Path.of("src/main/assembly/conf/leveret.properties"))
        PropertyKeys.defaults.forEach { (key, default) ->
            assertThat(text).contains(key)
            if (default.isNotEmpty()) assertThat(text).contains(default)
        }
        assertThat(text).contains(PropertyKeys.JDBC_URL, PropertyKeys.ENABLE_STOP_COMMAND)
        assertThat(text).doesNotContain("cluster")
    }

    @Test
    fun `template documents the database keys`() {
        val text = Files.readString(Path.of("src/main/assembly/conf/leveret.properties"))
        listOf(
            "leveret.jdbc.username",
            "leveret.jdbc.password",
            "leveret.jdbc.maxActive",
            "leveret.jdbc.minIdle",
            "leveret.jdbc.maxWait",
            "leveret.jdbc.idleTimeout",
            "leveret.jdbc.keepaliveTime",
            "leveret.jdbc.maxLifetime",
            "leveret.jdbc.validationTimeout",
            "leveret.embeddedDatabase.port",
            "leveret.autoDatabaseUpgrade",
        ).forEach { key -> assertThat(text).contains(key) }
        assertThat(text).doesNotContain("oracle", "sqlserver")
    }
}
