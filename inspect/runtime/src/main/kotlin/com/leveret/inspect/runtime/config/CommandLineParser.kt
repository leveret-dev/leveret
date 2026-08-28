package com.leveret.inspect.runtime.config

/** Parses application arguments, all of which must be property definitions in `-Dkey=value` form. */
object CommandLineParser {
    fun parse(args: Array<String>): Map<String, String> {
        val values = LinkedHashMap<String, String>()
        for (arg in args) {
            require(arg.startsWith("-D")) { "Unsupported argument, expected -Dkey=value: $arg" }
            val definition = arg.substring(2)
            val separator = definition.indexOf('=')
            require(separator > 0) { "Unsupported argument, expected -Dkey=value: $arg" }
            values[definition.substring(0, separator)] = definition.substring(separator + 1)
        }
        return values
    }
}
