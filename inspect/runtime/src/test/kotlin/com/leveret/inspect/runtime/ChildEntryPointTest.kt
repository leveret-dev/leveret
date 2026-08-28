package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.proc.CommandFactory
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ChildEntryPointTest {
    private class FakeComponent : MonitoredComponent {
        val started = AtomicBoolean(false)
        val operationalNow = AtomicBoolean(false)
        val stopped = CountDownLatch(1)
        val hardStopped = AtomicBoolean(false)
        override fun start() { started.set(true) }
        override fun isUp() = started.get()
        override fun isOperational() = operationalNow.get()
        override fun stop() { stopped.countDown() }
        override fun hardStop() { hardStopped.set(true); stopped.countDown() }
    }

    @Test
    fun `publishes up then operational and stops on command`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            val commands = file.mainView(ProcessId.WEB.index)
            val component = FakeComponent()
            val entryPoint = ChildEntryPoint(
                Settings(mapOf("process.gracefulStopTimeout" to "5000")),
                commands,
                component,
            )
            val thread = Thread { entryPoint.launch() }.apply { isDaemon = true; start() }

            await().atMost(5, TimeUnit.SECONDS).untilAsserted {
                assertThat(commands.up).isTrue()
                assertThat(commands.operational).isFalse()
            }
            component.operationalNow.set(true)
            await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(commands.operational).isTrue() }

            commands.askedForStop = true
            assertThat(component.stopped.await(5, TimeUnit.SECONDS)).isTrue()
            thread.join(5_000)
            assertThat(component.hardStopped).isFalse()
        }
    }

    @Test
    fun `hard stop command bypasses graceful stop`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            val commands = file.mainView(ProcessId.COMPUTE.index)
            val component = FakeComponent()
            val thread = Thread {
                ChildEntryPoint(Settings(mapOf("process.gracefulStopTimeout" to "5000")), commands, component).launch()
            }.apply { isDaemon = true; start() }

            await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(commands.up).isTrue() }
            commands.askedForHardStop = true
            assertThat(component.stopped.await(5, TimeUnit.SECONDS)).isTrue()
            assertThat(component.hardStopped).isTrue()
            thread.join(5_000)
        }
    }

    @Test
    fun `fromHandoffFile binds the slot named by the handoff index`(@TempDir dir: Path) {
        val handoff = dir.resolve("web.properties")
        val properties = Properties().apply {
            setProperty(CommandFactory.HANDOFF_KEY, ProcessId.WEB.key)
            setProperty(CommandFactory.HANDOFF_INDEX, ProcessId.WEB.index.toString())
            setProperty(CommandFactory.HANDOFF_GRACEFUL_STOP_TIMEOUT, "5000")
            setProperty(CommandFactory.HANDOFF_SHARED_DIR, dir.toString())
        }
        Files.newOutputStream(handoff).use { properties.store(it, null) }

        val component = FakeComponent()
        val entryPoint = ChildEntryPoint.fromHandoffFile(handoff, component)
        val thread = Thread { entryPoint.launch() }.apply { isDaemon = true; start() }

        CommandFile(dir).use { file ->
            val web = file.view(ProcessId.WEB.index)
            val compute = file.view(ProcessId.COMPUTE.index)
            await().atMost(5, TimeUnit.SECONDS).untilAsserted { assertThat(web.up).isTrue() }
            assertThat(compute.up).isFalse()

            web.askedForStop = true
            assertThat(component.stopped.await(5, TimeUnit.SECONDS)).isTrue()
            thread.join(5_000)
            assertThat(component.hardStopped).isFalse()
        }
    }
}
