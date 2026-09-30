package com.leveret.inspect.classpath

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.stream.JsonReader
import com.google.gson.Strictness
import java.io.StringReader

data class MavenTuple(
    val modelBuilder: String,
    val resolver: String,
)

data class RepositoryPolicy(
    val offline: Boolean,
    val descriptorRepositoriesIgnored: Boolean,
    val targetRepositoriesDiscarded: Boolean,
    val approvedRemoteId: String,
    val approvedRemoteUrl: String,
)

data class ClasspathDiagnostic(
    val sourceSet: String?,
    val reason: String,
    val coordinate: String?,
    val message: String,
)

data class ClasspathAnalysis(
    val tuple: MavenTuple,
    val activeProfiles: List<String>,
    val repositoryPolicy: RepositoryPolicy,
    val mainClasspath: List<String>,
    val testClasspath: List<String>,
    val testSourceRoots: List<String>,
    val diagnostics: List<ClasspathDiagnostic> = emptyList(),
) {
    val complete: Boolean get() = diagnostics.isEmpty()

    fun write(): String = GsonBuilder().serializeNulls().create().toJson(
        mapOf(
            "version" to 1,
            "tuple" to tuple,
            "activeProfiles" to activeProfiles,
            "repositoryPolicy" to repositoryPolicy,
            "mainClasspath" to mainClasspath,
            "testClasspath" to testClasspath,
            "testSourceRoots" to testSourceRoots,
            "diagnostics" to diagnostics,
        ),
    )

    companion object {
        fun read(text: String): ClasspathAnalysis {
            val reader = JsonReader(StringReader(text))
            reader.strictness = Strictness.STRICT
            val root = JsonParser.parseReader(reader).asJsonObject
            require(reader.peek() == com.google.gson.stream.JsonToken.END_DOCUMENT) { "Trailing JSON" }
            root.fields("version", "tuple", "activeProfiles", "repositoryPolicy", "mainClasspath", "testClasspath", "testSourceRoots", "diagnostics")
            require(root.number("version") == 1) { "Unsupported classpath format" }
            val tuple = root.obj("tuple").also { it.fields("modelBuilder", "resolver") }
            val policy = root.obj("repositoryPolicy").also {
                it.fields("offline", "descriptorRepositoriesIgnored", "targetRepositoriesDiscarded", "approvedRemoteId", "approvedRemoteUrl")
            }
            return ClasspathAnalysis(
                tuple = MavenTuple(tuple.string("modelBuilder"), tuple.string("resolver")),
                activeProfiles = root.strings("activeProfiles"),
                repositoryPolicy = RepositoryPolicy(
                    policy.boolean("offline"),
                    policy.boolean("descriptorRepositoriesIgnored"),
                    policy.boolean("targetRepositoriesDiscarded"),
                    policy.string("approvedRemoteId"),
                    policy.string("approvedRemoteUrl"),
                ),
                mainClasspath = root.strings("mainClasspath"),
                testClasspath = root.strings("testClasspath"),
                testSourceRoots = root.strings("testSourceRoots"),
                diagnostics = root.array("diagnostics").map { item ->
                    val value = item.asJsonObject.also { it.fields("sourceSet", "reason", "coordinate", "message") }
                    ClasspathDiagnostic(
                        value.optionalString("sourceSet"),
                        value.string("reason"),
                        value.optionalString("coordinate"),
                        value.string("message"),
                    )
                },
            )
        }
    }
}

private fun JsonObject.fields(vararg names: String) {
    require(keySet() == names.toSet()) { "Invalid classpath fields" }
}
private fun JsonObject.obj(name: String): JsonObject = get(name).asJsonObject
private fun JsonObject.array(name: String): JsonArray = get(name).asJsonArray
private fun JsonObject.string(name: String): String = get(name).asJsonPrimitive.also { require(it.isString) }.asString
private fun JsonObject.optionalString(name: String): String? =
    if (get(name).isJsonNull) null else string(name)
private fun JsonObject.boolean(name: String): Boolean = get(name).asJsonPrimitive.also { require(it.isBoolean) }.asBoolean
private fun JsonObject.number(name: String): Int = get(name).asJsonPrimitive.also { require(it.isNumber) }.asInt
private fun JsonObject.strings(name: String): List<String> = array(name).map {
    require(it.isJsonPrimitive && it.asJsonPrimitive.isString)
    it.asString
}

class UnboundedVersionRangeException(message: String) : RuntimeException(message)
