package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.TimeUnit
import kotlin.io.path.exists
import kotlin.io.path.readText

internal data class GradleOracleSubject(
    val name: String,
    val project: Path,
    val localRepo: Path,
    val mainOracle: List<String>,
    val testOracle: List<String>,
)

internal object GradleOracleHarness {
    private val cacheRoot: Path =
        Path.of(System.getenv("LEVERET_ORACLE_CACHE") ?: "/tmp/leveret-oracle")

    val datadogWorkshop: GradleOracleSubject by lazy {
        provision(
            name = "vulnerable-java-application",
            url = "https://github.com/DataDog/vulnerable-java-application.git",
            revision = "e33ebdd5e719fe768abd9c9db88bc8fcc84e9dad",
            existingCheckout = Path.of("/tmp/leveret-oracle-subjects/vulnerable-java-application"),
            existingRepo = Path.of("/tmp/leveret-oracle-repos/vulnerable-java-application"),
        )
    }

    fun analyzeIsolated(project: Path, localRepo: Path): ClasspathAnalysis {
        val work = Files.createTempDirectory("gradle-classpath-worker")
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
                "-Djava.io.tmpdir=$work",
                "-cp",
                System.getProperty("java.class.path"),
                "com.leveret.inspect.classpath.WorkerMain",
                "--project",
                project.toAbsolutePath().toString(),
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
    ): GradleOracleSubject {
        val checkout =
            when {
                existingCheckout.resolve("gradle.lockfile").exists() -> existingCheckout
                else -> checkout(cacheRoot.resolve("subjects/$name"), url, revision)
            }
        if (checkout.resolve(".git").exists()) {
            run(listOf("git", "checkout", "--detach", revision), checkout)
        }
        val localRepo =
            when {
                existingRepo.resolve("oracle-compile.txt").exists() && existingRepo.resolve("m2").exists() ->
                    existingRepo
                else -> fillRepo(existingRepo.takeIf { it.exists() } ?: cacheRoot.resolve("repos/$name"), checkout)
            }
        val mavenRepo = localRepo.resolve("m2")
        return GradleOracleSubject(
            name = name,
            project = checkout,
            localRepo = mavenRepo,
            mainOracle = relativeOracle(localRepo.resolve("oracle-compile.txt")),
            testOracle = relativeOracle(localRepo.resolve("oracle-test.txt")),
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
        val gradleHome = localRepo.resolve("gradle-home")
        Files.createDirectories(gradleHome)
        val init = localRepo.resolve("oracle-init.gradle")
        Files.writeString(
            init,
            """
            gradle.beforeProject { project ->
                project.pluginManager.withPlugin('java') {
                    project.tasks.register('leveretOracleClasspath') {
                        doLast {
                            def dir = new File(System.getProperty('leveret.oracle.dir'))
                            dir.mkdirs()
                            def compile = project.configurations.getByName('compileClasspath')
                            def testCompile = project.configurations.getByName('testCompileClasspath')
                            new File(dir, 'oracle-compile.txt').text = compile.resolve().findAll { it.name.endsWith('.jar') }.collect { it.absolutePath }.join('\n') + '\n'
                            new File(dir, 'oracle-test.txt').text = testCompile.resolve().findAll { it.name.endsWith('.jar') }.collect { it.absolutePath }.join('\n') + '\n'
                        }
                    }
                }
            }
            """.trimIndent() + "\n",
        )
        val javaHome = oracleJava21()
        run(
            listOf(
                project.resolve("gradlew").toAbsolutePath().toString(),
                "--no-daemon",
                "--no-build-cache",
                "--gradle-user-home",
                gradleHome.toAbsolutePath().toString(),
                "-I",
                init.toAbsolutePath().toString(),
                "leveretOracleClasspath",
                "-Dleveret.oracle.dir=${localRepo.toAbsolutePath()}",
            ),
            project,
            mapOf(
                "JAVA_HOME" to javaHome.toString(),
                "PATH" to "${javaHome.resolve("bin")}:/usr/bin:/bin",
            ),
        )
        copyGradleCache(gradleHome, localRepo.resolve("m2"))
        return localRepo
    }

    private fun copyGradleCache(gradleHome: Path, mavenRepo: Path) {
        val files = gradleHome.resolve("caches/modules-2/files-2.1")
        check(Files.isDirectory(files)) { "gradle module cache missing at $files" }
        Files.walk(files).use { stream ->
            stream.filter { Files.isRegularFile(it) }.forEach { src ->
                val name = src.fileName.toString()
                if (!name.endsWith(".jar") && !name.endsWith(".pom")) return@forEach
                val dest = mavenRepo.resolve(gradleCacheToMaven(src))
                Files.createDirectories(dest.parent)
                if (!Files.exists(dest)) {
                    Files.copy(src, dest, StandardCopyOption.REPLACE_EXISTING)
                }
            }
        }
    }

    private fun relativeOracle(file: Path): List<String> =
        file.readText().split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map { gradleCacheToMaven(Path.of(it)) }

    private fun gradleCacheToMaven(path: Path): String {
        val normalized = path.toAbsolutePath().normalize().toString()
        val marker = "/files-2.1/"
        val index = normalized.indexOf(marker)
        check(index >= 0) { "oracle path $normalized is not a Gradle module cache file" }
        val parts = normalized.substring(index + marker.length).split('/')
        check(parts.size >= 5) { "oracle path $normalized is not group/name/version/hash/file" }
        val group = parts[0].replace('.', '/')
        return "$group/${parts[1]}/${parts[2]}/${parts[4]}"
    }

    private fun oracleJava21(): Path {
        val env = System.getenv("LEVERET_ORACLE_JAVA21")
        if (!env.isNullOrBlank()) return Path.of(env)
        val sdk = Path.of(System.getProperty("user.home"), ".sdkman/candidates/java/21.0.12-tem")
        check(Files.isDirectory(sdk)) {
            "JDK 21 is required for the Gradle oracle; set LEVERET_ORACLE_JAVA21"
        }
        return sdk
    }

    private fun run(command: List<String>, cwd: Path, env: Map<String, String> = emptyMap()) {
        val builder =
            ProcessBuilder(command)
                .directory(cwd.toFile())
                .redirectErrorStream(true)
        builder.environment().putAll(env)
        val process = builder.start()
        val finished = process.waitFor(10, TimeUnit.MINUTES)
        val log = process.inputStream.bufferedReader().readText()
        check(finished) { "timed out: $command\n$log" }
        check(process.exitValue() == 0) { "failed (${process.exitValue()}): $command\n$log" }
    }
}
