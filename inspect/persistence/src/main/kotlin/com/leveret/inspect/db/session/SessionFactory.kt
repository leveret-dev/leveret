package com.leveret.inspect.db.session

import com.leveret.inspect.db.pool.Database

/**
 * The one way to obtain a session. A read-only variant would be a claim the single pool cannot
 * enforce, so a caller that must not write says so by not writing.
 */
class SessionFactory(private val database: Database) {
    fun open(): DbSession = DbSession(database.dataSource.connection)
}
