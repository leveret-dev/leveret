package com.leveret.inspect.runtime.config

import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class SettingsValidatorTest {
    private fun withUrl(url: String) = Settings(mapOf(PropertyKeys.JDBC_URL to url))

    @Test
    fun `recognized providers pass in any case`() {
        listOf(
            "jdbc:h2:tcp://127.0.0.1:9092/inspect",
            "jdbc:PostgreSQL://db/inspect",
            "jdbc:oracle:thin:@host:1521/x",
            "jdbc:sqlserver://db;databaseName=inspect",
        ).forEach { url ->
            assertThatCode { SettingsValidator.validate(withUrl(url)) }.doesNotThrowAnyException()
        }
    }

    @Test
    fun `unknown provider and malformed url fail`() {
        listOf("jdbc:mysql://db/x", "postgresql://db/x", "jdbc:", "", "jdbc:h2", "h2:mem")
            .forEach { url ->
                assertThatThrownBy { SettingsValidator.validate(withUrl(url)) }
                    .isInstanceOf(IllegalArgumentException::class.java)
            }
    }

    @Test
    fun `absent url is accepted`() {
        assertThatCode { SettingsValidator.validate(Settings(emptyMap())) }.doesNotThrowAnyException()
    }
}
