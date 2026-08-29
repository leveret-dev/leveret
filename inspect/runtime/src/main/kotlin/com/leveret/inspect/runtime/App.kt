package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.config.SettingsLoader
import com.leveret.inspect.runtime.fs.InstallationHome
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.ipc.ProcessCommands
import com.leveret.inspect.runtime.log.LogConfig
import com.leveret.inspect.runtime.proc.CommandFactory
import com.leveret.inspect.runtime.proc.CommandSlotProcess
import com.leveret.inspect.runtime.proc.HttpSearchHealth
import com.leveret.inspect.runtime.proc.ManagedProcess
import com.leveret.inspect.runtime.proc.ProcessId
import com.leveret.inspect.runtime.proc.ProcessLauncher
import com.leveret.inspect.runtime.proc.SearchProcess
import com.leveret.inspect.runtime.supervise.Scheduler
import com.leveret.inspect.runtime.supervise.SettingsReloader
import com.leveret.inspect.runtime.supervise.StopWatchers
import java.nio.file.Path
import kotlin.system.exitProcess
import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Monitor entry point.
 *
 * Startup has two phases. Settings loading and logging configuration run unguarded, so an operator
 * error terminates with a nonzero status before anything is launched. Everything from
 * directory preparation onward runs guarded: a failure there is logged, children are stopped, and the
 * monitor exits normally, which is why readiness and logs, not exit status, tell an operator whether
 * startup succeeded.
 *
 * [childMainClasses] names the process each child runs. Search, web, and compute belong to later
 * parts, so a node assembled from this part alone supervises only what it is given.
 */
class App(
    private val home: Path,
    private val args: Array<String>,
    private val childMainClasses: Map<ProcessId, String> = emptyMap(),
    private val classpath: String = System.getProperty("java.class.path"),
) {
    fun run() {
        val settings = SettingsLoader(
            homeSupplier = { home },
            env = System.getenv(),
            systemProperties = systemProperties(),
            warn = { message -> System.err.println(message) },
        ).load(args)

        val fs = RuntimeFileSystem(settings)
        LogConfig.configure(settings, fs, ProcessId.APP)
        val log = LoggerFactory.getLogger(App::class.java)

        try {
            fs.reset()
            CommandFile(fs.tempDir).use { commandFile ->
                commandFile.clearAll()
                supervise(settings, fs, commandFile, log)
            }
        } catch (failure: Exception) {
            log.error("Startup failed", failure)
        }
    }

    private fun supervise(settings: Settings, fs: RuntimeFileSystem, commandFile: CommandFile, log: Logger) {
        if (childMainClasses.isEmpty()) {
            log.warn("No child processes are configured; the node has nothing to supervise")
        }
        val monitorCommands = commandFile.view(ProcessId.APP.index)
        val childCommands = Scheduler.START_ORDER.associateWith { commandFile.view(it.index) }
        val launcher = ProcessLauncher(
            consoleOutput = settings.boolValue(PropertyKeys.LOG_CONSOLE, false),
            logLine = { id, line -> LoggerFactory.getLogger(id.logPrefix).info(line) },
        )

        val scheduler = Scheduler(
            initialSettings = settings,
            monitorCommands = monitorCommands,
            reloader = SettingsReloader(
                SettingsLoader({ home }, System.getenv(), systemProperties(), { message -> log.warn(message) }),
                args,
            ),
            processFactory = { current -> children(current, fs, launcher, childCommands) },
        )

        val watchers = StopWatchers(
            monitorCommands = monitorCommands,
            childCommands = childCommands,
            scheduler = scheduler,
            stopCommandEnabled = settings.boolValue(PropertyKeys.ENABLE_STOP_COMMAND, false),
        )
        watchers.installShutdownHook()
        watchers.start()

        scheduler.schedule()
        scheduler.awaitTermination()
        watchers.stop()
    }

    private fun children(
        settings: Settings,
        fs: RuntimeFileSystem,
        launcher: ProcessLauncher,
        childCommands: Map<ProcessId, ProcessCommands>,
    ): Map<ProcessId, ManagedProcess> {
        val factory = CommandFactory(settings, fs, javaExecutable())
        return Scheduler.START_ORDER.mapNotNull { id ->
            val mainClass = childMainClasses[id] ?: return@mapNotNull null
            val command = factory.createFor(id, mainClass, classpath)
            val process = if (id == ProcessId.SEARCH) {
                SearchProcess(
                    command,
                    launcher,
                    HttpSearchHealth(
                        settings.required(PropertyKeys.SEARCH_HOST),
                        settings.intValue(PropertyKeys.SEARCH_PORT, 0),
                    ),
                )
            } else {
                CommandSlotProcess(command, launcher, requireNotNull(childCommands[id]))
            }
            id to process
        }.toMap()
    }

    private fun systemProperties(): Map<String, String> =
        System.getProperties().stringPropertyNames().associateWith { System.getProperty(it) }

    private fun javaExecutable(): String =
        Path.of(System.getProperty("java.home"), "bin", "java").toString()
}

fun main(args: Array<String>) {
    try {
        App(InstallationHome.derive(), args).run()
    } catch (failure: Exception) {
        System.err.println("Startup failed: ${failure.message}")
        exitProcess(1)
    }
}
