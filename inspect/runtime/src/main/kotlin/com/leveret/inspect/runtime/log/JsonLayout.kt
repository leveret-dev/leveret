package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.spi.ThrowableProxyUtil
import ch.qos.logback.core.LayoutBase
import java.time.Instant

/**
 * Renders one log event as a single-line JSON object.
 *
 * Field order is fixed: process key, diagnostic-context entries, timestamp, severity, logger,
 * message, and the stack trace when the event carries a throwable.
 */
class JsonLayout(private val processKey: String) : LayoutBase<ILoggingEvent>() {
    override fun doLayout(event: ILoggingEvent): String = render(event)

    fun render(event: ILoggingEvent): String {
        val out = StringBuilder(RECORD_CAPACITY)
        out.append('{')
        field(out, "process", processKey)
        for ((key, value) in diagnosticContext(event)) {
            field(out, key, value)
        }
        field(out, "timestamp", LOG_TIMESTAMP.format(Instant.ofEpochMilli(event.timeStamp)))
        field(out, "severity", event.level.toString())
        field(out, "logger", event.loggerName)
        field(out, "message", singleLine(event.formattedMessage))
        val throwable = event.throwableProxy
        if (throwable != null) {
            separate(out)
            out.append("\"stacktrace\":[")
            val frames = ThrowableProxyUtil.asString(throwable).split(LINE_BREAK)
            var first = true
            for (frame in frames) {
                if (frame.isEmpty()) continue
                if (!first) out.append(',')
                first = false
                out.append('"')
                escape(out, frame)
                out.append('"')
            }
            out.append(']')
        }
        out.append("}\n")
        return out.toString()
    }

    /**
     * Diagnostic-context entries that the record does not already own. An event created outside a
     * started logger context has no diagnostic-context adapter at all; such an event contributes
     * nothing instead of failing the render.
     */
    private fun diagnosticContext(event: ILoggingEvent): Map<String, String> {
        val entries = runCatching { event.mdcPropertyMap }.getOrNull() ?: return emptyMap()
        return entries.filterKeys { it !in OWNED_FIELDS }
    }

    private fun field(out: StringBuilder, name: String, value: String) {
        separate(out)
        out.append('"')
        escape(out, name)
        out.append("\":\"")
        escape(out, value)
        out.append('"')
    }

    private fun separate(out: StringBuilder) {
        if (out.length > 1) out.append(',')
    }

    private fun singleLine(message: String?): String = (message ?: "").replace(LINE_BREAK, " ")

    private fun escape(out: StringBuilder, raw: String) {
        for (character in raw) {
            when {
                character == '"' -> out.append("\\\"")
                character == '\\' -> out.append("\\\\")
                character == '\n' -> out.append("\\n")
                character == '\r' -> out.append("\\r")
                character == '\t' -> out.append("\\t")
                character == '\b' -> out.append("\\b")
                character == '\u000C' -> out.append("\\f")
                character < ' ' -> out.append("\\u").append("%04x".format(character.code))
                else -> out.append(character)
            }
        }
    }

    private companion object {
        const val RECORD_CAPACITY = 256

        /** Field names the record renders itself, so a diagnostic-context entry never shadows one. */
        val OWNED_FIELDS = setOf("process", "timestamp", "severity", "logger", "message", "stacktrace")
    }
}
