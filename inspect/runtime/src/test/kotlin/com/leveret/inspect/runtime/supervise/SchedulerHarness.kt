package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.ipc.ProcessCommands
import com.leveret.inspect.runtime.proc.ManagedProcess
import com.leveret.inspect.runtime.proc.ProcessId
import java.time.Duration
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

/** In-memory child that records what the scheduler asked of it, in order. */
class FakeProcess(override val id: ProcessId, private val events: MutableList<Pair<ProcessId, String>>) :
    ManagedProcess {
    private val alive = AtomicBoolean(false)
    private val operationalNow = AtomicBoolean(false)

    override fun start() {
        alive.set(true)
        events.add(id to "start")
    }

    override fun isAlive(): Boolean = alive.get()

    override fun isOperational(): Boolean = operationalNow.get()

    override fun askForStop() {
        events.add(id to "stop")
        alive.set(false)
    }

    override fun askForHardStop() {
        events.add(id to "hardStop")
        alive.set(false)
    }

    override fun waitForStop(timeout: Duration): Boolean = !alive.get()

    override fun destroyForcibly() {
        events.add(id to "destroy")
        alive.set(false)
    }

    override val exitCode: Int? get() = if (alive.get()) null else 0

    fun markOperational() = operationalNow.set(true)

    fun killUnexpectedly() {
        operationalNow.set(false)
        alive.set(false)
    }
}

/** Command slot backed by fields rather than a mapped file. */
class FakeCommands : ProcessCommands {
    override var up: Boolean = false
    override var operational: Boolean = false
    override var askedForStop: Boolean = false
    override var askedForHardStop: Boolean = false
    override var askedForRestart: Boolean = false

    override fun acknowledgeRestart() {
        askedForRestart = false
    }

    override var systemInfoUrl: String? = null

    override fun ping(): Long = 0L

    override fun clear() {
        up = false
        operational = false
        askedForStop = false
        askedForHardStop = false
        askedForRestart = false
        systemInfoUrl = null
    }
}

/**
 * Drives a real [Scheduler] over fake children so gate order, readiness aggregation, stop order, and
 * restart are observable without launching processes.
 */
class SchedulerHarness(
    settings: Settings = Settings(emptyMap()),
    reloader: Reloader = Reloader { it },
) {
    private val events: MutableList<Pair<ProcessId, String>> = Collections.synchronizedList(mutableListOf())
    private val processes = Collections.synchronizedMap(mutableMapOf<ProcessId, FakeProcess>())

    val monitorCommands = FakeCommands()

    val scheduler = Scheduler(
        initialSettings = settings,
        monitorCommands = monitorCommands,
        reloader = reloader,
        processFactory = {
            Scheduler.START_ORDER.associateWith { id -> FakeProcess(id, events).also { processes[id] = it } }
        },
        readinessPoll = Duration.ofMillis(20),
    )

    fun markOperational(id: ProcessId) {
        processes[id]?.markOperational()
    }

    fun killUnexpectedly(id: ProcessId) {
        processes[id]?.killUnexpectedly()
    }

    fun startedProcesses(): List<ProcessId> = eventsOf("start")

    fun stopOrderObserved(): List<ProcessId> = synchronized(events) {
        events.filter { it.second == "stop" || it.second == "hardStop" }.map { it.first }.distinct()
    }

    fun hardStopped(): List<ProcessId> = eventsOf("hardStop")

    private fun eventsOf(name: String): List<ProcessId> = synchronized(events) {
        events.filter { it.second == name }.map { it.first }
    }
}
