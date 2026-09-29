package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.PropertyKeys
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class DistributionTest {
    @Test
    fun `template documents every recognized key with its default`() {
        val text = Files.readString(Path.of("src/main/assembly/conf/leveret.properties"))
        PropertyKeys.defaults.forEach { (key, default) ->
            assertThat(text).contains(key)
            if (default.isNotEmpty()) assertThat(text).contains(default)
        }
        assertThat(text).doesNotContain("cluster")
    }
}
