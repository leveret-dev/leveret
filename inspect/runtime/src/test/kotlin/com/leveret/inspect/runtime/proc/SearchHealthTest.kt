package com.leveret.inspect.runtime.proc

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Duration
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class SearchHealthTest {
    private fun server(body: String): HttpServer =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/") { exchange ->
                val bytes = body.toByteArray()
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            start()
        }

    @Test
    fun `yellow and green are operational, red is not`() {
        listOf("yellow" to SearchHealth.Status.YELLOW, "green" to SearchHealth.Status.GREEN, "red" to SearchHealth.Status.RED)
            .forEach { (reported, expected) ->
                val http = server("""{"status":"$reported"}""")
                try {
                    val health = HttpSearchHealth("127.0.0.1", http.address.port, Duration.ofMillis(1), 2)
                    assertThat(health.status()).isEqualTo(expected)
                } finally {
                    http.stop(0)
                }
            }
    }

    @Test
    fun `refused connection is retried then reported unavailable`() {
        val closed = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val port = closed.address.port
        closed.stop(0)
        val health = HttpSearchHealth("127.0.0.1", port, Duration.ofMillis(1), 3)
        assertThat(health.status()).isEqualTo(SearchHealth.Status.UNAVAILABLE)
    }
}
