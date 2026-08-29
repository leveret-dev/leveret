package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

/** Index, column, and rename statements. Every name passes identifier validation first. */
object SchemaStatements {
    fun createIndex(table: String, name: String, columns: List<String>, unique: Boolean = false): String {
        val target = Identifiers.table(table)
        val index = Identifiers.index(name)
        val kind = if (unique) "create unique index" else "create index"
        return "$kind $index on $target (${columns.map(Identifiers::column).joinToString(", ")})"
    }

    fun dropIndex(table: String, name: String, dialect: Dialect): String {
        Identifiers.table(table)
        return "drop index ${Identifiers.existing(name)}"
    }

    fun renameIndex(from: String, to: String, dialect: Dialect): String =
        "alter index ${Identifiers.existing(from)} rename to ${Identifiers.index(to)}"

    fun addColumn(table: String, column: ColumnDef, dialect: Dialect): String =
        "alter table ${Identifiers.table(table)} add column ${column.render(dialect)}"

    fun dropColumn(table: String, column: String): String =
        "alter table ${Identifiers.table(table)} drop column ${Identifiers.column(column)}"

    fun setNullable(table: String, column: ColumnDef, dialect: Dialect): List<String> {
        val action = if (column.nullable) "drop not null" else "set not null"
        return listOf(
            "alter table ${Identifiers.table(table)} alter column ${column.name} $action",
        )
    }

    fun renameTable(from: String, to: String): String =
        "alter table ${Identifiers.table(from)} rename to ${Identifiers.table(to)}"

    fun renameConstraint(table: String, from: String, to: String, dialect: Dialect): String =
        "alter table ${Identifiers.table(table)} rename constraint ${Identifiers.existing(from)} " +
            "to ${Identifiers.constraint(to)}"
}
