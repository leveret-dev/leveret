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

}
