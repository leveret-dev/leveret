package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.LoggerContext
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.proc.ProcessId
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
        assertThat(
            LogConfig.rollingPolicy(
                Settings(mapOf("leveret.log.rollingPolicy" to "size:50MB", "leveret.log.maxFiles" to "3")),
            ),
        ).isEqualTo(RollingPolicy.Size("50MB", 3))
        assertThat(LogConfig.rollingPolicy(Settings(mapOf("leveret.log.rollingPolicy" to "none"))))
            .isEqualTo(RollingPolicy.None)
        assertThatThrownBy { LogConfig.rollingPolicy(Settings(mapOf("leveret.log.rollingPolicy" to "weekly"))) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `configure sends plain records at the process threshold to the process log file`(@TempDir home: Path) {
        val logFile = configure(
            home,
            ProcessId.APP,
            mapOf("leveret.log.rollingPolicy" to "none", "leveret.log.level.app" to "DEBUG"),
        )

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").debug("hello file")

        assertThat(Files.readString(logFile)).contains("app[").contains("hello file")
    }

    @Test
    fun `configure sends json records to a time-rolled file`(@TempDir home: Path) {
        val logFile = configure(home, ProcessId.WEB, mapOf("leveret.log.jsonOutput" to "true"))

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").info("time policy")

        assertThat(Files.readString(logFile)).contains("\"process\":\"web\"").contains("time policy")
    }

    @Test
    fun `configure sends records to a size-rolled file`(@TempDir home: Path) {
        val logFile = configure(home, ProcessId.COMPUTE, mapOf("leveret.log.rollingPolicy" to "size:1MB"))

        LoggerFactory.getLogger("com.leveret.inspect.runtime.Example").info("size policy")

        assertThat(Files.readString(logFile)).contains("ce[").contains("size policy")
    }

    /** Configures the shared logging backend and answers the expected active log file. */
    private fun configure(home: Path, id: ProcessId, extra: Map<String, String>): Path {
        val settings = Settings(mapOf(PropertyKeys.PATH_HOME to home.toString()) + extra)
        val fs = RuntimeFileSystem(settings)
        fs.reset()
        LogConfig.configure(settings, fs, id)
        return fs.logsDir.resolve(id.logFileName)
    }

    @AfterEach
    fun detachAppenders() {
        (LoggerFactory.getILoggerFactory() as LoggerContext).reset()
    }
}
