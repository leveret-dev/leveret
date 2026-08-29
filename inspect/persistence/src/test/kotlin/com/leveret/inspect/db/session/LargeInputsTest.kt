package com.leveret.inspect.db.session

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class LargeInputsTest {
    @Test
    fun `oversized inputs are partitioned and results concatenated`() {
        val input = (1..2500).toList()
        val partitions = mutableListOf<Int>()
        val read = LargeInputs.read(input) { partition ->
            partitions += partition.size
            partition.map { it * 2 }
        }
        assertThat(partitions).containsExactly(1000, 1000, 500)
        assertThat(read.first()).isEqualTo(2)
        assertThat(read).hasSize(2500)

        assertThat(LargeInputs.update(input) { it.size }).isEqualTo(2500)
        assertThat(LargeInputs.read<Int, Int>(emptyList()) { error("never called") }).isEmpty()
    }
}
