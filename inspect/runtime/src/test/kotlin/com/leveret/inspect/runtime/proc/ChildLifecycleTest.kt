package com.leveret.inspect.runtime.proc

import com.leveret.inspect.runtime.proc.ChildLifecycle.State
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ChildLifecycleTest {
  @Test
  fun `started precedes operational and stop is terminal`() {
    val child = ChildLifecycle()
    assertThat(child.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(child.tryToMoveTo(State.STARTING)).isTrue()
    assertThat(child.tryToMoveTo(State.STARTED)).isTrue()
    assertThat(child.tryToMoveTo(State.OPERATIONAL)).isTrue()
    assertThat(child.tryToMoveTo(State.STOPPING)).isTrue()
    assertThat(child.tryToMoveTo(State.FINALIZE_STOPPING)).isTrue()
    assertThat(child.tryToMoveTo(State.STOPPED)).isTrue()
    assertThat(child.tryToMoveTo(State.STARTING)).isFalse()
  }

  @Test
  fun `hard stopping is reachable from every live state`() {
    listOf(State.STARTING, State.STARTED, State.OPERATIONAL, State.STOPPING).forEach { from ->
      val child = ChildLifecycle()
      val path = listOf(State.STARTING, State.STARTED, State.OPERATIONAL, State.STOPPING)
      for (step in path) {
        child.tryToMoveTo(step)
        if (step == from) break
      }
      assertThat(child.tryToMoveTo(State.HARD_STOPPING)).isTrue()
    }
  }
}
