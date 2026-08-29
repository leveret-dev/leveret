package com.leveret.inspect.db.migration

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.session.SessionFactory

/**
 * Privileged control state: one row per successfully completed step. A number is written only after
 * its step returns, and never to suppress an error.
 */
class MigrationHistory(private val sessions: SessionFactory, private val dialect: Dialect) {
    fun ensureTable() {
        sessions.openWriter().use { session ->
            session.execute(
                "create table if not exists $TABLE ($COLUMN varchar($COLUMN_LENGTH) not null)",
            )
            session.commit()
        }
    }

    fun recordedNumbers(): List<Long> = sessions.openReadOnly().use { session ->
        session.select("select $COLUMN from $TABLE") { it.getString(1) }
            .map(MigrationNumber::parse)
            .sorted()
    }

    fun maximum(): Long? = recordedNumbers().maxOrNull()

    /** Uses its own committed connection, so history survives a later failure in the same run. */
    fun record(number: Long) {
        sessions.openWriter().use { session ->
            session.update("insert into $TABLE ($COLUMN) values (?)") {
                it.setString(1, MigrationNumber.format(number))
            }
            session.commit()
        }
    }

    companion object {
        const val TABLE = "schema_migrations"
        const val COLUMN = "version"
        const val COLUMN_LENGTH = 255
    }
}
