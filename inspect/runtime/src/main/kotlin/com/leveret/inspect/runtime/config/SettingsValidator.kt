package com.leveret.inspect.runtime.config

/**
 * Pre-guard settings validation: a configuration mistake must stop the monitor before any child is
 * launched, not after a partial start.
 *
 * Only the database provider is checked here. Connection, pool, and migration behavior belongs to the
 * persistence part, which extends this check without duplicating settings loading.
 */
object SettingsValidator {
    val PROVIDERS = setOf("h2", "sqlserver", "oracle", "postgresql")

    fun validate(settings: Settings) {
        val url = settings.optional(PropertyKeys.JDBC_URL) ?: return
        val trimmed = url.trim()
        val provider = trimmed
            .takeIf { it.startsWith(JDBC_PREFIX) }
            ?.removePrefix(JDBC_PREFIX)
            ?.substringBefore(':', missingDelimiterValue = "")
            ?.lowercase()
        require(!provider.isNullOrEmpty() && provider in PROVIDERS) {
            "${PropertyKeys.JDBC_URL} must be a jdbc:<provider>: URL whose provider is one of " +
                "${PROVIDERS.sorted().joinToString(", ")}, was '$url'"
        }
    }

    private const val JDBC_PREFIX = "jdbc:"
}
