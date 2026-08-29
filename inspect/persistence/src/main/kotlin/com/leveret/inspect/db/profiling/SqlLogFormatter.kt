package com.leveret.inspect.db.profiling

/** Statement and parameter rendering for the SQL trace channel. */
object SqlLogFormatter {
    const val PARAM_MAX_LENGTH = 500
    const val NULL_RENDERING = "[null]"

    private val whitespace = Regex("\\s+")

    fun normalize(sql: String): String = sql.replace(whitespace, " ").trim()

    fun render(value: Any?): String {
        if (value == null) return NULL_RENDERING
        val text = value.toString().replace("\n", "\\n").replace("\r", "\\r")
        return if (text.length <= PARAM_MAX_LENGTH) text else text.take(PARAM_MAX_LENGTH) + "..."
    }

    fun render(values: List<Any?>): String = values.joinToString(", ", "[", "]") { render(it) }
}
