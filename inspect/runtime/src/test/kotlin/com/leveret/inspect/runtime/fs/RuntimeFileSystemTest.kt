package com.leveret.inspect.runtime.fs

import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class RuntimeFileSystemTest {
  private fun settings(home: Path, extra: Map<String, String> = emptyMap()) = Settings(
    mapOf(
      "leveret.path.home" to home.toString(),
      "leveret.path.data" to "data",
      "leveret.path.logs" to "logs",
      "leveret.path.temp" to "temp",
    ) + extra,
  )

  @Test
  fun `creates directories and resolves relative paths against home`(@TempDir home: Path) {
    val fs = RuntimeFileSystem(settings(home))
    fs.reset()
    assertThat(fs.dataDir).isEqualTo(home.resolve("data")).isDirectory()
    assertThat(fs.tempDir).isEqualTo(home.resolve("temp")).isDirectory()
    assertThat(fs.tempDir.isAbsolute).isTrue()
  }

  @Test
  fun `absolute configured path is honoured`(@TempDir home: Path, @TempDir other: Path) {
    val fs = RuntimeFileSystem(settings(home, mapOf("leveret.path.data" to other.resolve("d").toString())))
    fs.reset()
    assertThat(fs.dataDir).isEqualTo(other.resolve("d")).isDirectory()
  }

  @Test
  fun `existing non directory path aborts`(@TempDir home: Path) {
    Files.writeString(home.resolve("data"), "file")
    assertThatThrownBy { RuntimeFileSystem(settings(home)).reset() }
      .isInstanceOf(IllegalStateException::class.java)
  }

  @Test
  fun `temp is cleaned one level while data and logs survive`(@TempDir home: Path) {
    val fs = RuntimeFileSystem(settings(home))
    fs.reset()
    Files.writeString(fs.dataDir.resolve("keep.db"), "x")
    Files.writeString(fs.logsDir.resolve("keep.log"), "x")
    Files.writeString(fs.tempDir.resolve("stale.properties"), "x")
    Files.createDirectories(fs.tempDir.resolve("nested/deeper"))
    Files.writeString(fs.tempDir.resolve("nested/deeper/x"), "x")
    val retained = fs.tempDir.resolve("sharedmemory")
    Files.writeString(retained, "x")

    fs.cleanTempDir(retain = setOf(retained))

    assertThat(fs.dataDir.resolve("keep.db")).exists()
    assertThat(fs.logsDir.resolve("keep.log")).exists()
    assertThat(fs.tempDir.resolve("stale.properties")).doesNotExist()
    assertThat(fs.tempDir.resolve("nested")).doesNotExist()
    assertThat(retained).exists()
  }
}
