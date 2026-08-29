package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import java.sql.SQLTransientConnectionException
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class DatabaseTest {
    private fun settings(pool: PoolSettings) = DatabaseSettings(
        url = "jdbc:h2:mem:pool-${System.nanoTime()};DB_CLOSE_DELAY=-1",
        username = "",
        password = "",
        embedded = true,
        pool = pool,
    )

    private val defaultPool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000)

    @Test
    fun `sessions are unavailable before start`() {
        Database(settings(defaultPool)).use { database ->
            assertThatThrownBy { database.writer }.isInstanceOf(IllegalStateException::class.java)
        }
    }

    @Test
    fun `writer and read only sources both work and report configured counts`() {
        Database(settings(defaultPool)).use { database ->
            database.start()
            database.writer.connection.use { connection ->
                connection.createStatement().use { it.execute("create table probe (id int)") }
                connection.commit()
            }
            database.readOnly.connection.use { connection ->
                connection.createStatement().use { statement ->
                    assertThat(statement.executeQuery("select count(*) from probe").next()).isTrue()
                }
            }
            val stats = database.stats()
            assertThat(stats.maxActive).isEqualTo(4)
            assertThat(stats.minIdle).isEqualTo(1)
            assertThat(stats.maxWaitMs).isEqualTo(1000)
            assertThat(stats.total).isGreaterThanOrEqualTo(1)
        }
    }

    @Test
    fun `exhaustion fails after the configured wait instead of exceeding the maximum`() {
        val pool = PoolSettings(1, 1, 250, 600000, 180000, 1800000, 5000)
        Database(settings(pool)).use { database ->
            database.start()
            database.writer.connection.use {
                val start = System.nanoTime()
                assertThatThrownBy { database.writer.connection }
                    .isInstanceOf(SQLTransientConnectionException::class.java)
                assertThat(System.nanoTime() - start).isGreaterThanOrEqualTo(250_000_000L)
                assertThat(database.stats().active).isEqualTo(1)
            }
        }
    }

    @Test
    fun `stats report zero counts when no pool is live`() {
        val stats = Database(settings(defaultPool)).stats()
        assertThat(stats.active).isZero()
        assertThat(stats.total).isZero()
        assertThat(stats.idle).isZero()
        assertThat(stats.maxActive).isEqualTo(4)
    }
}
