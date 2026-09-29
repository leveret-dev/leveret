package com.leveret.inspect.java

import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParseException
import com.google.gson.JsonPrimitive
import com.google.gson.JsonParser
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.google.gson.Strictness
import com.leveret.inspect.classpath.CacheOnlyClasspathWorker
import com.leveret.inspect.classpath.GradleLockfileClasspathWorker
import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import java.io.StringReader
import java.nio.file.Files
import java.nio.file.Path

data class FrozenAnalysis(val summary: AnalysisSummary, val artifacts: Map<String, String>)

object JavaAnalysisMain {
    private val gson = GsonBuilder().serializeNulls().create()

    @JvmStatic
    fun execute(args: Array<String>): Int {
        val reply: Any = try {
            require(args.size == 2 && args[0] == "--request") { "Expected --request <absolute-file>" }
            val file = Path.of(args[1])
            require(file.isAbsolute && Files.isRegularFile(file) && Files.size(file) <= 8_388_608) { "Invalid request file" }
            val reader = JsonReader(StringReader(Files.readString(file)))
            reader.strictness = Strictness.STRICT
            val parsed = JsonParser.parseReader(reader)
            require(parsed.isJsonObject) { "Java command must be a JSON object" }
            val command = parsed.asJsonObject
            require(reader.peek() == JsonToken.END_DOCUMENT && command.integer("schema") == 1) { "Invalid command schema" }
            val result = when (command.string("kind")) {
                "analyze" -> analyze(command)
                "references" -> references(command)
                else -> throw InspectException("invalid-input", "Unknown Java command")
            }
            mapOf("ok" to true, "result" to result)
        } catch (e: InspectException) {
            mapOf("ok" to false, "error" to (mapOf("code" to e.code, "message" to (e.message ?: e.code)) +
                (e.requiredBytes?.let { mapOf("requiredBytes" to it) } ?: emptyMap())))
        } catch (e: JsonParseException) {
            mapOf("ok" to false, "error" to mapOf("code" to "invalid-input", "message" to "Malformed Java command JSON"))
        } catch (e: IllegalArgumentException) {
            mapOf("ok" to false, "error" to mapOf("code" to "invalid-input", "message" to (e.message ?: "Invalid Java command")))
        } catch (e: Exception) {
            System.err.println("Java analysis failed: ${e.javaClass.simpleName}: ${e.message}")
            mapOf("ok" to false, "error" to mapOf("code" to "worker-failed", "message" to "Java analysis worker failed"))
        }
        System.out.println(gson.toJson(reply))
        return if ((reply as Map<*, *>)["ok"] == true) 0 else 1
    }

    private fun analyze(command: JsonObject): FrozenAnalysis {
        command.fields("schema", "kind", "store", "snapshot", "pathRoot", "repositoryId", "revision", "javaLevel", "build", "mainRoots", "testRoots", "cache", "artifacts", "skippedFiles")
        val root = absolute(command.string("snapshot"))
        val pathRoot = absolute(command.string("pathRoot"))
        require(root.startsWith(pathRoot) && Files.isDirectory(pathRoot)) { "Invalid repository snapshot root" }
        val cache = absolute(command.string("cache"))
        val artifacts = absolute(command.string("artifacts"))
        val classpath = when (command.string("build")) {
            "maven" -> CacheOnlyClasspathWorker.analyze(root.resolve("pom.xml"), cache)
            "gradle" -> GradleLockfileClasspathWorker.analyze(root, cache)
            else -> throw InspectException("invalid-input", "Unsupported classpath input")
        }
        Files.createDirectories(artifacts)
        val hashes = linkedMapOf<String, String>()
        for (path in (classpath.mainClasspath + classpath.testClasspath).distinct()) {
            val source = cache.resolve(path).toRealPath()
            require(source.startsWith(cache.toRealPath()) && Files.isRegularFile(source)) { "Artifact escapes cache" }
            val destination = artifacts.resolve(path).normalize()
            require(destination.startsWith(artifacts)) { "Artifact escapes scratch" }
            Files.createDirectories(destination.parent)
            Files.copy(source, destination)
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            Files.newInputStream(destination).use { stream ->
                val buffer = ByteArray(8192)
                while (true) {
                    val size = stream.read(buffer)
                    if (size < 0) break
                    digest.update(buffer, 0, size)
                }
            }
            hashes[path] = java.util.HexFormat.of().formatHex(digest.digest())
        }
        val mainRoots = command.array("mainRoots").map { inside(root, it.asString) }
        val testRoots = command.array("testRoots").map { inside(root, it.asString) }
        require(mainRoots.size == 1 && testRoots.size == 1) { "Exactly one main and one test source root are supported" }
        fun sources(roots: List<Path>): List<Path> = roots.flatMap { directory ->
            if (!Files.exists(directory)) emptyList() else Files.walk(directory).use { walk ->
                walk.filter { Files.isRegularFile(it) && it.toString().endsWith(".java") }
                    .map { candidate ->
                        require(candidate.toRealPath().startsWith(root.toRealPath())) { "Source escapes snapshot" }
                        candidate
                    }.toList()
            }
        }.sortedBy { it.toString() }
        val data = JavaExtractor.extract(JavaAnalysisInput(
            command.string("repositoryId"), command.string("revision"), pathRoot,
            sources(mainRoots), sources(testRoots), mainRoots, testRoots,
            command.string("javaLevel"), classpath, artifacts,
            command.array("skippedFiles").map { entry ->
                val item = entry.asJsonObject.also { it.fields("path", "sourceSet", "reason") }
                val path = item.string("path")
                require(!Path.of(path).isAbsolute && Path.of(path).none { it.toString() == ".." } && path.endsWith(".java"))
                SourceFile(path, item.string("sourceSet").also { require(it == "main" || it == "test") },
                    false, item.string("reason"))
            },
        ))
        return store(command).use { (_, sessions) ->
            FrozenAnalysis(JavaFactStore(sessions).publish(data), hashes)
        }
    }

