package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.ipc.ProcessCommands
import com.leveret.inspect.runtime.proc.CommandFactory
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A component whose start-up progress and stop are driven by [ChildEntryPoint]. */
interface MonitoredComponent {
    fun start()

    /** The component has reached its own start-up completion point. */
    fun isUp(): Boolean

    /** The component is ready to serve. */
    fun isOperational(): Boolean

    /** Graceful stop; may block until the component has released its work. */
    fun stop()

    /** Immediate stop; must not block beyond a second. */
    fun hardStop()
}

/**
 * Hosts a child component's lifecycle against its slot in the node's command file.
 *
 * The hosting thread starts the component, publishes `up` and `operational` as the component reaches
 * them, and watches the slot for stop commands. Publication is one-way: a flag once published is
 * never withdrawn, so the supervisor cannot observe a child regressing.
 */
class ChildEntryPoint(
    private val settings: Settings,
    private val commands: ProcessCommands,
    private val component: MonitoredComponent,
) {
    /** Runs until a stop command is observed and the component has halted. */
    fun launch() {
        component.start()
        var publishedUp = false
        var publishedOperational = false
        while (true) {
            if (!publishedUp && component.isUp()) {
                commands.up = true
                publishedUp = true
            }
            if (!publishedOperational && component.isOperational()) {
                commands.operational = true
                publishedOperational = true
            }
            if (commands.askedForHardStop) {
                hardStop()
                return
            }
            if (commands.askedForStop) {
                if (!within(gracefulStopTimeoutMs(), component::stop)) hardStop()
                return
            }
            Thread.sleep(POLL_INTERVAL_MS)
        }
    }

    private fun hardStop() {
        within(HARD_STOP_DEADLINE_MS, component::hardStop)
    }

    /**
     * Runs [action] on a daemon thread and waits at most [timeoutMs] for it. Returns whether it
     * finished; an unfinished action is abandoned rather than interrupted, because the caller
     * escalates instead of waiting.
     */
    private fun within(timeoutMs: Long, action: () -> Unit): Boolean {
        val finished = CountDownLatch(1)
        Thread({
            try {
                action()
            } finally {
                finished.countDown()
            }
        }, "child-stop").apply { isDaemon = true }.start()
        return finished.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun gracefulStopTimeoutMs(): Long =
        settings.optional(CommandFactory.HANDOFF_GRACEFUL_STOP_TIMEOUT)?.trim()?.toLongOrNull()
            ?: DEFAULT_GRACEFUL_STOP_TIMEOUT_MS

    companion object {
        const val POLL_INTERVAL_MS = 500L
        const val HARD_STOP_DEADLINE_MS = 1_000L
        const val DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 30_000L

        /**
         * Builds an entry point from the handoff file the supervisor wrote for this child. The
         * command file stays open for the life of the process: its mapping is the child's only
         * channel to the supervisor.
         */
        fun fromHandoffFile(path: Path, component: MonitoredComponent): ChildEntryPoint {
            val properties = Properties()
            Files.newInputStream(path).use { properties.load(it) }
            val settings = Settings(
                properties.stringPropertyNames().associateWith { properties.getProperty(it) },
            )
            val index = settings.required(CommandFactory.HANDOFF_INDEX).trim().toInt()
            val sharedDir = Path.of(settings.required(CommandFactory.HANDOFF_SHARED_DIR))
            val commands = CommandFile(sharedDir).mainView(index)
            return ChildEntryPoint(settings, commands, component)
        }
    }
}
