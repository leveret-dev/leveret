package com.leveret.inspect.runtime.acceptance

import com.leveret.inspect.runtime.Shutdowner
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/**
 * The specification's acceptance scenarios, exercised against a real monitor supervising real child
 * processes. Configuration precedence (scenario 2) is proven by the settings unit tests, which reach
 * every source directly.
 */
class NodeAcceptanceTest {
    private val nodes = mutableListOf<TestNode>()

    private fun node(home: Path): TestNode = TestNode(home).also { nodes.add(it) }

    @AfterEach
    fun stopNodes() = nodes.forEach { it.stopEverything() }

    private val startup: Duration = Duration.ofSeconds(60)

    @Test
    fun `scenario 1 standalone startup reaches operational state`(@TempDir home: Path) {
        val node = node(home)
        node.writeConfig()
        node.start()

        node.awaitOperational(startup)

        val monitorLog = node.logLines(ProcessId.APP)
        val searchUp = monitorLog.indexOfFirst { it.contains("Search is up") }
        val webUp = monitorLog.indexOfFirst { it.contains("Web Server is up") }
        val computeUp = monitorLog.indexOfFirst { it.contains("Compute Engine is up") }
        assertThat(searchUp).isGreaterThanOrEqualTo(0).isLessThan(webUp)
        assertThat(webUp).isLessThan(computeUp)
        assertThat(monitorLog).anySatisfy { assertThat(it).contains("Waiting for Search") }
        assertThat(node.logLines(ProcessId.WEB)).isNotEmpty()
        assertThat(node.logLines(ProcessId.COMPUTE)).isNotEmpty()
    }

    @Test
    fun `scenario 3 search never becomes ready`(@TempDir home: Path) {
        val node = node(home)
        node.healthColour = "red"
        node.writeConfig()
        node.start()

        node.awaitLog(ProcessId.APP, "Waiting for Search", startup)
        Thread.sleep(3_000)

        assertThat(node.logLines(ProcessId.APP)).noneSatisfy { assertThat(it).contains("is operational") }
        assertThat(node.logLines(ProcessId.WEB)).isEmpty()
        assertThat(node.logLines(ProcessId.COMPUTE)).isEmpty()
    }

    @Test
    fun `scenario 4 unexpected child loss stops the node`(@TempDir home: Path) {
        val node = node(home)
        node.writeConfig()
        node.start()
        node.awaitOperational(startup)

        node.childProcesses(ProcessId.WEB).forEach { it.destroyForcibly() }

        node.awaitLog(ProcessId.APP, "disappeared unexpectedly", startup)
        await().atMost(startup.toMillis(), TimeUnit.MILLISECONDS).untilAsserted {
            assertThat(node.searchProcesses()).isEmpty()
            assertThat(node.childProcesses(ProcessId.COMPUTE)).isEmpty()
        }
        assertThat(node.logLines(ProcessId.APP).count { it.contains("Web Server is up") }).isEqualTo(1)
    }

    @Test
    fun `scenario 5 graceful stop preserves reverse dependency order`(@TempDir home: Path) {
        val node = node(home)
        node.writeConfig("leveret.enableStopCommand=true")
        node.start()
        node.awaitOperational(startup)

        node.withCommands(ProcessId.APP) { it.askedForStop = true }

        node.awaitLog(ProcessId.APP, "Search stopped", startup)
        val stops = node.logLines(ProcessId.APP).filter { it.contains(" stopped") }
        assertThat(stops.indexOfFirst { it.contains("Compute Engine") })
            .isLessThan(stops.indexOfFirst { it.contains("Web Server") })
        assertThat(stops.indexOfFirst { it.contains("Web Server") })
            .isLessThan(stops.indexOfFirst { it.contains("Search") })
    }

    @Test
    fun `scenario 6 internal restart reschedules every child`(@TempDir home: Path) {
        val node = node(home)
        node.armRestartOnce()
        node.writeConfig()
        node.start()

        node.awaitOperational(startup)

        await().atMost(startup.toMillis(), TimeUnit.MILLISECONDS).untilAsserted {
            assertThat(node.logLines(ProcessId.APP).count { it.contains("Search is up") })
                .isGreaterThanOrEqualTo(2)
        }
        assertThat(node.logLines(ProcessId.APP)).anySatisfy { assertThat(it).contains("Search stopped") }
    }

    @Test
    fun `scenario 7 an immutable path change is rejected on restart`(@TempDir home: Path) {
        val node = node(home)
        node.armRestartOnce()
        node.writeConfig()
        node.start()
        node.awaitOperational(startup)

        Files.writeString(
            home.resolve("conf/leveret.properties"),
            Files.readString(home.resolve("conf/leveret.properties")) + "\nleveret.path.temp=other-temp\n",
        )
        node.withCommands(ProcessId.COMPUTE) { it.askedForRestart = true }

        node.awaitLog(ProcessId.APP, "Restart rejected", startup)
        assertThat(node.logLines(ProcessId.APP)).anySatisfy {
            assertThat(it).contains("leveret.path.temp cannot change")
        }
    }

    @Test
    fun `scenario 8 logging modes remain compatible`(@TempDir plain: Path, @TempDir json: Path) {
        val plainNode = node(plain)
        plainNode.writeConfig()
        plainNode.start()
        plainNode.awaitOperational(startup)

        assertThat(plain.resolve("logs/leveret.log")).exists()
        assertThat(plain.resolve("logs/web.log")).exists()
        assertThat(plain.resolve("logs/ce.log")).exists()
        assertThat(plainNode.logLines(ProcessId.APP).first()).contains("INFO", "app[")

        val jsonNode = node(json)
        jsonNode.writeConfig("leveret.log.jsonOutput=true", "leveret.log.level.web=DEBUG")
        jsonNode.start()
        jsonNode.awaitOperational(startup)

        assertThat(jsonNode.logLines(ProcessId.APP).first())
            .contains("\"process\":\"app\"", "\"severity\":", "\"logger\":", "\"message\":")
        assertThat(jsonNode.logLines(ProcessId.WEB).first()).contains("\"process\":\"web\"")
    }

    @Test
    fun `scenario 9 stale command state cannot make a node ready or restart it`(@TempDir home: Path) {
        val node = node(home)
        node.writeConfig()
        node.seedStaleCommands()

        node.start()
        node.awaitOperational(startup)

        assertThat(node.logLines(ProcessId.APP)).noneSatisfy { assertThat(it).contains("Restart") }
        assertThat(node.logLines(ProcessId.APP).count { it.contains("Search is up") }).isEqualTo(1)
    }

    @Test
    fun `scenario 10 the hard stop requester stops the node from any working directory`(@TempDir home: Path) {
        val node = node(home)
        node.writeConfig()
        node.start()
        node.awaitOperational(startup)

        Shutdowner.requestHardStop(home)

        node.awaitLog(ProcessId.APP, "Search stopped", startup)
        await().atMost(startup.toMillis(), TimeUnit.MILLISECONDS).untilAsserted {
            assertThat(node.searchProcesses()).isEmpty()
            assertThat(node.childProcesses(ProcessId.WEB)).isEmpty()
            assertThat(node.childProcesses(ProcessId.COMPUTE)).isEmpty()
        }
    }
}
