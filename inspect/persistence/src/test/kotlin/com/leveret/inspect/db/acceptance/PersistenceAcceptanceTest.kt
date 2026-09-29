package com.leveret.inspect.db.acceptance

import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.schema.Schema
import com.leveret.inspect.db.session.SessionFactory
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/**
 * The module's smoke proof, end to end against a real file on disk: resolve the store from runtime
 * settings, lay a schema down, write through a session, and survive a version change.
 */
class PersistenceAcceptanceTest {
    private val version1 = listOf(
        "create table symbol (id int primary key, name varchar(200) not null)",
        "create index symbol_name on symbol (name)",
    )

    // Reusing the index name is deliberate: it only creates cleanly if the rebuild dropped every
    // object of the old version, not just its tables.
    private val version2 = listOf(
        "create table symbol (id int primary key, name varchar(200) not null, kind varchar(40))",
        "create index symbol_name on symbol (name)",
    )

    @Test
    fun `a store resolved from settings is created on disk and holds committed writes`(
        @TempDir home: Path,
    ) {
        val dataDir = Files.createDirectories(home.resolve("data"))

        opened(home) { sessions ->
            Schema(sessions).ensure(1, version1)

            assertThat(dataDir.resolve("leveret.mv.db"))
                .describedAs("the store is one embedded file inside the runtime data directory")
                .exists()

            sessions.open().use { session ->
                session.update("insert into symbol (id, name) values (1, 'discarded')")
                session.rollback()
                session.update("insert into symbol (id, name) values (1, 'kept')")
                session.commit()
            }

            assertThat(names(sessions))
                .describedAs("the rolled-back insert left nothing and the committed one persisted")
                .containsExactly("kept")
        }
    }

    @Test
    fun `a failing batch leaves every batch committed before it durable`(@TempDir home: Path) {
        Files.createDirectories(home.resolve("data"))

        opened(home) { sessions ->
            Schema(sessions).ensure(1, version1)

            // Row 120 repeats an identifier already written by the first batch, so the third batch
            // fails after the first two have committed.
            val rows = (10..129).toList() + 20
            sessions.open().use { session ->
                assertThatThrownBy {
                    session.batch(
                        "insert into symbol (id, name) values (?, ?)",
                        rows = rows,
                        batchSize = 50,
                    ) { statement, id ->
                        statement.setInt(1, id)
                        statement.setString(2, "symbol-$id")
                    }
                }.describedAs("the duplicate identifier reaches the caller").isNotNull()
            }

            assertThat(names(sessions))
                .describedAs("the two batches that committed before the failure survived it")
                .hasSize(100)
        }
    }

    @Test
    fun `a matching version leaves data alone and a changed version rebuilds the store`(
        @TempDir home: Path,
    ) {
        Files.createDirectories(home.resolve("data"))

        opened(home) { sessions ->
            Schema(sessions).ensure(1, version1)
            sessions.open().use { session ->
                session.update("insert into symbol (id, name) values (1, 'kept')")
                session.commit()
            }
        }

        // A second Database over the same file stands in for a later run of the engine.
        opened(home) { sessions ->
            Schema(sessions).ensure(1, version1)
            assertThat(names(sessions))
                .describedAs("re-running ensure at the stamped version is a no-op")
                .containsExactly("kept")
        }

        opened(home) { sessions ->
            Schema(sessions).ensure(2, version2)
            assertThat(names(sessions))
                .describedAs("a version change rebuilt the store, discarding derivable rows")
                .isEmpty()

            sessions.open().use { session ->
                session.update("insert into symbol (id, name, kind) values (1, 'rebuilt', 'class')")
                session.commit()
                assertThat(session.select("select kind from symbol") { it.getString(1) })
                    .describedAs("the rebuilt store has the new schema, not the old one")
                    .containsExactly("class")
            }
        }

        opened(home) { sessions ->
            Schema(sessions).ensure(2, version2)
            assertThat(names(sessions))
                .describedAs("the new version is stamped, so the next run rebuilds nothing")
                .containsExactly("rebuilt")
        }
    }

    private fun opened(home: Path, body: (SessionFactory) -> Unit) {
        val settings = Settings(
            DatabaseKeys.defaults + mapOf(PropertyKeys.PATH_HOME to home.toString()),
        )
        Database(DatabaseSettings.from(settings)).use { database ->
            database.start()
            body(SessionFactory(database))
        }
    }

    private fun names(sessions: SessionFactory): List<String> = sessions.open().use { session ->
        session.select("select name from symbol order by id") { it.getString(1) }
    }
}
