package com.leveret.inspect.runtime.config

/**
 * Configuration keys, their defaults, and the translation from a key to its environment-variable
 * name.
 */
object PropertyKeys {
    const val CANONICAL_PREFIX = "leveret."

    const val PATH_HOME = "leveret.path.home"
    const val PATH_DATA = "leveret.path.data"
    const val PATH_LOGS = "leveret.path.logs"
    const val PATH_TEMP = "leveret.path.temp"

    const val LOG_LEVEL = "leveret.log.level"
    const val LOG_CONSOLE = "leveret.log.console"
    const val LOG_JSON = "leveret.log.jsonOutput"

    val defaults: Map<String, String> = mapOf(
        PATH_DATA to "data",
        PATH_LOGS to "logs",
        PATH_TEMP to "temp",
        LOG_LEVEL to "INFO",
        LOG_CONSOLE to "false",
        LOG_JSON to "false",
    )

    /** Environment-variable name of a key: uppercase, dots and dashes replaced by underscores. */
    fun envName(key: String): String = key.uppercase().replace('.', '_').replace('-', '_')
}
