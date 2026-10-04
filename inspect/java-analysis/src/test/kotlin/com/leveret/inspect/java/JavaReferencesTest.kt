package com.leveret.inspect.java

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class JavaReferencesTest {
    private val manifestHash = "a".repeat(64)

    @Test
    fun `renames and half-open hunks classify only verified originals while generated locations stay generated`() {
        val manifest = ChangeManifest("base", "head", listOf(
            ChangeFile("New.java", "Old.java", "New.java", "rename", listOf(
                ChangeHunk(4, 2, 4, 0), ChangeHunk(10, 0, 8, 2),
            )),
        ))
        fun site(path: String, first: Int, last: Int, column: Int = 1, artifact: BuildArtifactCitation? = null) =
            Location(path, Range(Position(first, 0), Position(last, column)), artifact)

        assertThat(JavaReferences.diffStatus(site("Old.java", 4, 5), manifest, "base")).isEqualTo("in-diff")
        assertThat(JavaReferences.diffStatus(site("Old.java", 4, 5), manifest, "head")).isEqualTo("outside-diff")
        assertThat(JavaReferences.diffStatus(site("New.java", 8, 9), manifest, "head")).isEqualTo("in-diff")
        assertThat(JavaReferences.diffStatus(site("New.java", 4, 4), manifest, "head")).isEqualTo("outside-diff")
        assertThat(JavaReferences.diffStatus(site("New.java", 7, 8, 0), manifest, "head")).isEqualTo("outside-diff")
        assertThat(JavaReferences.diffStatus(site("New.java", 10, 10), manifest, "head")).isEqualTo("outside-diff")
        val generated = site("New.java", 8, 9, artifact = BuildArtifactCitation(manifestHash, "generated", "materialized"))
        assertThat(JavaReferences.diffStatus(generated, manifest, "head")).isEqualTo("generated")
        assertThatThrownBy {
            JavaReferences.diffStatus(
                generated.copy(buildArtifact = generated.buildArtifact!!.copy(origin = "unknown")), manifest, "head",
            )
        }.isInstanceOf(InspectException::class.java)
        assertThatThrownBy { JavaReferences.diffStatus(site("New.java", 1, 2), manifest.copy(truncated = true), "head") }
            .isInstanceOf(InspectException::class.java)
    }

    @Test
    fun `cursor pages preserve records and reject another manifest scope or target artifact`() {
        val summary = AnalysisSummary("a", "fixture", "head", "config", AnalysisCoverage(false, 1, 1, 0, 0, 0, 1, 1))
        val artifact = BuildArtifactCitation(manifestHash, "pricing-original", "authored")
        val target = JavaMethod("4:prod:LPrice;.price(I)I", "LPrice;.price(I)I", "price(int)",
            Location("Pricing.java", Range(Position(1, 0), Position(1, 20)), artifact),
            Range(Position(1, 4), Position(1, 9)), "main")
        val records = (1..9).map { number -> DetailRecord.reference(JavaReference(
            "ref-$number", target.id, Location("PricingTest.java", Range(Position(number, 1), Position(number, 12))),
            null, "test", "call", diffStatus = "outside-diff",
        )) }
        val context = PageContext(summary, target, "head", "outside-diff", "manifest-a", records.size)
        val expected = records.map { it.reference!!.id }
        val delivered = mutableListOf<String>()
        var cursor: String? = null
        var pages = 0
        do {
            val page = JavaReferences.page(records.iterator(), context, 1600, cursor)
            delivered += page.items.mapNotNull { it.reference?.id }
            cursor = page.delivery.nextCursor
            pages++
            assertThat(page.referenceScope).isEqualTo("outside-diff")
            assertThat(page.summary.coverage.complete).isFalse()
            assertThat(com.google.gson.GsonBuilder().serializeNulls().create().toJson(page).toByteArray(Charsets.UTF_8).size)
                .isLessThanOrEqualTo(1600)
            if (cursor != null) {
                for (foreign in listOf(
                    context.copy(manifestDigest = "manifest-b"),
                    context.copy(summary = summary.copy(analysisId = "b")),
                    context.copy(target = target.copy(id = "5:other:${target.bindingKey}")),
                    context.copy(target = target.copy(location = target.location.copy(
                        buildArtifact = artifact.copy(artifactId = "pricing-generated", origin = "materialized"),
                    ))),
                    context.copy(side = "base"),
                    context.copy(referenceScope = "all"),
                )) {
                    val error = org.junit.jupiter.api.assertThrows<InspectException> {
                        JavaReferences.page(records.iterator(), foreign, 1600, cursor)
                    }
                    assertThat(error.code).isEqualTo("invalid-cursor")
                }
            }
        } while (cursor != null)
        assertThat(pages).isGreaterThan(1)
        assertThat(delivered).containsExactlyElementsOf(expected)
        val malformedCursor = org.junit.jupiter.api.assertThrows<InspectException> {
            JavaReferences.page(records.iterator(), context, 1600, "not-a-cursor")
        }
        assertThat(malformedCursor.code).isEqualTo("invalid-cursor")
        val invalidBudget = org.junit.jupiter.api.assertThrows<InspectException> {
            JavaReferences.page(records.iterator(), context, 0, null)
        }
        assertThat(invalidBudget.code).isEqualTo("invalid-input")
    }

    @Test
    fun `mixed original and generated pages fit every accepted byte budget`() {
        val summary = AnalysisSummary("a", "fixture", "head", "config", AnalysisCoverage(false, 1, 1, 0, 0, 0, 1, 1))
        val target = JavaMethod("4:prod:LPrice;.price(I)I", "LPrice;.price(I)I", "price(int)",
            Location("Pricing.java", Range(Position(1, 0), Position(1, 20)), null),
            Range(Position(1, 4), Position(1, 9)), "main")
        val records = (1..12).map { number ->
            val generated = number % 2 == 0
            DetailRecord.reference(JavaReference(
                "ref-$number", target.id,
                Location("PricingTest.java", Range(Position(number, 1), Position(number, 12)),
                    if (generated) BuildArtifactCitation(manifestHash, "generated-$number", "materialized") else null),
                null, "test", "call", diffStatus = if (generated) "generated" else "outside-diff",
            ))
        } + (1..6).map { DetailRecord.file(SourceFile("Other$it.java", "test", false, "unsupported-root")) }
        val context = PageContext(summary, target, "head", "all", "manifest-a", records.size)
        val json = com.google.gson.GsonBuilder().serializeNulls().create()
        val delivered = mutableListOf<Int>()
        val tooSmall = mutableListOf<Int>()
        for (budget in 200..4000) {
            val items = mutableListOf<DetailRecord>()
            var cursor: String? = null
            try {
                do {
                    val page = JavaReferences.page(records.iterator(), context, budget, cursor)
                    assertThat(json.toJson(page).toByteArray(Charsets.UTF_8).size).describedAs("budget $budget")
                        .isLessThanOrEqualTo(budget)
                    items += page.items
                    cursor = page.delivery.nextCursor
                } while (cursor != null)
            } catch (error: InspectException) {
                assertThat(error.code).isEqualTo("budget-too-small")
                tooSmall += budget
                continue
            }
            assertThat(items).describedAs("budget $budget").isEqualTo(records)
            delivered += budget
        }
        assertThat(tooSmall).isNotEmpty()
        assertThat(delivered).isNotEmpty().contains(4000)
    }
}
