package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.SettingsLoader
import com.leveret.inspect.runtime.fs.InstallationHome
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.log.LogConfig
import java.nio.file.Path
import kotlin.system.exitProcess
import org.slf4j.LoggerFactory

/**
 * Entry point of the engine process.
 *
 * This module owns three things — configuration, the runtime directory layout, and logging — and
 * running it resolves all three and reports what they resolved to. Nothing is guarded: a
 * configuration mistake or an unusable directory is an operator error, and a nonzero exit with the
 * reason on standard error is more useful than a degraded default nobody notices.
 */
class App(
    private val home: Path,
    private val args: Array<String>,
) {
    fun run() {
        val settings = SettingsLoader(
            homeSupplier = { home },
            env = System.getenv(),
            systemProperties = systemProperties(),
            warn = { message -> System.err.println(message) },
        ).load(args)

        val fs = RuntimeFileSystem(settings)
        fs.reset()
        LogConfig.configure(settings, fs)

        LoggerFactory.getLogger(App::class.java).info(
            "Configuration resolved: home={}, data={}, logs={}, temp={}, level={}, layout={}",
            fs.home,
            fs.dataDir,
            fs.logsDir,
            fs.tempDir,
            LogConfig.levelOf(settings),
            if (settings.boolValue(PropertyKeys.LOG_JSON, false)) "json" else "plain",
        )
    }

    private fun systemProperties(): Map<String, String> =
        System.getProperties().stringPropertyNames().associateWith { System.getProperty(it) }
}

fun main(args: Array<String>) {
    try {
        App(InstallationHome.derive(), args).run()
    } catch (failure: Exception) {
        System.err.println("Startup failed: ${failure.message}")
        exitProcess(1)
    }
}
