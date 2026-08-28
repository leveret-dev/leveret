package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.LoggingEvent
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class JsonLayoutTest {
    private fun event(message: String, throwable: Throwable? = null): LoggingEvent {
        val context = LoggerContext()
        val logger = context.getLogger("com.leveret.inspect.runtime.Example")
        return LoggingEvent("m", logger, Level.INFO, message, throwable, emptyArray())
    }

    @Test
    fun `json record carries the specified fields on one line`() {
        val rendered = JsonLayout("web", nodeName = null).render(event("started\nsecond line"))
        assertThat(rendered.trimEnd()).doesNotContain("\n")
        assertThat(rendered).contains("\"process\":\"web\"")
            .contains("\"severity\":\"INFO\"")
            .contains("\"logger\":\"com.leveret.inspect.runtime.Example\"")
            .contains("\"timestamp\":")
            .contains("started second line")
            .doesNotContain("\"nodename\"")
            .doesNotContain("\"stacktrace\"")
    }

    @Test
    fun `node name and stacktrace appear when present`() {
        val rendered = JsonLayout("ce", nodeName = "node-1").render(event("boom", IllegalStateException("bad")))
        assertThat(rendered).contains("\"nodename\":\"node-1\"")
            .contains("\"stacktrace\":[")
            .contains("IllegalStateException")
    }
}
