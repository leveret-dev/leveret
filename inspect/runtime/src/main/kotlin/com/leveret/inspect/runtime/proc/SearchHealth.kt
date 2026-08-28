package com.leveret.inspect.runtime.proc

import java.net.ConnectException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import org.slf4j.LoggerFactory

/** Readiness probe of the search child, which has no command-file slot of its own. */
interface SearchHealth {
    fun status(): Status

    /** Reported status colour, or [UNAVAILABLE] when no colour could be read. */
    enum class Status(val isOperational: Boolean) {
        GREEN(true),
        YELLOW(true),
        RED(false),
        UNAVAILABLE(false),
    }
}

/**
 * Queries the health interface of the local search child over loopback HTTP.
 *
 * Only connection refusal is retried, because the search child accepts connections late in its own
 * startup. Every other outcome ends the check: an unreachable, silent, or uninterpretable health
 * interface leaves the child nonoperational rather than blocking the supervisor. A socket that
 * accepts and then never answers is exactly such a case, so the request itself is bounded.
 */
class HttpSearchHealth(
    private val host: String,
    private val port: Int,
    private val retryDelay: Duration = Duration.ofMillis(100),
    private val maxAttempts: Int = 600,
) : SearchHealth {
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(REQUEST_TIMEOUT).build()

    private val request: HttpRequest =
        HttpRequest.newBuilder(URI.create("http://$host:$port$HEALTH_PATH"))
            .timeout(REQUEST_TIMEOUT)
            .GET()
            .build()

    override fun status(): SearchHealth.Status {
        repeat(maxAttempts) {
            try {
                return colourOf(client.send(request, HttpResponse.BodyHandlers.ofString()).body())
            } catch (_: ConnectException) {
                if (!pause()) return SearchHealth.Status.UNAVAILABLE
            } catch (failure: Exception) {
                log.warn("Search health check on {}:{} failed", host, port, failure)
                return SearchHealth.Status.UNAVAILABLE
            }
        }
        log.warn("Search health interface on {}:{} refused {} attempts", host, port, maxAttempts)
        return SearchHealth.Status.UNAVAILABLE
    }

    private fun pause(): Boolean =
        try {
            Thread.sleep(retryDelay)
            true
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

    private fun colourOf(body: String): SearchHealth.Status {
        val colour = COLOUR.find(body)?.groupValues?.get(1)?.uppercase()
        return SearchHealth.Status.entries.firstOrNull { it.name == colour && it != SearchHealth.Status.UNAVAILABLE }
            ?: SearchHealth.Status.UNAVAILABLE
    }

    private companion object {
        /** Endpoint of the local search health interface, reporting a status colour. */
        const val HEALTH_PATH = "/health"

        /** One health call may not outlast several readiness polls. */
        val REQUEST_TIMEOUT: Duration = Duration.ofSeconds(5)

        val log = LoggerFactory.getLogger(HttpSearchHealth::class.java)
        val COLOUR = Regex("\"status\"\\s*:\\s*\"(\\w+)\"")
    }
}
