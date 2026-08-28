package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.pattern.TargetLengthBasedClassNameAbbreviator
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.classic.spi.ThrowableProxyUtil
import ch.qos.logback.core.LayoutBase
import java.time.Instant

/**
 * Renders one log event as an operator-readable line: timestamp, severity, process key, thread
 * identity, shortened logger name, and message. A throwable follows its message as an indented stack
 * trace so crash detail stays in the file.
 */
class PlainLayout(private val processKey: String) : LayoutBase<ILoggingEvent>() {
    private val loggerNames = TargetLengthBasedClassNameAbbreviator(LOGGER_NAME_TARGET_LENGTH)

    override fun doLayout(event: ILoggingEvent): String = render(event)

    fun render(event: ILoggingEvent): String {
        val out = StringBuilder(RECORD_CAPACITY)
        out.append(LOG_TIMESTAMP.format(Instant.ofEpochMilli(event.timeStamp)))
        out.append(' ').append(event.level.toString().padEnd(SEVERITY_WIDTH))
        out.append(' ').append(processKey)
        out.append('[').append(event.threadName).append(']')
        out.append(' ').append(loggerNames.abbreviate(event.loggerName))
        out.append(' ').append(event.formattedMessage ?: "")
        out.append('\n')
        val throwable = event.throwableProxy
        if (throwable != null) {
            out.append(ThrowableProxyUtil.asString(throwable))
            if (!out.endsWith("\n")) out.append('\n')
        }
        return out.toString()
    }

    private companion object {
        const val RECORD_CAPACITY = 192
        const val SEVERITY_WIDTH = 5
        const val LOGGER_NAME_TARGET_LENGTH = 20
    }
}
