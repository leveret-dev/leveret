package com.leveret.inspect.db.config

import com.leveret.inspect.runtime.config.PropertyKeys

/** Database property names and their defaults. Loading and precedence belong to the process runtime. */
object DatabaseKeys {
    const val URL = PropertyKeys.JDBC_URL
    const val USERNAME = "leveret.jdbc.username"
    const val PASSWORD = "leveret.jdbc.password"
    const val EMBEDDED_PORT = "leveret.embeddedDatabase.port"
    const val MAX_ACTIVE = "leveret.jdbc.maxActive"
    const val MIN_IDLE = "leveret.jdbc.minIdle"
    const val MAX_WAIT = "leveret.jdbc.maxWait"
    const val IDLE_TIMEOUT = "leveret.jdbc.idleTimeout"
    const val KEEPALIVE = "leveret.jdbc.keepaliveTime"
    const val MAX_LIFETIME = "leveret.jdbc.maxLifetime"
    const val VALIDATION_TIMEOUT = "leveret.jdbc.validationTimeout"
    const val AUTO_UPGRADE = "leveret.autoDatabaseUpgrade"

    const val DEFAULT_EMBEDDED_PORT = 9092
    const val EMBEDDED_DATABASE_NAME = "leveret"

    /** A configured zero wait is this finite sentinel, never an indefinite wait. */
    const val MAX_WAIT_SENTINEL = 2147483647

    const val MIN_MAX_WAIT = 250

    val defaults: Map<String, String> = mapOf(
        USERNAME to "",
        PASSWORD to "",
        MAX_ACTIVE to "60",
        MIN_IDLE to "10",
        MAX_WAIT to "8000",
        IDLE_TIMEOUT to "600000",
        KEEPALIVE to "180000",
        MAX_LIFETIME to "1800000",
        VALIDATION_TIMEOUT to "5000",
        AUTO_UPGRADE to "false",
    )
}
