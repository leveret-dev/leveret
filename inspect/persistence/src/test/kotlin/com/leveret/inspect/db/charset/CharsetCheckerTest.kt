package com.leveret.inspect.db.charset

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.dialect.H2Dialect
import com.leveret.inspect.db.dialect.PostgresDialect
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

class CharsetCheckerTest {
    private object UnknownDialect : Dialect {
        override val id = "unknown"
        override fun quote(identifier: String) = identifier
        override fun identityClause() = "identity"
        override fun upsert(table: String, columns: List<String>, conflictColumns: List<String>) = ""
    }

    @Test
    fun `h2 needs no check and an unsupported dialect fails`() {
        assertThat(CharsetChecker.handlerFor(H2Dialect)).isSameAs(NoCharsetCheck)
        assertThat(CharsetChecker.handlerFor(PostgresDialect)).isInstanceOf(PostgresCharsetHandler::class.java)
        assertThatThrownBy { CharsetChecker.handlerFor(UnknownDialect) }
            .isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("unknown")
    }

    @Test
    fun `postgresql accepts a utf8 database and its managed columns`() {
        val url = System.getenv("LEVERET_TEST_POSTGRES_URL")
        assumeTrue(url != null, "LEVERET_TEST_POSTGRES_URL is not configured")
        Database(
            DatabaseSettings(
                url = url!!,
                username = System.getenv("LEVERET_TEST_POSTGRES_USER") ?: "",
                password = System.getenv("LEVERET_TEST_POSTGRES_PASSWORD") ?: "",
                embedded = false,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        ).use { database ->
            database.start()
            val sessions = SessionFactory(database)
            sessions.openWriter().use { session ->
                session.execute("create table if not exists charset_probe (label varchar(40) not null)")
                session.commit()
                CharsetChecker.handlerFor(database.dialect)
                    .check(session, CheckerState.STARTUP, listOf("charset_probe"))
            }
        }
    }
}
