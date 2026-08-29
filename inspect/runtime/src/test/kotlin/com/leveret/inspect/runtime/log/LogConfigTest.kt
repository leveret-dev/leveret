package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.LoggerContext
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.slf4j.LoggerFactory

class LogConfigTest {
    @Test
    fun `level comes from the global key and falls back to INFO`() {
        assertThat(LogConfig.levelOf(Settings(mapOf("leveret.log.level" to "DEBUG"))).toString())
            .isEqualTo("DEBUG")
        assertThat(LogConfig.levelOf(Settings(mapOf("leveret.log.level" to " TRACE "))).toString())
            .isEqualTo("TRACE")
        assertThat(LogConfig.levelOf(Settings(emptyMap())).toString()).isEqualTo("INFO")
    }

    @Test
    fun `unsupported level fails configuration`() {
        assertThatThrownBy { LogConfig.levelOf(Settings(mapOf("leveret.log.level" to "WARN"))) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `configure sends plain records to the log file at the configured threshold`(@TempDir home: Path) {
        val logFile = configure(home, mapOf("leveret.log.level" to "DEBUG"))

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").debug("hello file")

        assertThat(Files.readString(logFile)).contains("leveret[").contains("hello file")
    }

    @Test
    fun `records below the threshold never reach the log file`(@TempDir home: Path) {
        val logFile = configure(home, mapOf("leveret.log.level" to "INFO"))

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").debug("too fine")

        assertThat(Files.readString(logFile)).doesNotContain("too fine")
    }

    @Test
    fun `configure sends json records to the same log file`(@TempDir home: Path) {
        val logFile = configure(home, mapOf("leveret.log.jsonOutput" to "true"))

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").info("json record")

        assertThat(Files.readString(logFile)).contains("\"process\":\"leveret\"").contains("json record")
    }

    /** Configures the shared logging backend and answers the single log file it writes. */
    private fun configure(home: Path, extra: Map<String, String>): Path {
        val settings = Settings(mapOf(PropertyKeys.PATH_HOME to home.toString()) + extra)
        val fs = RuntimeFileSystem(settings)
        fs.reset()
        LogConfig.configure(settings, fs)
        return fs.logsDir.resolve("leveret.log")
    }

    @AfterEach
    fun detachAppenders() {
        (LoggerFactory.getILoggerFactory() as LoggerContext).reset()
    }
}
