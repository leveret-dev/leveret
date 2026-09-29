package com.leveret.inspect.java

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.leveret.inspect.db.schema.Schema
import com.leveret.inspect.db.session.DbSession
import com.leveret.inspect.db.session.SessionFactory
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.sql.PreparedStatement

class JavaFactStore(private val sessions: SessionFactory) {
    private val gson = GsonBuilder().serializeNulls().create()

    init {
        Schema(sessions).ensure(1, listOf(
            "create table analyses (id varchar(64) primary key, repository varchar(1024) not null, revision varchar(128) not null, configuration varchar(64) not null, digest varchar(64) not null, summary clob not null)",
            "create table methods (analysis_id varchar(64) not null, id varchar(2048) not null, path varchar(4096) not null, start_line int not null, start_col int not null, end_line int not null, end_col int not null, payload clob not null, primary key (analysis_id, id))",
            "create index method_location on methods (analysis_id, path, start_line, start_col)",
            "create table refs (analysis_id varchar(64) not null, id varchar(4096) not null, target_id varchar(2048) not null, path varchar(4096) not null, start_line int not null, start_col int not null, payload clob not null, primary key (analysis_id, id))",
            "create index ref_target on refs (analysis_id, target_id, path, start_line, start_col)",
            "create table details (analysis_id varchar(64) not null, id varchar(4096) not null, path varchar(4096) not null, start_line int not null, start_col int not null, payload clob not null, primary key (analysis_id, id))",
            "create index detail_order on details (analysis_id, path, start_line, start_col)",
        ))
    }

    fun publish(data: AnalysisData): AnalysisSummary {
        val id = data.summary.analysisId
        require(id.isNotBlank() && data.methods.all { it.id.isNotBlank() })
        val digest = sha(gson.toJson(data))
        sessions.open().use { session ->
            try {
                val existing = session.select("select digest from analyses where id=?", { it.setString(1, id) }) { it.getString(1) }.singleOrNull()
                if (existing != null) {
                    if (existing != digest) throw InspectException("configuration-mismatch", "Analysis identity conflicts with stored content")
                    return data.summary
                }
                session.update("insert into analyses (id,repository,revision,configuration,digest,summary) values (?,?,?,?,?,?)") {
                    it.setString(1, id)
                    it.setString(2, data.summary.repositoryId)
                    it.setString(3, data.summary.revision)
                    it.setString(4, data.summary.configurationSha256)
                    it.setString(5, digest)
                    it.setString(6, gson.toJson(data.summary))
                }
                insert(session, "insert into methods (analysis_id,id,path,start_line,start_col,end_line,end_col,payload) values (?,?,?,?,?,?,?,?)", data.methods) { statement, method ->
                    statement.setString(1, id)
                    statement.setString(2, method.id)
                    statement.setString(3, method.location.path)
                    statement.setInt(4, method.nameRange.start.line)
                    statement.setInt(5, method.nameRange.start.column)
                    statement.setInt(6, method.nameRange.end.line)
                    statement.setInt(7, method.nameRange.end.column)
                    statement.setString(8, gson.toJson(method))
                }
                insert(session, "insert into refs (analysis_id,id,target_id,path,start_line,start_col,payload) values (?,?,?,?,?,?,?)", data.references) { statement, reference ->
                    statement.setString(1, id)
                    statement.setString(2, reference.id)
                    statement.setString(3, reference.targetId)
                    statement.setString(4, reference.location.path)
                    statement.setInt(5, reference.location.range.start.line)
                    statement.setInt(6, reference.location.range.start.column)
                    statement.setString(7, gson.toJson(DetailRecord.reference(reference)))
                }
                val details = buildList {
                    data.unresolved.forEach { add(Triple(it.id, it.location, DetailRecord.unresolved(it))) }
                    data.files.forEach { add(Triple("file:${it.sourceSet}:${it.path}", Location(it.path, Range(Position(0, 0), Position(0, 0))), DetailRecord.file(it))) }
                    data.diagnostics.forEachIndexed { index, message ->
                        add(Triple("diagnostic:$index", Location("", Range(Position(0, 0), Position(0, 0))), DetailRecord.diagnostic(message)))
                    }
                }
                insert(session, "insert into details (analysis_id,id,path,start_line,start_col,payload) values (?,?,?,?,?,?)", details) { statement, item ->
                    statement.setString(1, id)
                    statement.setString(2, item.first)
                    statement.setString(3, item.second.path)
                    statement.setInt(4, item.second.range.start.line)
                    statement.setInt(5, item.second.range.start.column)
                    statement.setString(6, gson.toJson(item.third))
                }
                session.commit()
            } catch (e: Exception) {
                session.rollback()
                throw e
            }
        }
        return data.summary
    }

