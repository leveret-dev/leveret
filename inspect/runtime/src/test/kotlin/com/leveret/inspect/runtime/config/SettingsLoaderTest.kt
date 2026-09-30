package com.leveret.inspect.runtime.config

import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class SettingsLoaderTest {
    private fun home(@TempDir dir: Path, vararg lines: String): Path {
        Files.createDirectories(dir.resolve("conf"))
        Files.writeString(dir.resolve("conf/leveret.properties"), lines.joinToString("\n"))
        return dir
    }

    @Test
    fun `system property beats argument beats environment beats file`(@TempDir dir: Path) {
        val h = home(dir, "leveret.log.level=DEBUG")
        val loader = SettingsLoader(
            homeSupplier = { h },
            env = mapOf("LEVERET_LOG_LEVEL" to "TRACE"),
            systemProperties = mapOf("leveret.log.level" to "INFO"),
            warn = {},
        )
        assertThat(loader.load(arrayOf("-Dleveret.log.level=DEBUG")).required("leveret.log.level")).isEqualTo("INFO")

        val withoutSysProp = SettingsLoader({ h }, mapOf("LEVERET_LOG_LEVEL" to "TRACE"), emptyMap(), {})
        assertThat(withoutSysProp.load(arrayOf("-Dleveret.log.level=DEBUG")).required("leveret.log.level")).isEqualTo("DEBUG")
        assertThat(withoutSysProp.load(emptyArray()).required("leveret.log.level")).isEqualTo("TRACE")

        val fileOnly = SettingsLoader({ h }, emptyMap(), emptyMap(), {})
        assertThat(fileOnly.load(emptyArray()).required("leveret.log.level")).isEqualTo("DEBUG")
    }

    @Test
    fun `home is runtime owned and absolute`(@TempDir dir: Path) {
        val h = home(dir, "leveret.path.home=/somewhere/else")
        val settings = SettingsLoader({ h }, emptyMap(), emptyMap(), {}).load(emptyArray())
        assertThat(settings.required(PropertyKeys.PATH_HOME)).isEqualTo(h.toAbsolutePath().toString())
    }

    @Test
    fun `a foreign prefix never feeds a recognized key`(@TempDir dir: Path) {
        val h = home(dir, "unrelated.log.level=TRACE")
        val settings = SettingsLoader(
            { h },
            mapOf("UNRELATED_LOG_LEVEL" to "TRACE"),
            mapOf("unrelated.log.level" to "TRACE"),
            {},
        ).load(emptyArray())
        assertThat(settings.required(PropertyKeys.LOG_LEVEL)).isEqualTo("INFO")
    }

    @Test
    fun `missing file warns and defaults still apply`(@TempDir dir: Path) {
        val warnings = mutableListOf<String>()
        val settings = SettingsLoader({ dir }, emptyMap(), emptyMap(), warnings::add).load(emptyArray())
        assertThat(warnings).isNotEmpty()
        assertThat(settings.required(PropertyKeys.LOG_LEVEL)).isEqualTo("INFO")
        assertThat(settings.required(PropertyKeys.PATH_DATA)).isEqualTo("data")
        assertThat(settings.required(PropertyKeys.LOG_JSON)).isEqualTo("false")
    }

    @Test
    fun `unreadable existing file fails loading`(@TempDir dir: Path) {
        Files.createDirectories(dir.resolve("conf/leveret.properties"))
        assertThatThrownBy { SettingsLoader({ dir }, emptyMap(), emptyMap(), {}).load(emptyArray()) }
            .isInstanceOf(IllegalStateException::class.java)
    }
}
