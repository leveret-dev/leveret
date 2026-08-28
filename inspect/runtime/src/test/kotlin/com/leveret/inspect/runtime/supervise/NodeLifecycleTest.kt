package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.supervise.NodeLifecycle.State
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class NodeLifecycleTest {
  @Test
  fun `follows the specified transition table`() {
    val node = NodeLifecycle()
    assertThat(node.state).isEqualTo(State.INIT)
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(node.tryToMoveTo(State.STARTING)).isTrue()
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isTrue()
    assertThat(node.tryToMoveTo(State.OPERATIONAL)).isFalse()
    assertThat(node.tryToMoveTo(State.STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.HARD_STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.FINALIZE_STOPPING)).isTrue()
    assertThat(node.tryToMoveTo(State.STOPPED)).isTrue()
    assertThat(node.tryToMoveTo(State.STARTING)).isFalse()
  }

  @Test
  fun `restarting returns to starting`() {
    val node = NodeLifecycle()
    node.tryToMoveTo(State.STARTING)
    node.tryToMoveTo(State.OPERATIONAL)
    assertThat(node.tryToMoveTo(State.RESTARTING)).isTrue()
    assertThat(node.tryToMoveTo(State.STARTING)).isTrue()
  }

  @Test
  fun `stopping cannot skip finalize`() {
    val node = NodeLifecycle()
    node.tryToMoveTo(State.STARTING)
    node.tryToMoveTo(State.STOPPING)
    assertThat(node.tryToMoveTo(State.STOPPED)).isFalse()
  }
}
