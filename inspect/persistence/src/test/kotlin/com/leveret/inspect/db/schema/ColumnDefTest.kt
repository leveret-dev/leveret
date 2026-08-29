package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ColumnDefTest {
    @Test
    fun `nullability is explicit and defaults are dialect rendered`() {
        assertThat(ColumnDef("uuid", ColumnType.VARCHAR, nullable = false, limit = 40).render(PostgresDialect))
            .isEqualTo("uuid varchar(40) not null")
        assertThat(ColumnDef("enabled", ColumnType.BOOLEAN, nullable = false, default = true).render(PostgresDialect))
            .isEqualTo("enabled boolean not null default true")
        assertThat(ColumnDef("state", ColumnType.VARCHAR, limit = 20, default = "PENDING").render(PostgresDialect))
            .isEqualTo("state varchar(20) null default 'PENDING'")
    }

    @Test
    fun `large types differ per dialect`() {
        assertThat(ColumnDef("body", ColumnType.TEXT).render(H2Dialect)).isEqualTo("body clob null")
        assertThat(ColumnDef("body", ColumnType.TEXT).render(PostgresDialect)).isEqualTo("body text null")
        assertThat(ColumnDef("payload", ColumnType.BINARY).render(PostgresDialect))
            .isEqualTo("payload bytea null")
    }

    @Test
    fun `varchar limits are enforced`() {
        assertThatThrownBy { ColumnDef("t", ColumnType.VARCHAR, limit = 4001).render(PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("4000")
        assertThatThrownBy { ColumnDef("t", ColumnType.VARCHAR).render(PostgresDialect) }
            .isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("limit")
    }
}
