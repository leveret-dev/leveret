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
    fun `legacy prefix resolves to canonical key and conflict warns`(@TempDir dir: Path) {
        val h = home(dir, "sonar.log.level=TRACE")
        val warnings = mutableListOf<String>()
        val settings = SettingsLoader({ h }, emptyMap(), emptyMap(), warnings::add).load(emptyArray())
        assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
        assertThat(warnings).isEmpty()

        val h2 = home(dir, "sonar.log.level=TRACE", "leveret.log.level=DEBUG")
        val conflicts = mutableListOf<String>()
        val resolved = SettingsLoader({ h2 }, emptyMap(), emptyMap(), conflicts::add).load(emptyArray())
        assertThat(resolved.required("leveret.log.level")).isEqualTo("DEBUG")
        assertThat(conflicts).anySatisfy { assertThat(it).contains("sonar.log.level").contains("leveret.log.level") }
    }

    @Test
    fun `legacy environment name is accepted`(@TempDir dir: Path) {
        val h = home(dir, "leveret.log.level=DEBUG")
        val settings = SettingsLoader({ h }, mapOf("SONAR_LOG_LEVEL" to "TRACE"), emptyMap(), {}).load(emptyArray())
        assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
    }

    @Test
    fun `missing file warns and defaults still apply`(@TempDir dir: Path) {
        val warnings = mutableListOf<String>()
        val settings = SettingsLoader({ dir }, emptyMap(), emptyMap(), warnings::add).load(emptyArray())
        assertThat(warnings).isNotEmpty()
        assertThat(settings.required(PropertyKeys.LOG_LEVEL)).isEqualTo("INFO")
        assertThat(settings.required(PropertyKeys.gracefulStopTimeout(com.leveret.inspect.runtime.proc.ProcessId.WEB)))
            .isEqualTo("240000")
        assertThat(settings.required(PropertyKeys.gracefulStopTimeout(com.leveret.inspect.runtime.proc.ProcessId.COMPUTE)))
            .isEqualTo("21600000")
    }

    @Test
    fun `unreadable existing file fails loading`(@TempDir dir: Path) {
        Files.createDirectories(dir.resolve("conf/leveret.properties"))
        assertThatThrownBy { SettingsLoader({ dir }, emptyMap(), emptyMap(), {}).load(emptyArray()) }
            .isInstanceOf(IllegalStateException::class.java)
    }

    @Test
    fun `legacy file is used when canonical file is absent`(@TempDir dir: Path) {
        Files.createDirectories(dir.resolve("conf"))
        Files.writeString(dir.resolve("conf/sonar.properties"), "leveret.log.level=TRACE")
        val settings = SettingsLoader({ dir }, emptyMap(), emptyMap(), {}).load(emptyArray())
        assertThat(settings.required("leveret.log.level")).isEqualTo("TRACE")
    }
}
