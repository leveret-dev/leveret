package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import kotlin.io.path.exists
import kotlin.io.path.readText

internal data class OracleSubject(
    val name: String,
    val pom: Path,
    val localRepo: Path,
    val mainOracle: List<String>,
    val testOracle: List<String>,
)

internal object OracleHarness {
    private val cacheRoot: Path =
        Path.of(
            System.getenv("LEVERET_ORACLE_CACHE")
                ?: "/tmp/leveret-oracle",
        )

    val commonsLang: OracleSubject by lazy {
        provision(
            name = "commons-lang",
            url = "https://github.com/apache/commons-lang.git",
            revision = "620f4ff4b4b0934e6dc46465fe5c92fd7e1fb997",
            existingCheckout = Path.of("/tmp/leveret-oracle-subjects/commons-lang"),
            existingRepo = Path.of("/tmp/leveret-oracle-repos/commons-lang"),
        )
    }

    val jacksonDatabind: OracleSubject by lazy {
        provision(
            name = "jackson-databind",
            url = "https://github.com/FasterXML/jackson-databind.git",
            revision = "jackson-databind-2.20.0",
            existingCheckout = Path.of("/tmp/leveret-oracle-subjects/jackson-databind"),
            existingRepo = Path.of("/tmp/leveret-oracle-repos/jackson"),
        )
    }

    fun analyzeIsolated(pom: Path, localRepo: Path): ClasspathAnalysis {
        val work = Files.createTempDirectory("classpath-worker")
        val output = work.resolve("analysis.txt")
        val javaHome = Path.of(System.getProperty("java.home"))
        val javaBin = javaHome.resolve("bin/java").toString()
        val command =
            listOf(
                "bwrap",
                "--unshare-net",
                "--die-with-parent",
                "--ro-bind", "/", "/",
                "--dev", "/dev",
                "--proc", "/proc",
                "--bind", work.toString(), work.toString(),
                "--setenv", "PATH", javaHome.resolve("bin").toString(),
                "--setenv", "HOME", work.toString(),
                "--setenv", "JAVA_HOME", javaHome.toString(),
                javaBin,
                "-XX:-UsePerfData",
                "-Djava.io.tmpdir=${work}",
                "-cp",
                System.getProperty("java.class.path"),
                "com.leveret.inspect.classpath.WorkerMain",
                "--pom",
                pom.toAbsolutePath().toString(),
                "--local-repo",
                localRepo.toAbsolutePath().toString(),
                "--output",
                output.toString(),
            )
        val process =
            ProcessBuilder(command)
                .redirectErrorStream(true)
                .start()
        val finished = process.waitFor(3, TimeUnit.MINUTES)
        val log = process.inputStream.bufferedReader().readText()
        check(finished) { "isolated worker timed out\n$log" }
        check(process.exitValue() == 0) { "isolated worker failed (${process.exitValue()})\n$log" }
        return ClasspathAnalysis.read(output.readText())
    }

    private fun provision(
        name: String,
        url: String,
        revision: String,
        existingCheckout: Path,
        existingRepo: Path,
    ): OracleSubject {
        val checkout =
            when {
                existingCheckout.resolve("pom.xml").exists() -> existingCheckout
                else -> checkout(cacheRoot.resolve("subjects/$name"), url, revision)
            }
        val localRepo =
            when {
                existingRepo.resolve("oracle-compile.txt").exists() -> existingRepo
                else -> fillRepo(cacheRoot.resolve("repos/$name"), checkout)
            }
        return OracleSubject(
            name = name,
            pom = checkout.resolve("pom.xml"),
            localRepo = localRepo,
            mainOracle = relativeOracle(localRepo, localRepo.resolve("oracle-compile.txt")),
            testOracle = relativeOracle(localRepo, localRepo.resolve("oracle-test.txt")),
        )
    }

    private fun checkout(dir: Path, url: String, revision: String): Path {
        if (!dir.resolve(".git").exists()) {
            Files.createDirectories(dir.parent)
            run(listOf("git", "clone", "--filter=blob:none", url, dir.toString()), dir.parent)
        }
        run(listOf("git", "checkout", "--detach", revision), dir)
        return dir
    }

    private fun fillRepo(localRepo: Path, project: Path): Path {
        Files.createDirectories(localRepo)
        val settings = localRepo.resolve("empty-settings.xml")
        Files.writeString(settings, "<settings/>\n")
        for (scope in listOf("compile", "test")) {
            run(
                listOf(
                    "mvn",
                    "-s", settings.toString(),
                    "-gs", settings.toString(),
                    "-Dmaven.repo.local=$localRepo",
                    "-DskipTests",
                    "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath",
                    "-DincludeScope=$scope",
                    "-Dmdep.pathSeparator=\n",
                    "-Dmdep.outputFile=${localRepo.resolve("oracle-$scope.txt")}",
                    "-q",
                ),
                project,
            )
        }
        return localRepo
    }

    private fun relativeOracle(localRepo: Path, file: Path): List<String> {
        val prefix = localRepo.toAbsolutePath().normalize().toString().trimEnd('/') + "/"
        return file.readText().split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map { absolute ->
            val normalized = Path.of(absolute).toAbsolutePath().normalize().toString()
            check(normalized.startsWith(prefix)) { "oracle path $normalized is outside $prefix" }
            normalized.substring(prefix.length)
        }
    }

    private fun run(command: List<String>, cwd: Path) {
        val process =
            ProcessBuilder(command)
                .directory(cwd.toFile())
                .redirectErrorStream(true)
                .start()
        val finished = process.waitFor(10, TimeUnit.MINUTES)
        val log = process.inputStream.bufferedReader().readText()
        check(finished) { "timed out: $command\n$log" }
        check(process.exitValue() == 0) { "failed (${process.exitValue()}): $command\n$log" }
    }
}
