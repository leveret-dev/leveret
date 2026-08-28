package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ShutdownerTest {
    private fun writeConfig(home: Path, vararg lines: String) {
        Files.createDirectories(home.resolve("conf"))
        Files.writeString(home.resolve("conf/leveret.properties"), lines.joinToString("\n"))
    }

    @Test
    fun `writes the monitor hard stop flag in the configured temp directory`(@TempDir home: Path) {
        val temp = home.resolve("absolute-temp")
        Files.createDirectories(temp)
        writeConfig(home, "leveret.path.temp=$temp")

        Shutdowner.requestHardStop(home)

        CommandFile(temp).use { assertThat(it.view(ProcessId.APP.index).askedForHardStop).isTrue() }
    }

    @Test
    fun `a relative temp resolves against installation home`(@TempDir home: Path) {
        writeConfig(home, "leveret.path.temp=temp")
        Files.createDirectories(home.resolve("temp"))

        Shutdowner.requestHardStop(home)

        CommandFile(home.resolve("temp")).use {
            assertThat(it.view(ProcessId.APP.index).askedForHardStop).isTrue()
        }
    }

    @Test
    fun `an unreadable configuration is reported instead of silently ignored`(@TempDir home: Path) {
        Files.createDirectories(home.resolve("conf/leveret.properties"))

        org.assertj.core.api.Assertions
            .assertThatThrownBy { Shutdowner.requestHardStop(home) }
            .isInstanceOf(IllegalStateException::class.java)
    }
}
