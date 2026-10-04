package com.leveret.inspect.java

import com.google.gson.JsonParser
import com.leveret.inspect.db.config.DatabaseSettings
import com.leveret.inspect.db.config.DatabaseKeys
import com.leveret.inspect.db.pool.Database
import com.leveret.inspect.db.session.SessionFactory
import com.leveret.inspect.runtime.config.PropertyKeys
import com.leveret.inspect.runtime.config.Settings
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class JavaFactStoreTest {
    @Test
    fun `base and head persist separately while conflicting publication rolls back`(@TempDir home: Path) {
        val base = fixture("base", "a", "price(int)")
        val head = fixture("head", "b", "price(int)")
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(base)
            store.publish(head)
            assertThatThrownBy { store.publish(base.copy(methods = emptyList())) }
                .isInstanceOf(InspectException::class.java)
            val failed = fixture("failed", "c", "price(int)")
            assertThatThrownBy { store.publish(failed.copy(references = failed.references + failed.references.single())) }
                .isNotNull()
            assertThatThrownBy { store.summary("c") }
                .isInstanceOf(InspectException::class.java)
            assertThat(store.summary("a")).isEqualTo(base.summary)
            assertThat(store.summary("b")).isEqualTo(head.summary)
        }
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            assertThat(store.summary("a")).isEqualTo(base.summary)
            assertThat(store.summary("b")).isEqualTo(head.summary)
            assertThatThrownBy { store.summary("c") }
                .isInstanceOf(InspectException::class.java)
            assertThat(store.methodAt("a", TargetSelector(
                "src/main/java/Pricing.java", Position(3, 17), null,
            )).id).isEqualTo("7:fixture:Lfixture/Pricing;.price(I)I")
            val manifest = ChangeManifest("base", "head", listOf(ChangeFile(
                "src/main/java/Pricing.java", "src/main/java/Pricing.java", "src/main/java/Pricing.java",
                "delete", listOf(ChangeHunk(3, 1, 3, 0)),
            )))
            val selector = TargetSelector("src/main/java/Pricing.java", Position(3, 17), null)
            val basePage = store.query(ReferenceRequest("a", "config", manifest, "base", selector, "outside-diff"))
            assertThat(basePage.items.mapNotNull { it.reference?.id }).containsExactly("ref-a")
            assertThatThrownBy { store.query(ReferenceRequest("b", "config", manifest, "base", selector, "outside-diff")) }
                .isInstanceOf(InspectException::class.java)
                .hasMessageContaining("revision")
            assertThatThrownBy {
                store.query(ReferenceRequest("a", "config", manifest.copy(truncated = true), "base", selector, "outside-diff"))
            }
                .isInstanceOf(InspectException::class.java)
        }
    }

    @Test
    fun `renamed original targets resolve only through the selected side path`(@TempDir home: Path) {
        fun renamed(revision: String, id: String, path: String): AnalysisData {
            val data = fixture(revision, id, "price(int)")
            return data.copy(methods = listOf(data.methods.single().copy(location = data.methods.single().location.copy(path = path))))
        }
        val base = renamed("base", "rename-base", "src/main/java/OldPricing.java")
        val head = renamed("head", "rename-head", "src/main/java/NewPricing.java")
        val manifest = ChangeManifest("base", "head", listOf(ChangeFile(
            "src/main/java/NewPricing.java", "src/main/java/OldPricing.java", "src/main/java/NewPricing.java",
            "rename", listOf(ChangeHunk(3, 1, 3, 1)),
        )))
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(base)
            store.publish(head)
            fun query(data: AnalysisData, side: String, path: String) = store.query(ReferenceRequest(
                data.summary.analysisId, data.summary.configurationSha256, manifest, side,
                TargetSelector(path, Position(3, 17), null), "outside-diff",
            ))
            assertThat(query(base, "base", "src/main/java/OldPricing.java").items.mapNotNull { it.reference?.id })
                .containsExactly("ref-rename-base")
            assertThat(query(head, "head", "src/main/java/NewPricing.java").items.mapNotNull { it.reference?.id })
                .containsExactly("ref-rename-head")
            assertThatThrownBy { query(base, "base", "src/main/java/NewPricing.java") }
                .isInstanceOf(InspectException::class.java)
                .hasMessageContaining("not found")
        }
    }


    @Test
    fun `query delivers checked reference with unresolved coverage on last page`(@TempDir home: Path) {
        val data = fixture("head", "b", "price(int)")
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(data)
            val manifest = ChangeManifest("base", "head", listOf(
                ChangeFile(
                    "src/main/java/Pricing.java", "src/main/java/Pricing.java", "src/main/java/Pricing.java",
                    "modify", listOf(ChangeHunk(3, 1, 3, 1)),
                ),
                ChangeFile(
                    "src/test/java/PricingTest.java", "src/test/java/PricingTest.java", "src/test/java/PricingTest.java",
                    "modify", listOf(ChangeHunk(7, 1, 7, 1)),
                ),
            ))
            val request = ReferenceRequest("b", "config", manifest, "head", TargetSelector(
                "src/main/java/Pricing.java", Position(3, 17), null,
            ), "outside-diff", 65536)
            val page = store.query(request)
            assertThat(page.items.mapNotNull { it.reference }).isEmpty()
            val all = store.query(request.copy(referenceScope = "all"))
            assertThat(all.items.mapNotNull { it.reference?.id }).containsExactly("ref-b")
            assertThat(all.items.mapNotNull { it.reference?.diffStatus }).containsExactly("in-diff")
            assertThat(page.summary.coverage.complete).isFalse()
            assertThat(page.delivery.complete).isTrue()
            assertThatThrownBy { store.query(request.copy(configurationSha256 = "stale")) }
                .isInstanceOf(InspectException::class.java)
                .hasMessageContaining("configuration")
        }
    }

    @Test
    fun `H2 cursor iteration returns each reference once`(@TempDir home: Path) {
        val original = fixture("head", "paged", "price(int)")
        val references = (1..12).map { n -> original.references.single().copy(
            id = "ref-$n", location = Location("src/test/java/PricingTest.java",
                Range(Position(n + 1, 12), Position(n + 1, 28))),
        ) }
        val data = original.copy(references = references)
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(data)
            val manifest = ChangeManifest("base", "head", emptyList())
            val request = ReferenceRequest("paged", "config", manifest, "head",
                TargetSelector("src/main/java/Pricing.java", Position(3, 17), null), "outside-diff", 1700)
            val found = mutableListOf<String>()
            var cursor: String? = null
            do {
                val page = store.query(request.copy(cursor = cursor))
                found += page.items.mapNotNull { it.reference?.id }
                cursor = page.delivery.nextCursor
                assertThat(page.summary.coverage.complete).isFalse()
            } while (cursor != null)
            assertThat(found).containsExactlyElementsOf(references.map { it.id })
        }
    }

    @Test
    fun `first bounded page includes the target caller before bulk file coverage`(@TempDir home: Path) {
        val original = fixture("head", "many-files", "price(int)")
        val files = original.files + (1..400).map { SourceFile("src/main/java/Filler$it.java", "main", true) }
        val data = original.copy(
            summary = original.summary.copy(coverage = original.summary.coverage.copy(mainExamined = 401)),
            files = files,
        )
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(data)
            val page = store.query(ReferenceRequest("many-files", "config", ChangeManifest("head", "head", emptyList()),
                "head", TargetSelector("src/main/java/Pricing.java", Position(3, 17), null), "outside-diff", 65536))
            assertThat(page.items.mapNotNull { it.reference?.id }).containsExactly("ref-many-files")
            assertThat(page.delivery.truncated).isTrue()
            assertThat(page.summary.coverage.mainExamined).isEqualTo(401)
        }
    }

    @Test
    fun `real extraction survives reopen and resolves unchanged test caller`(@TempDir home: Path) {
        val root = home.resolve("source")
        val main = root.resolve("src/main/java/example/Pricing.java")
        val test = root.resolve("src/test/java/example/PricingTest.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, """
            package example;
            class Pricing {
                static int price(int n) { return n * 12; }
                static int price(String s) { return s.length(); }
            }
        """.trimIndent())
        Files.writeString(test, """
            package example;
            class PricingTest {
                int numeric() { return Pricing.price(3); }
                int textual() { return Pricing.price("ABC"); }
            }
        """.trimIndent())
        val input = cacheOnly(root, listOf(main), listOf(test))
        val data = JavaExtractor.extract(input)
        opened(home) { JavaFactStore(it).publish(data) }
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            val manifest = ChangeManifest("base", "head", listOf(ChangeFile(
                "src/main/java/example/Pricing.java", "src/main/java/example/Pricing.java", "src/main/java/example/Pricing.java",
                "modify", listOf(ChangeHunk(3, 1, 3, 1)),
            )))
            val request = ReferenceRequest(data.summary.analysisId, data.summary.configurationSha256, manifest, "head",
                TargetSelector("src/main/java/example/Pricing.java", Position(3, 15), null), "outside-diff")
            val page = store.query(request)
            assertThat(page.items.mapNotNull { it.reference?.location?.path })
                .containsExactly("src/test/java/example/PricingTest.java")
            assertThat(page.items.mapNotNull { it.reference?.location?.range })
                .containsExactly(Range(Position(3, 27), Position(3, 43)))
            assertThat(page.summary.coverage.complete).isTrue()
        }
    }

    @Test
    fun `long legal method signatures survive publication and exact query`(@TempDir home: Path) {
        val root = home.resolve("source")
        val main = root.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        val parameters = (1..60).joinToString(", ") { "java.util.Map<String,java.util.List<Integer>> p$it" }
        val arguments = (1..60).joinToString(", ") { "null" }
        Files.writeString(main, """
            package example;
            class Pricing {
                static int price($parameters) { return 12; }
                int caller() { return price($arguments); }
            }
        """.trimIndent())
        val input = cacheOnly(root, listOf(main), emptyList())
        val data = JavaExtractor.extract(input)
        val declaration = data.methods.single { it.signature.contains(".price(") }
        opened(home) { JavaFactStore(it).publish(data) }
        opened(home) { sessions ->
            val page = JavaFactStore(sessions).query(ReferenceRequest(
                data.summary.analysisId, data.summary.configurationSha256,
                ChangeManifest("head", "head", emptyList()), "head",
                TargetSelector(declaration.location.path,
                    declaration.nameRange.start.copy(column = declaration.nameRange.start.column + 1),
                    declaration.location.buildArtifact),
                "outside-diff",
            ))
            assertThat(page.items.mapNotNull { it.reference?.targetId }).containsExactly(declaration.id)
            assertThat(page.items.mapNotNull { it.reference?.basis }).containsExactly("checked")
        }
    }

    @Test
    fun `duplicate declaration selector is indeterminate after publication`(@TempDir home: Path) {
        val root = home.resolve("source")
        val main = root.resolve("src/main/java/example/Pricing.java")
        val test = root.resolve("src/test/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, "package example; class Pricing { static int price(int n) { return n; } }")
        Files.writeString(test, "package example; class Pricing { static int price(int n) { return n + 1; } }")
        val input = cacheOnly(root, listOf(main), listOf(test))
        val data = JavaExtractor.extract(input)
        val declaration = data.methods.single { it.signature.contains(".price(") }
        opened(home) { JavaFactStore(it).publish(data) }
        opened(home) { sessions ->
            // Both copies share the name position; neither may be selected as a unique target.
            for (path in listOf("src/main/java/example/Pricing.java", "src/test/java/example/Pricing.java")) {
                val error = org.junit.jupiter.api.assertThrows<InspectException> {
                    JavaFactStore(sessions).query(ReferenceRequest(
                        data.summary.analysisId, data.summary.configurationSha256,
                        ChangeManifest("head", "head", emptyList()), "head",
                        TargetSelector(path, declaration.nameRange.start.copy(column = declaration.nameRange.start.column + 1), null),
                        "outside-diff",
                    ))
                }
                assertThat(error.code).describedAs(path).isEqualTo("target-indeterminate")
            }
        }
    }

    @Test
    fun `artifact citations survive publication and declaration lookup`(@TempDir home: Path) {
        val citation = BuildArtifactCitation("a".repeat(64), "pricing-generated", "materialized")
        val base = fixture("head", "cited", "example.Pricing.price(int)")
        val target = base.methods.single().let { it.copy(location = it.location.copy(buildArtifact = citation)) }
        opened(home) { JavaFactStore(it).publish(base.copy(methods = listOf(target))) }
        opened(home) { sessions ->
            val found = JavaFactStore(sessions).methodAt("cited", TargetSelector(
                target.location.path, Position(3, 16), citation,
            ))
            assertThat(found.location.buildArtifact).isEqualTo(citation)
        }
    }

    @Test
    fun `same path and offsets in two compilation variants publish and query by artifact identity`(@TempDir home: Path) {
        val root = home.resolve("source")
        val manifest = "b".repeat(64)
        fun citation(id: String, origin: String) = BuildArtifactCitation(manifest, id, origin)
        fun source(variant: String, name: String, text: String, artifact: String, origin: String): JavaSourceInput {
            val file = root.resolve("$variant/example/$name.java")
            Files.createDirectories(file.parent)
            Files.writeString(file, text)
            return JavaSourceInput(file, "src/main/java/example/$name.java", "UTF-8", citation(artifact, origin))
        }
        fun compilation(id: String, origin: String): JavaCompilationInput {
            val pricing = source(id, "Pricing", """
                package example;
                class Pricing {
                    static int price(int n) { return n; }
                }
            """.trimIndent(), "$id-pricing", origin)
            val consumer = source(id, "Consumer", """
                package example;
                class Consumer {
                    int call() { return Pricing.price(3); }
                }
            """.trimIndent(), "$id-consumer", origin)
            val sourceRoot = root.resolve(id)
            return JavaCompilationInput(id, id, "main", listOf(pricing, consumer), listOf(sourceRoot),
                listOf(sourceRoot), emptyList(), JavaCompilationEnvironment.legacy("21"), emptyList())
        }
        val input = JavaAnalysisInput(
            "fixture", "head", root, root.resolve("artifacts"),
            listOf(compilation("variant-a", "authored"), compilation("variant-b", "materialized")),
            emptyList(), emptyList(), "exported:$manifest",
        )
        val data = JavaExtractor.extract(input)
        val targets = data.methods.filter { it.signature.contains(".price(int)") }
        assertThat(targets.map { it.bindingKey }.distinct()).hasSize(1)
        assertThat(targets.map { it.id }).doesNotHaveDuplicates()
        assertThat(data.references.map { it.id }).doesNotHaveDuplicates()

        opened(home) { JavaFactStore(it).publish(data) }
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            val change = ChangeManifest("head", "head", emptyList())
            fun request(target: JavaMethod, scope: String) = ReferenceRequest(
                data.summary.analysisId, data.summary.configurationSha256, change, "head",
                TargetSelector(target.location.path,
                    target.nameRange.start.copy(column = target.nameRange.start.column + 1),
                    target.location.buildArtifact),
                scope,
            )
            val authored = targets.single { it.location.buildArtifact?.origin == "authored" }
            val generated = targets.single { it.location.buildArtifact?.origin == "materialized" }
            val authoredPage = store.query(request(authored, "outside-diff"))
            assertThat(authoredPage.target.id).isEqualTo(authored.id)
            assertThat(authoredPage.items.mapNotNull { it.reference?.diffStatus }).containsExactly("outside-diff")
            assertThat(store.query(request(generated, "outside-diff")).items.mapNotNull { it.reference }).isEmpty()
            val generatedPage = store.query(request(generated, "all"))
            assertThat(generatedPage.target.id).isEqualTo(generated.id)
            assertThat(generatedPage.items.mapNotNull { it.reference?.diffStatus }).containsExactly("generated")
            assertThat(generatedPage.items.single { it.reference != null }.reference!!.location.buildArtifact?.artifactId)
                .isEqualTo("variant-b-consumer")
            val wrongOrigin = generated.location.buildArtifact!!.copy(origin = "authored")
            val error = org.junit.jupiter.api.assertThrows<InspectException> {
                store.query(request(generated.copy(location = generated.location.copy(buildArtifact = wrongOrigin)), "all"))
            }
            assertThat(error.code).isEqualTo("target-missing")
        }
    }

    @Test
    fun `schema 4 stored locations require explicit null provenance instead of treating omission as original`(@TempDir home: Path) {
        val data = fixture("head", "stored-provenance", "price(int)")
        val manifest = ChangeManifest("head", "head", emptyList())
        val request = ReferenceRequest(
            data.summary.analysisId, data.summary.configurationSha256, manifest, "head",
            TargetSelector(data.methods.single().location.path, Position(3, 17), null), "outside-diff",
        )
        opened(home) { sessions ->
            val store = JavaFactStore(sessions)
            store.publish(data)
            assertThat(store.query(request).items.mapNotNull { it.reference?.diffStatus })
                .containsExactly("outside-diff")
            sessions.open().use { session ->
                val payload = session.select(
                    "select payload from refs where analysis_id=?",
                    { it.setString(1, data.summary.analysisId) },
                ) { it.getString(1) }.single()
                val root = JsonParser.parseString(payload).asJsonObject
                root.getAsJsonObject("reference").getAsJsonObject("location").remove("buildArtifact")
                session.update("update refs set payload=? where analysis_id=?") {
                    it.setString(1, root.toString())
                    it.setString(2, data.summary.analysisId)
                }
                session.commit()
            }
            val error = org.junit.jupiter.api.assertThrows<InspectException> { store.query(request.copy(referenceScope = "all")) }
            assertThat(error.code).isEqualTo("analysis-unavailable")
        }
    }

    private fun cacheOnly(root: Path, main: List<Path>, test: List<Path>) = JavaAnalysisInput.cacheOnly(
        "fixture", "head", root, main, test,
        listOf(root.resolve("src/main/java")), listOf(root.resolve("src/test/java")), "21",
        com.leveret.inspect.classpath.ClasspathAnalysis(
            com.leveret.inspect.classpath.MavenTuple("fixture", "fixture"), emptyList(),
            com.leveret.inspect.classpath.RepositoryPolicy(true, true, true, "central", "https://repo.maven.apache.org/maven2"),
            emptyList(), emptyList(), listOf("src/test/java"),
        ), root.resolve("cache"),
    )

    private fun fixture(revision: String, id: String, signature: String): AnalysisData {
        val bindingKey = "Lfixture/Pricing;.price(I)I"
        val target = JavaMethod("7:fixture:$bindingKey", bindingKey, signature,
            Location("src/main/java/Pricing.java", Range(Position(3, 4), Position(3, 40))),
            Range(Position(3, 15), Position(3, 20)), "main")
        val reference = JavaReference("ref-$id", target.id,
            Location("src/test/java/PricingTest.java", Range(Position(7, 12), Position(7, 28))), null, "test", "call")
        return AnalysisData(
            AnalysisSummary(id, "fixture", revision, "config", AnalysisCoverage(false, 1, 1, 0, 0, 0, 1, 1)),
            listOf(target), listOf(reference), listOf(UnresolvedSite("gap-$id", reference.location, "test", "missing dependency")),
            listOf(SourceFile("src/main/java/Pricing.java", "main", true), SourceFile("src/test/java/PricingTest.java", "test", true)),
            listOf("missing dependency"),
        )
    }

    private fun opened(home: Path, body: (SessionFactory) -> Unit) {
        Files.createDirectories(home.resolve("data"))
        val settings = Settings(DatabaseKeys.defaults + mapOf(PropertyKeys.PATH_HOME to home.toString()))
        Database(DatabaseSettings.from(settings)).use { database ->
            database.start()
            body(SessionFactory(database))
        }
    }
}
