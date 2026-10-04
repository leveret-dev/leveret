package com.leveret.inspect.java

import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipFile
import org.eclipse.jdt.core.JavaCore
import org.eclipse.jdt.core.dom.IMethodBinding
import org.eclipse.jdt.core.dom.ITypeBinding

/** The compiler's `--release` state; `unknown` never means `unset`. */
data class JavaRelease(val state: String, val value: String? = null) {
    init {
        require(state == "set" && value != null || (state == "unset" || state == "unknown") && value == null) { "Invalid release state" }
    }

    companion object {
        val UNSET = JavaRelease("unset")
        val UNKNOWN = JavaRelease("unknown")
    }
}

/**
 * Effective compiler settings of one exported compilation. Everything is nullable because the exporter may not know it;
 * [supportProblem] is the single place that decides whether the worker can reproduce the environment.
 * [platform] maps fingerprint names (`release`, `modules`, `ct.sym`, `rt.jar`) to SHA-256; empty means unknown.
 * [usedModuleOptions] names the JPMS options that carry values; null means unknown, empty means known unused.
 */
data class JavaCompilationEnvironment(
    val sourceLevel: String?,
    val targetLevel: String?,
    val encoding: String?,
    val preview: Boolean?,
    val release: JavaRelease,
    val platform: Map<String, String>,
    val usedModuleOptions: List<String>?,
) {
    /** Null when the worker reproduces this environment; otherwise why it cannot. Never inferred from names or version strings. */
    fun supportProblem(workerPlatform: Map<String, String>): String? {
        when (release.state) {
            "set" -> return "release ${release.value} selects platform API definitions the analysis worker cannot reproduce"
            "unknown" -> return "release state is unknown"
        }
        levelProblem("source", sourceLevel)?.let { return it }
        levelProblem("target", targetLevel)?.let { return it }
        if (encoding == null) return "encoding is unknown"
        if (!isUtf8(encoding)) return "encoding $encoding is not supported; only UTF-8 is"
        when (preview) {
            null -> return "preview setting is unknown"
            true -> return "preview features are enabled"
            false -> Unit
        }
        val used = usedModuleOptions ?: return "module options are unknown"
        if (used.isNotEmpty()) return "module options in use: ${used.joinToString(", ")}"
        if (platform.isEmpty()) return "platform is unknown"
        if ("modules" !in platform) return "platform has no modules fingerprint"
        if ("modules" !in workerPlatform) return "platform cannot be verified: the analysis worker has no modules fingerprint"
        for ((name, sha256) in platform) {
            if (workerPlatform[name] != sha256) return "platform fingerprint $name does not match the analysis worker"
        }
        return null
    }

    private fun levelProblem(kind: String, level: String?): String? = when {
        level == null -> "$kind level is unknown"
        !JavaCore.isSupportedJavaVersion(level) -> "$kind level $level is not supported by the analysis worker"
        else -> null
    }

    companion object {
        // The running VM is the only platform JDT is given (`includeRunningVMBootclasspath`), so its files are its identity.
        private val worker: Map<String, String> by lazy {
            val home = Path.of(System.getProperty("java.home"))
            listOf("release" to home.resolve("release"), "modules" to home.resolve("lib/modules"), "ct.sym" to home.resolve("lib/ct.sym"))
                .filter { Files.isRegularFile(it.second) }
                .associate { it.first to JavaAnalysisIdentity.hash(it.second) }
        }

        fun workerPlatform(): Map<String, String> = worker

        /** The cache-only adapter analyses on the worker's own platform, so its platform matches by construction. */
        fun legacy(level: String) = JavaCompilationEnvironment(level, level, "UTF-8", false, JavaRelease.UNSET, worker, emptyList())

        fun isUtf8(name: String): Boolean = runCatching { Charset.forName(name) }.getOrNull() == StandardCharsets.UTF_8
    }
}

/** Where JDT found the declaring type of a call: a source file, or a classpath entry optionally owned by a compilation. */
sealed interface ResolvedMethodOrigin {
    data class Source(val file: Path) : ResolvedMethodOrigin
    data class Binary(val ownerCompilationId: String?) : ResolvedMethodOrigin
}

/** The outermost declaring type of a bound method (`example.Pricing`), and whether JDT resolved it to source. */
data class DeclaringType(val topLevel: String?, val fromSource: Boolean)

