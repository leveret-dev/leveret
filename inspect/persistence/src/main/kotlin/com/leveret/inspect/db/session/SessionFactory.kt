package com.leveret.inspect.db.session

import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.profiling.SqlProfiler
import java.sql.Connection

class SessionFactory(
    private val database: Database,
    private val profiler: SqlProfiler = SqlProfiler(),
) {
    fun openWriter(): DbSession = open(database.writer.connection)

    fun openReadOnly(): DbSession = open(database.readOnly.connection)

    private fun open(connection: Connection): DbSession {
        connection.autoCommit = false
        return DbSession(connection, database.dialect, profiler)
    }
}
