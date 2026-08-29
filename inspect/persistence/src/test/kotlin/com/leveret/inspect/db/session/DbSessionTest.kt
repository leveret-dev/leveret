package com.leveret.inspect.db.session

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.pool.Database
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class DbSessionTest {
    private lateinit var database: Database
    private lateinit var sessions: SessionFactory

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:session-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                poolSize = 4,
            ),
        )
        database.start()
        sessions = SessionFactory(database)
        sessions.open().use { session ->
            session.execute("create table claims (id int primary key, state varchar(20), body clob)")
            session.commit()
        }
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `rollback discards and commit persists`() {
        sessions.open().use { session ->
            session.update("insert into claims (id, state) values (?, ?)") {
                it.setInt(1, 1)
                it.setString(2, "PENDING")
            }
            session.rollback()
            assertThat(count()).isZero()

            session.update("insert into claims (id, state) values (?, ?)") {
                it.setInt(1, 1)
                it.setString(2, "PENDING")
            }
            session.commit()
        }
        assertThat(count()).isEqualTo(1)
    }

    @Test
    fun `conditional claim reports affected rows so a lost race is visible`() {
        sessions.open().use { session ->
            session.update("insert into claims (id, state) values (1, 'PENDING')")
            session.commit()
        }
        val claim = {
            sessions.open().use { session ->
                val changed = session.update(
                    "update claims set state = 'IN_PROGRESS' where id = 1 and state = 'PENDING'",
                )
                session.commit()
                changed
            }
        }
        assertThat(claim()).isEqualTo(1)
        assertThat(claim()).isZero()
    }

    @Test
    fun `batch commits per batch and leaves earlier batches durable`() {
        sessions.open().use { session ->
            val written = session.batch(
                "insert into claims (id, state) values (?, ?)",
                rows = (1..250).toList(),
                batchSize = 100,
            ) { statement, id ->
                statement.setInt(1, id)
                statement.setString(2, "PENDING")
            }
            assertThat(written).isEqualTo(250)
        }
        assertThat(count()).isEqualTo(250)
    }

    @Test
    fun `streamed values persist through a prepared statement`() {
        val body = "x".repeat(100_000)
        sessions.open().use { session ->
            session.prepare("insert into claims (id, state, body) values (?, ?, ?)").use { statement ->
                statement.setInt(1, 1)
                statement.setString(2, "PENDING")
                statement.setCharacterStream(3, body.reader(), body.length.toLong())
                statement.executeUpdate()
            }
            session.commit()
        }
        sessions.open().use { session ->
            val stored = session.select("select body from claims where id = 1") { it.getString(1) }
            assertThat(stored).containsExactly(body)
        }
    }

    private fun count(): Int = sessions.open().use { session ->
        session.select("select count(*) from claims") { it.getInt(1) }.single()
    }
}
