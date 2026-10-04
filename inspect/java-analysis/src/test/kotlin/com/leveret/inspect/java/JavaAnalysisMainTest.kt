package com.leveret.inspect.java

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class JavaAnalysisMainTest {
    private val gson = GsonBuilder().serializeNulls().create()

    private fun execute(request: Path, payload: Any): Pair<Int, JsonObject> {
        Files.writeString(request, if (payload is String) payload else gson.toJson(payload))
        val old = System.out
        val output = ByteArrayOutputStream()
        val code = try {
            System.setOut(PrintStream(output))
            JavaAnalysisMain.execute(arrayOf("--request", request.toString()))
        } finally {
            System.setOut(old)
        }
        val response = output.toString().lineSequence().filter { it.isNotBlank() }.last()
        return code to JsonParser.parseString(response).asJsonObject
    }

    @Test
    fun `malformed schema 2 command returns one structured error and does not initialize store`(@TempDir dir: Path) {
        val store = dir.resolve("store")
        val (code, json) = execute(dir.resolve("request.json"), mapOf(
            "schema" to 2, "kind" to "analyze", "store" to store.toString(),
            "input" to mapOf("kind" to "cache-only"),
        ))
        assertThat(code).isEqualTo(1)
        assertThat(json.get("ok").asBoolean).isFalse()
        assertThat(json.getAsJsonObject("error").get("code").asString).isEqualTo("invalid-input")
        assertThat(Files.exists(dir.resolve("store.mv.db"))).isFalse()
    }

    @Test
    fun `otherwise valid legacy schema 1 command has no compatibility path`(@TempDir dir: Path) {
        val snapshot = Files.createDirectories(dir.resolve("snapshot"))
        val main = Files.createDirectories(snapshot.resolve("src/main/java"))
        Files.createDirectories(snapshot.resolve("src/test/java"))
        Files.writeString(main.resolve("Pricing.java"), "class Pricing { static int price(int n) { return n; } }")
        Files.writeString(snapshot.resolve("gradle.lockfile"), "empty=compileClasspath,testCompileClasspath\n")
        val cache = Files.createDirectories(dir.resolve("cache"))
        val store = dir.resolve("store")
        val (code, json) = execute(dir.resolve("legacy.json"), mapOf(
            "schema" to 1, "kind" to "analyze", "store" to store.toString(),
            "snapshot" to snapshot.toString(), "pathRoot" to snapshot.toString(),
            "repositoryId" to "fixture", "revision" to "head", "javaLevel" to "21", "build" to "gradle",
            "mainRoots" to listOf("src/main/java"), "testRoots" to listOf("src/test/java"),
            "cache" to cache.toString(), "artifacts" to dir.resolve("artifacts").toString(),
            "skippedFiles" to emptyList<Any>(),
        ))
        assertThat(code).isEqualTo(1)
        assertThat(json.getAsJsonObject("error").get("code").asString).isEqualTo("invalid-input")
        assertThat(Files.exists(dir.resolve("store.mv.db"))).isFalse()
    }

    @Test
    fun `invalid JSON and null required fields fail as invalid input`(@TempDir dir: Path) {
        val request = dir.resolve("invalid.json")
        for (payload in listOf("""{"schema":2,"kind":""", """{"schema":2,"kind":null}""")) {
            val (code, json) = execute(request, payload)
            assertThat(code).isEqualTo(1)
            assertThat(json.getAsJsonObject("error").get("code").asString).isEqualTo("invalid-input")
        }
    }

    @Test
    fun `prepared input analyzes frozen sources without invoking a classpath resolver`(@TempDir dir: Path) {
        val sourceRoot = Files.createDirectories(dir.resolve("prepared/sources/main"))
        val artifactRoot = Files.createDirectories(dir.resolve("prepared/artifacts"))
        val source = sourceRoot.resolve("example/Pricing.java")
        Files.createDirectories(source.parent)
        Files.writeString(source, "package example; public class Pricing { public static int price(int n) { return n * 12; } }")
        Files.writeString(dir.resolve("pom.xml"), "<project><broken resolver input")
        val citation = mapOf("manifestSha256" to "a".repeat(64), "artifactId" to "pricing-output", "origin" to "materialized")
        val compiler = mapOf(
            "sourceLevel" to "21", "targetLevel" to "21", "encoding" to "UTF-8", "preview" to false,
            "release" to mapOf("state" to "unset", "value" to null),
            "platform" to JavaCompilationEnvironment.workerPlatform(), "usedModuleOptions" to emptyList<String>(),
        )
        val compilation = mapOf(
            "id" to "prod", "resolutionDomain" to "build:fixture:prod", "sourceSet" to "main",
            "files" to listOf(mapOf(
                "physicalPath" to source.toString(), "displayPath" to "build/generated/example/Pricing.java",
                "encoding" to "UTF-8", "buildArtifact" to citation,
            )),
            "roots" to listOf(sourceRoot.toString()), "sourcePath" to listOf(sourceRoot.toString()),
            "classpath" to emptyList<String>(), "compiler" to compiler, "origins" to emptyList<Any>(),
        )
        val input = mapOf(
            "kind" to "prepared", "repositoryId" to "fixture", "revision" to "head",
            "pathRoot" to dir.resolve("prepared").toString(), "artifactRoot" to artifactRoot.toString(),
            "compilations" to listOf(compilation), "skippedFiles" to emptyList<Any>(),
            "diagnostics" to emptyList<String>(), "buildIdentity" to "build-evidence:fixture",
        )
        val (code, json) = execute(dir.resolve("prepared.json"), mapOf(
            "schema" to 2, "kind" to "analyze", "store" to dir.resolve("facts").toString(), "input" to input,
        ))
        assertThat(code).isEqualTo(0)
        assertThat(json.get("ok").asBoolean).isTrue()
        val summary = json.getAsJsonObject("result").getAsJsonObject("summary")
        assertThat(summary.get("revision").asString).isEqualTo("head")
        assertThat(summary.getAsJsonObject("coverage").get("mainExamined").asInt).isEqualTo(1)
    }

    @Test
    fun `wrong typed target provenance is invalid input and does not initialize store`(@TempDir dir: Path) {
        val request = dir.resolve("wrong-provenance.json")
        val store = dir.resolve("facts")
        for (buildArtifact in listOf("0", "[]", "\"artifact\"", "true")) {
            val payload = """
                {
                  "schema": 2,
                  "kind": "references",
                  "store": "$store",
                  "request": {
                    "analysisId": "analysis",
                    "configurationSha256": "configuration",
                    "manifest": {
                      "schema": 1,
                      "base": "head",
                      "head": "head",
                      "files": [],
                      "truncated": false,
                      "errors": []
                    },
                    "side": "head",
                    "target": {
                      "path": "Pricing.java",
                      "position": { "line": 1, "column": 1 },
                      "buildArtifact": $buildArtifact
                    },
                    "referenceScope": "outside-diff",
                    "byteBudget": 65536,
                    "cursor": null
                  }
                }
            """.trimIndent()
            val (code, json) = execute(request, payload)
            assertThat(code).isEqualTo(1)
            assertThat(json.getAsJsonObject("error").get("code").asString)
                .describedAs("buildArtifact=$buildArtifact").isEqualTo("invalid-input")
            assertThat(Files.exists(dir.resolve("facts.mv.db"))).isFalse()
        }
    }
}
