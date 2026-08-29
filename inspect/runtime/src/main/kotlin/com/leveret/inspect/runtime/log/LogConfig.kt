package com.leveret.inspect.runtime.log

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.LoggerContext
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.Appender
import ch.qos.logback.core.ConsoleAppender
import ch.qos.logback.core.FileAppender
import ch.qos.logback.core.Layout
import ch.qos.logback.core.encoder.Encoder
import ch.qos.logback.core.encoder.LayoutWrappingEncoder
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.slf4j.LoggerFactory

/** Timestamp format of both layouts. */
internal val LOG_TIMESTAMP: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX").withZone(ZoneId.systemDefault())

/** Any line break, including a carriage-return line-feed pair, as one match. */
internal val LINE_BREAK = Regex("\\R")

/**
 * Log destination, threshold, and layout of the engine.
 *
 * An unsupported level throws instead of degrading to a default, because a threshold silently
 * ignored for the life of the process is worse than a refused start.
 */
object LogConfig {
    /** The engine's own name: the log file is named after it and both layouts stamp it on a record. */
    const val NAME = "leveret"

    private const val DEFAULT_LEVEL = "INFO"
    private const val FILE_APPENDER = "file"
    private const val CONSOLE_APPENDER = "console"

    private val levels = mapOf("INFO" to Level.INFO, "DEBUG" to Level.DEBUG, "TRACE" to Level.TRACE)

    fun levelOf(settings: Settings): Level {
        val raw = settings.value(PropertyKeys.LOG_LEVEL, DEFAULT_LEVEL)
        return levels[raw.trim()]
            ?: throw IllegalArgumentException(
                "Unsupported log level: $raw. Supported levels are ${levels.keys.joinToString(", ")}",
            )
    }

    /**
     * Points the logging backend at the log file. Any earlier configuration is discarded, including
     * the backend's own default, which would otherwise keep writing to standard output as well.
     */
    fun configure(settings: Settings, fs: RuntimeFileSystem) {
        val json = settings.boolValue(PropertyKeys.LOG_JSON, false)
        val layout: () -> Layout<ILoggingEvent> = { if (json) JsonLayout(NAME) else PlainLayout(NAME) }

        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        context.reset()
        val root = context.getLogger(Logger.ROOT_LOGGER_NAME)
        root.level = levelOf(settings)
        root.addAppender(fileAppender(context, fs.logsDir.resolve("$NAME.log"), layout()))
        if (settings.boolValue(PropertyKeys.LOG_CONSOLE, false)) {
            root.addAppender(consoleAppender(context, layout()))
        }
    }

    private fun fileAppender(
        context: LoggerContext,
        file: Path,
        layout: Layout<ILoggingEvent>,
    ): Appender<ILoggingEvent> {
        val appender = FileAppender<ILoggingEvent>()
        appender.context = context
        appender.name = FILE_APPENDER
        appender.file = file.toString()
        appender.isAppend = true
        appender.encoder = encoder(context, layout)
        appender.start()
        return appender
    }

    private fun consoleAppender(context: LoggerContext, layout: Layout<ILoggingEvent>): Appender<ILoggingEvent> {
        val appender = ConsoleAppender<ILoggingEvent>()
        appender.context = context
        appender.name = CONSOLE_APPENDER
        appender.encoder = encoder(context, layout)
        appender.start()
        return appender
    }

    private fun encoder(context: LoggerContext, layout: Layout<ILoggingEvent>): Encoder<ILoggingEvent> {
        layout.context = context
        layout.start()
        val encoder = LayoutWrappingEncoder<ILoggingEvent>()
        encoder.context = context
        encoder.charset = StandardCharsets.UTF_8
        encoder.layout = layout
        encoder.start()
        return encoder
    }
}
