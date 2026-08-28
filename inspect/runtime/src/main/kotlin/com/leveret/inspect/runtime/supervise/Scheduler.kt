package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.ipc.ProcessCommands
import com.leveret.inspect.runtime.proc.ChildHandler
import com.leveret.inspect.runtime.proc.ManagedProcess
import com.leveret.inspect.runtime.proc.ProcessId
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.slf4j.LoggerFactory

/**
 * Starts children in dependency order, aggregates their readiness into node state, and owns stop,
 * escalation, and internal restart.
 *
 * Children are built through [processFactory] rather than handed in, because an internal restart
 * replaces every child with one launched from the reloaded settings.
 */
class Scheduler(
    initialSettings: Settings,
    private val monitorCommands: ProcessCommands,
    private val reloader: Reloader,
    private val processFactory: (Settings) -> Map<ProcessId, ManagedProcess>,
    private val readinessPoll: Duration = Duration.ofMillis(500),
) {
    val lifecycle = NodeLifecycle()

    private val terminated = CountDownLatch(1)

    @Volatile
    private var settings: Settings = initialSettings

    @Volatile
    private var children: Map<ProcessId, ChildHandler> = emptyMap()

    @Volatile
    private var stopInProgress = false

    /** Starts children on a background thread; readiness gating happens there, not in the caller. */
    fun schedule() {
        if (!lifecycle.tryToMoveTo(NodeLifecycle.State.STARTING)) return
        stopInProgress = false
        children = processFactory(settings).mapValues { (id, process) ->
            ChildHandler(
                id = id,
                process = process,
                pollInterval = readinessPoll,
                onOperational = ::onChildOperational,
                onUnexpectedExit = ::onChildLost,
            )
        }
        thread(isDaemon = true, name = "node-scheduler", block = ::startInOrder)
    }

    /** Blocks until the node reaches its terminal state. */
    fun awaitTermination() = terminated.await()

    fun stop() = shutdown(hard = false)

    fun hardStop() = shutdown(hard = true)

    /**
     * Stops every child, reloads settings, and schedules again. A rejected reload leaves no mixed
     * configuration behind: the node is hard-stopped instead.
     */
    fun requestRestart(): Boolean {
        if (!lifecycle.tryToMoveTo(NodeLifecycle.State.RESTARTING)) return false
        monitorCommands.acknowledgeRestart()
        stopChildren(hard = false)
        settings = try {
            reloader.reload(settings)
        } catch (rejected: Exception) {
            log.error("Restart rejected: {}", rejected.message)
            shutdown(hard = true)
            return false
        }
        schedule()
        return true
    }

    private fun startInOrder() {
        for (id in START_ORDER) {
            val child = children[id] ?: continue
            if (stopInProgress) return
            log.info("Waiting for {} to be up", id.displayName)
            child.start()
            while (!child.awaitOperational(readinessPoll)) {
                if (stopInProgress || lifecycle.state != NodeLifecycle.State.STARTING) return
            }
            log.info("{} is up", id.displayName)
        }
        if (lifecycle.tryToMoveTo(NodeLifecycle.State.OPERATIONAL)) {
            log.info("Leveret Inspect is operational")
        }
    }

    internal fun onChildOperational(id: ProcessId) = log.debug("{} reported operational", id.displayName)

    /** A partially operational node is worse than a stopped one, so one lost child stops them all. */
    internal fun onChildLost(id: ProcessId) {
        if (stopInProgress) return
        log.error("{} disappeared unexpectedly; stopping the node", id.displayName)
        shutdown(hard = true)
    }

    private fun shutdown(hard: Boolean) {
        val target = if (hard) NodeLifecycle.State.HARD_STOPPING else NodeLifecycle.State.STOPPING
        if (!lifecycle.tryToMoveTo(target)) return
        stopChildren(hard)
        lifecycle.tryToMoveTo(NodeLifecycle.State.FINALIZE_STOPPING)
        lifecycle.tryToMoveTo(NodeLifecycle.State.STOPPED)
        terminated.countDown()
    }

    private fun stopChildren(hard: Boolean) {
        stopInProgress = true
        STOP_ORDER.mapNotNull { children[it] }.forEach { child ->
            if (hard) {
                child.hardStop(HARD_STOP_WAIT)
            } else if (child.stopGracefully(gracefulWaitOf(child.id))) {
                child.finalizeStop()
            } else {
                log.warn("{} did not stop gracefully in time", child.id.displayName)
                child.hardStop(HARD_STOP_WAIT)
            }
            log.info("{} stopped", child.id.displayName)
        }
    }

    /** The supervisor waits longer than the child's own deadline so escalation is never premature. */
    private fun gracefulWaitOf(id: ProcessId): Duration {
        val configured = settings.optional(PropertyKeys.gracefulStopTimeout(id))?.trim()?.toLongOrNull()
            ?: return SUPERVISOR_TIMEOUT_MARGIN
        return Duration.ofMillis(configured).plus(SUPERVISOR_TIMEOUT_MARGIN)
    }

    companion object {
        val START_ORDER = listOf(ProcessId.SEARCH, ProcessId.WEB, ProcessId.COMPUTE)
        val STOP_ORDER = START_ORDER.reversed()

        /** Margin the supervisor adds to a child's own graceful deadline before escalating. */
        val SUPERVISOR_TIMEOUT_MARGIN: Duration = Duration.ofSeconds(60)
        val HARD_STOP_WAIT: Duration = Duration.ofMinutes(1)

        private val log = LoggerFactory.getLogger(Scheduler::class.java)
    }
}

/**
 * Turns local command flags into scheduler actions.
 *
 * The hard-stop watcher always runs; the graceful-stop watcher runs only when the operator enabled
 * the stop command. Restart requests are acknowledged before the scheduler acts on them, so a child
 * observes its request being taken.
 */
class StopWatchers(
    private val monitorCommands: ProcessCommands,
    private val childCommands: Map<ProcessId, ProcessCommands>,
    private val scheduler: Scheduler,
    private val stopCommandEnabled: Boolean,
    private val pollInterval: Duration = Duration.ofMillis(500),
) {
    @Volatile
    private var running = false

    private var watcher: Thread? = null

    fun start() {
        running = true
        watcher = thread(isDaemon = true, name = "command-watcher") {
            while (running) {
                if (monitorCommands.askedForHardStop) {
                    scheduler.hardStop()
                    return@thread
                }
                if (stopCommandEnabled && monitorCommands.askedForStop) {
                    scheduler.stop()
                    return@thread
                }
                childCommands.values.firstOrNull { it.askedForRestart }?.let {
                    it.acknowledgeRestart()
                    scheduler.requestRestart()
                }
                if (!sleep()) return@thread
            }
        }
    }

    fun stop() {
        running = false
        watcher?.interrupt()
    }

    /** Registers the shutdown hook so an interrupt performs an ordered node stop. */
    fun installShutdownHook() {
        Runtime.getRuntime().addShutdownHook(
            Thread({
                stop()
                scheduler.stop()
            }, "shutdown-hook"),
        )
    }

    private fun sleep(): Boolean =
        try {
            TimeUnit.MILLISECONDS.sleep(pollInterval.toMillis())
            true
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
}
