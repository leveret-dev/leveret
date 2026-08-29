package com.leveret.inspect.db.charset

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import com.leveret.inspect.db.session.DbSession

enum class CheckerState { FRESH_INSTALL, UPGRADE, STARTUP }

/**
 * Text comparison and storage must behave identically across databases, so encoding is verified rather
 * than assumed. Nonconforming columns fail: silently rewriting an operator's database is worse than
 * refusing to start.
 */
interface CharsetHandler {
    fun check(session: DbSession, state: CheckerState, tables: Collection<String>)
}

object NoCharsetCheck : CharsetHandler {
    override fun check(session: DbSession, state: CheckerState, tables: Collection<String>) = Unit
}

class PostgresCharsetHandler : CharsetHandler {
    override fun check(session: DbSession, state: CheckerState, tables: Collection<String>) {
        val encoding = session
            .select(
                "select pg_encoding_to_char(encoding) from pg_database where datname = current_database()",
            ) { it.getString(1) }
            .firstOrNull()
            .orEmpty()
        require(encoding.uppercase().replace("-", "") == "UTF8") {
            "Database encoding must be UTF-8 capable, was '$encoding'"
        }
        if (state == CheckerState.FRESH_INSTALL || tables.isEmpty()) return

        val offending = session.select(
            """
            select table_name, column_name, collation_name
            from information_schema.columns
            where table_schema = current_schema()
              and data_type in ('character varying', 'character')
              and collation_name is not null
              and upper(replace(collation_name, '-', '')) not like '%UTF8%'
            """.trimIndent(),
        ) { Triple(it.getString(1), it.getString(2), it.getString(3)) }
            .filter { (table, _, _) -> table in tables }

        require(offending.isEmpty()) {
            "Columns must inherit the default collation or use a UTF-8 collation: " +
                offending.joinToString(", ") { (table, column, collation) -> "$table.$column ($collation)" }
        }
    }
}

object CharsetChecker {
    fun handlerFor(dialect: Dialect): CharsetHandler = when (dialect) {
        H2Dialect -> NoCharsetCheck
        PostgresDialect -> PostgresCharsetHandler()
        else -> throw IllegalArgumentException("No charset handler for dialect '${dialect.id}'")
    }
}
