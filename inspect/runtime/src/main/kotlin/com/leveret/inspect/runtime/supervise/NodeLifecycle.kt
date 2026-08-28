package com.leveret.inspect.runtime.supervise

import java.util.EnumMap

/**
 * Lifecycle of a whole node as observed by its monitor.
 *
 * Only the transitions in [TRANSITIONS] are legal; a rejected or repeated request is ignored rather
 * than producing a second transition, so callers can race without corrupting the sequence.
 */
class NodeLifecycle {
    enum class State {
        INIT,
        STARTING,
        OPERATIONAL,
        RESTARTING,
        STOPPING,
        HARD_STOPPING,
        FINALIZE_STOPPING,
        STOPPED,
    }

    @Volatile
    var state: State = State.INIT
        private set

    fun tryToMoveTo(target: State): Boolean =
        synchronized(this) {
            if (target !in TRANSITIONS.getValue(state)) return false
            state = target
            true
        }

    private companion object {
        val TRANSITIONS: Map<State, Set<State>> =
            EnumMap<State, Set<State>>(State::class.java).apply {
                put(State.INIT, setOf(State.STARTING))
                put(
                    State.STARTING,
                    setOf(State.OPERATIONAL, State.RESTARTING, State.STOPPING, State.HARD_STOPPING),
                )
                put(State.OPERATIONAL, setOf(State.RESTARTING, State.STOPPING, State.HARD_STOPPING))
                put(State.RESTARTING, setOf(State.STARTING, State.HARD_STOPPING))
                put(State.STOPPING, setOf(State.FINALIZE_STOPPING, State.HARD_STOPPING))
                put(State.HARD_STOPPING, setOf(State.FINALIZE_STOPPING))
                put(State.FINALIZE_STOPPING, setOf(State.STOPPED))
                put(State.STOPPED, emptySet())
            }
    }
}
