package com.leveret.inspect.runtime.acceptance

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch

/**
 * Stand-in for the search process: serves one health colour on the configured port and then stays
 * alive until the supervisor terminates it, which is exactly the lifecycle the real search child has.
 */
object StubSearchMain {
    @JvmStatic
    fun main(args: Array<String>) {
        val port = Integer.parseInt(System.getProperty("stub.health.port"))
        val colour = System.getProperty("stub.health.colour", "green")
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
        server.createContext("/health") { exchange ->
            val body = """{"status":"$colour"}""".toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        println("stub search listening on $port with colour $colour")
        CountDownLatch(1).await()
    }
}
