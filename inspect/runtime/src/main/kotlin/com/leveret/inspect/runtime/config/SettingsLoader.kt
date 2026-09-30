package com.leveret.inspect.runtime.config

import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

/**
 * Resolves settings from the base configuration file, the environment, application arguments, JVM
 * system properties, the runtime-owned installation home, and finally the declared defaults. Later
 * sources override earlier ones.
 */
class SettingsLoader(
    private val homeSupplier: () -> Path,
    private val env: Map<String, String>,
    private val systemProperties: Map<String, String>,
    private val warn: (String) -> Unit,
) {
    fun load(args: Array<String>): Settings {
        val home = homeSupplier().toAbsolutePath().normalize()
        val fileValues = readBaseFile(home)

        val values = LinkedHashMap<String, String>(fileValues)
        values.putAll(environmentValues(PropertyKeys.defaults.keys + fileValues.keys))
        values.putAll(CommandLineParser.parse(args))
        values.putAll(prefixedSystemProperties())
        values[PropertyKeys.PATH_HOME] = home.toString()
        PropertyKeys.defaults.forEach { (key, default) -> values.putIfAbsent(key, default) }
        return Settings(values)
    }

    private fun readBaseFile(home: Path): Map<String, String> {
        val file = home.resolve(CONF_DIRECTORY).resolve(FILE_NAME)
        if (!Files.exists(file)) {
            warn("Configuration file $file is absent; continuing with defaults")
            return emptyMap()
        }
        val properties = Properties()
        try {
            Files.newBufferedReader(file, StandardCharsets.UTF_8).use { properties.load(it) }
        } catch (e: IOException) {
            throw IllegalStateException("Configuration file $file cannot be read", e)
        }
        return properties.stringPropertyNames().associateWith { properties.getProperty(it) }
    }

    /**
     * Environment overrides for keys eligible to receive them: declared defaults and keys present in
     * the configuration file.
     */
    private fun environmentValues(eligible: Set<String>): Map<String, String> =
        eligible.mapNotNull { key ->
            env[PropertyKeys.envName(key)]?.let { key to it }
        }.toMap()

    private fun prefixedSystemProperties(): Map<String, String> =
        systemProperties.filterKeys { it.startsWith(PropertyKeys.CANONICAL_PREFIX) }

    private companion object {
        const val CONF_DIRECTORY = "conf"
        const val FILE_NAME = "leveret.properties"
    }
}
