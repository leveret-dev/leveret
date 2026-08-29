package com.leveret.inspect.db.schema

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class IdentifiersTest {
    @Test
    fun `new identifiers follow the shared convention`() {
        assertThat(Identifiers.table("issue_changes")).isEqualTo("issue_changes")
        assertThat(Identifiers.constraint("pk_issue_changes")).isEqualTo("pk_issue_changes")
    }

    @Test
    fun `length shape and keywords are rejected without exemptions`() {
        val rejected: List<() -> Unit> = listOf(
            { Identifiers.table("a".repeat(26)) },
            { Identifiers.constraint("c".repeat(31)) },
            { Identifiers.table("1issues") },
            { Identifiers.table("_issues") },
            { Identifiers.table("Issues") },
            { Identifiers.column("issue-key") },
            { Identifiers.table("groups") },
            { Identifiers.column("value") },
            { Identifiers.column("select") },
        )
        rejected.forEach { call ->
            assertThatThrownBy(call).isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `existing names are accepted case insensitively`() {
        assertThat(Identifiers.existing("Arch_Models_UUID")).isEqualTo("Arch_Models_UUID")
        assertThatThrownBy { Identifiers.existing("has space") }
            .isInstanceOf(IllegalArgumentException::class.java)
    }
}
