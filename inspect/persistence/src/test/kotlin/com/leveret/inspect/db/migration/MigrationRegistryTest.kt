package com.leveret.inspect.db.migration

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class MigrationRegistryTest {
    private object NoopStep : MigrationStep {
        override fun execute(context: MigrationContext) = Unit
    }

    @Test
    fun `numbers parse from the dated form and compare numerically`() {
        assertThat(MigrationNumber.parse("2026_09_001")).isEqualTo(2026_09_001L)
        assertThat(MigrationNumber.format(2026_09_001L)).isEqualTo("2026_09_001")
        assertThat(MigrationNumber.parse("2026_09_002")).isGreaterThan(MigrationNumber.parse("2026_09_001"))
        listOf("2026-09-001", "2026_9_1", "abc", "", "-2026_09_001").forEach { text ->
            assertThatThrownBy { MigrationNumber.parse(text) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `registry orders numerically and rejects duplicates and empty descriptions`() {
        val registry = MigrationRegistry()
            .register("2026_09_002", "create metrics", NoopStep)
            .register("2026_09_001", "create projects", NoopStep)
        assertThat(registry.all().map { it.number })
            .containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(registry.maximum).isEqualTo(2026_09_002L)

        assertThatThrownBy { registry.register("2026_09_001", "again", NoopStep) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("2026_09_001")
        assertThatThrownBy { registry.register("2026_09_003", " ", NoopStep) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("description")
    }

    @Test
    fun `selection starts above the recorded maximum`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "one", NoopStep)
            .register("2026_09_002", "two", NoopStep)
            .register("2026_09_003", "three", NoopStep)
        assertThat(MigrationRegistry().maximum).isNull()
        assertThat(registry.above(null).map { it.number }).hasSize(3)
        assertThat(registry.above(2026_09_001L).map { it.number })
            .containsExactly(2026_09_002L, 2026_09_003L)
        assertThat(registry.above(2026_09_003L)).isEmpty()
    }
}
