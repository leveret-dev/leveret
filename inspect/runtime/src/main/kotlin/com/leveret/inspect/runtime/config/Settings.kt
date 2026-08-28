package com.leveret.inspect.runtime.config

/** Immutable resolved configuration. */
class Settings(private val values: Map<String, String>) {
    val keys: Set<String> get() = values.keys

    fun optional(key: String): String? = values[key]

    fun required(key: String): String =
        optional(key) ?: throw IllegalStateException("Missing configuration property: $key")

    fun value(key: String, fallback: String): String = optional(key) ?: fallback

    fun intValue(key: String, fallback: Int): Int {
        val raw = optional(key) ?: return fallback
        return raw.trim().toIntOrNull()
            ?: throw IllegalArgumentException("Configuration property $key is not an integer: $raw")
    }

    fun boolValue(key: String, fallback: Boolean): Boolean {
        val raw = optional(key) ?: return fallback
        return when (raw.trim().lowercase()) {
            "true" -> true
            "false" -> false
            else -> throw IllegalArgumentException("Configuration property $key is not a boolean: $raw")
        }
    }

    fun asMap(): Map<String, String> = values
}
