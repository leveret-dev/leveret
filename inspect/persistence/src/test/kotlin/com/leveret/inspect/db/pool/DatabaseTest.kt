package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DatabaseTest {
    private fun settings(poolSize: Int = 4) = DatabaseSettings(
        url = "jdbc:h2:mem:pool-${System.nanoTime()};DB_CLOSE_DELAY=-1",
        poolSize = poolSize,
    )

    @Test
    fun `connections are unavailable before start`() {
        Database(settings()).use { database ->
            assertThatThrownBy { database.dataSource }.isInstanceOf(IllegalStateException::class.java)
        }
    }

    @Test
    fun `a started pool hands out connections with autocommit disabled`() {
        Database(settings()).use { database ->
            database.start()
            database.dataSource.connection.use { connection ->
                assertThat(connection.autoCommit).isFalse()
                connection.createStatement().use { it.execute("create table probe (id int)") }
                connection.commit()
            }
            database.dataSource.connection.use { connection ->
                connection.createStatement().use { statement ->
                    assertThat(statement.executeQuery("select count(*) from probe").next()).isTrue()
                }
            }
        }
    }

    @Test
    fun `the pool size knob bounds concurrently open connections`() {
        Database(settings(poolSize = 2)).use { database ->
            database.start()
            val held = List(2) { database.dataSource.connection }
            try {
                assertThat(held).allSatisfy { assertThat(it.isClosed).isFalse() }
            } finally {
                held.forEach { it.close() }
            }
        }
    }

    @Test
    fun `closing a database that was never started is harmless`() {
        Database(settings()).close()
    }
}
