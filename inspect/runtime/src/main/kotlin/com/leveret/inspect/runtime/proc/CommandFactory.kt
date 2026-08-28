package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

/** Launch description of one child process. */
data class ChildCommand(
    val id: ProcessId,
    val arguments: List<String>,
    val environmentAdditions: Map<String, String>,
    val suppressedEnvironment: Set<String>,
    val settingsFile: Path?,
)

/**
 * Builds child launch commands.
 *
 * Web and compute children receive the effective settings through a properties file in the runtime
 * temporary directory, carrying the internal handoff keys. The search child receives no handoff file.
 */
class CommandFactory(
    private val settings: Settings,
    private val fs: RuntimeFileSystem,
    private val javaExecutable: String,
) {
    fun createFor(id: ProcessId, mainClass: String, classpath: String): ChildCommand {
        val options = JvmOptions(mandatoryOptions())
            .addFromSettings(settings, id)
        propagateProxyProperties(options)

        val settingsFile = if (id == ProcessId.SEARCH) null else writeHandoffFile(id)
        val arguments = buildList {
            add(javaExecutable)
            addAll(options.toList())
            add("-cp")
            add(classpath)
            add(mainClass)
            if (settingsFile != null) add(settingsFile.toString())
        }

        return ChildCommand(
            id = id,
            arguments = arguments,
            environmentAdditions = emptyMap(),
            suppressedEnvironment = suppressedEnvironment(),
            settingsFile = settingsFile,
        )
    }

    private fun mandatoryOptions(): Map<String, String> = mapOf(
        "-Dfile.encoding=" to "UTF-8",
        "-Djava.awt.headless=" to "true",
        "-Djava.io.tmpdir=" to fs.tempDir.toString(),
        "--add-opens=java.base/java.util=" to "ALL-UNNAMED",
    )

    private fun propagateProxyProperties(options: JvmOptions) {
        PROXY_PROPERTIES.forEach { name ->
            val value = System.getProperty(name) ?: return@forEach
            val option = "-D$name=$value"
            if (!options.definesSameAs(option)) options.add(option)
        }
    }

    /** Children never inherit generic JVM tool options, so no ambient agent attaches to them. */
    private fun suppressedEnvironment(): Set<String> = setOf(GENERIC_JVM_TOOL_OPTIONS)

    private fun writeHandoffFile(id: ProcessId): Path {
        val properties = Properties()
        settings.asMap().forEach { (key, value) -> properties.setProperty(key, value) }
        properties.setProperty(PropertyKeys.PATH_DATA, fs.dataDir.toString())
        properties.setProperty(PropertyKeys.PATH_LOGS, fs.logsDir.toString())
        properties.setProperty(PropertyKeys.PATH_TEMP, fs.tempDir.toString())
        properties.setProperty(PropertyKeys.PATH_WEB, fs.webDir.toString())
        properties.setProperty(HANDOFF_KEY, id.key)
        properties.setProperty(HANDOFF_INDEX, id.index.toString())
        properties.setProperty(HANDOFF_GRACEFUL_STOP_TIMEOUT, childGracefulStopTimeout(id).toString())
        properties.setProperty(HANDOFF_SHARED_DIR, fs.tempDir.toString())

        val file = Files.createTempFile(fs.tempDir, "${id.key}-", ".properties")
        Files.newOutputStream(file).use { properties.store(it, "Leveret Inspect ${id.displayName} settings") }
        return file
    }

    /** The child is granted its configured grace period plus a fixed margin. */
    private fun childGracefulStopTimeout(id: ProcessId): Long {
        val configured = settings.optional(PropertyKeys.gracefulStopTimeout(id))
            ?: PropertyKeys.defaults[PropertyKeys.gracefulStopTimeout(id)]
            ?: return CHILD_TIMEOUT_MARGIN_MS
        val parsed = requireNotNull(configured.trim().toLongOrNull()) {
            "${PropertyKeys.gracefulStopTimeout(id)} must be an integer, was '$configured'"
        }
        require(parsed >= 1) { "${PropertyKeys.gracefulStopTimeout(id)} must be at least 1, was $parsed" }
        return parsed + CHILD_TIMEOUT_MARGIN_MS
    }

    companion object {
        const val HANDOFF_KEY = "process.key"
        const val HANDOFF_INDEX = "process.index"
        const val HANDOFF_GRACEFUL_STOP_TIMEOUT = "process.gracefulStopTimeout"
        const val HANDOFF_SHARED_DIR = "process.sharedDir"

        /** Margin added to the operator's grace period before the child escalates internally. */
        const val CHILD_TIMEOUT_MARGIN_MS = 30_000L

        private const val GENERIC_JVM_TOOL_OPTIONS = "JAVA_TOOL_OPTIONS"

        private val PROXY_PROPERTIES = listOf(
            "http.proxyHost",
            "http.proxyPort",
            "http.nonProxyHosts",
            "https.proxyHost",
            "https.proxyPort",
            "http.proxyUser",
            "http.proxyPassword",
        )
    }
}
