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
    private fun pathSettings(home: Path, extra: Map<String, String> = emptyMap()) = Settings(
        mapOf(
            "leveret.path.home" to home.toString(),
            "leveret.path.data" to "data",
            "leveret.path.logs" to "logs",
            "leveret.path.temp" to "temp",
            "leveret.path.web" to "web",
        ) + extra,
    )

    private fun fileSystem(home: Path): RuntimeFileSystem =
        RuntimeFileSystem(pathSettings(home)).also { it.reset() }

    @Test
    fun `child receives settings handoff file with internal keys`(@TempDir home: Path) {
        val fs = fileSystem(home)
        val settings = pathSettings(home, mapOf("leveret.web.gracefulStopTimeOutInMs" to "240000"))

        val command = CommandFactory(settings, fs, "java")
            .createFor(ProcessId.WEB, "com.example.Main", "app.jar")

        assertThat(command.arguments.first()).isEqualTo("java")
        assertThat(command.arguments).contains("com.example.Main")
        val handoff = requireNotNull(command.settingsFile)
        assertThat(handoff).exists().hasParent(fs.tempDir)
        assertThat(command.arguments.last()).isEqualTo(handoff.toString())

        val loaded = Properties().apply { Files.newInputStream(handoff).use { load(it) } }
        assertThat(loaded.getProperty("process.key")).isEqualTo("web")
        assertThat(loaded.getProperty("process.index")).isEqualTo("2")
        assertThat(loaded.getProperty("process.gracefulStopTimeout")).isEqualTo("270000")
        assertThat(loaded.getProperty("process.sharedDir")).isEqualTo(fs.tempDir.toString())
        assertThat(loaded.getProperty("leveret.path.logs")).isEqualTo(fs.logsDir.toString())
    }

    @Test
    fun `search command has no handoff file`(@TempDir home: Path) {
        val fs = fileSystem(home)
        val command = CommandFactory(pathSettings(home), fs, "java")
            .createFor(ProcessId.SEARCH, "com.example.Search", "search.jar")

        assertThat(command.settingsFile).isNull()
        assertThat(command.suppressedEnvironment).containsExactly("JAVA_TOOL_OPTIONS")
    }

    @Test
    fun `web command suppresses generic jvm tool options`(@TempDir home: Path) {
        val fs = fileSystem(home)
        val command = CommandFactory(pathSettings(home), fs, "java")
            .createFor(ProcessId.WEB, "com.example.Main", "app.jar")

        assertThat(command.suppressedEnvironment).containsExactly("JAVA_TOOL_OPTIONS")
    }

    @Test
    fun `mandatory options are present and cannot be overridden by settings`(@TempDir home: Path) {
        val fs = fileSystem(home)
        val command = CommandFactory(pathSettings(home), fs, "java")
            .createFor(ProcessId.COMPUTE, "com.example.Compute", "app.jar")

        assertThat(command.arguments).contains(
            "-Dfile.encoding=UTF-8",
            "-Djava.awt.headless=true",
            "-Djava.io.tmpdir=${fs.tempDir}",
        )

        val hostile = pathSettings(home, mapOf("leveret.ce.javaOpts" to "-Dfile.encoding=ISO-8859-1"))
        org.assertj.core.api.Assertions
            .assertThatThrownBy {
                CommandFactory(hostile, fs, "java").createFor(ProcessId.COMPUTE, "com.example.Compute", "app.jar")
            }.isInstanceOf(IllegalArgumentException::class.java)
    }

    @Test
    fun `proxy system properties propagate unless already set`(@TempDir home: Path) {
        val fs = fileSystem(home)
        System.setProperty("http.proxyHost", "proxy.internal")
        System.setProperty("http.proxyPort", "3128")
        try {
            val propagated = CommandFactory(pathSettings(home), fs, "java")
                .createFor(ProcessId.WEB, "com.example.Main", "app.jar")
            assertThat(propagated.arguments).contains("-Dhttp.proxyHost=proxy.internal", "-Dhttp.proxyPort=3128")

            val overridden = CommandFactory(
                pathSettings(home, mapOf("leveret.web.javaOpts" to "-Dhttp.proxyHost=explicit.internal")),
                fs,
                "java",
            ).createFor(ProcessId.WEB, "com.example.Main", "app.jar")
            assertThat(overridden.arguments)
                .contains("-Dhttp.proxyHost=explicit.internal")
                .doesNotContain("-Dhttp.proxyHost=proxy.internal")
        } finally {
            System.clearProperty("http.proxyHost")
            System.clearProperty("http.proxyPort")
        }
    }
}