    fun summary(analysisId: String): AnalysisSummary = sessions.open().use { session ->
        session.select("select summary from analyses where id=?", { it.setString(1, analysisId) }) {
            parseSummary(it.getString(1))
        }.singleOrNull() ?: throw InspectException("analysis-unavailable", "Analysis $analysisId is unavailable")
    }

    fun methodAt(analysisId: String, path: String, position: Position): JavaMethod = sessions.open().use { session ->
        methodAt(session, analysisId, path, position)
    }

    private fun methodAt(session: DbSession, analysisId: String, path: String, position: Position): JavaMethod {
        if (path.startsWith('/') || path.split('/').any { it == ".." || it == "." } || position.line < 1 || position.column < 0) {
            throw InspectException("invalid-input", "Invalid declaration path or position")
        }
        val matches = session.select("select payload from methods where analysis_id=? and path=? and start_line<=? and end_line>=?", {
            it.setString(1, analysisId); it.setString(2, path); it.setInt(3, position.line); it.setInt(4, position.line)
        }) { parseMethod(it.getString(1)) }.filter { method ->
            val start = method.nameRange.start
            val end = method.nameRange.end
            (position.line > start.line || position.line == start.line && position.column >= start.column) &&
                (position.line < end.line || position.line == end.line && position.column < end.column)
        }
        if (matches.size > 1) throw InspectException("target-indeterminate", "Declaration selector matches multiple methods")
        return matches.singleOrNull() ?: throw InspectException("target-missing", "Method declaration not found at $path:${position.line}:${position.column}")
    }

    fun query(request: ReferenceRequest): ReferencePage {
        JavaReferences.validate(request.manifest, request.side)
        val revision = if (request.side == "base") request.manifest.base else request.manifest.head
        sessions.open().use { session ->
            val summary = session.select("select summary from analyses where id=?", { it.setString(1, request.analysisId) }) {
                parseSummary(it.getString(1))
            }.singleOrNull() ?: throw InspectException("analysis-unavailable", "Analysis unavailable")
            if (summary.revision != revision) throw InspectException("snapshot-mismatch", "Manifest revision differs from analysis")
            if (summary.configurationSha256 != request.configurationSha256) throw InspectException("configuration-mismatch", "Analysis configuration differs from request")
            val target = methodAt(session, request.analysisId, request.target.path, request.target.position)
            val sql = """
                select payload from (
                  select path, start_line, start_col, id, payload from refs where analysis_id=? and target_id=?
                  union all
                  select path, start_line, start_col, id, payload from details where analysis_id=?
                ) order by path,start_line,start_col,id
            """.trimIndent()
            session.prepare(sql).use { statement ->
                statement.setString(1, request.analysisId)
                statement.setString(2, target.id)
                statement.setString(3, request.analysisId)
                var total = 0
                statement.executeQuery().use { result ->
                    while (result.next()) {
                        val item = parseDetail(result.getString(1))
                        if (item.kind != "reference" || JavaReferences.outsideDiff(item.reference!!.location, request.manifest, request.side)) total++
                    }
                }
                statement.executeQuery().use { result ->
                    val records = object : Iterator<DetailRecord> {
                        private var next: DetailRecord? = null
                        override fun hasNext(): Boolean {
                            if (next != null) return true
                            while (result.next()) {
                                val item = parseDetail(result.getString(1))
                                if (item.kind != "reference" ||
                                    JavaReferences.outsideDiff(item.reference!!.location, request.manifest, request.side)) {
                                    next = item
                                    return true
                                }
                            }
                            return false
                        }
                        override fun next(): DetailRecord {
                            if (!hasNext()) throw NoSuchElementException()
                            return checkNotNull(next).also { next = null }
                        }
                    }
                    val context = PageContext(summary, target, request.side, JavaReferences.digest(request.manifest), total)
                    return JavaReferences.page(records, context, request.byteBudget, request.cursor)
                }
            }
        }
    }

