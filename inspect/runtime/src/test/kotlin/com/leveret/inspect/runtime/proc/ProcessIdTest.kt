package com.leveret.inspect.runtime.proc

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ProcessIdTest {
    @Test
    fun `identities address the reserved command slots`() {
        assertThat(ProcessId.entries.map { Triple(it.key, it.index, it.logPrefix) })
            .containsExactly(
                Triple("app", 0, "leveret"),
                Triple("search", 1, "search"),
                Triple("web", 2, "web"),
                Triple("ce", 3, "ce"),
            )
        assertThat(ProcessId.MAX_PROCESSES).isEqualTo(5)
        assertThat(ProcessId.WEB.logFileName).isEqualTo("web.log")
        assertThat(ProcessId.entries.map { it.displayName })
            .containsExactly("Leveret Inspect", "Search", "Web Server", "Compute Engine")
    }

    @Test
    fun `lookup rejects unknown key and out of range index`() {
        assertThat(ProcessId.fromKey("ce")).isEqualTo(ProcessId.COMPUTE)
        assertThat(ProcessId.fromKey("search")).isEqualTo(ProcessId.SEARCH)
        assertThat(ProcessId.fromIndex(1)).isEqualTo(ProcessId.SEARCH)
        assertThatThrownBy { ProcessId.fromKey("es") }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { ProcessId.fromIndex(4) }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy { ProcessId.fromIndex(-1) }.isInstanceOf(IllegalArgumentException::class.java)
    }
}
