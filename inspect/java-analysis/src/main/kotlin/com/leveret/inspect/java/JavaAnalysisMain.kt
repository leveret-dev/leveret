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
            require(reader.peek() == JsonToken.END_DOCUMENT && command.integer("schema") == 2) { "Invalid command schema" }
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
        command.fields("schema", "kind", "store", "input")
        val input = command.obj("input")
        return when (input.string("kind")) {
            "cache-only" -> analyzeCacheOnly(command, input)
            "prepared" -> analyzePrepared(command, input)
            else -> throw InspectException("invalid-input", "Unsupported Java analysis input")
        }
    }

    private fun analyzeCacheOnly(command: JsonObject, input: JsonObject): FrozenAnalysis {
        input.fields("kind", "snapshot", "pathRoot", "cachePathRoot", "artifactRoot", "repositoryId", "revision",
            "javaLevel", "build", "mainRoots", "testRoots", "cache", "artifacts", "skippedFiles",
            "preparedCompilations", "fallbackRoles", "diagnostics", "buildIdentity")
        val root = absolute(input.string("snapshot"))
        val pathRoot = absolute(input.string("pathRoot"))
        val cachePathRoot = absolute(input.string("cachePathRoot"))
        val artifactRoot = absolute(input.string("artifactRoot"))
        require(root.startsWith(cachePathRoot) && cachePathRoot.startsWith(pathRoot) &&
            Files.isDirectory(pathRoot) && Files.isDirectory(cachePathRoot)) { "Invalid repository snapshot root" }
        val cache = absolute(input.string("cache"))
        val artifacts = absolute(input.string("artifacts"))
        require(artifacts.startsWith(artifactRoot)) { "Invalid cache artifact root" }
        val classpath = when (input.string("build")) {
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
        val mainRoots = input.array("mainRoots").map { inside(root, it.asString) }
        val testRoots = input.array("testRoots").map { inside(root, it.asString) }
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
        val cacheInput = JavaAnalysisInput.cacheOnly(
            input.string("repositoryId"), input.string("revision"), cachePathRoot,
            sources(mainRoots), sources(testRoots), mainRoots, testRoots,
            input.string("javaLevel"), classpath, artifacts, skipped(input),
        )
        val prepared = preparedCompilations(input.array("preparedCompilations"), pathRoot, artifactRoot)
        val fallbackRoles = input.array("fallbackRoles").map { it.asString }.toSet()
        require(fallbackRoles.all { it == "production" || it == "test" }) { "Invalid fallback role" }
        val fallback = cacheInput.compilations.filter {
            it.sourceSet == "main" && "production" in fallbackRoles || it.sourceSet == "test" && "test" in fallbackRoles
        }.map { it.copy(id = "fallback:${it.sourceSet}") }
        val normalized = if (prepared.isEmpty() && fallbackRoles == setOf("production", "test")) cacheInput else {
            val compilations = (prepared + fallback).sortedBy { if (it.sourceSet == "main") 0 else 1 }
            require(compilations.isNotEmpty()) { "No Java compilation is available" }
            require(compilations.map { it.sourceSet }.distinct().size == compilations.size) { "More than one compilation selected for a role" }
            JavaAnalysisInput(
                input.string("repositoryId"), input.string("revision"), pathRoot, artifactRoot, compilations,
                cacheInput.skippedFiles, cacheInput.diagnostics + input.array("diagnostics").map { it.asString },
                input.string("buildIdentity") + ":" + cacheInput.buildIdentity,
            )
        }
        val data = JavaExtractor.extract(normalized)
        return store(command).use { (_, sessions) ->
            FrozenAnalysis(JavaFactStore(sessions).publish(data), hashes)
        }
    }

    private fun preparedCompilations(values: JsonArray, pathRoot: Path, artifactRoot: Path): List<JavaCompilationInput> =
        values.map { value ->
            val item = value.asJsonObject.also {
                it.fields("id", "resolutionDomain", "sourceSet", "files", "roots", "sourcePath", "classpath", "compiler", "origins")
            }
            val files = item.array("files").map { raw ->
                val file = raw.asJsonObject.also { it.fields("physicalPath", "displayPath", "encoding", "buildArtifact") }
                JavaSourceInput(
                    contained(pathRoot, file.string("physicalPath")), file.string("displayPath"), file.string("encoding"),
                    artifact(file.obj("buildArtifact")),
                )
            }
            val compiler = item.obj("compiler").also {
                it.fields("sourceLevel", "targetLevel", "encoding", "preview", "release", "platform", "usedModuleOptions")
            }
            val release = compiler.obj("release").also { it.fields("state", "value") }
            val platform = compiler.obj("platform").entrySet().associate { (name, item) ->
                require(item.isJsonPrimitive && item.asJsonPrimitive.isString) { "Invalid platform fingerprint" }
                name to item.asString
            }
            val origins = item.array("origins").map { raw ->
                val origin = raw.asJsonObject.also { it.fields("path", "artifact", "ownerCompilationId") }
                JavaOrigin(
                    contained(artifactRoot, origin.string("path")), artifact(origin.obj("artifact")),
                    origin.nullableString("ownerCompilationId"),
                )
            }
            JavaCompilationInput(
                item.string("id"), item.string("resolutionDomain"), item.string("sourceSet"), files,
                item.paths("roots", pathRoot), item.paths("sourcePath", pathRoot), item.paths("classpath", artifactRoot),
                JavaCompilationEnvironment(
                    compiler.nullableString("sourceLevel"), compiler.nullableString("targetLevel"),
                    compiler.nullableString("encoding"), compiler.nullableBoolean("preview"),
                    JavaRelease(release.string("state"), release.nullableString("value")), platform,
                    compiler.nullableStrings("usedModuleOptions"),
                ),
                origins,
            )
        }

    private fun analyzePrepared(command: JsonObject, input: JsonObject): FrozenAnalysis {
        input.fields("kind", "repositoryId", "revision", "pathRoot", "artifactRoot", "compilations", "skippedFiles", "diagnostics", "buildIdentity")
        val pathRoot = absolute(input.string("pathRoot"))
        val artifactRoot = absolute(input.string("artifactRoot"))
        require(Files.isDirectory(pathRoot) && Files.isDirectory(artifactRoot) && artifactRoot.startsWith(pathRoot)) { "Invalid prepared roots" }
        val compilations = preparedCompilations(input.array("compilations"), pathRoot, artifactRoot)
        require(compilations.isNotEmpty()) { "Prepared input has no supported compilations" }
        val data = JavaExtractor.extract(JavaAnalysisInput(
            input.string("repositoryId"), input.string("revision"), pathRoot, artifactRoot, compilations,
            skipped(input), input.array("diagnostics").map { it.asString }, input.string("buildIdentity"),
        ))
        return store(command).use { (_, sessions) ->
            FrozenAnalysis(JavaFactStore(sessions).publish(data), emptyMap())
        }
    }

    private fun references(command: JsonObject): ReferencePage {
        command.fields("schema", "kind", "store", "request")
        val source = command.obj("request")
        val allowed = setOf("analysisId", "configurationSha256", "manifest", "side", "target", "referenceScope", "byteBudget", "cursor")
        require(source.keySet().containsAll(allowed - setOf("cursor")) && source.keySet().all { it in allowed })
        val target = source.obj("target").also { it.fields("path", "position", "buildArtifact") }
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
        val rawArtifact = target.get("buildArtifact") ?: throw IllegalArgumentException("Missing buildArtifact")
        val artifact = if (rawArtifact.isJsonNull) null else {
            require(rawArtifact.isJsonObject) { "Invalid buildArtifact" }
            rawArtifact.asJsonObject.also {
                it.fields("manifestSha256", "artifactId", "origin")
            }.let { BuildArtifactCitation(it.string("manifestSha256"), it.string("artifactId"), it.string("origin")) }
        }
        val request = ReferenceRequest(source.string("analysisId"), source.string("configurationSha256"),
            ChangeManifest(manifest.string("base"), manifest.string("head"), files,
                manifest.boolean("truncated"), manifest.array("errors").map { it.asString }),
            source.string("side"), TargetSelector(target.string("path"), Position(position.integer("line"), position.integer("column")), artifact),
            source.string("referenceScope"), source.integer("byteBudget"), source.get("cursor")?.takeIf { !it.isJsonNull }?.asString)
        return store(command).use { (_, sessions) ->
            JavaFactStore(sessions).query(request)
        }
    }

    private fun skipped(input: JsonObject): List<SourceFile> = input.array("skippedFiles").map { entry ->
        val item = entry.asJsonObject.also { it.fields("path", "sourceSet", "reason") }
        val path = item.string("path")
        require(!Path.of(path).isAbsolute && Path.of(path).none { it.toString() == ".." } && path.endsWith(".java"))
        SourceFile(path, item.string("sourceSet").also { require(it == "main" || it == "test") }, false, item.string("reason"))
    }

    private fun artifact(item: JsonObject): BuildArtifactCitation {
        item.fields("manifestSha256", "artifactId", "origin")
        val hash = item.string("manifestSha256")
        val id = item.string("artifactId")
        val origin = item.string("origin")
        require(hash.matches(Regex("[0-9a-f]{64}")) && id.isNotBlank() && origin in setOf("authored", "materialized", "external"))
        return BuildArtifactCitation(hash, id, origin)
    }

    private fun contained(root: Path, raw: String): Path =
        absolute(raw).also { require(it.startsWith(root)) { "Prepared path escapes its root" } }

    private fun JsonObject.paths(name: String, root: Path): List<Path> =
        array(name).map { value ->
            require(value.isJsonPrimitive && value.asJsonPrimitive.isString) { "Invalid prepared path" }
            contained(root, value.asString)
        }

    private fun JsonObject.nullableString(name: String): String? {
        val value = get(name) ?: throw IllegalArgumentException("Missing $name")
        if (value.isJsonNull) return null
        require(value.isJsonPrimitive && value.asJsonPrimitive.isString) { "Invalid string $name" }
        return value.asString
    }

    private fun JsonObject.nullableBoolean(name: String): Boolean? {
        val value = get(name) ?: throw IllegalArgumentException("Missing $name")
        if (value.isJsonNull) return null
        require(value.isJsonPrimitive && value.asJsonPrimitive.isBoolean) { "Invalid boolean $name" }
        return value.asBoolean
    }

    private fun JsonObject.nullableStrings(name: String): List<String>? {
        val value = get(name) ?: throw IllegalArgumentException("Missing $name")
        if (value.isJsonNull) return null
        require(value.isJsonArray) { "Invalid string array $name" }
        return value.asJsonArray.map {
            require(it.isJsonPrimitive && it.asJsonPrimitive.isString) { "Invalid string in $name" }
            it.asString
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
