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
