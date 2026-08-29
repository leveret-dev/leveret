package com.leveret.inspect.db.migration

enum class VersionState { FRESH_INSTALL, UP_TO_DATE, REQUIRES_UPGRADE, REQUIRES_DOWNGRADE }

/** A schema newer than this build is never treated as current; no reverse migration exists. */
object DatabaseVersion {
    fun state(recordedMaximum: Long?, registryMaximum: Long?): VersionState = when {
        recordedMaximum == null -> VersionState.FRESH_INSTALL
        registryMaximum == null -> VersionState.REQUIRES_DOWNGRADE
        recordedMaximum == registryMaximum -> VersionState.UP_TO_DATE
        recordedMaximum < registryMaximum -> VersionState.REQUIRES_UPGRADE
        else -> VersionState.REQUIRES_DOWNGRADE
    }
}
