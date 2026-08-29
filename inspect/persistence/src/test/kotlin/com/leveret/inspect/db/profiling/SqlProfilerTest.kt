package com.leveret.inspect.db.profiling

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import java.sql.DriverManager
import java.sql.SQLException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory

class SqlProfilerTest {
    private val traceLogger = LoggerFactory.getLogger(SqlProfiler.LOGGER_NAME) as ch.qos.logback.classic.Logger
    private val records = ListAppender<ILoggingEvent>().apply { start() }

    private fun tracing(): SqlProfiler {
        traceLogger.level = Level.TRACE
        traceLogger.addAppender(records)
        return SqlProfiler(traceLogger)
    }

    @AfterEach
    fun detach() {
        traceLogger.detachAppender(records)
        traceLogger.level = null
    }

    private fun messages() = records.list.map { it.formattedMessage }

    @Test
    fun `profiled execution preserves results and exceptions while tracing`() {
        val profiler = tracing()
        assertThat(profiler.enabled).isTrue()
        DriverManager.getConnection("jdbc:h2:mem:profiler-${System.nanoTime()}").use { connection ->
            profiler.statement(connection).use {
                it.execute("create table t (id int primary key, label varchar(10))")
            }

            profiler.prepare(connection, "insert into t (id, label)\n values (?, ?)").use { statement ->
                statement.setInt(1, 7)
                statement.setString(2, "label")
                assertThat(statement.executeUpdate()).isEqualTo(1)
            }
            assertThat(messages().last())
                .contains("insert into t (id, label) values (?, ?)")
                .contains("[7, label]")
                .containsPattern("\\d+ ms")

            profiler.prepare(connection, "insert into t (id, label) values (?, ?)").use { statement ->
                statement.setInt(1, 7)
                statement.setString(2, "duplicate")
                assertThatThrownBy { statement.executeUpdate() }.isInstanceOf(SQLException::class.java)
            }
            assertThat(messages().last())
                .contains("insert into t (id, label) values (?, ?)")
                .contains("[7, duplicate]")
        }
    }

    @Test
    fun `pass through mode returns plain statements`() {
        val silent = LoggerFactory.getLogger("sql.silent") as ch.qos.logback.classic.Logger
        silent.level = Level.DEBUG
        val profiler = SqlProfiler(silent)
        assertThat(profiler.enabled).isFalse()
        DriverManager.getConnection("jdbc:h2:mem:plain-${System.nanoTime()}").use { connection ->
            profiler.prepare(connection, "select 1").use { statement ->
                assertThat(statement.javaClass.name).doesNotContain("Proxy")
            }
        }
    }
}
