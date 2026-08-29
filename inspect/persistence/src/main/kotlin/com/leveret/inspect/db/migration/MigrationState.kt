package com.leveret.inspect.db.migration

import java.time.Clock
import java.time.Duration
import java.time.Instant

enum class MigrationStatus {
    NO_MIGRATION,
    MIGRATION_RUNNING,
    MIGRATION_FAILED,
    MIGRATION_SUCCEEDED,
    NOT_SUPPORTED,
    MIGRATION_REQUIRED,
}

/**
 * Operator-visible migration progress. Deliberately single-threaded: migration is serialized by
 * startup leadership, so this object is never shared between concurrent runs.
 */
class MigrationState(private val clock: Clock = Clock.systemUTC()) {
    var status: MigrationStatus = MigrationStatus.NO_MIGRATION
        private set
    var startedAt: Instant? = null
        private set
    var error: Throwable? = null
        private set
    var completed: Int = 0
        private set
    var total: Int = 0
        private set

    fun required() {
        status = MigrationStatus.MIGRATION_REQUIRED
    }

    fun notSupported() {
        status = MigrationStatus.NOT_SUPPORTED
    }

    fun start(total: Int) {
        this.total = total
        completed = 0
        error = null
        startedAt = clock.instant()
        status = MigrationStatus.MIGRATION_RUNNING
    }

    fun stepCompleted() {
        completed++
    }

    fun failed(error: Throwable) {
        this.error = error
        status = MigrationStatus.MIGRATION_FAILED
    }

    fun succeeded() {
        status = MigrationStatus.MIGRATION_SUCCEEDED
    }

    /** Available only while running and only after one step has provided a rate. */
    fun expectedFinish(): Instant? {
        val started = startedAt ?: return null
        if (status != MigrationStatus.MIGRATION_RUNNING || completed == 0) return null
        val elapsed = Duration.between(started, clock.instant())
        val remaining = (total - completed).toLong()
        return clock.instant().plus(elapsed.dividedBy(completed.toLong()).multipliedBy(remaining))
    }
}