/**
 * Establishes which declaration a bound call really reaches by repeating JDT's lookup over the compilation's frozen entries:
 * types declared in its member files, then its source path by file name, then its ordered classpath.
 * A type with competing providers has no origin (null), so it can never be joined to a source declaration by name alone.
 */
class JavaOriginIndex(compilations: List<JavaCompilationInput>) : AutoCloseable {
    private val byId = compilations.associateBy { it.id }
    private val declaredByCompilation = HashMap<String, HashMap<String, MutableSet<Path>>>()
    private val declaredByDomain = HashMap<String, HashMap<String, MutableSet<Path>>>()
    private val ownersByCompilation = HashMap<String, Map<Path, JavaOrigin>>()
    private val archives = HashMap<Path, ZipFile>()
    private val resolved = HashMap<Triple<String, String, Boolean>, ResolvedMethodOrigin?>()

    /** Registers the top-level types a member file declares, as seen while that file is already being visited. */
    fun declare(compilationId: String, file: Path, topLevelTypes: Collection<String>) {
        val domain = compilation(compilationId).resolutionDomain
        for (name in topLevelTypes) {
            declaredByCompilation.getOrPut(compilationId) { HashMap() }.getOrPut(name) { LinkedHashSet() }.add(file)
            declaredByDomain.getOrPut(domain) { HashMap() }.getOrPut(name) { LinkedHashSet() }.add(file)
        }
        resolved.clear()
    }

    /** True when more than one file of the compilation's resolution domain declares [topLevel]. */
    fun duplicated(compilationId: String, topLevel: String?): Boolean =
        topLevel != null && (declaredByDomain[compilation(compilationId).resolutionDomain]?.get(topLevel)?.size ?: 0) > 1

    fun resolve(binding: IMethodBinding, compilationId: String): ResolvedMethodOrigin? = resolve(declaringType(binding), compilationId)

    fun resolve(type: DeclaringType, compilationId: String): ResolvedMethodOrigin? {
        val name = type.topLevel ?: return null
        val key = Triple(compilationId, name, type.fromSource)
        if (key in resolved) return resolved[key]
        val unit = compilation(compilationId)
        val origin = if (type.fromSource) source(unit, name) else binary(unit, name)
        resolved[key] = origin
        return origin
    }

    override fun close() {
        archives.values.forEach { it.close() }
        archives.clear()
    }

    private fun source(unit: JavaCompilationInput, name: String): ResolvedMethodOrigin? {
        if (duplicated(unit.id, name)) return null
        val found = LinkedHashSet<Path>()
        declaredByCompilation[unit.id]?.get(name)?.let { found.addAll(it) }
        val relative = name.replace('.', '/') + ".java"
        for (root in unit.sourcePath) {
            val candidate = root.resolve(relative)
            if (Files.isRegularFile(candidate)) found.add(candidate.toRealPath())
        }
        return found.singleOrNull()?.let { ResolvedMethodOrigin.Source(it) }
    }

    private fun binary(unit: JavaCompilationInput, name: String): ResolvedMethodOrigin? {
        val entry = name.replace('.', '/') + ".class"
        val owners = ownersByCompilation.getOrPut(unit.id) { unit.origins.associateBy { it.path.toRealPath() } }
        var owner: String? = null
        var seen = false
        for (path in unit.classpath) {
            if (!provides(path, entry)) continue
            val candidate = owners[path.toRealPath()]?.ownerCompilationId
            if (!seen) {
                owner = candidate
                seen = true
            } else if (candidate != owner) return null
        }
        return ResolvedMethodOrigin.Binary(owner)
    }

    private fun provides(path: Path, entry: String): Boolean =
        if (Files.isDirectory(path)) Files.isRegularFile(path.resolve(entry)) else archives.getOrPut(path) { ZipFile(path.toFile()) }.getEntry(entry) != null

    private fun compilation(id: String) = byId[id] ?: throw IllegalArgumentException("Unknown compilation $id")

    companion object {
        fun declaringType(binding: IMethodBinding): DeclaringType {
            val declaring = binding.methodDeclaration.declaringClass
            var outer: ITypeBinding = declaring
            while (true) outer = outer.declaringClass ?: break
            val name = (outer.erasure.binaryName ?: outer.qualifiedName)?.takeIf { it.isNotEmpty() }
            return DeclaringType(name, declaring.isFromSource)
        }
    }
}
