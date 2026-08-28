package com.leveret.inspect.runtime.proc

import java.util.EnumMap

/**
 * Lifecycle of a single child process.
 *
 * `STARTED` means the operating-system process was launched and its watchers installed; readiness is
 * the separate `OPERATIONAL` step reported by the child itself. Stop states are reachable from every
 * live state because a stop request may arrive at any point during startup.
 */
class ChildLifecycle {
    enum class State {
        INIT,
        STARTING,
        STARTED,
        OPERATIONAL,
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
        val STOPS = setOf(State.STOPPING, State.HARD_STOPPING, State.FINALIZE_STOPPING)

        val TRANSITIONS: Map<State, Set<State>> =
            EnumMap<State, Set<State>>(State::class.java).apply {
                put(State.INIT, setOf(State.STARTING))
                put(State.STARTING, setOf(State.STARTED) + STOPS)
                put(State.STARTED, setOf(State.OPERATIONAL) + STOPS)
                put(State.OPERATIONAL, STOPS)
                put(State.STOPPING, setOf(State.HARD_STOPPING, State.FINALIZE_STOPPING))
                put(State.HARD_STOPPING, setOf(State.FINALIZE_STOPPING))
                put(State.FINALIZE_STOPPING, setOf(State.STOPPED))
                put(State.STOPPED, emptySet())
            }
    }
}
