package com.leveret.inspect.db.pool

import com.leveret.inspect.db.config.DatabaseSettings
import java.net.ServerSocket
import java.nio.file.Path
import java.sql.DriverManager
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EmbeddedDatabaseTest {
    @Test
    fun `embedded server serves the node database on loopback`(@TempDir dataDir: Path) {
        val port = freePort()
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            assertThat(embedded.url).isEqualTo(DatabaseSettings.embeddedUrl(port))
            DriverManager.getConnection(embedded.url, "", "").use { connection ->
                connection.createStatement().use { statement ->
                    statement.execute("create table probe (id int)")
                    assertThat(statement.executeQuery("select count(*) from probe").next()).isTrue()
                }
            }
        }
        assertThat(dataDir.toFile().list()).isNotEmpty()
    }

    @Test
    fun `a second start is refused`(@TempDir dataDir: Path) {
        val port = freePort()
        EmbeddedDatabase(port, dataDir).use { embedded ->
            embedded.start()
            assertThatThrownBy { embedded.start() }.isInstanceOf(IllegalStateException::class.java)
        }
    }

    private fun freePort(): Int = ServerSocket(0).use { it.localPort }
}
