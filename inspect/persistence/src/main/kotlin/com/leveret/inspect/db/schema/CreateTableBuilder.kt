package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.Dialect

/**
 * Builds one table's DDL. The builder owns the naming rules that make a schema comparable across
 * databases: one primary-key naming convention, declared column order, and a single auto-increment
 * column.
 */
class CreateTableBuilder(table: String, private val dialect: Dialect) {
    private val table = Identifiers.table(table)
    private val columns = mutableListOf<ColumnDef>()
    private var primaryKeyColumns = emptyList<String>()
    private var constraintName: String? = null

    fun column(column: ColumnDef): CreateTableBuilder = apply { columns += column }

    fun primaryKey(vararg columns: String): CreateTableBuilder = apply {
        primaryKeyColumns = columns.map(Identifiers::column)
    }

    fun primaryKeyName(name: String): CreateTableBuilder = apply {
        constraintName = Identifiers.constraint(name)
    }

    fun build(): List<String> {
        check(columns.isNotEmpty()) { "Table $table declares no column" }
        val generated = columns.filter { it.autoIncrement }
        require(generated.size <= 1) { "Table $table declares ${generated.size} auto-increment columns" }
        generated.forEach { column ->
            require(column.name == "id") {
                "Auto-increment column '${column.name}' in $table must be named id"
            }
            require(!column.nullable) { "Auto-increment column id in $table must be nonnullable" }
            require(column.type in NUMERIC_TYPES) { "Auto-increment column id in $table must be numeric" }
        }
        val body = columns.map { it.render(dialect) }.toMutableList()
        if (primaryKeyColumns.isNotEmpty()) {
            val name = constraintName ?: Identifiers.constraint("pk_$table")
            body += "constraint $name primary key (${primaryKeyColumns.joinToString(", ")})"
        }
        return listOf("create table $table (${body.joinToString(", ")})")
    }

    private companion object {
        val NUMERIC_TYPES = setOf(ColumnType.INTEGER, ColumnType.BIGINT)
    }
}
