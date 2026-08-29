package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

enum class ColumnType { VARCHAR, TEXT, BINARY, BOOLEAN, TINY, SMALL, INTEGER, BIGINT, DECIMAL, TIMESTAMP }

/** One logical column. The dialect decides the physical type; nullability is always explicit. */
data class ColumnDef(
    val name: String,
    val type: ColumnType,
    val nullable: Boolean = true,
    val limit: Int? = null,
    val default: Any? = null,
    val autoIncrement: Boolean = false,
) {
    init {
        Identifiers.column(name)
    }

    fun render(dialect: Dialect): String {
        val parts = mutableListOf(name, typeClause(dialect))
        parts += if (nullable) "null" else "not null"
        default?.let { parts += "default ${literal(it, dialect)}" }
        return parts.joinToString(" ")
    }

    private fun typeClause(dialect: Dialect): String = when (type) {
        ColumnType.VARCHAR -> {
            val size = requireNotNull(limit) { "Column '$name' of type VARCHAR requires a limit" }
            require(size in 1..VARCHAR_MAX_LENGTH) {
                "Column '$name' varchar limit $size exceeds $VARCHAR_MAX_LENGTH"
            }
            "varchar($size)"
        }
        ColumnType.TEXT -> if (dialect.id == "postgresql") "text" else "clob"
        ColumnType.BINARY -> if (dialect.id == "postgresql") "bytea" else "blob"
        ColumnType.BOOLEAN -> "boolean"
        ColumnType.TINY -> "smallint"
        ColumnType.SMALL -> "smallint"
        ColumnType.INTEGER -> if (autoIncrement) dialect.identityClause() else "integer"
        ColumnType.BIGINT -> "bigint"
        ColumnType.DECIMAL -> "decimal(38,20)"
        ColumnType.TIMESTAMP -> "timestamp"
    }

    private fun literal(value: Any, dialect: Dialect): String = when (value) {
        is Boolean -> dialect.booleanLiteral(value)
        is Number -> value.toString()
        else -> "'${value.toString().replace("'", "''")}'"
    }

    companion object {
        const val VARCHAR_MAX_LENGTH = 4000
        const val IDENTIFIER_LENGTH = 40
    }
}
