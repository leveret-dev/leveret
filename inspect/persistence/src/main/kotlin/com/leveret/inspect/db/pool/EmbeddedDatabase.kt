package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.config.DatabaseSettings
import java.nio.file.Path
import org.h2.tools.Server
import org.slf4j.LoggerFactory

/**
 * The embedded database is a loopback server because web and compute are separate processes sharing
 * one database. It is an evaluation and test target, never a production one.
 */
class EmbeddedDatabase(
    private val port: Int = DatabaseKeys.DEFAULT_EMBEDDED_PORT,
    private val baseDir: Path,
) : AutoCloseable {
    private val log = LoggerFactory.getLogger(EmbeddedDatabase::class.java)
    private var server: Server? = null

    val url: String = DatabaseSettings.embeddedUrl(port)

    fun start() {
        check(server == null) { "Embedded database is already started on port $port" }
        server = Server.createTcpServer(
            "-tcpPort", port.toString(),
            "-baseDir", baseDir.toAbsolutePath().toString(),
            "-ifNotExists",
        ).start()
        log.info("Embedded database listening on {}", url)
    }

    override fun close() {
        server?.stop()
        server = null
    }
}
