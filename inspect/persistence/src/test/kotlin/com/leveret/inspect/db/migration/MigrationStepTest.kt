package com.leveret.inspect.db.migration

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MigrationStepTest {
    private lateinit var database: Database
    private lateinit var context: MigrationContext

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:step-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        context = MigrationContext(SessionFactory(database), database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `a multi statement ddl step commits per statement so a later failure keeps earlier work`() {
        val step = object : DdlChange() {
            override fun statements(dialect: Dialect) = listOf(
                "create table alpha (id int)",
                "create table beta (id int)",
                "create table beta (id int)",
            )
        }
        assertThatThrownBy { step.execute(context) }.isInstanceOf(Exception::class.java)
        assertThat(tables()).contains("ALPHA", "BETA")
    }

    @Test
    fun `data steps read and write through separate sessions`() {
        object : DdlChange() {
            override fun statements(dialect: Dialect) = listOf("create table counts (id int, total int)")
        }.execute(context)

        context.write { session ->
            session.update("insert into counts (id, total) values (1, 10)")
            session.commit()
        }
        val total = context.read { session -> session.select("select total from counts") { it.getInt(1) } }
        assertThat(total).containsExactly(10)
    }

    private fun tables(): List<String> = context.read { session ->
        session.select(
            "select table_name from information_schema.tables where table_schema = 'PUBLIC'",
        ) { it.getString(1) }
    }
}
