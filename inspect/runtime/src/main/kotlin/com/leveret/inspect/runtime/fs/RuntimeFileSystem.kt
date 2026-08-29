package com.leveret.inspect.runtime.fs

import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Runtime directories of an installation.
 *
 * A relative configured path resolves against installation home; every exposed path is absolute and
 * normalized. Only the temporary directory is cleaned; data and log directories are never cleared.
 */
class RuntimeFileSystem(settings: Settings) {

    val home: Path = Paths.get(settings.required(PropertyKeys.PATH_HOME)).toAbsolutePath().normalize()
    val dataDir: Path = resolve(settings, PropertyKeys.PATH_DATA, "data")
    val logsDir: Path = resolve(settings, PropertyKeys.PATH_LOGS, "logs")
    val tempDir: Path = resolve(settings, PropertyKeys.PATH_TEMP, "temp")

    private fun resolve(settings: Settings, key: String, fallback: String): Path =
        home.resolve(settings.value(key, fallback)).toAbsolutePath().normalize()

    /** Verifies and creates every directory, then empties the temporary directory. */
    fun reset() {
        listOf(dataDir, logsDir, tempDir).forEach(::prepare)
        cleanTempDir(emptySet())
    }

    /**
     * Removes the immediate children of the temporary directory, recursing into child directories to
     * delete them entirely. Paths in [retain] are left untouched.
     */
    fun cleanTempDir(retain: Set<Path>) {
        if (!Files.isDirectory(tempDir)) return
        val retained = retain.map { it.toAbsolutePath().normalize() }.toSet()
        try {
            Files.newDirectoryStream(tempDir).use { children ->
                children.forEach { child ->
                    if (child.toAbsolutePath().normalize() !in retained) {
                        deleteRecursively(child)
                    }
                }
            }
        } catch (e: IOException) {
            throw IllegalStateException("Cannot clean directory: $tempDir", e)
        }
    }

    private fun prepare(directory: Path) {
        if (Files.exists(directory) && !Files.isDirectory(directory)) {
            throw IllegalStateException("Path exists but is not a directory: $directory")
        }
        try {
            Files.createDirectories(directory)
        } catch (e: IOException) {
            throw IllegalStateException("Cannot create directory: $directory", e)
        }
    }

    private fun deleteRecursively(path: Path) {
        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            Files.newDirectoryStream(path).use { children -> children.forEach(::deleteRecursively) }
        }
        Files.deleteIfExists(path)
    }
}
