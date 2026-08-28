package com.leveret.inspect.runtime.ipc

import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CommandFileTest {
    @Test
    fun `file layout reserves one slot per process`(@TempDir dir: Path) {
        CommandFile(dir).use { it.clearAll() }
        assertThat(Files.size(dir.resolve(CommandFile.FILE_NAME)))
            .isEqualTo((CommandFile.SLOT_SIZE * ProcessId.MAX_PROCESSES).toLong())
    }

    @Test
    fun `flags and url round trip per slot without bleeding`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            val web = file.view(ProcessId.WEB.index)
            val compute = file.view(ProcessId.COMPUTE.index)
            web.up = true
            web.operational = true
            web.systemInfoUrl = "http://127.0.0.1:9000/api/system/info"

            assertThat(web.up).isTrue()
            assertThat(web.operational).isTrue()
            assertThat(web.systemInfoUrl).isEqualTo("http://127.0.0.1:9000/api/system/info")
            assertThat(compute.up).isFalse()
            assertThat(compute.operational).isFalse()
            assertThat(compute.systemInfoUrl).isNull()
        }
    }

    @Test
    fun `restart request survives until acknowledged`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            val child = file.view(ProcessId.COMPUTE.index)
            child.askedForRestart = true
            assertThat(child.askedForRestart).isTrue()
            file.view(ProcessId.COMPUTE.index).acknowledgeRestart()
            assertThat(child.askedForRestart).isFalse()
        }
    }

    @Test
    fun `oversized url is rejected`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            assertThatThrownBy { file.view(0).systemInfoUrl = "u".repeat(CommandFile.MAX_URL_BYTES + 1) }
                .isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `index outside reserved range is rejected`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            assertThat(file.view(4)).isNotNull()
            assertThatThrownBy { file.view(5) }.isInstanceOf(IllegalArgumentException::class.java)
            assertThatThrownBy { file.view(-1) }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }

    @Test
    fun `clearAll and mainView drop stale state`(@TempDir dir: Path) {
        CommandFile(dir).use { file ->
            file.view(ProcessId.WEB.index).apply { up = true; operational = true }
        }
        CommandFile(dir).use { file ->
            assertThat(file.view(ProcessId.WEB.index).up).isTrue()
            file.clearAll()
            assertThat(file.view(ProcessId.WEB.index).up).isFalse()

            file.view(ProcessId.COMPUTE.index).operational = true
            assertThat(file.mainView(ProcessId.COMPUTE.index).operational).isFalse()
        }
    }
}