    private fun references(command: JsonObject): ReferencePage {
        command.fields("schema", "kind", "store", "request")
        val source = command.obj("request")
        val allowed = setOf("analysisId", "configurationSha256", "manifest", "side", "target", "byteBudget", "cursor")
        require(source.keySet().containsAll(allowed - setOf("cursor")) && source.keySet().all { it in allowed })
        val target = source.obj("target").also { it.fields("path", "position") }
        val position = target.obj("position").also { it.fields("line", "column") }
        val manifest = source.obj("manifest")
        require(manifest.integer("schema") == 1)
        val files = manifest.array("files").map { entry ->
            val file = entry.asJsonObject
            ChangeFile(file.string("path"), file.string("oldPath"), file.string("newPath"), file.string("status"),
                file.array("hunks").map { value ->
                    val hunk = value.asJsonObject
                    ChangeHunk(hunk.integer("oldStart"), hunk.integer("oldLines"), hunk.integer("newStart"), hunk.integer("newLines"))
                }, file.boolean("truncated"), file.array("errors").map { it.asString })
        }
        val request = ReferenceRequest(source.string("analysisId"), source.string("configurationSha256"),
            ChangeManifest(manifest.string("base"), manifest.string("head"), files,
                manifest.boolean("truncated"), manifest.array("errors").map { it.asString }),
            source.string("side"), TargetSelector(target.string("path"), Position(position.integer("line"), position.integer("column"))),
            source.integer("byteBudget"), source.get("cursor")?.takeIf { !it.isJsonNull }?.asString)
        return store(command).use { (_, sessions) ->
            JavaFactStore(sessions).query(request)
        }
    }

    private data class OpenStore(val database: Database, val sessions: SessionFactory) : AutoCloseable {
        override fun close() = database.close()
    }

    private fun store(command: JsonObject): OpenStore {
        val path = absolute(command.string("store"))
        Files.createDirectories(path.parent)
        val database = Database(DatabaseSettings("jdbc:h2:file:$path", 1))
        database.start()
        return OpenStore(database, SessionFactory(database))
    }

    private fun absolute(raw: String): Path = Path.of(raw).also { require(it.isAbsolute && it == it.normalize()) }
    private fun inside(root: Path, raw: String): Path {
        val path = Path.of(raw)
        require(!path.isAbsolute && path.toString().isNotEmpty() && path.none { it.toString() == ".." || it.toString() == "." })
        return root.resolve(path).normalize().also { require(it.startsWith(root)) }
    }
    private fun JsonObject.fields(vararg expected: String) {
        val required = expected.toSet()
        val missing = required - keySet()
        val unexpected = keySet() - required
        require(missing.isEmpty() && unexpected.isEmpty()) {
            "Invalid Java command fields: missing ${missing.take(3)}, unexpected ${unexpected.take(3)}"
        }
    }
    private fun JsonObject.obj(name: String): JsonObject =
        get(name)?.takeIf { it.isJsonObject }?.asJsonObject ?: throw IllegalArgumentException("Missing or invalid $name")
    private fun JsonObject.array(name: String): JsonArray =
        get(name)?.takeIf { it.isJsonArray }?.asJsonArray ?: throw IllegalArgumentException("Missing or invalid $name")
    private fun JsonObject.primitive(name: String): JsonPrimitive =
        get(name)?.takeIf { it.isJsonPrimitive }?.asJsonPrimitive ?: throw IllegalArgumentException("Missing or invalid $name")
    private fun JsonObject.string(name: String): String = primitive(name).also { require(it.isString) }.asString
    private fun JsonObject.integer(name: String): Int = primitive(name).also { require(it.isNumber) }.asString.toIntOrNull()
        ?: throw IllegalArgumentException("Invalid integer $name")
    private fun JsonObject.boolean(name: String): Boolean = primitive(name).also { require(it.isBoolean) }.asBoolean
}
