package com.leveret.inspect.db.schema

/**
 * Generated identifiers are validated at construction: a name that reaches DDL generation has already
 * been proven safe, which is also what keeps the migration builders free of injection surface.
 */
object Identifiers {
    const val MAX_TABLE_LENGTH = 25
    const val MAX_CONSTRAINT_LENGTH = 30

    /**
     * Reserved words rejected with no exemptions, taken from the strictest supported dialect so a name
     * that validates here needs no quoting on any of them. H2 reserves temporal unit words such as
     * `second` and `year` that PostgreSQL accepts, and an unquoted table named after one fails only at
     * migration time otherwise.
     */
    val RESERVED = setOf(
        "all", "alter", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "between",
        "by", "case", "cast", "check", "column", "constraint", "create", "cross", "current_catalog",
        "current_date", "current_path", "current_role", "current_schema", "current_time",
        "current_timestamp", "current_user", "day", "default", "delete", "desc", "distinct", "drop",
        "else", "end", "except", "exists", "false", "fetch", "filter", "for", "foreign", "from", "full",
        "group", "groups", "having", "hour", "if", "ilike", "in", "index", "inner", "insert",
        "intersect", "interval", "into", "is", "join", "key", "leading", "left", "like", "limit",
        "localtime", "localtimestamp", "minus", "minute", "month", "natural", "not", "null", "offset",
        "on", "or", "order", "outer", "over", "partition", "primary", "qualify", "range", "references",
        "regexp", "right", "row", "rownum", "second", "select", "session_user", "set", "some",
        "symmetric", "system_user", "table", "then", "to", "top", "trailing", "true", "uescape",
        "union", "unique", "unknown", "update", "user", "using", "value", "values", "when", "where",
        "window", "with", "year",
    )

    private val shape = Regex("[a-z][a-z0-9_]*")
    private val existingShape = Regex("[A-Za-z][A-Za-z0-9_]*")

    fun table(name: String): String = validate(name, MAX_TABLE_LENGTH, "table")

    fun column(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "column")

    fun constraint(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "constraint")

    fun index(name: String): String = validate(name, MAX_CONSTRAINT_LENGTH, "index")

    /** Accepts an already existing mixed-case name, the one case where case is not normalized. */
    fun existing(name: String): String {
        require(existingShape.matches(name) && name.length <= MAX_CONSTRAINT_LENGTH) {
            "Existing identifier '$name' must be alphanumeric with underscores and at most " +
                "$MAX_CONSTRAINT_LENGTH characters"
        }
        return name
    }

    private fun validate(name: String, maxLength: Int, kind: String): String {
        require(name.length <= maxLength) {
            "New $kind name '$name' exceeds $maxLength characters"
        }
        require(shape.matches(name)) {
            "New $kind name '$name' must be lowercase letters, digits, and underscores, starting with " +
                "a letter"
        }
        require(name !in RESERVED) { "New $kind name '$name' is a reserved SQL keyword" }
        return name
    }
}
