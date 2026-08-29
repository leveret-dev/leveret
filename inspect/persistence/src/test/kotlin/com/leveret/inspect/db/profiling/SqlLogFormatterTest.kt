package com.leveret.inspect.db.profiling

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class SqlLogFormatterTest {
    @Test
    fun `normalization collapses layout whitespace`() {
        assertThat(SqlLogFormatter.normalize("select a\n\tfrom  t\n where a =  ?"))
            .isEqualTo("select a from t where a = ?")
    }

    @Test
    fun `parameters render bounded with a distinct null and escaped newlines`() {
        assertThat(SqlLogFormatter.render(null)).isEqualTo("[null]")
        assertThat(SqlLogFormatter.render("a\nb")).isEqualTo("a\\nb")
        val long = "x".repeat(SqlLogFormatter.PARAM_MAX_LENGTH + 10)
        val rendered = SqlLogFormatter.render(long)
        assertThat(rendered).hasSize(SqlLogFormatter.PARAM_MAX_LENGTH + 3).endsWith("...")
        assertThat(SqlLogFormatter.render(listOf(1, null, "b"))).isEqualTo("[1, [null], b]")
    }
}
