package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import javax.sql.DataSource

/**
 * One pool over the single embedded store. Autocommit is disabled here rather than per session, so
 * every connection handed out has the same transaction contract however it was obtained. The
 * remaining pool behaviour is left at the driver's defaults: there is one process, one file, and no
 * network between them, which is the situation those defaults already describe.
 */
class Database(private val settings: DatabaseSettings) : AutoCloseable {
    private var source: HikariDataSource? = null

    val dataSource: DataSource
        get() = checkNotNull(source) { "Database is not started" }

    fun start() {
        if (source != null) return
        source = HikariDataSource(
            HikariConfig().apply {
                jdbcUrl = settings.url
                poolName = "leveret"
                isAutoCommit = false
                maximumPoolSize = settings.poolSize
            },
        )
    }

    override fun close() {
        source?.close()
        source = null
    }
}
