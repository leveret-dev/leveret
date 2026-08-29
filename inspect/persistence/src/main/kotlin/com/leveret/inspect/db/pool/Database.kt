package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.dialect.Dialect
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import javax.sql.DataSource

/** Pool counts and configured limits. Publication belongs to the telemetry part. */
data class PoolStats(
    val active: Int,
    val total: Int,
    val idle: Int,
    val maxActive: Int,
    val minIdle: Int,
    val maxLifetimeMs: Long,
    val maxWaitMs: Int,
)

/**
 * Owns the writer and read-only pools. The pool itself enforces the documented ranges, so an invalid
 * configuration fails here rather than degrading into an unbounded wait.
 */
class Database(private val settings: DatabaseSettings) : AutoCloseable {
    val dialect: Dialect = settings.dialect

    private var writerSource: HikariDataSource? = null
    private var readOnlySource: HikariDataSource? = null

    val writer: DataSource
        get() = checkNotNull(writerSource) { "Database is not started" }

    val readOnly: DataSource
        get() = checkNotNull(readOnlySource) { "Database is not started" }

    fun start() {
        if (writerSource != null) return
        writerSource = HikariDataSource(config("leveret-writer", readOnly = false))
        readOnlySource = HikariDataSource(config("leveret-reader", readOnly = true))
    }

    fun stats(): PoolStats {
        val pool = writerSource?.hikariPoolMXBean
        return PoolStats(
            active = pool?.activeConnections ?: 0,
            total = pool?.totalConnections ?: 0,
            idle = pool?.idleConnections ?: 0,
            maxActive = settings.pool.maxActive,
            minIdle = settings.pool.minIdle,
            maxLifetimeMs = settings.pool.maxLifetimeMs,
            maxWaitMs = settings.pool.maxWaitMs,
        )
    }

    override fun close() {
        readOnlySource?.close()
        writerSource?.close()
        readOnlySource = null
        writerSource = null
    }

    private fun config(poolName: String, readOnly: Boolean) = HikariConfig().apply {
        jdbcUrl = settings.url
        username = settings.username
        password = settings.password
        this.poolName = poolName
        this.isReadOnly = readOnly
        isAutoCommit = false
        maximumPoolSize = settings.pool.maxActive
        minimumIdle = settings.pool.minIdle
        connectionTimeout = settings.pool.maxWaitMs.toLong()
        idleTimeout = settings.pool.idleTimeoutMs
        keepaliveTime = settings.pool.keepaliveMs
        maxLifetime = settings.pool.maxLifetimeMs
        validationTimeout = settings.pool.validationTimeoutMs
    }
}
