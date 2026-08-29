package com.leveret.inspect.db.session

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.profiling.SqlProfiler
import java.sql.Connection
import java.sql.PreparedStatement
import java.sql.ResultSet

/**
 * One connection with autocommit disabled. Ordinary work stays inside the caller's transaction: the
 * session commits only when told to, so a part that needs a narrower boundary declares it instead of
 * inheriting an assumed all-or-nothing transaction.
 */
class DbSession(
    private val connection: Connection,
    val dialect: Dialect,
    private val profiler: SqlProfiler,
) : AutoCloseable {
    fun commit() = connection.commit()

    fun rollback() = connection.rollback()

    fun execute(sql: String) {
        profiler.statement(connection).use { it.execute(sql) }
    }

    fun prepare(sql: String): PreparedStatement = profiler.prepare(connection, sql)

    fun update(sql: String, bind: (PreparedStatement) -> Unit = {}): Int =
        prepare(sql).use { statement ->
            bind(statement)
            statement.executeUpdate()
        }

    fun <T> select(sql: String, bind: (PreparedStatement) -> Unit = {}, row: (ResultSet) -> T): List<T> =
        prepare(sql).use { statement ->
            bind(statement)
            statement.executeQuery().use { results ->
                val rows = mutableListOf<T>()
                while (results.next()) rows += row(results)
                rows
            }
        }

    /** Commits each full batch and the final partial batch, so earlier batches survive a later failure. */
    fun <T> batch(
        sql: String,
        rows: Iterable<T>,
        batchSize: Int = DEFAULT_BATCH_SIZE,
        bind: (PreparedStatement, T) -> Unit,
    ): Int {
        require(batchSize >= 1) { "batchSize must be at least 1, was $batchSize" }
        var pending = 0
        var written = 0
        prepare(sql).use { statement ->
            rows.forEach { row ->
                bind(statement, row)
                statement.addBatch()
                pending++
                if (pending == batchSize) {
                    written += statement.executeBatch().size
                    commit()
                    pending = 0
                }
            }
            if (pending > 0) {
                written += statement.executeBatch().size
                commit()
            }
        }
        return written
    }

    /** Migration readers ask for relaxed isolation, which is applied only where the driver reports it. */
    fun relaxIsolationIfSupported() {
        if (connection.metaData.supportsTransactionIsolationLevel(Connection.TRANSACTION_READ_UNCOMMITTED)) {
            connection.transactionIsolation = Connection.TRANSACTION_READ_UNCOMMITTED
        }
    }

    override fun close() = connection.close()

    companion object {
        const val DEFAULT_BATCH_SIZE = 250
    }
}
