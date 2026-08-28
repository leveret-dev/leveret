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
import ch.qos.logback.core.rolling.FixedWindowRollingPolicy
import ch.qos.logback.core.rolling.RollingFileAppender
import ch.qos.logback.core.rolling.SizeBasedTriggeringPolicy
import ch.qos.logback.core.rolling.TimeBasedRollingPolicy
import ch.qos.logback.core.util.FileSize
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.proc.ProcessId
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

/** Retention of rolled log files. */
sealed interface RollingPolicy {
    /** Rolls once per period described by [datePattern], keeping [maxFiles] periods. */
    data class Time(val datePattern: String, val maxFiles: Int) : RollingPolicy

    /** Rolls once the active file reaches [maxFileSize], keeping files numbered 1 to [maxFiles]. */
    data class Size(val maxFileSize: String, val maxFiles: Int) : RollingPolicy

    /** Keeps only the active file. */
    data object None : RollingPolicy
}

/**
 * Log destinations, thresholds, layouts, and rotation of one process.
 *
 * Configuration runs before the guarded startup phase, so an unsupported level or rolling policy
 * throws instead of degrading to a default.
 */
object LogConfig {
    private const val DEFAULT_LEVEL = "INFO"
    private const val DEFAULT_ROLLING_POLICY = "time:yyyy-MM-dd"
    private const val DEFAULT_MAX_FILES = 7
    private const val TIME_PREFIX = "time:"
    private const val SIZE_PREFIX = "size:"
    private const val NO_ROLLING = "none"
    private const val FILE_APPENDER = "file"
    private const val CONSOLE_APPENDER = "console"

    private val levels = mapOf("INFO" to Level.INFO, "DEBUG" to Level.DEBUG, "TRACE" to Level.TRACE)

    /** Threshold of [id]: its own key wins over the global key, which falls back to `INFO`. */
    fun levelFor(settings: Settings, id: ProcessId): Level {
        val raw = settings.optional(PropertyKeys.logLevel(id))
            ?: settings.value(PropertyKeys.LOG_LEVEL, DEFAULT_LEVEL)
        return levels[raw.trim()]
            ?: throw IllegalArgumentException(
                "Unsupported log level: $raw. Supported levels are ${levels.keys.joinToString(", ")}",
            )
    }

    fun rollingPolicy(settings: Settings): RollingPolicy {
        val maxFiles = settings.intValue(PropertyKeys.LOG_MAX_FILES, DEFAULT_MAX_FILES)
        val raw = settings.value(PropertyKeys.LOG_ROLLING_POLICY, DEFAULT_ROLLING_POLICY).trim()
        return when {
            raw == NO_ROLLING -> RollingPolicy.None
            raw.startsWith(TIME_PREFIX) ->
                RollingPolicy.Time(argument(raw, TIME_PREFIX), maxFiles)
            raw.startsWith(SIZE_PREFIX) ->
                RollingPolicy.Size(argument(raw, SIZE_PREFIX), maxFiles)
            else -> throw IllegalArgumentException(
                "Unsupported log rolling policy: $raw. Supported forms are " +
                    "$TIME_PREFIX<date-pattern>, $SIZE_PREFIX<file-size>, and $NO_ROLLING",
            )
        }
    }

    private fun argument(raw: String, prefix: String): String {
        val argument = raw.substring(prefix.length).trim()
        if (argument.isEmpty()) {
            throw IllegalArgumentException("Log rolling policy $raw carries no $prefix argument")
        }
        return argument
    }

    /**
     * Points the logging backend at the log file of [id], replacing any earlier configuration so an
     * internal restart reconfigures cleanly.
     */
    fun configure(settings: Settings, fs: RuntimeFileSystem, id: ProcessId) {
        val level = levelFor(settings, id)
        val policy = rollingPolicy(settings)
        val json = settings.boolValue(PropertyKeys.LOG_JSON, false)
        val layout: () -> Layout<ILoggingEvent> =
            { if (json) JsonLayout(id.key) else PlainLayout(id.key) }

        val context = LoggerFactory.getILoggerFactory() as LoggerContext
        context.reset()
        val root = context.getLogger(Logger.ROOT_LOGGER_NAME)
        root.level = level
        root.addAppender(fileAppender(context, fs.logsDir.resolve(id.logFileName), layout(), policy))
        if (id == ProcessId.APP && settings.boolValue(PropertyKeys.LOG_CONSOLE, false)) {
            root.addAppender(consoleAppender(context, layout()))
        }
    }

    private fun fileAppender(
        context: LoggerContext,
        file: Path,
        layout: Layout<ILoggingEvent>,
        policy: RollingPolicy,
    ): Appender<ILoggingEvent> {
        val target = file.toString()
        val encoder = encoder(context, layout)
        val appender = when (policy) {
            RollingPolicy.None -> FileAppender<ILoggingEvent>()
            is RollingPolicy.Time, is RollingPolicy.Size -> RollingFileAppender<ILoggingEvent>()
        }
        appender.context = context
        appender.name = FILE_APPENDER
        appender.file = target
        appender.isAppend = true
        appender.encoder = encoder
        if (appender is RollingFileAppender<ILoggingEvent>) {
            when (policy) {
                RollingPolicy.None -> Unit
                is RollingPolicy.Time -> appender.rollingPolicy = timePolicy(context, appender, target, policy)
                is RollingPolicy.Size -> {
                    appender.rollingPolicy = sizePolicy(context, appender, target, policy)
                    appender.triggeringPolicy = sizeTrigger(context, policy)
                }
            }
        }
        appender.start()
        return appender
    }

    private fun timePolicy(
        context: LoggerContext,
        appender: FileAppender<ILoggingEvent>,
        target: String,
        policy: RollingPolicy.Time,
    ): TimeBasedRollingPolicy<ILoggingEvent> {
        val rolling = TimeBasedRollingPolicy<ILoggingEvent>()
        rolling.context = context
        rolling.setParent(appender)
        rolling.fileNamePattern = "$target.%d{${policy.datePattern}}"
        rolling.maxHistory = policy.maxFiles
        rolling.start()
        return rolling
    }

    private fun sizePolicy(
        context: LoggerContext,
        appender: FileAppender<ILoggingEvent>,
        target: String,
        policy: RollingPolicy.Size,
    ): FixedWindowRollingPolicy {
        val rolling = FixedWindowRollingPolicy()
        rolling.context = context
        rolling.setParent(appender)
        rolling.fileNamePattern = "$target.%i"
        rolling.minIndex = 1
        rolling.maxIndex = policy.maxFiles
        rolling.start()
        return rolling
    }

    private fun sizeTrigger(context: LoggerContext, policy: RollingPolicy.Size): SizeBasedTriggeringPolicy<ILoggingEvent> {
        val triggering = SizeBasedTriggeringPolicy<ILoggingEvent>()
        triggering.context = context
        triggering.maxFileSize = FileSize.valueOf(policy.maxFileSize)
        triggering.start()
        return triggering
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
