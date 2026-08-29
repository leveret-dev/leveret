package com.leveret.inspect.db.config

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.Dialects
import com.leveret.inspect.runtime.config.Settings

data class PoolSettings(
    val maxActive: Int,
    val minIdle: Int,
    val maxWaitMs: Int,
    val idleTimeoutMs: Long,
    val keepaliveMs: Long,
    val maxLifetimeMs: Long,
    val validationTimeoutMs: Long,
)

/**
 * Resolved connection contract. The embedded database is selected explicitly rather than inferred, so
 * an operator who sets both a port and a URL learns which one takes effect instead of guessing.
 */
data class DatabaseSettings(
    val url: String,
    val username: String,
    val password: String,
    val embedded: Boolean,
    val pool: PoolSettings,
    val autoUpgrade: Boolean = false,
) {
    val provider: String = url.removePrefix(JDBC_PREFIX).substringBefore(':').lowercase()

    val dialect: Dialect = Dialects.of(provider)

    companion object {
        private const val JDBC_PREFIX = "jdbc:"
        private const val LOOPBACK = "127.0.0.1"

        fun from(settings: Settings, warn: (String) -> Unit): DatabaseSettings {
            val configuredUrl = settings.optional(DatabaseKeys.URL)?.trim()?.takeIf { it.isNotEmpty() }
            val configuredPort = settings.optional(DatabaseKeys.EMBEDDED_PORT)?.trim()
                ?.takeIf { it.isNotEmpty() }
            val embedded = configuredPort != null || configuredUrl == null
            val url = if (embedded) {
                val port = if (configuredPort == null) {
                    DatabaseKeys.DEFAULT_EMBEDDED_PORT
                } else {
                    configuredPort.toIntOrNull() ?: throw IllegalArgumentException(
                        "${DatabaseKeys.EMBEDDED_PORT} must be an integer, was '$configuredPort'",
                    )
                }
                embeddedUrl(port).also { generated ->
                    if (configuredUrl != null) {
                        val relation = if (configuredUrl == generated) "matched" else "did not match"
                        warn(
                            "${DatabaseKeys.URL} is ignored because ${DatabaseKeys.EMBEDDED_PORT} " +
                                "selects the embedded database; the effective URL is $generated and " +
                                "the configured URL $relation it",
                        )
                    }
                }
            } else {
                requireNotNull(configuredUrl)
            }
            require(url.startsWith(JDBC_PREFIX) && url.removePrefix(JDBC_PREFIX).contains(':')) {
                "${DatabaseKeys.URL} must be a jdbc:<provider>: URL, was '$url'"
            }
            return DatabaseSettings(
                url = url,
                username = settings.value(DatabaseKeys.USERNAME, ""),
                password = settings.value(DatabaseKeys.PASSWORD, ""),
                embedded = embedded,
                pool = pool(settings),
                autoUpgrade = settings.boolValue(DatabaseKeys.AUTO_UPGRADE, false),
            )
        }

        fun embeddedUrl(port: Int): String =
            "jdbc:h2:tcp://$LOOPBACK:$port/${DatabaseKeys.EMBEDDED_DATABASE_NAME}"

        private fun pool(settings: Settings): PoolSettings {
            val maxActive = settings.intValue(DatabaseKeys.MAX_ACTIVE, 60)
            require(maxActive >= 1) {
                "${DatabaseKeys.MAX_ACTIVE} must be at least 1, was $maxActive"
            }
            val configuredWait = settings.intValue(DatabaseKeys.MAX_WAIT, 8000)
            require(configuredWait == 0 || configuredWait >= DatabaseKeys.MIN_MAX_WAIT) {
                "${DatabaseKeys.MAX_WAIT} must be 0 or at least ${DatabaseKeys.MIN_MAX_WAIT} ms, " +
                    "was $configuredWait"
            }
            return PoolSettings(
                maxActive = maxActive,
                minIdle = settings.intValue(DatabaseKeys.MIN_IDLE, 10),
                maxWaitMs = if (configuredWait == 0) DatabaseKeys.MAX_WAIT_SENTINEL else configuredWait,
                idleTimeoutMs = settings.intValue(DatabaseKeys.IDLE_TIMEOUT, 600000).toLong(),
                keepaliveMs = settings.intValue(DatabaseKeys.KEEPALIVE, 180000).toLong(),
                maxLifetimeMs = settings.intValue(DatabaseKeys.MAX_LIFETIME, 1800000).toLong(),
                validationTimeoutMs = settings.intValue(DatabaseKeys.VALIDATION_TIMEOUT, 5000).toLong(),
            )
        }
    }
}
