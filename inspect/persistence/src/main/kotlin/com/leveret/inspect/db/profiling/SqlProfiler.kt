package com.leveret.inspect.db.profiling

import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.Statement
import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Statements are created here so trace profiling can wrap them without touching the pool. Wrapping is
 * decided per statement from the logger's level, and a wrapped statement keeps the exact return value
 * or exception of the statement it wraps.
 */
class SqlProfiler(private val logger: Logger = LoggerFactory.getLogger(LOGGER_NAME)) {
    val enabled: Boolean get() = logger.isTraceEnabled

    fun prepare(connection: Connection, sql: String): PreparedStatement {
        val delegate = connection.prepareStatement(sql)
        if (!enabled) return delegate
        return Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(PreparedStatement::class.java),
            TimingHandler(delegate, sql, logger, captureParameters = true),
        ) as PreparedStatement
    }

    fun statement(connection: Connection): Statement {
        val delegate = connection.createStatement()
        if (!enabled) return delegate
        return Proxy.newProxyInstance(
            javaClass.classLoader,
            arrayOf(Statement::class.java),
            TimingHandler(delegate, sql = null, logger = logger, captureParameters = false),
        ) as Statement
    }

    private class TimingHandler(
        private val delegate: Statement,
        private val sql: String?,
        private val logger: Logger,
        private val captureParameters: Boolean,
    ) : InvocationHandler {
        private val parameters = sortedMapOf<Int, Any?>()

        override fun invoke(proxy: Any, method: Method, args: Array<out Any?>?): Any? {
            val arguments = args ?: emptyArray()
            if (captureParameters && method.name.startsWith("set") && arguments.size >= 2) {
                (arguments[0] as? Int)?.let { parameters[it] = arguments[1] }
            }
            if (!method.name.startsWith("execute")) return call(method, arguments)
            val started = System.nanoTime()
            try {
                return call(method, arguments)
            } finally {
                val millis = (System.nanoTime() - started) / 1_000_000
                val statementSql =
                    SqlLogFormatter.normalize(sql ?: arguments.firstOrNull()?.toString() ?: "")
                val rendered = if (parameters.isEmpty()) {
                    ""
                } else {
                    " ${SqlLogFormatter.render(parameters.values.toList())}"
                }
                logger.trace("$millis ms | $statementSql$rendered")
            }
        }

        private fun call(method: Method, arguments: Array<out Any?>): Any? =
            try {
                method.invoke(delegate, *arguments)
            } catch (failure: InvocationTargetException) {
                throw failure.targetException
            }
    }

    companion object {
        const val LOGGER_NAME = "sql"
    }
}
