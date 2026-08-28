package com.leveret.inspect.runtime.proc

import java.time.Duration
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test

class ChildHandlerTest {
    private class FakeProcess(override val id: ProcessId = ProcessId.WEB) : ManagedProcess {
        @Volatile var alive = false

        @Volatile var operational = false

        @Volatile var obeysGracefulStop = true

        @Volatile var destroyed = false

        val stopRequests = AtomicInteger()
        val hardStopRequests = AtomicInteger()

        override fun start() {
            alive = true
        }

        override fun isAlive(): Boolean = alive

        override fun isOperational(): Boolean = operational

        override fun askForStop() {
            stopRequests.incrementAndGet()
            if (obeysGracefulStop) alive = false
        }

        override fun askForHardStop() {
            hardStopRequests.incrementAndGet()
        }

        override fun waitForStop(timeout: Duration): Boolean = !alive

        override fun destroyForcibly() {
            destroyed = true
            alive = false
        }

        override val exitCode: Int? get() = if (alive) null else 0
    }

    private val exits = ConcurrentLinkedQueue<ProcessId>()
    private val operationalEvents = ConcurrentLinkedQueue<ProcessId>()

    private fun handlerFor(process: FakeProcess) =
        ChildHandler(
            id = process.id,
            process = process,
            pollInterval = Duration.ofMillis(20),
            onOperational = { operationalEvents.add(it) },
            onUnexpectedExit = { exits.add(it) },
        )

    @Test
    fun `operational event fires exactly once`() {
        val process = FakeProcess()
        val handler = handlerFor(process)
        handler.start()
        assertThat(handler.lifecycle.state).isEqualTo(ChildLifecycle.State.STARTED)

        process.operational = true

        assertThat(handler.awaitOperational(Duration.ofSeconds(5))).isTrue()
        assertThat(handler.awaitOperational(Duration.ofSeconds(5))).isTrue()
        Thread.sleep(200)
        assertThat(operationalEvents).containsExactly(ProcessId.WEB)
        assertThat(handler.lifecycle.state).isEqualTo(ChildLifecycle.State.OPERATIONAL)
    }

    @Test
    fun `unexpected exit is reported when no stop is in progress`() {
        val process = FakeProcess()
        handlerFor(process).start()

        process.alive = false

        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(exits).containsExactly(ProcessId.WEB)
        }
    }

    @Test
    fun `graceful stop is not reported as an unexpected exit`() {
        val process = FakeProcess()
        val handler = handlerFor(process)
        handler.start()

        assertThat(handler.stopGracefully(Duration.ofSeconds(1))).isTrue()
        assertThat(process.stopRequests.get()).isEqualTo(1)
        assertThat(handler.lifecycle.state).isEqualTo(ChildLifecycle.State.STOPPING)

        Thread.sleep(200)
        assertThat(exits).isEmpty()

        handler.finalizeStop()
        assertThat(handler.lifecycle.state).isEqualTo(ChildLifecycle.State.STOPPED)
    }

    @Test
    fun `a survivor of the graceful stop is destroyed forcibly`() {
        val process = FakeProcess()
        process.obeysGracefulStop = false
        val handler = handlerFor(process)
        handler.start()

        assertThat(handler.stopGracefully(Duration.ofMillis(50))).isFalse()

        handler.hardStop(Duration.ofMillis(50))

        assertThat(process.hardStopRequests.get()).isEqualTo(1)
        assertThat(process.destroyed).isTrue()
        assertThat(handler.lifecycle.state).isEqualTo(ChildLifecycle.State.STOPPED)
        Thread.sleep(200)
        assertThat(exits).isEmpty()
    }
}
