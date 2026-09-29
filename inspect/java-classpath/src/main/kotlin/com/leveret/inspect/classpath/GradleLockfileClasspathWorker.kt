package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path

object GradleLockfileClasspathWorker {
    fun analyze(projectDir: Path, localRepository: Path): ClasspathAnalysis {
        val repo = localRepository.toAbsolutePath().normalize()
        val lockfile = projectDir.resolve("gradle.lockfile")
        val hasLockfile = Files.isRegularFile(lockfile)
        val entries = if (hasLockfile) parseLockfile(lockfile) else emptyList()
        return ClasspathAnalysis(
            tuple = MavenTuple(
                if (hasLockfile) "gradle.lockfile" else "none",
                catalogTuple(projectDir),
            ),
            activeProfiles = listOf("compileClasspath", "testCompileClasspath"),
            repositoryPolicy = RepositoryPolicy(
                offline = true,
                descriptorRepositoriesIgnored = true,
                targetRepositoriesDiscarded = true,
                approvedRemoteId = CacheOnlyClasspathWorker.CENTRAL_ID,
                approvedRemoteUrl = CacheOnlyClasspathWorker.CENTRAL_URL,
            ),
            mainClasspath = classpath(entries, "compileClasspath", repo),
            testClasspath = classpath(entries, "testCompileClasspath", repo),
            testSourceRoots = testSourceRoots(projectDir),
            missClasses = missClasses(projectDir, hasLockfile),
        )
    }

    private fun classpath(entries: List<LockedModule>, configuration: String, repo: Path): List<String> =
        entries.mapNotNull { entry ->
            if (configuration !in entry.configurations) return@mapNotNull null
            val dir = repo.resolve(entry.group.replace('.', '/'))
                .resolve(entry.name)
                .resolve(entry.version)
            val jar = dir.resolve("${entry.name}-${entry.version}.jar")
            if (Files.isRegularFile(jar)) {
                return@mapNotNull repo.relativize(jar).toString().replace('\\', '/')
            }
            val pom = dir.resolve("${entry.name}-${entry.version}.pom")
            if (Files.isRegularFile(pom) && isPomPackaging(pom)) return@mapNotNull null
            throw MissingLockedArtifactException(
                "Locked artifact ${entry.group}:${entry.name}:${entry.version} is not in the cache",
            )
        }

    private fun parseLockfile(lockfile: Path): List<LockedModule> =
        Files.readAllLines(lockfile).mapNotNull { raw ->
            val line = raw.trim()
            if (line.isEmpty() || line.startsWith("#") || line.startsWith("empty=")) return@mapNotNull null
            val sep = line.indexOf('=')
            if (sep <= 0) return@mapNotNull null
            val coordinates = line.substring(0, sep).split(':')
            if (coordinates.size != 3) return@mapNotNull null
            LockedModule(
                group = coordinates[0],
                name = coordinates[1],
                version = coordinates[2],
                configurations = line.substring(sep + 1).split(',').filter { it.isNotEmpty() }.toSet(),
            )
        }

    private fun missClasses(projectDir: Path, hasLockfile: Boolean): List<String> {
        val misses = mutableListOf<String>()
        if (!hasLockfile) misses += "missing-lockfile"
        val settings = settingsText(projectDir)
        if (INCLUDED_BUILD.containsMatchIn(settings)) misses += "included-builds"
        if (UNPUBLISHED_CATALOG.containsMatchIn(settings)) misses += "unpublished-catalogs"
        if (!hasLockfile && catalogHasDynamicVersions(projectDir.resolve("gradle/libs.versions.toml"))) {
            misses += "dynamic-versions"
        }
        return misses
    }

    private fun settingsText(projectDir: Path): String = buildString {
        for (name in listOf("settings.gradle.kts", "settings.gradle")) {
            val file = projectDir.resolve(name)
            if (Files.isRegularFile(file)) append(Files.readString(file))
        }
    }

    private fun catalogHasDynamicVersions(catalog: Path): Boolean {
        if (!Files.isRegularFile(catalog)) return false
        var section = ""
        for (raw in Files.readAllLines(catalog)) {
            val line = raw.trim()
            if (line.startsWith("[")) {
                section = line.trim('[', ']').substringBefore('.')
                continue
            }
            if (line.isEmpty() || line.startsWith("#")) continue
            val versions = mutableListOf<String>()
            if (section == "versions") {
                QUOTED.findAll(line).mapTo(versions) { it.groupValues[1] }
            }
            VERSION_LITERAL.find(line)?.groupValues?.get(1)?.let { versions += it }
            SHORTHAND_VERSION.find(line)?.groupValues?.get(1)?.let { versions += it }
            STRICT_VERSION.find(line)?.groupValues?.get(1)?.let { versions += it }
            if (versions.any { isDynamic(it) }) return true
        }
        return false
    }

    private fun isDynamic(version: String): Boolean =
        '+' in version ||
            version.startsWith("latest.") ||
            version.startsWith("[") ||
            version.startsWith("(")

    private fun catalogTuple(projectDir: Path): String =
        if (Files.isRegularFile(projectDir.resolve("gradle/libs.versions.toml"))) "libs.versions.toml" else "none"

    private fun testSourceRoots(projectDir: Path): List<String> {
        val roots = mutableListOf<String>()
        for (candidate in listOf("src/test/java", "src/test/kotlin")) {
            if (Files.isDirectory(projectDir.resolve(candidate))) roots += candidate
        }
        if (roots.isEmpty()) roots += "src/test/java"
        return roots
    }

    private fun isPomPackaging(pom: Path): Boolean =
        PACKAGING.find(Files.readString(pom))?.groupValues?.get(1) == "pom"

    private val INCLUDED_BUILD = Regex("""includeBuild\s*[\('"]""")
    private val UNPUBLISHED_CATALOG = Regex("""from\s*\(?\s*['"][^'"]+:[^'"]+:[^'"]+['"]""")
    private val VERSION_LITERAL = Regex("""\bversion\s*=\s*"([^"]+)"""")
    private val SHORTHAND_VERSION = Regex("""=\s*"[^"]+:[^"]+:([^"]+)"""")
    private val STRICT_VERSION = Regex("""\b(?:strictly|require|prefer)\s*=\s*"([^"]+)"""")
    private val QUOTED = Regex(""""([^"]+)"""")
    private val PACKAGING = Regex("""<packaging>\s*([^<]+)\s*</packaging>""")
}

private data class LockedModule(
    val group: String,
    val name: String,
    val version: String,
    val configurations: Set<String>,
)
