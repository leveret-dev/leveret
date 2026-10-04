package com.leveret.inspect.java

import com.leveret.inspect.classpath.ClasspathAnalysis
import java.nio.file.Path
import org.eclipse.jdt.core.JavaCore

data class Position(val line: Int, val column: Int)
data class Range(val start: Position, val end: Position)
/** Identity of an exported build artifact; the manifest hash plus artifact id pin the exact immutable bytes. */
data class BuildArtifactCitation(val manifestSha256: String, val artifactId: String, val origin: String)
data class Location(val path: String, val range: Range, val buildArtifact: BuildArtifactCitation? = null)
data class JavaMethod(
    val id: String,
    val bindingKey: String,
    val signature: String,
    val location: Location,
    val nameRange: Range,
    val sourceSet: String,
)
data class JavaReference(
    val id: String,
    val targetId: String,
    val location: Location,
    val enclosing: JavaMethod?,
    val sourceSet: String,
    val kind: String,
    val basis: String = "checked",
    val diffStatus: String? = null,
)
data class UnresolvedCandidate(val targetId: String, val basis: String)
data class UnresolvedSite(
    val id: String,
    val location: Location,
    val sourceSet: String,
    val reason: String,
    val candidates: List<UnresolvedCandidate>? = null,
)
data class SourceFile(val path: String, val sourceSet: String, val examined: Boolean, val reason: String? = null)
data class AnalysisCoverage(
    val complete: Boolean,
    val mainExamined: Int,
    val testExamined: Int,
    val mainSkipped: Int,
    val testSkipped: Int,
    val mainUnresolved: Int,
    val testUnresolved: Int,
    val diagnosticCount: Int,
)
data class AnalysisIdentity(val analysisId: String, val configurationSha256: String)
data class AnalysisData(
    val summary: AnalysisSummary,
    val methods: List<JavaMethod>,
    val references: List<JavaReference>,
    val unresolved: List<UnresolvedSite>,
    val files: List<SourceFile>,
    val diagnostics: List<String>,
) {
    val coverage get() = summary.coverage
}
data class AnalysisSummary(
    val analysisId: String,
    val repositoryId: String,
    val revision: String,
    val configurationSha256: String,
    val coverage: AnalysisCoverage,
)
/** One Java source: [physicalPath] is what the compiler reads, [displayPath] is what facts report. */
data class JavaSourceInput(val physicalPath: Path, val displayPath: String, val encoding: String, val buildArtifact: BuildArtifactCitation?)
/** Verified origin of a compiler path entry. [ownerCompilationId] names the compilation whose sources produced a binary entry. */
data class JavaOrigin(val path: Path, val artifact: BuildArtifactCitation?, val ownerCompilationId: String?)
data class JavaCompilationInput(
    val id: String,
    val resolutionDomain: String,
    val sourceSet: String,
    val files: List<JavaSourceInput>,
    val roots: List<Path>,
    val sourcePath: List<Path>,
    val classpath: List<Path>,
    val compiler: JavaCompilationEnvironment,
    val origins: List<JavaOrigin>,
)
data class JavaAnalysisInput(
    val repositoryId: String,
    val revision: String,
    val pathRoot: Path,
    val artifactRoot: Path,
    val compilations: List<JavaCompilationInput>,
    val skippedFiles: List<SourceFile>,
    val diagnostics: List<String>,
    val buildIdentity: String,
) {
    companion object {
        /** Declarations of the cache-only adapter share one domain: a main/test name clash stays ambiguous. */
        const val CACHE_ONLY_DOMAIN = "shared-module"

        /** Normalizes the cache-only main/test layout without changing its source-path or classpath semantics. */
        fun cacheOnly(
            repositoryId: String, revision: String, pathRoot: Path, mainFiles: List<Path>, testFiles: List<Path>,
            mainRoots: List<Path>, testRoots: List<Path>, javaLevel: String, classpath: ClasspathAnalysis,
            artifactRoot: Path, skippedFiles: List<SourceFile> = emptyList(),
        ): JavaAnalysisInput {
            require(JavaCore.isSupportedJavaVersion(javaLevel)) { "Unsupported Java level $javaLevel" }
            val root = pathRoot.toRealPath()
            val artifacts = artifactRoot.toAbsolutePath().normalize()
            val compiler = JavaCompilationEnvironment.legacy(javaLevel)
            fun files(paths: List<Path>) = paths.map { JavaSourceInput(it, JavaAnalysisIdentity.relative(root, it), "UTF-8", null) }
            fun entries(names: List<String>) = names.map { artifacts.resolve(it).normalize() }
            val compilations = listOfNotNull(
                if (mainFiles.isEmpty()) null else JavaCompilationInput(
                    "main", CACHE_ONLY_DOMAIN, "main", files(mainFiles), mainRoots, mainRoots,
                    entries(classpath.mainClasspath), compiler, emptyList(),
                ),
                if (testFiles.isEmpty()) null else JavaCompilationInput(
                    "test", CACHE_ONLY_DOMAIN, "test", files(testFiles), testRoots, mainRoots + testRoots,
                    entries((classpath.mainClasspath + classpath.testClasspath).distinct()), compiler, emptyList(),
                ),
            )
            return JavaAnalysisInput(
                repositoryId, revision, pathRoot, artifactRoot, compilations, skippedFiles,
                classpath.diagnostics.map { "${it.sourceSet ?: "all"}: ${it.reason}: ${it.message}" },
                "cache-only:" + classpath.write(),
            )
        }
    }
}
