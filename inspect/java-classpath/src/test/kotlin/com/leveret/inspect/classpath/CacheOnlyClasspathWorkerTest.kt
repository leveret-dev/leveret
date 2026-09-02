package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.io.TempDir

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class CacheOnlyClasspathWorkerTest {
    @Test
    fun `records the Maven 3 tuple and cache-only policy`(@TempDir dir: Path) {
        val pom = writePom(
            dir,
            """
            <project>
              <modelVersion>4.0.0</modelVersion>
              <groupId>t</groupId>
              <artifactId>bare</artifactId>
              <version>1.0</version>
            </project>
            """.trimIndent(),
        )
        val analysis = CacheOnlyClasspathWorker.analyze(pom, dir.resolve("repo"))
        assertThat(analysis.tuple).isEqualTo(MavenTuple("3.9.16", "1.9.27"))
        assertThat(analysis.repositoryPolicy.offline).isTrue()
        assertThat(analysis.repositoryPolicy.descriptorRepositoriesIgnored).isTrue()
        assertThat(analysis.repositoryPolicy.targetRepositoriesDiscarded).isTrue()
        assertThat(analysis.repositoryPolicy.approvedRemoteId).isEqualTo("central")
        assertThat(analysis.mainClasspath).isEmpty()
        assertThat(analysis.testClasspath).isEmpty()
        assertThat(analysis.testSourceRoots).contains("src/test/java")
    }

    @Test
    fun `rejects an unbounded parent version range`(@TempDir dir: Path) {
        val pom = writePom(
            dir,
            """
            <project>
              <modelVersion>4.0.0</modelVersion>
              <parent>
                <groupId>t</groupId>
                <artifactId>parent</artifactId>
                <version>[1.0,)</version>
              </parent>
              <artifactId>child</artifactId>
              <version>1.0</version>
            </project>
            """.trimIndent(),
        )
        assertThatThrownBy { CacheOnlyClasspathWorker.analyze(pom, dir.resolve("repo")) }
            .isInstanceOf(UnboundedVersionRangeException::class.java)
            .hasMessageContaining("does not specify an upper bound")
    }

    @Test
    fun `resolves a bounded parent version range from the local cache`(@TempDir dir: Path) {
        val repo = dir.resolve("repo")
        installPom(repo, "t", "parent", "1.0", "<groupId>t</groupId><artifactId>parent</artifactId><version>1.0</version><packaging>pom</packaging>")
        installPom(repo, "t", "parent", "1.1", "<groupId>t</groupId><artifactId>parent</artifactId><version>1.1</version><packaging>pom</packaging>")
        writeMetadata(repo, "t", "parent", listOf("1.0", "1.1"))
        val pom = writePom(
            dir,
            """
            <project>
              <modelVersion>4.0.0</modelVersion>
              <parent>
                <groupId>t</groupId>
                <artifactId>parent</artifactId>
                <version>[1.0,1.2]</version>
              </parent>
              <artifactId>child</artifactId>
              <version>1.0</version>
            </project>
            """.trimIndent(),
        )
        val analysis = CacheOnlyClasspathWorker.analyze(pom, repo)
        assertThat(analysis.mainClasspath).isEmpty()
        assertThat(analysis.testClasspath).isEmpty()
    }

    @Test
    fun `commons lang main classpath matches the isolated Maven oracle`() {
        val subject = OracleHarness.commonsLang
        val analysis = OracleHarness.analyzeIsolated(subject.pom, subject.localRepo)
        assertRecorded(analysis)
        assertThat(analysis.mainClasspath).hasSize(4).containsExactlyElementsOf(subject.mainOracle)
    }

    @Test
    fun `commons lang test classpath matches the isolated Maven oracle`() {
        val subject = OracleHarness.commonsLang
        val analysis = OracleHarness.analyzeIsolated(subject.pom, subject.localRepo)
        assertRecorded(analysis)
        assertThat(analysis.testClasspath).hasSize(23).containsExactlyElementsOf(subject.testOracle)
    }

    @Test
    fun `jackson databind main classpath matches the isolated Maven oracle`() {
        val subject = OracleHarness.jacksonDatabind
        val analysis = OracleHarness.analyzeIsolated(subject.pom, subject.localRepo)
        assertRecorded(analysis)
        assertThat(analysis.mainClasspath).hasSize(2).containsExactlyElementsOf(subject.mainOracle)
    }

    @Test
    fun `jackson databind test classpath and profile test roots match the isolated Maven oracle`() {
        val subject = OracleHarness.jacksonDatabind
        val analysis = OracleHarness.analyzeIsolated(subject.pom, subject.localRepo)
        assertRecorded(analysis)
        assertThat(analysis.testClasspath).hasSize(38).containsExactlyElementsOf(subject.testOracle)
        assertThat(analysis.activeProfiles).contains("java21")
        assertThat(analysis.testSourceRoots).contains(
            "src/test/java",
            "src/test-jdk11/java",
            "src/test-jdk17/java",
            "src/test-jdk21/java",
        )
    }

    private fun assertRecorded(analysis: ClasspathAnalysis) {
        assertThat(analysis.tuple).isEqualTo(MavenTuple("3.9.16", "1.9.27"))
        assertThat(analysis.repositoryPolicy.offline).isTrue()
        assertThat(analysis.repositoryPolicy.descriptorRepositoriesIgnored).isTrue()
        assertThat(analysis.repositoryPolicy.targetRepositoriesDiscarded).isTrue()
        assertThat(analysis.repositoryPolicy.approvedRemoteId).isEqualTo("central")
    }

    private fun writePom(dir: Path, body: String): Path {
        val pom = dir.resolve("pom.xml")
        Files.writeString(pom, body)
        return pom
    }

    private fun installPom(repo: Path, group: String, artifact: String, version: String, inner: String) {
        val dir = repo.resolve(group.replace('.', '/')).resolve(artifact).resolve(version)
        Files.createDirectories(dir)
        Files.writeString(
            dir.resolve("$artifact-$version.pom"),
            """
            <project>
              <modelVersion>4.0.0</modelVersion>
              $inner
            </project>
            """.trimIndent(),
        )
        Files.writeString(dir.resolve("_remote.repositories"), "pom>central=\n")
    }

    private fun writeMetadata(repo: Path, group: String, artifact: String, versions: List<String>) {
        val dir = repo.resolve(group.replace('.', '/')).resolve(artifact)
        Files.createDirectories(dir)
        val versionsXml = versions.joinToString("\n") { "      <version>$it</version>" }
        Files.writeString(
            dir.resolve("maven-metadata-central.xml"),
            """
            <metadata>
              <groupId>$group</groupId>
              <artifactId>$artifact</artifactId>
              <versioning>
                <latest>${versions.last()}</latest>
                <release>${versions.last()}</release>
                <versions>
            $versionsXml
                </versions>
              </versioning>
            </metadata>
            """.trimIndent(),
        )
        Files.writeString(dir.resolve("_remote.repositories"), "pom>central=\n")
    }
}
