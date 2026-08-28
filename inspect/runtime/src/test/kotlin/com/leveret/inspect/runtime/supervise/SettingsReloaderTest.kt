package com.leveret.inspect.runtime.supervise

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import com.leveret.inspect.runtime.config.SettingsLoader
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class SettingsReloaderTest {
    private fun loaderFor(home: Path): SettingsLoader =
        SettingsLoader({ home }, emptyMap(), emptyMap(), {})

    private fun writeConfig(home: Path, vararg lines: String) {
        Files.createDirectories(home.resolve("conf"))
        Files.writeString(home.resolve("conf/leveret.properties"), lines.joinToString("\n"))
    }

    @Test
    fun `a reloadable property change is accepted`(@TempDir home: Path) {
        writeConfig(home, "leveret.log.level=DEBUG")
        val current = loaderFor(home).load(emptyArray())
        writeConfig(home, "leveret.log.level=TRACE")

        val reloaded = SettingsReloader(loaderFor(home), emptyArray()).reload(current)

        assertThat(reloaded.required(PropertyKeys.LOG_LEVEL)).isEqualTo("TRACE")
    }

    @Test
    fun `an immutable path change is rejected by name`(@TempDir home: Path) {
        writeConfig(home, "leveret.path.temp=temp")
        val current = loaderFor(home).load(emptyArray())
        writeConfig(home, "leveret.path.temp=other-temp")

        assertThatThrownBy { SettingsReloader(loaderFor(home), emptyArray()).reload(current) }
            .isInstanceOf(IllegalStateException::class.java)
            .hasMessageContaining(PropertyKeys.PATH_TEMP)
    }

    @Test
    fun `a default that becomes explicit but identical is accepted`(@TempDir home: Path) {
        writeConfig(home, "leveret.log.level=INFO")
        val current = loaderFor(home).load(emptyArray())
        writeConfig(home, "leveret.log.level=INFO", "leveret.path.data=data")

        val reloaded = SettingsReloader(loaderFor(home), emptyArray()).reload(current)

        assertThat(reloaded.required(PropertyKeys.PATH_DATA)).isEqualTo("data")
    }

    @Test
    fun `the reloader is a plain function of the current settings`() {
        val fixed = Settings(mapOf(PropertyKeys.LOG_LEVEL to "TRACE"))
        val reloader = Reloader { fixed }

        assertThat(reloader.reload(Settings(emptyMap())).required(PropertyKeys.LOG_LEVEL)).isEqualTo("TRACE")
    }
}
