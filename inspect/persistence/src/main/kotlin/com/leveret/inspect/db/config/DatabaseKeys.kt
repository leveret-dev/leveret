package com.leveret.inspect.db.config

/**
 * Database property names and their defaults. Loading and precedence belong to the process runtime.
 *
 * The engine owns its store, so there is no connection contract to configure: the store lives in the
 * runtime data directory and the URL key exists only to relocate it — an in-memory database for a
 * test, or a different filesystem for an operator whose data directory is unsuitable.
 */
object DatabaseKeys {
    const val URL = "leveret.db.url"
    const val POOL_SIZE = "leveret.db.poolSize"

    const val DEFAULT_POOL_SIZE = 8

    /** Base name of the embedded store inside the data directory. */
    const val STORE_NAME = "leveret"

    val defaults: Map<String, String> = mapOf(
        POOL_SIZE to DEFAULT_POOL_SIZE.toString(),
    )
}
