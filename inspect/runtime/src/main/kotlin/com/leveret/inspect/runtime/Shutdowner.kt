package com.leveret.inspect.runtime

import com.leveret.inspect.runtime.config.SettingsLoader
import com.leveret.inspect.runtime.fs.InstallationHome
import com.leveret.inspect.runtime.fs.RuntimeFileSystem
import com.leveret.inspect.runtime.ipc.CommandFile
import com.leveret.inspect.runtime.proc.ProcessId
import java.nio.file.Path
import kotlin.system.exitProcess

/**
 * Standalone hard-stop requester.
 *
 * The temporary directory is resolved against installation home, never the caller's working
 * directory, so the request reaches the running node from anywhere.
 */
object Shutdowner {
    @JvmStatic
    fun main(args: Array<String>) {
        try {
            requestHardStop(InstallationHome.derive())
        } catch (failure: Exception) {
            System.err.println("Hard stop could not be requested: ${failure.message}")
            exitProcess(1)
        }
    }

    fun requestHardStop(home: Path) {
        val settings = SettingsLoader({ home }, System.getenv(), emptyMap(), {}).load(emptyArray())
        val tempDir = RuntimeFileSystem(settings).tempDir
        CommandFile(tempDir).use { it.view(ProcessId.APP.index).askedForHardStop = true }
    }
}
