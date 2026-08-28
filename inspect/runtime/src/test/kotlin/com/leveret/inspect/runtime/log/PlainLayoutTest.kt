package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.LoggingEvent
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class PlainLayoutTest {
    private fun event(message: String): LoggingEvent {
        val context = LoggerContext()
        val logger = context.getLogger("com.leveret.inspect.runtime.Example")
        return LoggingEvent("m", logger, Level.INFO, message, null, emptyArray())
    }

    @Test
    fun `plain record carries the specified fields on one line`() {
        val rendered = PlainLayout("app").render(event("started"))

        assertThat(rendered).endsWith("\n")
        assertThat(rendered.trimEnd().lines()).hasSize(1)
        assertThat(rendered).contains("INFO")
            .contains("app[")
            .contains("Example")
            .doesNotContain("com.leveret.inspect.runtime.Example")
            .endsWith("started\n")
    }
}
