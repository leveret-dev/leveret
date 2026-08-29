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

class MigrationEngineTest {
    private lateinit var database: Database
    private lateinit var history: MigrationHistory
    private lateinit var context: MigrationContext

    private fun table(name: String) = object : DdlChange() {
        override fun statements(dialect: Dialect) = listOf("create table $name (id int)")
    }

    private val failing = object : MigrationStep {
        override fun execute(context: MigrationContext) = throw IllegalStateException("step failed")
    }

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:engine-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        val sessions = SessionFactory(database)
        history = MigrationHistory(sessions, database.dialect)
        context = MigrationContext(sessions, database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `a fresh database runs every step in order and records each success`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "create beta", table("beta"))
        val engine = MigrationEngine(registry, history, context)
        assertThat(engine.version()).isEqualTo(VersionState.FRESH_INSTALL)

        engine.run()

        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
        assertThat(engine.state.completed).isEqualTo(2)
        assertThat(engine.state.total).isEqualTo(2)
        assertThat(engine.version()).isEqualTo(VersionState.UP_TO_DATE)
    }

    @Test
    fun `execution stops at the first failure and a retry reselects it`() {
        val registry = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "fail", failing)
            .register("2026_09_003", "create gamma", table("gamma"))
        val engine = MigrationEngine(registry, history, context)

        assertThatThrownBy { engine.run() }.hasMessageContaining("step failed")

        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L)
        assertThat(engine.state.status).isEqualTo(MigrationStatus.MIGRATION_FAILED)
        assertThat(engine.state.error).isInstanceOf(IllegalStateException::class.java)
        assertThat(engine.version()).isEqualTo(VersionState.REQUIRES_UPGRADE)

        val repaired = MigrationRegistry()
            .register("2026_09_001", "create alpha", table("alpha"))
            .register("2026_09_002", "now works", table("beta"))
            .register("2026_09_003", "create gamma", table("gamma"))
        val retry = MigrationEngine(repaired, history, context)
        retry.run()
        assertThat(history.recordedNumbers())
            .containsExactly(2026_09_001L, 2026_09_002L, 2026_09_003L)
        assertThat(retry.state.total).isEqualTo(2)
    }

    @Test
    fun `an empty selection reports no migration and a newer schema runs nothing`() {
        val registry = MigrationRegistry().register("2026_09_001", "create alpha", table("alpha"))
        MigrationEngine(registry, history, context).run()

        val again = MigrationEngine(registry, history, context)
        again.run()
        assertThat(again.state.status).isEqualTo(MigrationStatus.NO_MIGRATION)

        history.record(2026_09_009L)
        val newer = MigrationEngine(registry, history, context)
        assertThat(newer.version()).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
        newer.run()
        assertThat(newer.state.status).isEqualTo(MigrationStatus.NOT_SUPPORTED)
        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_009L)
    }

    @Test
    fun `progress exposes counts and an estimate only after a step completes`() {
        val state = MigrationState()
        assertThat(state.status).isEqualTo(MigrationStatus.NO_MIGRATION)
        state.start(4)
        assertThat(state.status).isEqualTo(MigrationStatus.MIGRATION_RUNNING)
        assertThat(state.expectedFinish()).isNull()
        state.stepCompleted()
        assertThat(state.completed).isEqualTo(1)
        assertThat(state.expectedFinish()).isNotNull()
        state.succeeded()
        assertThat(state.status).isEqualTo(MigrationStatus.MIGRATION_SUCCEEDED)
    }
}
