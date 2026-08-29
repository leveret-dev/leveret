package com.leveret.inspect.db.dialect

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DialectTest {
    @Test
    fun `only h2 and postgresql resolve`() {
        assertThat(Dialects.of("h2")).isSameAs(H2Dialect)
        assertThat(Dialects.of("POSTGRESQL")).isSameAs(PostgresDialect)
        listOf("oracle", "mssql", "sqlserver", "mysql", "").forEach { token ->
            assertThatThrownBy { Dialects.of(token) }
                .isInstanceOf(IllegalArgumentException::class.java)
                .hasMessageContaining(token)
        }
    }

    @Test
    fun `statement differences are dialect owned`() {
        assertThat(H2Dialect.quote("issues")).isEqualTo("\"ISSUES\"")
        assertThat(PostgresDialect.quote("issues")).isEqualTo("\"issues\"")
        assertThat(H2Dialect.identityClause()).isEqualTo("integer generated always as identity")
        assertThat(PostgresDialect.identityClause()).isEqualTo("serial")
        assertThat(H2Dialect.limitOffset(10, 20)).isEqualTo("limit 10 offset 20")
        assertThat(PostgresDialect.booleanLiteral(true)).isEqualTo("true")
    }

    @Test
    fun `upsert targets the conflict columns`() {
        val sql = PostgresDialect.upsert("metrics", listOf("uuid", "name"), listOf("uuid"))
        assertThat(sql).isEqualTo(
            "insert into metrics (uuid, name) values (?, ?) " +
                "on conflict (uuid) do update set name = excluded.name",
        )
        assertThat(H2Dialect.upsert("metrics", listOf("uuid", "name"), listOf("uuid")))
            .isEqualTo("merge into metrics (uuid, name) key (uuid) values (?, ?)")
    }
}
