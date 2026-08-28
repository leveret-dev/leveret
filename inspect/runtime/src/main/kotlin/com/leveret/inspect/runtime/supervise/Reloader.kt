package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.config.SettingsLoader

/** Produces the settings an internal restart continues with. */
fun interface Reloader {
    /** @throws IllegalStateException when the new settings are not a legal continuation. */
    fun reload(current: Settings): Settings
}

/**
 * Reloads settings from their sources and refuses a change that a running node cannot honor: the
 * directory layout is fixed for the lifetime of a monitor instance, because children already hold
 * paths handed to them at launch.
 */
class SettingsReloader(
    private val loader: SettingsLoader,
    private val args: Array<String>,
) : Reloader {
    override fun reload(current: Settings): Settings {
        val reloaded = loader.load(args)
        IMMUTABLE_KEYS.forEach { key ->
            val before = current.optional(key)
            val after = reloaded.optional(key)
            if (before != after) {
                throw IllegalStateException(
                    "$key cannot change on restart: was '$before', now '$after'",
                )
            }
        }
        return reloaded
    }

    private companion object {
        val IMMUTABLE_KEYS = listOf(
            PropertyKeys.PATH_DATA,
            PropertyKeys.PATH_LOGS,
            PropertyKeys.PATH_TEMP,
            PropertyKeys.PATH_WEB,
        )
    }
}
