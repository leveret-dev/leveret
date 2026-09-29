package com.leveret.inspect.runtime.fs

import java.nio.file.Files
import java.nio.file.Path

/**
 * Locates installation home from the running artifact, so home is a property of the installation
 * rather than of how an operator invoked the process.
 */
object InstallationHome {
    fun derive(): Path {
        val artifact = Path.of(
            InstallationHome::class.java.protectionDomain.codeSource.location.toURI(),
        ).toAbsolutePath().normalize()
        val directory = if (Files.isDirectory(artifact)) artifact else artifact.parent
        return if (directory.fileName?.toString() == LIB_DIRECTORY) directory.parent else directory
    }

    private const val LIB_DIRECTORY = "lib"
}
