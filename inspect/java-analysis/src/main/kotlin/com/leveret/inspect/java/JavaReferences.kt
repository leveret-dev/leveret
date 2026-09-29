package com.leveret.inspect.java

import com.google.gson.GsonBuilder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

data class ChangeHunk(val oldStart: Int, val oldLines: Int, val newStart: Int, val newLines: Int)
data class ChangeFile(
    val path: String, val oldPath: String, val newPath: String, val status: String,
    val hunks: List<ChangeHunk>, val truncated: Boolean = false, val errors: List<String> = emptyList(),
)
data class ChangeManifest(
    val base: String, val head: String, val files: List<ChangeFile>,
    val truncated: Boolean = false, val errors: List<String> = emptyList(),
    val schema: Int = 1,
)
data class TargetSelector(val path: String, val position: Position)
data class ReferenceRequest(
    val analysisId: String, val configurationSha256: String, val manifest: ChangeManifest,
    val side: String, val target: TargetSelector, val byteBudget: Int = 65536, val cursor: String? = null,
)
data class DetailRecord(
    val kind: String, val reference: JavaReference? = null, val unresolved: UnresolvedSite? = null,
    val file: SourceFile? = null, val diagnostic: String? = null,
) {
    companion object {
        fun reference(value: JavaReference) = DetailRecord("reference", reference = value)
        fun unresolved(value: UnresolvedSite) = DetailRecord("unresolved", unresolved = value)
        fun file(value: SourceFile) = DetailRecord("file", file = value)
        fun diagnostic(value: String) = DetailRecord("diagnostic", diagnostic = value)
    }
}
data class Delivery(val complete: Boolean, val truncated: Boolean, val omittedRecords: Int, val nextCursor: String?)
data class ReferencePage(
    val summary: AnalysisSummary, val target: JavaMethod, val side: String,
    val items: List<DetailRecord>, val delivery: Delivery,
)
data class PageContext(
    val summary: AnalysisSummary, val target: JavaMethod, val side: String,
    val manifestDigest: String, val totalRecords: Int,
)
class InspectException(val code: String, message: String, val requiredBytes: Int? = null) : IllegalArgumentException(message)

object JavaReferences {
    private val json = GsonBuilder().serializeNulls().create()

    fun outsideDiff(location: Location, manifest: ChangeManifest, side: String): Boolean {
        validate(manifest, side)
        require(location.range.start.line >= 1 && location.range.end.line >= location.range.start.line)
        val end = location.range.end.line - if (location.range.end.column == 0) 1 else 0
        for (file in manifest.files) {
            val path = if (side == "base") file.oldPath else file.newPath
            if (path != location.path) continue
            for (hunk in file.hunks) {
                val start = if (side == "base") hunk.oldStart else hunk.newStart
                val lines = if (side == "base") hunk.oldLines else hunk.newLines
                if (lines > 0 && location.range.start.line < start + lines && end >= start) return false
            }
        }
        return true
    }

    fun validate(manifest: ChangeManifest, side: String) {
        if (side !in setOf("base", "head") || manifest.schema != 1 || manifest.base.isBlank() || manifest.head.isBlank() ||
            manifest.truncated || manifest.errors.isNotEmpty() || manifest.files.any {
                it.truncated || it.errors.isNotEmpty() || it.hunks.any { h ->
                    h.oldStart < 0 || h.newStart < 0 || h.oldLines < 0 || h.newLines < 0
                }
            }
        ) throw InspectException("invalid-input", "Incomplete or invalid change manifest")
    }

    fun digest(manifest: ChangeManifest): String = sha(json.toJson(manifest))

    fun page(records: Iterator<DetailRecord>, context: PageContext, byteBudget: Int, cursor: String?): ReferencePage {
        if (byteBudget !in 1..262144) throw InspectException("invalid-input", "Byte budget must be between 1 and 262144")
        val offset = if (cursor == null) 0 else decode(cursor, context)
        if (offset > context.totalRecords) throw InspectException("invalid-cursor", "Cursor exceeds query records")
        repeat(offset) { if (!records.hasNext()) throw InspectException("invalid-cursor", "Cursor exceeds query records"); records.next() }
        val items = mutableListOf<DetailRecord>()
        fun delivery(count: Int): Delivery {
            val remaining = context.totalRecords - offset - count
            return Delivery(remaining == 0, remaining > 0, remaining,
                if (remaining == 0) null else encode(offset + count, context))
        }
        val emptyDelivery = Delivery(true, false, 0, null)
        val fixedBytes = bytes(ReferencePage(context.summary, context.target, context.side, emptyList(), emptyDelivery)) -
            bytes(emptyDelivery)
        fun required(count: Int, recordBytes: Int): Int =
            fixedBytes + bytes(delivery(count)) + recordBytes + maxOf(0, count - 1)
        val headerBytes = required(0, 0)
        if (headerBytes > byteBudget) throw InspectException("budget-too-small", "Response header exceeds budget", headerBytes)
        var recordBytes = 0
        while (records.hasNext()) {
            val next = records.next()
            val encodedBytes = bytes(next)
            val count = items.size + 1
            val candidateBytes = required(count, recordBytes + encodedBytes)
            if (candidateBytes > byteBudget) {
                if (items.isEmpty()) throw InspectException("budget-too-small", "Next record exceeds budget", candidateBytes)
                break
            }
            items += next
            recordBytes += encodedBytes
        }
        return ReferencePage(context.summary, context.target, context.side, items, delivery(items.size))
    }

    private fun bytes(value: Any): Int = json.toJson(value).toByteArray(StandardCharsets.UTF_8).size

    private fun encode(offset: Int, context: PageContext): String {
        val payload = "$offset:${context.summary.analysisId}:${context.target.id}:${context.side}:${context.manifestDigest}"
        val data = "$offset:${sha(payload)}"
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data.toByteArray(StandardCharsets.UTF_8))
    }

    private fun decode(cursor: String, context: PageContext): Int {
        try {
            val decoded = String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8)
            val parts = decoded.split(':')
            if (parts.size != 2) throw IllegalArgumentException()
            val offset = parts[0].toInt()
            if (offset <= 0 || encode(offset, context) != cursor) throw IllegalArgumentException()
            return offset
        } catch (_: IllegalArgumentException) {
            throw InspectException("invalid-cursor", "Cursor does not match this analysis, target, side, and manifest")
        }
    }

    private fun sha(text: String): String = java.util.HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(StandardCharsets.UTF_8)),
    )
}
