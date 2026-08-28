package com.leveret.inspect.runtime.acceptance

import com.leveret.inspect.runtime.App
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.ipc.ProcessCommands
import com.leveret.inspect.runtime.proc.ProcessId
import java.io.IOException
import java.net.ServerSocket
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.TimeUnit
import org.awaitility.Awaitility.await

/**
 * Runs a real monitor over a temporary installation home with real child processes: the stub search
 * server and two stub children hosted by the child entry point.
 */
class TestNode(private val home: Path) {
    val searchPort: Int = freePort()

    private var monitor: Thread? = null

    fun writeConfig(vararg lines: String) {
        Files.createDirectories(home.resolve("conf"))
        val searchOptions = "-Dstub.health.port=$searchPort -Dstub.health.colour=$healthColour"
        val restartOptions = restartMarker?.let { "-Dstub.restart.marker=$it" } ?: ""
        Files.writeString(
            home.resolve("conf/leveret.properties"),
            (
                lines.toList() + listOf(
                    "leveret.search.port=$searchPort",
                    "leveret.search.javaOpts=$searchOptions",
                    "leveret.web.javaOpts=-Xmx128m $restartOptions",
                    "leveret.ce.javaOpts=-Xmx128m",
                )
                ).joinToString("\n"),
        )
    }

    var healthColour: String = "green"

    var restartMarker: Path? = null

    fun armRestartOnce(): Path {
        val marker = home.resolve("restart-once")
        Files.createDirectories(home)
        Files.writeString(marker, "restart")
        restartMarker = marker
        return marker
    }

    fun start(vararg args: String) {
        val app = App(
            home = home,
            args = arrayOf(*args),
            childMainClasses = mapOf(
                ProcessId.SEARCH to StubSearchMain::class.java.name,
                ProcessId.WEB to StubChildMain::class.java.name,
                ProcessId.COMPUTE to StubChildMain::class.java.name,
            ),
        )
        monitor = Thread({ app.run() }, "test-monitor").apply { isDaemon = true; start() }
    }

    fun awaitOperational(timeout: Duration) = awaitLog(ProcessId.APP, "is operational", timeout)

    fun awaitLog(id: ProcessId, fragment: String, timeout: Duration) {
        await().atMost(timeout.toMillis(), TimeUnit.MILLISECONDS).untilAsserted {
            org.assertj.core.api.Assertions.assertThat(logLines(id))
                .anySatisfy { line -> org.assertj.core.api.Assertions.assertThat(line).contains(fragment) }
        }
    }

    fun logLines(id: ProcessId): List<String> {
        val file = home.resolve("logs").resolve(id.logFileName)
        return if (Files.exists(file)) Files.readAllLines(file) else emptyList()
    }

    fun tempDir(): Path = home.resolve("temp")

    fun <T> withCommands(id: ProcessId, block: (ProcessCommands) -> T): T =
        CommandFile(tempDir()).use { block(it.view(id.index)) }

    fun seedStaleCommands() {
        Files.createDirectories(tempDir())
        CommandFile(tempDir()).use { file ->
            file.view(ProcessId.WEB.index).apply { up = true; operational = true }
            file.view(ProcessId.COMPUTE.index).askedForRestart = true
        }
    }

    /** Child JVMs of this node, identified by the handoff file each one was launched with. */
    fun childProcesses(id: ProcessId): List<ProcessHandle> =
        ProcessHandle.allProcesses()
            .filter { handle ->
                handle.info().commandLine().orElse("").let { line ->
                    line.contains(tempDir().toString()) && line.contains("${id.key}-")
                }
            }
            .toList()

    fun searchProcesses(): List<ProcessHandle> =
        ProcessHandle.allProcesses()
            .filter { it.info().commandLine().orElse("").contains("stub.health.port=$searchPort") }
            .toList()

    fun stopEverything() {
        (childProcesses(ProcessId.WEB) + childProcesses(ProcessId.COMPUTE) + searchProcesses())
            .forEach { it.destroyForcibly() }
        monitor?.interrupt()
    }

    private fun freePort(): Int =
        try {
            ServerSocket(0).use { it.localPort }
        } catch (e: IOException) {
            throw IllegalStateException("No free port for the stub search server", e)
        }
}
