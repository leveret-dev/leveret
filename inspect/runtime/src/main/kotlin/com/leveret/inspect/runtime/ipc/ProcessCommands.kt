package com.leveret.inspect.runtime.ipc

/**
 * One process's slot in the local command file.
 *
 * A view is a window onto shared bytes, not a snapshot: every read observes what the owning process
 * last wrote, and every write is immediately visible to other views of the same slot.
 */
interface ProcessCommands {
    /** The process has reached its own start-up completion point. */
    var up: Boolean

    /** The process is ready to serve. */
    var operational: Boolean

    /** A graceful stop was requested. */
    var askedForStop: Boolean

    /** A hard stop was requested. */
    var askedForHardStop: Boolean

    /**
     * A restart was requested. The requester keeps the request set until it observes the flag
     * cleared by [acknowledgeRestart], so an unread request is never lost.
     */
    var askedForRestart: Boolean

    /** Clears only the restart flag, telling the requester that the request was taken over. */
    fun acknowledgeRestart()

    /** System-information endpoint of the process, or `null` while it has published none. */
    var systemInfoUrl: String?

    /** Stores the current instant as the liveness mark and returns the stored value. */
    fun ping(): Long

    /** Zeroes the whole slot, dropping any state an earlier instance left behind. */
    fun clear()
}
