package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class CreateTableBuilderTest {
    @Test
    fun `primary key defaults to the shared naming rule and keeps column order`() {
        val statements = CreateTableBuilder("issue_changes", PostgresDialect)
            .column(ColumnDef("issue_key", ColumnType.VARCHAR, nullable = false, limit = 40))
            .column(ColumnDef("change_key", ColumnType.VARCHAR, nullable = false, limit = 40))
            .column(ColumnDef("created_at", ColumnType.BIGINT, nullable = false))
            .primaryKey("issue_key", "change_key")
            .build()
        assertThat(statements).containsExactly(
            "create table issue_changes (" +
                "issue_key varchar(40) not null, " +
                "change_key varchar(40) not null, " +
                "created_at bigint not null, " +
                "constraint pk_issue_changes primary key (issue_key, change_key))",
        )
    }

    @Test
    fun `auto increment is one nonnullable numeric id column`() {
        val statements = CreateTableBuilder("events", H2Dialect)
            .column(ColumnDef("id", ColumnType.INTEGER, nullable = false, autoIncrement = true))
            .primaryKey("id")
            .build()
        assertThat(statements.single())
            .contains("id integer generated always as identity not null")
            .contains("constraint pk_events primary key (id)")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("seq", ColumnType.INTEGER, nullable = false, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("id")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("id", ColumnType.INTEGER, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("nonnullable")

        assertThatThrownBy {
            CreateTableBuilder("events", H2Dialect)
                .column(ColumnDef("id", ColumnType.VARCHAR, nullable = false, limit = 40, autoIncrement = true))
                .build()
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("numeric")
    }

    @Test
    fun `a table needs columns and a validated name`() {
        assertThatThrownBy { CreateTableBuilder("issues", PostgresDialect).build() }
            .isInstanceOf(IllegalStateException::class.java)
        assertThatThrownBy { CreateTableBuilder("Issues", PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
    }
}
