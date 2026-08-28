package com.leveret.inspect.runtime.acceptance

import com.leveret.inspect.runtime.ChildEntryPoint
import com.leveret.inspect.runtime.MonitoredComponent
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.log.LogConfig
import com.leveret.inspect.runtime.proc.CommandFactory
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import org.slf4j.LoggerFactory

/**
 * Stand-in for the web and compute processes: configures its own log file, publishes readiness
 * through its command slot, and honors stop requests, which is the child contract this part defines.
 *
 * When the marker file named by `stub.restart.marker` exists, the web child consumes it and asks for
 * one restart. The request is written after readiness, because the entry point clears its own slot on
 * startup and an earlier request would be wiped.
 */
object StubChildMain {
    @JvmStatic
    fun main(args: Array<String>) {
        val handoff = Path.of(args[0])
        val properties = Properties().apply { Files.newInputStream(handoff).use { load(it) } }
        val settings = Settings(properties.stringPropertyNames().associateWith { properties.getProperty(it) })
        val id = ProcessId.fromKey(properties.getProperty(CommandFactory.HANDOFF_KEY))
        val sharedDir = Path.of(properties.getProperty(CommandFactory.HANDOFF_SHARED_DIR))

        LogConfig.configure(settings, RuntimeFileSystem(settings), id)

        val restartMarker = System.getProperty("stub.restart.marker")
            ?.let(Path::of)
            ?.takeIf { id == ProcessId.WEB }

        ChildEntryPoint.fromHandoffFile(handoff, ReadyComponent(id, sharedDir, restartMarker)).launch()
    }

    private class ReadyComponent(
        private val id: ProcessId,
        private val sharedDir: Path,
        private val restartMarker: Path?,
    ) : MonitoredComponent {
        private val log = LoggerFactory.getLogger(StubChildMain::class.java)
        private val running = AtomicBoolean(false)
        private val restartAsked = AtomicBoolean(false)

        override fun start() {
            running.set(true)
            log.info("{} stub started", id.displayName)
            println("${id.displayName} stub started")
        }

        override fun isUp(): Boolean = running.get()

        override fun isOperational(): Boolean {
            if (running.get()) askForRestartOnce()
            return running.get()
        }

        override fun stop() {
            running.set(false)
            log.info("{} stub stopped gracefully", id.displayName)
            println("${id.displayName} stub stopped gracefully")
        }

        override fun hardStop() {
            running.set(false)
            log.info("{} stub hard stopped", id.displayName)
            println("${id.displayName} stub hard stopped")
        }

        private fun askForRestartOnce() {
            val marker = restartMarker ?: return
            if (!restartAsked.compareAndSet(false, true)) return
            if (!Files.deleteIfExists(marker)) return
            CommandFile(sharedDir).use { it.view(id.index).askedForRestart = true }
            log.info("{} stub asked for one restart", id.displayName)
        }
    }
}
