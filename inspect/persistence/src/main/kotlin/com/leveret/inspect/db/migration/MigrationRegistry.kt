package com.leveret.inspect.db.migration

/**
 * Steps register themselves here; ordering is numeric, never declaration order. The registry ships
 * empty: each part contributes the steps that build its own tables.
 */
class MigrationRegistry {
    private val migrations = sortedMapOf<Long, Migration>()

    fun register(number: String, description: String, step: MigrationStep): MigrationRegistry = apply {
        val parsed = MigrationNumber.parse(number)
        require(parsed !in migrations) { "Migration number $number is already registered" }
        require(description.isNotBlank()) { "Migration $number needs a nonempty description" }
        migrations[parsed] = Migration(parsed, description, step)
    }

    fun all(): List<Migration> = migrations.values.toList()

    fun above(recorded: Long?): List<Migration> =
        if (recorded == null) all() else migrations.tailMap(recorded + 1).values.toList()

    val maximum: Long? get() = migrations.keys.maxOrNull()
}
