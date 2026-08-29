package com.leveret.inspect.db.migration

/** Migration numbers are `YYYY_MM_NNN` in text and a decimal number in comparisons and history. */
object MigrationNumber {
    private val shape = Regex("(\\d{4})_(\\d{2})_(\\d{3})")

    fun parse(text: String): Long {
        val match = shape.matchEntire(text)
            ?: throw IllegalArgumentException("Migration number '$text' must have the form YYYY_MM_NNN")
        return match.groupValues.drop(1).joinToString("").toLong()
    }

    fun format(number: Long): String {
        require(number >= 0) { "Migration number $number must be nonnegative" }
        val text = number.toString().padStart(9, '0')
        return "${text.substring(0, 4)}_${text.substring(4, 6)}_${text.substring(6)}"
    }
}
