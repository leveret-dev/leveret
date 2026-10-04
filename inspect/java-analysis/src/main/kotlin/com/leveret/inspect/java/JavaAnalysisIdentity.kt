package com.leveret.inspect.java

import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.security.MessageDigest

object JavaAnalysisIdentity {
    fun compute(input: JavaAnalysisInput): AnalysisIdentity {
        require(input.repositoryId.isNotBlank() && input.revision.isNotBlank() && input.buildIdentity.isNotBlank())
        require(input.compilations.any { it.files.isNotEmpty() })
        require(input.compilations.map { it.id }.toSet().size == input.compilations.size &&
            input.compilations.all { it.id.isNotBlank() && it.resolutionDomain.isNotBlank() }) {
            "Compilation ids must be unique and non-empty"
        }
        require(input.compilations.all { it.sourceSet == "main" || it.sourceSet == "test" }) { "Unknown source set" }
        val owners = mutableSetOf<Pair<String, Path>>()
        val displays = mutableSetOf<Pair<String, String>>()
        for (compilation in input.compilations) {
            for (file in compilation.files) {
                require(owners.add(compilation.resolutionDomain to file.physicalPath.toRealPath())) {
                    "A Java source may belong to only one source set"
                }
                require(safeDisplay(file.displayPath)) { "Unsafe display path: ${file.displayPath}" }
                require(displays.add(compilation.resolutionDomain to file.displayPath)) { "Duplicate display path: ${file.displayPath}" }
            }
        }
        val root = input.pathRoot.toRealPath()
        val usesArtifacts = input.compilations.any { it.classpath.isNotEmpty() || it.origins.isNotEmpty() }
        val artifactRoot = if (usesArtifacts) input.artifactRoot.toRealPath() else input.artifactRoot.toAbsolutePath().normalize()
        val settings = mutableListOf(
            "java-analysis:2", input.repositoryId, input.revision, input.buildIdentity,
            System.getProperty("java.version"), System.getProperty("java.vm.version"),
        )
        for ((name, sha256) in JavaCompilationEnvironment.workerPlatform().toSortedMap()) settings += record("worker-platform", name, sha256)
        for (path in System.getProperty("java.class.path").split(java.io.File.pathSeparator)) {
            if (path.endsWith(".jar")) settings += "worker-jar:$path:${hash(Path.of(path))}"
        }
        fun layout(kind: String, directory: Path): String {
            val normalized = directory.toAbsolutePath().normalize()
            require(normalized.startsWith(root)) { "Root outside snapshot: $directory" }
            if (Files.exists(normalized)) contained(root, normalized)
            return record(kind, root.relativize(normalized).toString().replace('\\', '/'))
        }
        fun anchored(path: Path): String {
            val real = path.toRealPath()
            return when {
                real.startsWith(artifactRoot) -> record("artifact", artifactRoot.relativize(real).toString().replace('\\', '/'))
                real.startsWith(root) -> record("path", root.relativize(real).toString().replace('\\', '/'))
                else -> throw IllegalArgumentException("Origin escapes analysis input: $path")
            }
        }
        val artifacts = mutableListOf<String>()
        for (compilation in input.compilations) {
            val compiler = compilation.compiler
            settings += record("compilation", compilation.id, compilation.resolutionDomain, compilation.sourceSet)
            settings += record(
                "compiler", compiler.sourceLevel, compiler.targetLevel, compiler.encoding, compiler.preview?.toString(),
                compiler.release.state, compiler.release.value,
                compiler.usedModuleOptions?.let { "[" + record(*it.sorted().toTypedArray()) + "]" },
                compiler.platform.toSortedMap().entries.joinToString(",") { record(it.key, it.value) },
            )
            settings += compilation.roots.map { layout("root", it) }
            settings += compilation.sourcePath.map { layout("sourcepath", it) }
            require(compilation.origins.map { it.path.toRealPath() }.toSet().size == compilation.origins.size) { "Duplicate origin path" }
            for (origin in compilation.origins) {
                settings += record("origin", anchored(origin.path), citation(origin.artifact), origin.ownerCompilationId)
            }
            for (entry in compilation.classpath) {
                val real = contained(artifactRoot, entry)
                val name = artifactRoot.relativize(real).toString().replace('\\', '/')
                settings += record("classpath", compilation.id, name)
                artifacts += record("artifact", compilation.id, name, hashEntry(real))
            }
            for (file in compilation.files.sortedWith(compareBy({ it.displayPath }, { it.physicalPath.toString() }))) {
                settings += record(
                    "source", compilation.id, file.displayPath, relative(root, file.physicalPath), file.encoding,
                    citation(file.buildArtifact), hash(file.physicalPath.toRealPath()),
                )
            }
        }
        for (file in input.skippedFiles) {
            require(!file.examined && file.reason != null)
            settings += "skipped:${file.sourceSet}:${file.path}:${file.reason}"
        }
        settings += input.diagnostics.map { record("diagnostic", it) }
        val config = sha(settings)
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

    internal fun hash(path: Path): String {
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

    /** A class directory is identified by its sorted member paths and bytes; a link inside it would escape the frozen entry. */
    private fun hashEntry(path: Path): String {
        if (!Files.isDirectory(path)) return hash(path)
        val members = Files.walk(path).use { walk ->
            walk.filter { it != path }.map {
                require(!Files.isSymbolicLink(it)) { "Symbolic link in classpath directory: $it" }
                if (Files.isRegularFile(it, LinkOption.NOFOLLOW_LINKS)) record(path.relativize(it).toString().replace('\\', '/'), hash(it)) else ""
            }.filter { it.isNotEmpty() }.sorted().toList()
        }
        return sha(members)
    }

    private fun safeDisplay(path: String) = path.isNotEmpty() && !path.startsWith('/') && !path.contains('\\') && !path.contains('\u0000') &&
        path.split('/').none { it.isEmpty() || it == "." || it == ".." }

    private fun citation(value: BuildArtifactCitation?) = value?.let { record(it.manifestSha256, it.artifactId, it.origin) }

    /** Length-delimited fields: no choice of ids, paths or settings can make two different records encode alike. */
    private fun record(vararg parts: String?): String = parts.joinToString("|") { it?.let { value -> "${value.length}:$value" } ?: "-" }

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
