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
            assertThatThrownBy { JvmOptions(mandatory).add(bad) }
                .isInstanceOf(IllegalArgumentException::class.java)
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
