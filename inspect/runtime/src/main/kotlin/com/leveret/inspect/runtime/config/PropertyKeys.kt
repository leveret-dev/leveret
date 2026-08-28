package com.leveret.inspect.runtime.config

import com.leveret.inspect.runtime.proc.ProcessId

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
    const val PATH_WEB = "leveret.path.web"

    const val ENABLE_STOP_COMMAND = "leveret.enableStopCommand"

    const val JDBC_URL = "leveret.jdbc.url"

    const val LOG_LEVEL = "leveret.log.level"
    const val LOG_CONSOLE = "leveret.log.console"
    const val LOG_JSON = "leveret.log.jsonOutput"
    const val LOG_ROLLING_POLICY = "leveret.log.rollingPolicy"
    const val LOG_MAX_FILES = "leveret.log.maxFiles"

    const val SEARCH_HOST = "leveret.search.host"
    const val SEARCH_PORT = "leveret.search.port"

    fun javaOpts(id: ProcessId): String = "$CANONICAL_PREFIX${id.key}.javaOpts"

    fun javaAdditionalOpts(id: ProcessId): String = "$CANONICAL_PREFIX${id.key}.javaAdditionalOpts"

    fun gracefulStopTimeout(id: ProcessId): String = "$CANONICAL_PREFIX${id.key}.gracefulStopTimeOutInMs"

    fun logLevel(id: ProcessId): String = "$LOG_LEVEL.${id.key}"

    val defaults: Map<String, String> = mapOf(
        PATH_DATA to "data",
        PATH_LOGS to "logs",
        PATH_TEMP to "temp",
        PATH_WEB to "web",
        LOG_LEVEL to "INFO",
        LOG_CONSOLE to "false",
        LOG_JSON to "false",
        LOG_ROLLING_POLICY to "time:yyyy-MM-dd",
        LOG_MAX_FILES to "7",
        SEARCH_HOST to "127.0.0.1",
        SEARCH_PORT to "9001",
        javaOpts(ProcessId.SEARCH) to
            "-Xmx512m -Xms512m -XX:MaxDirectMemorySize=256m -XX:+HeapDumpOnOutOfMemoryError",
        javaOpts(ProcessId.WEB) to "-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError",
        javaOpts(ProcessId.COMPUTE) to "-Xmx512m -Xms128m -XX:+HeapDumpOnOutOfMemoryError",
        javaAdditionalOpts(ProcessId.SEARCH) to "",
        javaAdditionalOpts(ProcessId.WEB) to "",
        javaAdditionalOpts(ProcessId.COMPUTE) to "",
        gracefulStopTimeout(ProcessId.WEB) to "240000",
        gracefulStopTimeout(ProcessId.COMPUTE) to "21600000",
    )

    /** Environment-variable name of a key: uppercase, dots and dashes replaced by underscores. */
    fun envName(key: String): String = key.uppercase().replace('.', '_').replace('-', '_')
}
