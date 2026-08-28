package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings

/**
 * Ordered JVM option list for a child process.
 *
 * [mandatory] maps an option prefix, including its trailing separator, to the only value the runtime
 * accepts for it. An operator may restate a mandatory option exactly, but may not assign it another
 * value. Exact duplicates collapse and insertion order is preserved, mandatory options first.
 */
class JvmOptions(private val mandatory: Map<String, String>) {
    private val options = LinkedHashSet<String>()

    init {
        mandatory.forEach { (prefix, value) -> options.add(prefix + value) }
    }

    fun add(option: String): JvmOptions {
        require(option.isNotBlank()) { "JVM option must not be empty" }
        require(option.startsWith("-")) { "JVM option must start with '-': $option" }
        mandatory.forEach { (prefix, value) ->
            if (option.startsWith(prefix) && option != prefix + value) {
                throw IllegalArgumentException(
                    "JVM option '$option' overrides mandatory option '${prefix + value}'",
                )
            }
        }
        options.add(option)
        return this
    }

    fun addFromSettings(settings: Settings, id: ProcessId): JvmOptions {
        listOf(PropertyKeys.javaOpts(id), PropertyKeys.javaAdditionalOpts(id)).forEach { key ->
            settings.optional(key)
                ?.split(WHITESPACE)
                ?.filter { it.isNotBlank() }
                ?.forEach { add(it) }
        }
        return this
    }

    /** True when any current option assigns the same system property or option name as [option]. */
    fun definesSameAs(option: String): Boolean {
        val name = option.substringBefore('=')
        return options.any { it.substringBefore('=') == name }
    }

    fun toList(): List<String> = options.toList()

    private companion object {
        val WHITESPACE = Regex("\\s+")
    }
}
