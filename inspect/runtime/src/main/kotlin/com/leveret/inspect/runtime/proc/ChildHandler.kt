package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.ipc.ProcessCommands
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.slf4j.LoggerFactory

/** One supervised child, seen by the supervisor as liveness, readiness, and stop requests. */
interface ManagedProcess {
    val id: ProcessId

    fun start()

    fun isAlive(): Boolean

    fun isOperational(): Boolean

    fun askForStop()

    fun askForHardStop()

    /** Waits for the operating-system process to leave, returning whether it did. */
    fun waitForStop(timeout: Duration): Boolean

    fun destroyForcibly()

    /** Termination status, or `null` while the process is still running or was never launched. */
    val exitCode: Int?
}

/** Operating-system half shared by every child: launch, liveness, and forced termination. */
abstract class LaunchedProcess(
    private val command: ChildCommand,
    private val launcher: ProcessLauncher,
) : ManagedProcess {
    override val id: ProcessId get() = command.id

    @Volatile
    private var process: Process? = null

    override fun start() {
        process = launcher.launch(command)
    }

    override fun isAlive(): Boolean = process?.isAlive == true

    override fun waitForStop(timeout: Duration): Boolean =
        process?.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS) ?: true

    override fun destroyForcibly() {
        process?.destroyForcibly()
    }

    override val exitCode: Int? get() = process?.takeIf { !it.isAlive }?.exitValue()

    /** Requests operating-system termination of the child. */
    protected fun terminate() {
        process?.destroy()
    }
}

/** Web and compute children report readiness and take stop requests through their command slot. */
class CommandSlotProcess(
    command: ChildCommand,
    launcher: ProcessLauncher,
    private val commands: ProcessCommands,
) : LaunchedProcess(command, launcher) {
    override fun isOperational(): Boolean = commands.operational

    override fun askForStop() {
        commands.askedForStop = true
    }

    override fun askForHardStop() {
        commands.askedForHardStop = true
    }
}

/**
 * The search child runs no stop logic of its own: readiness is its reported health colour and every
 * stop request maps directly to operating-system termination.
 */
class SearchProcess(
    command: ChildCommand,
    launcher: ProcessLauncher,
    private val health: SearchHealth,
) : LaunchedProcess(command, launcher) {
    override fun isOperational(): Boolean = health.status().isOperational

    override fun askForStop() = terminate()

    override fun askForHardStop() = terminate()
}

/**
 * Supervisor-side lifecycle of one child.
 *
 * A single watcher thread observes readiness and liveness: it emits the operational event once and
 * reports an exit as unexpected only while no stop is in progress, because a stop makes the very same
 * exit the intended outcome.
 */
class ChildHandler(
    val id: ProcessId,
    private val process: ManagedProcess,
    private val pollInterval: Duration = Duration.ofMillis(500),
    private val onOperational: (ProcessId) -> Unit,
    private val onUnexpectedExit: (ProcessId) -> Unit,
) {
    val lifecycle = ChildLifecycle()

    private val operational = CountDownLatch(1)

    @Volatile
    private var stopping = false

    fun start() {
        check(lifecycle.tryToMoveTo(ChildLifecycle.State.STARTING)) { "$id was already started" }
        process.start()
        lifecycle.tryToMoveTo(ChildLifecycle.State.STARTED)
        thread(isDaemon = true, name = "${id.key}-watcher", block = ::watch)
    }

    fun awaitOperational(timeout: Duration): Boolean =
        operational.await(timeout.toMillis(), TimeUnit.MILLISECONDS)

    /** Asks the child to stop and reports whether it left within [timeout]. */
    fun stopGracefully(timeout: Duration): Boolean {
        stopping = true
        if (!lifecycle.tryToMoveTo(ChildLifecycle.State.STOPPING)) return !process.isAlive()
        process.askForStop()
        return process.waitForStop(timeout)
    }

    /** Escalates: hard-stop request, bounded wait, forced destruction, then finalization. */
    fun hardStop(timeout: Duration) {
        stopping = true
        lifecycle.tryToMoveTo(ChildLifecycle.State.HARD_STOPPING)
        process.askForHardStop()
        if (!process.waitForStop(timeout)) {
            log.warn("{} survived its hard stop and is destroyed forcibly", id.displayName)
            process.destroyForcibly()
        }
        finalizeStop()
    }

    fun finalizeStop() {
        stopping = true
        lifecycle.tryToMoveTo(ChildLifecycle.State.FINALIZE_STOPPING)
        lifecycle.tryToMoveTo(ChildLifecycle.State.STOPPED)
    }

    private fun watch() {
        while (true) {
            if (!process.isAlive()) {
                if (!stopping) {
                    log.warn("{} exited unexpectedly with status {}", id.displayName, process.exitCode)
                    onUnexpectedExit(id)
                }
                return
            }
            if (operational.count > 0L && readinessOf()) {
                lifecycle.tryToMoveTo(ChildLifecycle.State.OPERATIONAL)
                onOperational(id)
                operational.countDown()
            }
            try {
                Thread.sleep(pollInterval)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    private fun readinessOf(): Boolean =
        try {
            process.isOperational()
        } catch (failure: Exception) {
            log.warn("Readiness check of {} failed", id.displayName, failure)
            false
        }

    private companion object {
        val log = LoggerFactory.getLogger(ChildHandler::class.java)
    }
}