    private fun parseSummary(text: String): AnalysisSummary {
        val root = JsonParser.parseString(text).asJsonObject
        val c = root.obj("coverage")
        return AnalysisSummary(root.string("analysisId"), root.string("repositoryId"), root.string("revision"),
            root.string("configurationSha256"), AnalysisCoverage(
                c.bool("complete"), c.number("mainExamined"), c.number("testExamined"),
                c.number("mainSkipped"), c.number("testSkipped"), c.number("mainUnresolved"),
                c.number("testUnresolved"), c.number("diagnosticCount"),
            ))
    }

    private fun parseMethod(text: String): JavaMethod = method(JsonParser.parseString(text).asJsonObject)

    private fun method(root: JsonObject): JavaMethod = JavaMethod(
        root.string("id"), root.string("signature"), location(root.obj("location")),
        range(root.obj("nameRange")), root.string("sourceSet"),
    )

    private fun position(root: JsonObject) = Position(root.number("line"), root.number("column"))
    private fun range(root: JsonObject) = Range(position(root.obj("start")), position(root.obj("end")))
    private fun location(root: JsonObject) = Location(root.string("path"), range(root.obj("range")))

    private fun parseDetail(text: String): DetailRecord {
        val root = JsonParser.parseString(text).asJsonObject
        return when (root.string("kind")) {
            "reference" -> {
                val value = root.obj("reference")
                DetailRecord.reference(JavaReference(
                    value.string("id"), value.string("targetId"), location(value.obj("location")),
                    value.get("enclosing").takeIf { !it.isJsonNull }?.asJsonObject?.let(::method),
                    value.string("sourceSet"), value.string("kind"), value.string("basis"),
                ))
            }
            "unresolved" -> {
                val value = root.obj("unresolved")
                DetailRecord.unresolved(UnresolvedSite(value.string("id"), location(value.obj("location")),
                    value.string("sourceSet"), value.string("reason")))
            }
            "file" -> {
                val value = root.obj("file")
                DetailRecord.file(SourceFile(value.string("path"), value.string("sourceSet"), value.bool("examined"),
                    value.get("reason").takeIf { !it.isJsonNull }?.asString))
            }
            "diagnostic" -> DetailRecord.diagnostic(root.string("diagnostic"))
            else -> throw InspectException("analysis-unavailable", "Invalid stored Java detail")
        }
    }

    private fun JsonObject.obj(name: String): JsonObject = get(name)?.asJsonObject
        ?: throw InspectException("analysis-unavailable", "Missing stored Java object: $name")
    private fun JsonObject.string(name: String): String = get(name)?.asJsonPrimitive?.also {
        require(it.isString) { "Invalid stored Java string: $name" }
    }?.asString ?: throw InspectException("analysis-unavailable", "Missing stored Java string: $name")
    private fun JsonObject.number(name: String): Int = get(name)?.asJsonPrimitive?.also {
        require(it.isNumber) { "Invalid stored Java number: $name" }
    }?.asInt ?: throw InspectException("analysis-unavailable", "Missing stored Java number: $name")
    private fun JsonObject.bool(name: String): Boolean = get(name)?.asJsonPrimitive?.also {
        require(it.isBoolean) { "Invalid stored Java boolean: $name" }
    }?.asBoolean ?: throw InspectException("analysis-unavailable", "Missing stored Java boolean: $name")

    private fun <T> insert(session: DbSession, sql: String, rows: List<T>, bind: (PreparedStatement, T) -> Unit) {
        session.prepare(sql).use { statement ->
            for (row in rows) {
                bind(statement, row)
                statement.addBatch()
            }
            statement.executeBatch()
        }
    }

    private fun sha(value: String): String = java.util.HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)),
    )
}
