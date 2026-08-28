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
        val fileValues = canonicalize(readBaseFile(home), "configuration file")

        val values = LinkedHashMap<String, String>(fileValues)
        values.putAll(environmentValues(PropertyKeys.defaults.keys + fileValues.keys))
        values.putAll(canonicalize(CommandLineParser.parse(args), "command line arguments"))
        values.putAll(canonicalize(prefixedSystemProperties(), "system properties"))
        values[PropertyKeys.PATH_HOME] = home.toString()
        PropertyKeys.defaults.forEach { (key, default) -> values.putIfAbsent(key, default) }
        return Settings(values)
    }

    private fun readBaseFile(home: Path): Map<String, String> {
        val canonicalFile = home.resolve("conf").resolve("leveret.properties")
        val legacyFile = home.resolve("conf").resolve("sonar.properties")
        val file = when {
            Files.exists(canonicalFile) -> canonicalFile
            Files.exists(legacyFile) -> legacyFile
            else -> {
                warn("No configuration file found at $canonicalFile or $legacyFile, using defaults")
                return emptyMap()
            }
        }
        if (!Files.isRegularFile(file)) {
            throw IllegalStateException("Configuration file is not a regular file: $file")
        }
        val properties = Properties()
        try {
            Files.newBufferedReader(file, StandardCharsets.UTF_8).use(properties::load)
        } catch (e: IOException) {
            throw IllegalStateException("Cannot read configuration file: $file", e)
        }
        return properties.stringPropertyNames().associateWith(properties::getProperty)
    }

    /**
     * Environment overrides for keys eligible to receive them: declared defaults and keys present in
     * the configuration file. Both the canonical and the legacy variable name are accepted.
     */
    private fun environmentValues(eligible: Set<String>): Map<String, String> {
        val values = LinkedHashMap<String, String>()
        for (key in eligible) {
            val canonicalName = PropertyKeys.envName(key)
            val legacyName = PropertyKeys.envName(legacyKey(key))
            val canonicalValue = env[canonicalName]
            val legacyValue = env[legacyName]
            if (canonicalValue != null && legacyValue != null && canonicalValue != legacyValue) {
                warn(
                    "Environment variables $canonicalName and $legacyName carry different values, " +
                        "using $canonicalName",
                )
            }
            (canonicalValue ?: legacyValue)?.let { values[key] = it }
        }
        return values
    }

    private fun prefixedSystemProperties(): Map<String, String> =
        systemProperties.filterKeys {
            it.startsWith(PropertyKeys.CANONICAL_PREFIX) || it.startsWith(PropertyKeys.LEGACY_PREFIX)
        }

    /**
     * Canonicalizes one source. When a canonical key and its legacy alias appear in the same source
     * with different values the canonical value wins and both names are reported.
     */
    private fun canonicalize(source: Map<String, String>, sourceName: String): Map<String, String> {
        val values = LinkedHashMap<String, String>()
        val seenAs = HashMap<String, String>()
        for ((rawKey, value) in source) {
            val key = PropertyKeys.canonical(rawKey)
            val previousRawKey = seenAs[key]
            if (previousRawKey == null) {
                values[key] = value
                seenAs[key] = rawKey
                continue
            }
            if (values[key] == value) continue
            if (rawKey == key) {
                values[key] = value
                seenAs[key] = rawKey
            }
            warn(
                "Properties $key and ${legacyKey(key)} carry different values in $sourceName, " +
                    "using $key",
            )
        }
        return values
    }

    private fun legacyKey(canonicalKey: String): String =
        PropertyKeys.LEGACY_PREFIX + canonicalKey.removePrefix(PropertyKeys.CANONICAL_PREFIX)
}
