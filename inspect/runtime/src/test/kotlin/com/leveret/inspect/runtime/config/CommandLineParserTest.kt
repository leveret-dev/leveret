package com.leveret.inspect.runtime.config

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class CommandLineParserTest {
    @Test
    fun `parses well formed definitions`() {
        assertThat(CommandLineParser.parse(arrayOf("-Da=1", "-Db=x=y")))
            .containsExactlyInAnyOrderEntriesOf(mapOf("a" to "1", "b" to "x=y"))
    }

    @Test
    fun `rejects malformed arguments`() {
        listOf("a=1", "-Da", "-D=1", "").forEach { arg ->
            assertThatThrownBy { CommandLineParser.parse(arrayOf(arg)) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }
}
