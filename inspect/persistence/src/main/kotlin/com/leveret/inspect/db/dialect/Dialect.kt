package com.leveret.inspect.db.dialect

/**
 * Every statement difference between supported databases lives behind this contract, so a builder
 * never has to know which database it is generating for. Adding a database means adding one
 * implementation, not editing call sites.
 */
interface Dialect {
    val id: String

    fun quote(identifier: String): String

    fun booleanLiteral(value: Boolean): String = value.toString()

    /** Column type clause for the single allowed auto-increment column. */
    fun identityClause(): String

    fun limitOffset(limit: Int, offset: Int): String = "limit $limit offset $offset"

    fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String
}

object H2Dialect : Dialect {
    override val id = "h2"

    override fun quote(identifier: String) = "\"${identifier.uppercase()}\""

    override fun identityClause() = "integer generated always as identity"

    override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String {
        val placeholders = columns.joinToString(", ") { "?" }
        return "merge into $table (${columns.joinToString(", ")}) " +
            "key (${conflictColumns.joinToString(", ")}) values ($placeholders)"
    }
}

object PostgresDialect : Dialect {
    override val id = "postgresql"

    override fun quote(identifier: String) = "\"${identifier.lowercase()}\""

    override fun identityClause() = "serial"

    override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>): String {
        val placeholders = columns.joinToString(", ") { "?" }
        val updates = columns.filterNot { it in conflictColumns }
            .joinToString(", ") { "$it = excluded.$it" }
        return "insert into $table (${columns.joinToString(", ")}) values ($placeholders) " +
            "on conflict (${conflictColumns.joinToString(", ")}) do update set $updates"
    }
}

object Dialects {
    private val byId = listOf(H2Dialect, PostgresDialect).associateBy { it.id }

    fun of(provider: String): Dialect = byId[provider.lowercase()]
        ?: throw IllegalArgumentException(
            "Unsupported database provider '$provider'; supported providers are ${byId.keys.sorted()}",
        )
}
