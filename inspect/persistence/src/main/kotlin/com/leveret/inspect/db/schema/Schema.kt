package com.leveret.inspect.db.schema

import com.leveret.inspect.db.session.SessionFactory

/**
 * The whole schema contract: a stamped version, and a wipe-and-rebuild when the stamp does not match.
 *
 * There is no migration path because there is nothing to migrate. Every table this engine holds is
 * derived from source code by re-running analysis over the working tree, so a schema change costs a
 * re-index and never costs data. A migration engine would buy the ability to preserve rows that can
 * be recomputed from a checkout in less time than the migration itself would take to write.
 *
 * The one thing that would force real migrations back is state the user authored rather than the
 * analysis derived — an accepted-findings baseline above all, because no amount of re-analysis
 * reconstructs a human decision. Until such a table exists, rebuilding is both cheaper and safer:
 * a rebuild cannot leave the store in a half-migrated shape.
 */
class Schema(private val sessions: SessionFactory) {
    /**
     * Brings the store to [expectedVersion], applying [ddl] in the order given when it must rebuild.
     * The caller owns its own schema; this unit only decides whether that schema needs laying down.
     */
    fun ensure(expectedVersion: Int, ddl: List<String>) {
        sessions.open().use { session ->
            session.execute(CREATE_STAMP)
            session.commit()
            // A stamp table holding anything other than exactly one row is damage, not a version, and
            // rebuilding is the same repair either way.
            val stamped = session.select(SELECT_STAMP) { it.getInt(1) }.singleOrNull()
            if (stamped == expectedVersion) return

            session.execute("drop all objects")
            ddl.forEach(session::execute)
            session.execute(CREATE_STAMP)
            session.update("insert into schema_version (version) values (?)") {
                it.setInt(1, expectedVersion)
            }
            session.commit()
        }
    }

    private companion object {
        const val CREATE_STAMP = "create table if not exists schema_version (version int not null)"
        const val SELECT_STAMP = "select version from schema_version"
    }
}
