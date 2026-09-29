package com.leveret.inspect.java

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class JavaReferencesTest {
    @Test
    fun `renames and zero-line hunks select the chosen side without swallowing unchanged lines`() {
        val manifest = ChangeManifest("base", "head", listOf(
            ChangeFile("New.java", "Old.java", "New.java", "rename", listOf(
                ChangeHunk(4, 2, 4, 0), ChangeHunk(10, 0, 8, 2),
            )),
        ))
        fun site(path: String, first: Int, last: Int, column: Int = 1) = Location(path,
            Range(Position(first, 0), Position(last, column)))
        assertThat(JavaReferences.outsideDiff(site("Old.java", 4, 5), manifest, "base")).isFalse()
        assertThat(JavaReferences.outsideDiff(site("Old.java", 4, 5), manifest, "head")).isTrue()
        assertThat(JavaReferences.outsideDiff(site("New.java", 8, 9), manifest, "head")).isFalse()
        assertThat(JavaReferences.outsideDiff(site("New.java", 4, 4), manifest, "head")).isTrue()
        assertThat(JavaReferences.outsideDiff(site("New.java", 7, 8, 0), manifest, "head")).isTrue()
        assertThatThrownBy { JavaReferences.outsideDiff(site("New.java", 1, 2), manifest.copy(truncated = true), "head") }
            .isInstanceOf(InspectException::class.java)
    }

    @Test
    fun `cursor pages preserve each record and reject another manifest`() {
        val summary = AnalysisSummary("a", "fixture", "head", "config", AnalysisCoverage(false, 1, 1, 0, 0, 0, 1, 1))
        val target = JavaMethod("method-a", "price(int)", Location("Pricing.java", Range(Position(1, 0), Position(1, 20))),
            Range(Position(1, 4), Position(1, 9)), "main")
        val records = (1..9).map { number -> DetailRecord.reference(JavaReference(
            "ref-$number", target.id, Location("PricingTest.java", Range(Position(number, 1), Position(number, 12))),
            null, "test", "call",
        )) }
        val context = PageContext(summary, target, "head", "manifest-a", records.size)
        val expected = records.map { it.reference!!.id }
        val delivered = mutableListOf<String>()
        var cursor: String? = null
        var pages = 0
        do {
            val page = JavaReferences.page(records.iterator(), context, 1500, cursor)
            delivered += page.items.mapNotNull { it.reference?.id }
            cursor = page.delivery.nextCursor
            pages++
            assertThat(page.summary.coverage.complete).isFalse()
            if (cursor != null) {
                assertThatThrownBy { JavaReferences.page(records.iterator(), context.copy(manifestDigest = "manifest-b"), 1500, cursor) }
                    .isInstanceOf(InspectException::class.java)
            }
        } while (cursor != null)
        assertThat(pages).isGreaterThan(1)
        assertThat(delivered).containsExactlyElementsOf(expected)
    }
}
