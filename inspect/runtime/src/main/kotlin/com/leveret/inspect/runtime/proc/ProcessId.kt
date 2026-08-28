package com.leveret.inspect.runtime.proc

/**
 * Stable process identities of a node.
 *
 * Keys, indexes and the reserved slot count are release-coupled: they address slots in the local
 * command file and must not be renumbered.
 */
enum class ProcessId(
    val key: String,
    val index: Int,
    val logPrefix: String,
    val displayName: String,
) {
    APP("app", 0, "leveret", "Leveret Inspect"),
    SEARCH("es", 1, "es", "Search"),
    WEB("web", 2, "web", "Web Server"),
    COMPUTE("ce", 3, "ce", "Compute Engine"),
    ;

    val logFileName: String get() = "$logPrefix.log"

    companion object {
        /** Reserved command-file slots. Indexes 0 until this bound are addressable. */
        const val MAX_PROCESSES = 5

        fun fromKey(key: String): ProcessId =
            entries.firstOrNull { it.key == key }
                ?: throw IllegalArgumentException("Unknown process key: $key")

        fun fromIndex(index: Int): ProcessId =
            entries.firstOrNull { it.index == index }
                ?: throw IllegalArgumentException("Unknown process index: $index")
    }
}
