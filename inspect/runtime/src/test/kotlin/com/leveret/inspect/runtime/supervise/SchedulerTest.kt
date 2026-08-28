package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.proc.ProcessId
import java.util.concurrent.TimeUnit
import org.assertj.core.api.Assertions.assertThat
import org.awaitility.Awaitility.await
import org.junit.jupiter.api.Test

class SchedulerTest {
    private fun operationalNode(): SchedulerHarness {
        val harness = SchedulerHarness()
        harness.scheduler.schedule()
        Scheduler.START_ORDER.forEach { id ->
            await().atMost(5, TimeUnit.SECONDS).untilAsserted {
                assertThat(harness.startedProcesses()).contains(id)
            }
            harness.markOperational(id)
        }
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
        }
        return harness
    }

    @Test
    fun `web waits for search and compute waits for both`() {
        val harness = SchedulerHarness()
        harness.scheduler.schedule()

        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH)
        }
        harness.markOperational(ProcessId.SEARCH)
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH, ProcessId.WEB)
        }
        harness.markOperational(ProcessId.WEB)
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.startedProcesses())
                .containsExactly(ProcessId.SEARCH, ProcessId.WEB, ProcessId.COMPUTE)
        }
        assertThat(harness.scheduler.lifecycle.state).isNotEqualTo(NodeLifecycle.State.OPERATIONAL)
        harness.markOperational(ProcessId.COMPUTE)
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
        }
    }

    @Test
    fun `node never becomes operational while search stays unhealthy`() {
        val harness = SchedulerHarness()
        harness.scheduler.schedule()
        Thread.sleep(500)

        assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH)
        assertThat(harness.scheduler.lifecycle.state).isNotEqualTo(NodeLifecycle.State.OPERATIONAL)
    }

    @Test
    fun `unexpected child exit hard stops the node`() {
        val harness = operationalNode()

        harness.killUnexpectedly(ProcessId.WEB)

        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.hardStopped()).contains(ProcessId.SEARCH, ProcessId.COMPUTE)
            assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.STOPPED)
        }
        assertThat(harness.startedProcesses()).containsExactly(ProcessId.SEARCH, ProcessId.WEB, ProcessId.COMPUTE)
    }

    @Test
    fun `graceful stop follows reverse dependency order`() {
        val harness = operationalNode()

        harness.scheduler.stop()

        assertThat(harness.stopOrderObserved())
            .containsExactly(ProcessId.COMPUTE, ProcessId.WEB, ProcessId.SEARCH)
        assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.STOPPED)
    }

    @Test
    fun `restart stops every child and schedules them again`() {
        val harness = operationalNode()

        assertThat(harness.scheduler.requestRestart()).isTrue()

        assertThat(harness.stopOrderObserved())
            .containsExactly(ProcessId.COMPUTE, ProcessId.WEB, ProcessId.SEARCH)
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.startedProcesses().filter { it == ProcessId.SEARCH }).hasSize(2)
        }
        assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.STARTING)
    }

    @Test
    fun `failed reload hard stops the node`() {
        val harness = SchedulerHarness(reloader = Reloader { throw IllegalStateException("leveret.path.temp cannot change") })
        harness.scheduler.schedule()
        Scheduler.START_ORDER.forEach { id ->
            await().atMost(5, TimeUnit.SECONDS).untilAsserted {
                assertThat(harness.startedProcesses()).contains(id)
            }
            harness.markOperational(id)
        }
        await().atMost(5, TimeUnit.SECONDS).untilAsserted {
            assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.OPERATIONAL)
        }

        assertThat(harness.scheduler.requestRestart()).isFalse()

        assertThat(harness.scheduler.lifecycle.state).isEqualTo(NodeLifecycle.State.STOPPED)
    }
}
