package com.leveret.inspect.db.acceptance

import com.leveret.inspect.db.charset.CharsetChecker
import com.leveret.inspect.db.charset.CheckerState
import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.migration.DdlChange
import com.leveret.inspect.db.migration.MigrationContext
import com.leveret.inspect.db.migration.MigrationEngine
import com.leveret.inspect.db.migration.MigrationHistory
import com.leveret.inspect.db.migration.MigrationRegistry
import com.leveret.inspect.db.migration.MigrationStatus
import com.leveret.inspect.db.migration.VersionState
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.pool.EmbeddedDatabase
import com.leveret.inspect.db.schema.ColumnDef
import com.leveret.inspect.db.schema.ColumnType
import com.leveret.inspect.db.schema.CreateTableBuilder
import com.leveret.inspect.db.session.SessionFactory
import com.leveret.inspect.runtime.config.Settings
import java.net.ServerSocket
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/** The specification's acceptance scenarios, end to end against a real embedded database. */
class PersistenceAcceptanceTest {
    private val claims = object : DdlChange() {
        override fun statements(dialect: Dialect) = CreateTableBuilder("claims", dialect)
            .column(ColumnDef("uuid", ColumnType.VARCHAR, nullable = false, limit = ColumnDef.IDENTIFIER_LENGTH))
            .column(ColumnDef("state", ColumnType.VARCHAR, nullable = false, limit = 20))
            .primaryKey("uuid")
            .build()
    }

    @Test
    fun `scenario 1 and 2 embedded selection and its precedence`() {
        val defaults = Settings(DatabaseKeys.defaults)
        assertThat(DatabaseSettings.from(defaults) {}.url).isEqualTo("jdbc:h2:tcp://127.0.0.1:9092/leveret")

        val warnings = mutableListOf<String>()
        val withBoth = Settings(
            DatabaseKeys.defaults + mapOf(
                DatabaseKeys.EMBEDDED_PORT to "9600",
                DatabaseKeys.URL to "jdbc:postgresql://db.internal/leveret",
            ),
        )
        assertThat(DatabaseSettings.from(withBoth) { warnings += it }.embedded).isTrue()
        assertThat(warnings).hasSize(1)
    }

    @Test
    fun `scenario 6 7 8 and 9 migration lifecycle over a real database`(@TempDir dataDir: Path) {
        val port = ServerSocket(0).use { it.localPort }
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            val settings = Settings(
                DatabaseKeys.defaults + mapOf(DatabaseKeys.EMBEDDED_PORT to port.toString()),
            )
            Database(DatabaseSettings.from(settings) {}).use { database ->
                database.start()
                val sessions = SessionFactory(database)
                val history = MigrationHistory(sessions, database.dialect)
                val context = MigrationContext(sessions, database.dialect)
                val registry = MigrationRegistry().register("2026_09_001", "create claims", claims)

                val engine = MigrationEngine(registry, history, context)
                assertThat(engine.version()).isEqualTo(VersionState.FRESH_INSTALL)
                engine.run()
                assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
                assertThat(engine.version()).isEqualTo(VersionState.UP_TO_DATE)

                sessions.openReadOnly().use { session ->
                    CharsetChecker.handlerFor(database.dialect)
                        .check(session, CheckerState.STARTUP, listOf("claims"))
                }

                sessions.openWriter().use { session ->
                    session.update("insert into claims (uuid, state) values ('u1', 'PENDING')")
                    session.commit()
                }
                val claim = {
                    sessions.openWriter().use { session ->
                        val changed = session.update(
                            "update claims set state = 'IN_PROGRESS' where uuid = 'u1' and state = 'PENDING'",
                        )
                        session.commit()
                        changed
                    }
                }
                assertThat(claim()).isEqualTo(1)
                assertThat(claim()).isZero()

                history.record(2026_12_001L)
                val newer = MigrationEngine(registry, history, context)
                assertThat(newer.version()).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
                newer.run()
                assertThat(newer.state.status).isEqualTo(MigrationStatus.NOT_SUPPORTED)

                assertThat(database.stats().maxActive).isEqualTo(60)
            }
        }
    }
}
