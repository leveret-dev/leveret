package com.leveret.inspect.java

import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import org.eclipse.jdt.core.dom.ASTParser

object JavaAnalysisIdentity {
    fun compute(input: JavaAnalysisInput): AnalysisIdentity {
        require(input.repositoryId.isNotBlank() && input.revision.isNotBlank())
        require(input.mainFiles.isNotEmpty() || input.testFiles.isNotEmpty())
        val root = input.sourceRoot.toRealPath()
        val repo = if (input.classpath.mainClasspath.isEmpty() && input.classpath.testClasspath.isEmpty()) {
            input.artifactRoot.toAbsolutePath().normalize()
        } else input.artifactRoot.toRealPath()
        val settings = mutableListOf(
            "java-analysis:1", input.repositoryId, input.revision, input.javaLevel,
            System.getProperty("java.version"), System.getProperty("java.vm.version"),
            hash(Path.of(System.getProperty("java.home"), "release")),
            hash(Path.of(System.getProperty("java.home"), "lib", "modules")),
            input.classpath.write(),
            "preview=disabled",
        )
        for (path in System.getProperty("java.class.path").split(java.io.File.pathSeparator)) {
            if (path.endsWith(".jar")) settings += "worker-jar:$path:${hash(Path.of(path))}"
        }
        for ((scope, roots, files) in listOf(
            Triple("main", input.mainRoots, input.mainFiles),
            Triple("test", input.testRoots, input.testFiles),
        )) {
            for (directory in roots) {
                val normalized = directory.toAbsolutePath().normalize()
                require(normalized.startsWith(root)) { "Root outside snapshot: $directory" }
                if (Files.exists(normalized)) contained(root, normalized)
                settings += "$scope:root:${root.relativize(normalized).toString().replace('\\', '/')}"
            }
            for (file in files.sortedBy { it.toString() }) {
                settings += "$scope:source:${relative(root, file)}:${hash(file)}"
            }
        }
        for (file in input.skippedFiles) {
            require(!file.examined && file.reason != null)
            settings += "skipped:${file.sourceSet}:${file.path}:${file.reason}"
        }
        val config = sha(settings)
        val artifacts = mutableListOf<String>()
        for ((scope, paths) in listOf("main" to input.classpath.mainClasspath, "test" to input.classpath.testClasspath)) {
            for (path in paths) artifacts += "$scope:artifact:$path:${hash(contained(repo, repo.resolve(path)))}"
        }
        return AnalysisIdentity(sha(settings + artifacts), config)
    }

    internal fun relative(root: Path, path: Path): String = root.relativize(contained(root, path)).toString().replace('\\', '/')

    internal fun contained(root: Path, path: Path): Path {
        val real = path.toRealPath()
        require(real.startsWith(root) && Files.isRegularFile(real) || real.startsWith(root) && Files.isDirectory(real)) {
            "Path escapes analysis input: $path"
        }
        return real
    }

    private fun hash(path: Path): String {
        val digest = MessageDigest.getInstance("SHA-256")
        Files.newInputStream(path).use { stream ->
            val bytes = ByteArray(8192)
            while (true) {
                val count = stream.read(bytes)
                if (count < 0) break
                digest.update(bytes, 0, count)
            }
        }
        return java.util.HexFormat.of().formatHex(digest.digest())
    }

    private fun sha(values: List<String>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        values.forEach {
            val bytes = it.toByteArray(Charsets.UTF_8)
            digest.update(java.nio.ByteBuffer.allocate(4).putInt(bytes.size).array())
            digest.update(bytes)
        }
        return java.util.HexFormat.of().formatHex(digest.digest())
    }
}
