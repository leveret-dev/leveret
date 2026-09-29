package com.leveret.inspect.runtime

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ToolchainTest {
    @Test
    fun `runs on java 25 or later`() {
        assertThat(Runtime.version().feature()).isGreaterThanOrEqualTo(25)
    }
}
