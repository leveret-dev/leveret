package com.leveret.inspect.db.migration

import com.leveret.inspect.db.dialect.Dialect
import com.leveret.inspect.db.session.DbSession
import com.leveret.inspect.db.session.SessionFactory

/**
 * The database handles a step is allowed to use. Schema work commits per statement, so a step that
 * emits several statements is deliberately not atomic as a whole; data work gets a separate reader and
 * writer.
 */
class MigrationContext(private val sessions: SessionFactory, val dialect: Dialect) {
    fun ddl(statements: List<String>) {
        sessions.openWriter().use { session ->
            statements.forEach { statement ->
                session.execute(statement)
                session.commit()
            }
        }
    }

    fun <T> read(block: (DbSession) -> T): T = sessions.openReadOnly().use { session ->
        session.relaxIsolationIfSupported()
        block(session)
    }

    fun write(block: (DbSession) -> Unit) = sessions.openWriter().use(block)
}

interface MigrationStep {
    fun execute(context: MigrationContext)
}

/** Schema change expressed as generated statements, committed one by one. */
abstract class DdlChange : MigrationStep {
    abstract fun statements(dialect: Dialect): List<String>

    final override fun execute(context: MigrationContext) = context.ddl(statements(context.dialect))
}

data class Migration(val number: Long, val description: String, val step: MigrationStep)
