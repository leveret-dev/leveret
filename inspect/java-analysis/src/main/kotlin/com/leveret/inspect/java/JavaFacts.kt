package com.leveret.inspect.java

import com.leveret.inspect.classpath.ClasspathAnalysis
import java.nio.file.Path

data class Position(val line: Int, val column: Int)
data class Range(val start: Position, val end: Position)
data class Location(val path: String, val range: Range)
data class JavaMethod(
    val id: String,
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
data class JavaAnalysisInput(
    val repositoryId: String,
    val revision: String,
    val sourceRoot: Path,
    val mainFiles: List<Path>,
    val testFiles: List<Path>,
    val mainRoots: List<Path>,
    val testRoots: List<Path>,
    val javaLevel: String,
    val classpath: ClasspathAnalysis,
    val artifactRoot: Path,
    val skippedFiles: List<SourceFile> = emptyList(),
)
