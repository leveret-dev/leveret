package com.leveret.inspect.java

import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class JavaAnalysisMainTest {
    @Test
    fun `malformed command returns one structured error and does not initialize store`(@TempDir dir: Path) {
        val request = dir.resolve("request.json")
        Files.writeString(request, """{"schema":1,"kind":"analyze","store":"${dir.resolve("store")}"}""")
        val old = System.out
        val output = java.io.ByteArrayOutputStream()
        try {
            System.setOut(java.io.PrintStream(output))
            assertThat(JavaAnalysisMain.execute(arrayOf("--request", request.toString()))).isEqualTo(1)
        } finally {
            System.setOut(old)
        }
        val json = com.google.gson.JsonParser.parseString(output.toString()).asJsonObject
        assertThat(json.get("ok").asBoolean).isFalse()
        assertThat(json.getAsJsonObject("error").get("code").asString).isEqualTo("invalid-input")
        assertThat(Files.exists(dir.resolve("store.mv.db"))).isFalse()
    }
    @Test
    fun `invalid JSON and null required fields fail as invalid input`(@TempDir dir: Path) {
        val request = dir.resolve("invalid.json")
        for (payload in listOf("""{"schema":1,"kind":""", """{"schema":1,"kind":null}""")) {
            Files.writeString(request, payload)
            val old = System.out
            val output = java.io.ByteArrayOutputStream()
            try {
                System.setOut(java.io.PrintStream(output))
                assertThat(JavaAnalysisMain.execute(arrayOf("--request", request.toString()))).isEqualTo(1)
            } finally {
                System.setOut(old)
            }
            val json = com.google.gson.JsonParser.parseString(output.toString()).asJsonObject
            assertThat(json.getAsJsonObject("error").get("code").asString).isEqualTo("invalid-input")
        }
    }

    @Test
    fun `wrong typed target provenance is invalid input and does not initialize store`(@TempDir dir: Path) {
        val request = dir.resolve("wrong-provenance.json")
        val store = dir.resolve("facts")
        for (buildArtifact in listOf("0", "[]", "\"artifact\"", "true")) {
            Files.writeString(request, """
                {
                  "schema": 1,
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
            """.trimIndent())
            val old = System.out
            val output = java.io.ByteArrayOutputStream()
            try {
                System.setOut(java.io.PrintStream(output))
                assertThat(JavaAnalysisMain.execute(arrayOf("--request", request.toString()))).isEqualTo(1)
            } finally {
                System.setOut(old)
            }
            val json = com.google.gson.JsonParser.parseString(output.toString()).asJsonObject
            assertThat(json.getAsJsonObject("error").get("code").asString)
                .describedAs("buildArtifact=$buildArtifact").isEqualTo("invalid-input")
            assertThat(Files.exists(dir.resolve("facts.mv.db"))).isFalse()
        }
    }


}
