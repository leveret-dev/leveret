package com.leveret.inspect.db.schema

import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class SchemaStatementsTest {
    @Test
    fun `index statements are dialect aware`() {
        assertThat(SchemaStatements.createIndex("issues", "issues_component_uuid", listOf("component_uuid")))
            .isEqualTo("create index issues_component_uuid on issues (component_uuid)")
        assertThat(
            SchemaStatements.createIndex("issues", "issues_kee", listOf("kee"), unique = true),
        ).isEqualTo("create unique index issues_kee on issues (kee)")
        assertThat(SchemaStatements.dropIndex("issues", "issues_kee", PostgresDialect))
            .isEqualTo("drop index issues_kee")
        assertThat(SchemaStatements.dropIndex("issues", "issues_kee", H2Dialect))
            .isEqualTo("drop index issues_kee")
        assertThat(SchemaStatements.renameIndex("arch_intended_uuid", "arch_models_uuid", PostgresDialect))
            .isEqualTo("alter index arch_intended_uuid rename to arch_models_uuid")
    }

    @Test
    fun `column and table changes are generated per dialect`() {
        val column = ColumnDef("producer", ColumnType.VARCHAR, limit = 40)
        assertThat(SchemaStatements.addColumn("issues", column, PostgresDialect))
            .isEqualTo("alter table issues add column producer varchar(40) null")
        assertThat(SchemaStatements.dropColumn("issues", "producer"))
            .isEqualTo("alter table issues drop column producer")
        assertThat(
            SchemaStatements.setNullable(
                "a3s_contexts",
                ColumnDef("branch_name", ColumnType.VARCHAR, nullable = true, limit = 255),
                PostgresDialect,
            ),
        ).containsExactly("alter table a3s_contexts alter column branch_name drop not null")
        assertThat(
            SchemaStatements.setNullable(
                "a3s_contexts",
                ColumnDef("branch_name", ColumnType.VARCHAR, nullable = false, limit = 255),
                H2Dialect,
            ),
        ).containsExactly("alter table a3s_contexts alter column branch_name set not null")
        assertThat(SchemaStatements.renameTable("arch_intended", "arch_models"))
            .isEqualTo("alter table arch_intended rename to arch_models")
        assertThat(
            SchemaStatements.renameConstraint("arch_models", "pk_arch_intended", "pk_arch_models", PostgresDialect),
        ).isEqualTo("alter table arch_models rename constraint pk_arch_intended to pk_arch_models")
    }

    @Test
    fun `generated names are validated`() {
        assertThatThrownBy {
            SchemaStatements.createIndex("issues", "Issues_Index", listOf("kee"))
        }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
