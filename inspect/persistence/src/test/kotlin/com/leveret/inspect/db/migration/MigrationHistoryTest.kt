package com.leveret.inspect.db.migration

import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.PoolSettings
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class MigrationHistoryTest {
    private lateinit var database: Database
    private lateinit var history: MigrationHistory

    @BeforeEach
    fun open() {
        database = Database(
            DatabaseSettings(
                url = "jdbc:h2:mem:history-${System.nanoTime()};DB_CLOSE_DELAY=-1",
                username = "",
                password = "",
                embedded = true,
                pool = PoolSettings(4, 1, 1000, 600000, 180000, 1800000, 5000),
            ),
        )
        database.start()
        history = MigrationHistory(SessionFactory(database), database.dialect)
    }

    @AfterEach
    fun close() = database.close()

    @Test
    fun `history table is created once and idempotently`() {
        history.ensureTable()
        history.ensureTable()
        assertThat(history.recordedNumbers()).isEmpty()
        assertThat(history.maximum()).isNull()
    }

    @Test
    fun `recorded numbers are durable and the maximum is current`() {
        history.ensureTable()
        history.record(2026_09_002L)
        history.record(2026_09_001L)
        assertThat(history.recordedNumbers()).containsExactly(2026_09_001L, 2026_09_002L)
        assertThat(history.maximum()).isEqualTo(2026_09_002L)
    }

    @Test
    fun `version state compares recorded and registry maxima`() {
        assertThat(DatabaseVersion.state(null, 2026_09_002L)).isEqualTo(VersionState.FRESH_INSTALL)
        assertThat(DatabaseVersion.state(2026_09_002L, 2026_09_002L)).isEqualTo(VersionState.UP_TO_DATE)
        assertThat(DatabaseVersion.state(2026_09_001L, 2026_09_002L)).isEqualTo(VersionState.REQUIRES_UPGRADE)
        assertThat(DatabaseVersion.state(2026_09_003L, 2026_09_002L)).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
        assertThat(DatabaseVersion.state(null, null)).isEqualTo(VersionState.FRESH_INSTALL)
        assertThat(DatabaseVersion.state(2026_09_001L, null)).isEqualTo(VersionState.REQUIRES_DOWNGRADE)
    }
}
