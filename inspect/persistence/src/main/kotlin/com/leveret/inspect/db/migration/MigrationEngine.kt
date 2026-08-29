package com.leveret.inspect.db.migration

import org.slf4j.LoggerFactory

/**
 * Runs the selected steps in numeric order, recording each success before starting the next step, and
 * stops at the first failure so the failing number stays selectable on the next run.
 */
class MigrationEngine(
    private val registry: MigrationRegistry,
    private val history: MigrationHistory,
    private val context: MigrationContext,
    val state: MigrationState = MigrationState(),
) {
    private val log = LoggerFactory.getLogger(MigrationEngine::class.java)

    fun version(): VersionState {
        history.ensureTable()
        return DatabaseVersion.state(history.maximum(), registry.maximum)
    }

    fun run() {
        history.ensureTable()
        val recorded = history.maximum()
        if (DatabaseVersion.state(recorded, registry.maximum) == VersionState.REQUIRES_DOWNGRADE) {
            state.notSupported()
            log.error(
                "Database schema {} is newer than this release, which supplies no reverse migration",
                recorded?.let(MigrationNumber::format),
            )
            return
        }
        val selected = registry.above(recorded)
        if (selected.isEmpty()) return
        state.start(selected.size)
        log.info("Running {} database migrations", selected.size)
        selected.forEach { migration ->
            val number = MigrationNumber.format(migration.number)
            val started = System.nanoTime()
            try {
                migration.step.execute(context)
            } catch (failure: Exception) {
                state.failed(failure)
                log.error("Migration {} '{}' failed", number, migration.description, failure)
                throw failure
            }
            history.record(migration.number)
            state.stepCompleted()
            log.info(
                "Migration {} '{}' completed in {} ms",
                number,
                migration.description,
                (System.nanoTime() - started) / 1_000_000,
            )
        }
        state.succeeded()
        log.info("All {} database migrations completed", selected.size)
    }
}
