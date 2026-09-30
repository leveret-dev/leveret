package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class GradleLockfileClasspathWorkerTest {
    @Test
    fun `lockfile compile and test classpaths resolve from the cache`(@TempDir dir: Path) {
        Files.writeString(
            dir.resolve("gradle.lockfile"),
            """
            # This is a Gradle generated file for dependency locking.
            org.junit.jupiter:junit-jupiter-api:5.13.4=testCompileClasspath,testRuntimeClasspath
            org.slf4j:slf4j-api:2.0.17=compileClasspath,runtimeClasspath,testCompileClasspath,testRuntimeClasspath
            empty=annotationProcessor
            """.trimIndent() + "\n",
        )
        val repo = dir.resolve("repo")
        installJar(repo, "org.slf4j", "slf4j-api", "2.0.17")
        installJar(repo, "org.junit.jupiter", "junit-jupiter-api", "5.13.4")

        val analysis = GradleLockfileClasspathWorker.analyze(dir, repo)

        assertThat(analysis.mainClasspath).containsExactly("org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar")
        assertThat(analysis.testClasspath).containsExactly(
            "org/junit/jupiter/junit-jupiter-api/5.13.4/junit-jupiter-api-5.13.4.jar",
            "org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar",
        )
    }

    @Test
    fun `records lockfile tuple and cache-only policy`(@TempDir dir: Path) {
        Files.writeString(dir.resolve("gradle.lockfile"), "empty=compileClasspath,testCompileClasspath\n")
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.tuple).isEqualTo(MavenTuple("gradle.lockfile", "none"))
        assertThat(analysis.repositoryPolicy.offline).isTrue()
        assertThat(analysis.repositoryPolicy.descriptorRepositoriesIgnored).isTrue()
        assertThat(analysis.repositoryPolicy.targetRepositoriesDiscarded).isTrue()
        assertThat(analysis.repositoryPolicy.approvedRemoteId).isEqualTo("central")
        assertThat(analysis.mainClasspath).isEmpty()
        assertThat(analysis.testClasspath).isEmpty()
        assertThat(analysis.diagnostics).isEmpty()
    }

    @Test
    fun `omits pom-only locked modules from the classpath`(@TempDir dir: Path) {
        Files.writeString(
            dir.resolve("gradle.lockfile"),
            """
            com.fasterxml.jackson:jackson-bom:2.15.4=compileClasspath,testCompileClasspath
            org.slf4j:slf4j-api:2.0.17=compileClasspath,testCompileClasspath
            empty=
            """.trimIndent() + "\n",
        )
        val repo = dir.resolve("repo")
        installPom(repo, "com.fasterxml.jackson", "jackson-bom", "2.15.4")
        installJar(repo, "org.slf4j", "slf4j-api", "2.0.17")
        val analysis = GradleLockfileClasspathWorker.analyze(dir, repo)
        assertThat(analysis.mainClasspath).containsExactly("org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar")
        assertThat(analysis.testClasspath).containsExactly("org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar")
    }

    @Test
    fun `missing lockfile records the miss and leaves classpaths empty`(@TempDir dir: Path) {
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.tuple).isEqualTo(MavenTuple("none", "none"))
        assertThat(analysis.mainClasspath).isEmpty()
        assertThat(analysis.testClasspath).isEmpty()
        assertThat(analysis.diagnostics.map { it.reason }).containsExactly("missing-lockfile")
    }

    @Test
    fun `catalog without a lockfile records missing-lockfile and keeps declared coordinates off the classpath`(@TempDir dir: Path) {
        val catalog = dir.resolve("gradle/libs.versions.toml")
        Files.createDirectories(catalog.parent)
        Files.writeString(
            catalog,
            """
            [versions]
            slf4j = "2.0.17"
            [libraries]
            slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }
            """.trimIndent() + "\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.tuple).isEqualTo(MavenTuple("none", "libs.versions.toml"))
        assertThat(analysis.mainClasspath).isEmpty()
        assertThat(analysis.diagnostics.map { it.reason }).contains("missing-lockfile")
    }

    @Test
    fun `dynamic catalog versions are recorded when no lockfile pins them`(@TempDir dir: Path) {
        val catalog = dir.resolve("gradle/libs.versions.toml")
        Files.createDirectories(catalog.parent)
        Files.writeString(
            catalog,
            """
            [libraries]
            slf4j-api = { module = "org.slf4j:slf4j-api", version = "2.+" }
            """.trimIndent() + "\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.diagnostics.map { it.reason }).contains("missing-lockfile", "dynamic-versions")
    }

    @Test
    fun `dynamic versions in the catalog versions table are recorded`(@TempDir dir: Path) {
        val catalog = dir.resolve("gradle/libs.versions.toml")
        Files.createDirectories(catalog.parent)
        Files.writeString(
            catalog,
            """
            [versions]
            slf4j = "2.+"
            [libraries]
            slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }
            """.trimIndent() + "\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.diagnostics.map { it.reason }).contains("missing-lockfile", "dynamic-versions")
    }


    @Test
    fun `included builds and unpublished catalogs are recorded from settings text`(@TempDir dir: Path) {
        Files.writeString(dir.resolve("gradle.lockfile"), "empty=compileClasspath\n")
        Files.writeString(
            dir.resolve("settings.gradle.kts"),
            """
            includeBuild("plugin")
            dependencyResolutionManagement {
                versionCatalogs {
                    create("shared") {
                        from("com.example:catalog:1.0")
                    }
                }
            }
            """.trimIndent() + "\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.diagnostics.map { it.reason }).contains("included-builds", "unpublished-catalogs")
    }

    @Test
    fun `groovy settings record included builds and unpublished catalogs`(@TempDir dir: Path) {
        Files.writeString(dir.resolve("gradle.lockfile"), "empty=compileClasspath\n")
        Files.writeString(
            dir.resolve("settings.gradle"),
            """
            includeBuild 'plugin'
            dependencyResolutionManagement {
                versionCatalogs {
                    shared {
                        from 'com.example:catalog:1.0'
                    }
                }
            }
            """.trimIndent() + "\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.diagnostics.map { it.reason }).contains("included-builds", "unpublished-catalogs")
    }


    @Test
    fun `missing artifact preserves other locked entries in their scopes`(@TempDir dir: Path) {
        Files.writeString(
            dir.resolve("gradle.lockfile"),
            "t:present:1=compileClasspath,testCompileClasspath\n" +
                "t:absent:1=compileClasspath,testCompileClasspath\n" +
                "t:test-only:1=testCompileClasspath\n",
        )
        val repo = dir.resolve("repo")
        installJar(repo, "t", "present", "1")
        installJar(repo, "t", "test-only", "1")
        val analysis = GradleLockfileClasspathWorker.analyze(dir, repo)
        assertThat(analysis.mainClasspath).containsExactly("t/present/1/present-1.jar")
        assertThat(analysis.testClasspath).containsExactly(
            "t/present/1/present-1.jar",
            "t/test-only/1/test-only-1.jar",
        )
        assertThat(analysis.diagnostics.map { it.coordinate }).contains("t:absent:1")
        assertThat(analysis.complete).isFalse()
        assertThat(ClasspathAnalysis.read(analysis.write())).isEqualTo(analysis)
    }

    @Test
    fun `reports an absent locked jar as incomplete resolution`(@TempDir dir: Path) {
        Files.writeString(
            dir.resolve("gradle.lockfile"),
            "org.slf4j:slf4j-api:2.0.17=compileClasspath\n",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.complete).isFalse()
        assertThat(analysis.diagnostics.map { it.coordinate }).contains("org.slf4j:slf4j-api:2.0.17")
    }

    @Test
    fun `reports a missing jar when the cached pom is not pom packaging`(@TempDir dir: Path) {
        Files.writeString(
            dir.resolve("gradle.lockfile"),
            "org.slf4j:slf4j-api:2.0.17=compileClasspath\n",
        )
        installPom(
            dir.resolve("repo"),
            "org.slf4j",
            "slf4j-api",
            "2.0.17",
            "<groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.17</version>",
        )
        val analysis = GradleLockfileClasspathWorker.analyze(dir, dir.resolve("repo"))
        assertThat(analysis.complete).isFalse()
        assertThat(analysis.diagnostics.map { it.coordinate }).contains("org.slf4j:slf4j-api:2.0.17")
    }


    @Test
    fun `datadog workshop main classpath matches the isolated Gradle oracle`() {
        val subject = GradleOracleHarness.datadogWorkshop
        val analysis = GradleOracleHarness.analyzeIsolated(subject.project, subject.localRepo)
        assertThat(analysis.tuple).isEqualTo(MavenTuple("gradle.lockfile", "none"))
        assertThat(analysis.repositoryPolicy.offline).isTrue()
        assertThat(analysis.diagnostics).isEmpty()
        assertThat(analysis.mainClasspath).hasSize(36).containsExactlyInAnyOrderElementsOf(subject.mainOracle)
    }

    @Test
    fun `datadog workshop test classpath matches the isolated Gradle oracle`() {
        val subject = GradleOracleHarness.datadogWorkshop
        val analysis = GradleOracleHarness.analyzeIsolated(subject.project, subject.localRepo)
        assertThat(analysis.testClasspath).hasSize(61).containsExactlyInAnyOrderElementsOf(subject.testOracle)
    }


    private fun installJar(repo: Path, group: String, artifact: String, version: String) {
        val dir = repo.resolve(group.replace('.', '/')).resolve(artifact).resolve(version)
        Files.createDirectories(dir)
        Files.write(dir.resolve("$artifact-$version.jar"), byteArrayOf(0x50, 0x4B, 0x03, 0x04))
    }

    private fun installPom(
        repo: Path,
        group: String,
        artifact: String,
        version: String,
        inner: String = "<packaging>pom</packaging>",
    ) {
        val dir = repo.resolve(group.replace('.', '/')).resolve(artifact).resolve(version)
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("$artifact-$version.pom"), "<project>$inner</project>")
    }
}
