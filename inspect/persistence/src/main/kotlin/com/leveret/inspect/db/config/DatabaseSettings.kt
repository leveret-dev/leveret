package com.leveret.inspect.db.config

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Paths

/**
 * Resolved store contract: where the single embedded file lives and how many connections may be open
 * against it. Deriving the location from the runtime data directory rather than accepting a
 * connection string is what makes the store the engine's own — there is no server to point at, so
 * there is nothing for an operator to get wrong beyond choosing a different directory.
 */
data class DatabaseSettings(val url: String, val poolSize: Int) {
    companion object {
        fun from(settings: Settings): DatabaseSettings {
            val override = settings.optional(DatabaseKeys.URL)?.trim()?.takeIf { it.isNotEmpty() }
            val poolSize = settings.intValue(DatabaseKeys.POOL_SIZE, DatabaseKeys.DEFAULT_POOL_SIZE)
            require(poolSize >= 1) {
                "${DatabaseKeys.POOL_SIZE} must be at least 1, was $poolSize"
            }
            return DatabaseSettings(url = override ?: embeddedUrl(settings), poolSize = poolSize)
        }

        /** The store is a plain file, so an interrupted run leaves a database the next run can open. */
        private fun embeddedUrl(settings: Settings): String {
            val home = Paths.get(settings.required(PropertyKeys.PATH_HOME)).toAbsolutePath().normalize()
            val data = home.resolve(settings.value(PropertyKeys.PATH_DATA, "data"))
                .toAbsolutePath()
                .normalize()
            return "jdbc:h2:file:${data.resolve(DatabaseKeys.STORE_NAME)}"
        }
    }
}
