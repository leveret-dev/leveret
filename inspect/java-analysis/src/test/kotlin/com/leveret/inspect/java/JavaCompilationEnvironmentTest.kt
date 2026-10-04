package com.leveret.inspect.java

import com.leveret.inspect.classpath.ClasspathAnalysis
import com.leveret.inspect.classpath.MavenTuple
import com.leveret.inspect.classpath.RepositoryPolicy
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.eclipse.core.runtime.NullProgressMonitor
import org.eclipse.jdt.core.JavaCore
import org.eclipse.jdt.core.dom.AST
import org.eclipse.jdt.core.dom.ASTParser
import org.eclipse.jdt.core.dom.ASTVisitor
import org.eclipse.jdt.core.dom.CompilationUnit
import org.eclipse.jdt.core.dom.FileASTRequestor
import org.eclipse.jdt.core.dom.IMethodBinding
import org.eclipse.jdt.core.dom.MethodInvocation
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

/** Exported inputs are analysed exactly as declared; every fixture here is parsed by the real JDT. */
class JavaCompilationEnvironmentTest {
    private val worker = JavaCompilationEnvironment.workerPlatform()
    private val manifest = "a".repeat(64)
    private val unsupported = "unsupported-exported-environment"

    @Test
    fun `original consumer resolves the numeric overload of a generated source in a second root`(@TempDir work: Path) {
        val original = work.resolve("roots/original")
        val generated = work.resolve("roots/generated")
        val consumer = writeSource(original.resolve("example/Consumer.java"), """
            package example;
            class Consumer {
                int numeric() { return Pricing.price(3); }
                int textual() { return Pricing.price("ABC"); }
            }
        """.trimIndent())
        val pricing = writeSource(generated.resolve("example/Pricing.java"), """
            package example;
            final class Pricing {
                static int price(int quantity) { return quantity * 12; }
                static int price(String code) { return code.length(); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(analysis(work, compilation(
            "prod",
            files = listOf(
                member(consumer, "src/main/java/example/Consumer.java", "consumer-original"),
                member(pricing, "target/generated-sources/example/Pricing.java", "pricing-generated", "materialized"),
            ),
            roots = listOf(original, generated),
        )))
        val generatedPrice = data.methods.single { it.signature.contains("price(int)") }
        val generatedText = data.methods.single { it.signature.contains("price(java.lang.String)") }
        val numeric = data.references.filter { it.targetId == generatedPrice.id }
        assertThat(numeric.map { it.location.path }).containsExactly("src/main/java/example/Consumer.java")
        assertThat(numeric.map { it.location.range.start.line }).containsExactly(3)
        assertThat(data.references.filter { it.targetId == generatedText.id }.map { it.location.range.start.line })
            .containsExactly(4)
        assertThat(generatedPrice.location.path).isEqualTo("target/generated-sources/example/Pricing.java")
        assertThat(generatedPrice.location.buildArtifact).isEqualTo(citation("pricing-generated", "materialized"))
        assertThat(data.coverage.complete)
            .withFailMessage("diagnostics=%s unresolved=%s", data.diagnostics, data.unresolved).isTrue()
    }

    @Test
    fun `a checked reference carries the citation of the original file that contains the call`(@TempDir work: Path) {
        val consumer = writeSource(work.resolve("roots/original/example/Consumer.java"),
            "package example;\nclass Consumer {\n    int run() { return Pricing.price(3); }\n}")
        val pricing = writeSource(work.resolve("roots/generated/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n * 12; }\n}")
        val data = JavaExtractor.extract(analysis(work, compilation(
            "prod",
            files = listOf(
                member(consumer, "src/main/java/example/Consumer.java", "consumer-original"),
                member(pricing, "target/generated-sources/example/Pricing.java", "pricing-generated", "materialized"),
            ),
            roots = listOf(work.resolve("roots/original"), work.resolve("roots/generated")),
        )))
        val generatedPrice = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.filter { it.targetId == generatedPrice.id }.map { it.location.path })
            .containsExactly("src/main/java/example/Consumer.java")
        assertThat(data.references.single().location.buildArtifact?.artifactId).isEqualTo("consumer-original")
        assertThat(data.references.single().location.buildArtifact?.origin).isEqualTo("authored")
    }

    @Test
    fun `callers in original and generated files keep their own artifact origins`(@TempDir work: Path) {
        val pricing = writeSource(work.resolve("roots/original/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        val consumer = writeSource(work.resolve("roots/original/example/Consumer.java"),
            "package example;\nclass Consumer {\n    int run() { return Pricing.price(1); }\n}")
        val generatedCaller = writeSource(work.resolve("roots/generated/example/Generated.java"),
            "package example;\nclass Generated {\n    int run() { return Pricing.price(2); }\n}")
        val data = JavaExtractor.extract(analysis(work, compilation(
            "prod",
            files = listOf(
                member(pricing, "src/main/java/example/Pricing.java", "pricing-original"),
                member(consumer, "src/main/java/example/Consumer.java", "consumer-original"),
                member(generatedCaller, "target/generated-sources/example/Generated.java", "caller-generated", "materialized"),
            ),
            roots = listOf(work.resolve("roots/original"), work.resolve("roots/generated")),
        )))
        val price = data.methods.single { it.signature.contains(".price(int)") }
        val callers = data.references.filter { it.targetId == price.id }.associateBy { it.location.path }
        assertThat(callers.keys).containsExactlyInAnyOrder(
            "src/main/java/example/Consumer.java", "target/generated-sources/example/Generated.java")
        assertThat(callers.getValue("src/main/java/example/Consumer.java").location.buildArtifact)
            .isEqualTo(citation("consumer-original"))
        assertThat(callers.getValue("target/generated-sources/example/Generated.java").location.buildArtifact)
            .isEqualTo(citation("caller-generated", "materialized"))
        assertThat(callers.getValue("target/generated-sources/example/Generated.java").enclosing?.location?.buildArtifact)
            .isEqualTo(citation("caller-generated", "materialized"))
        assertThat(price.location.buildArtifact).isEqualTo(citation("pricing-original"))
    }

    @Test
    fun `members with identical basenames in different roots stay distinct`(@TempDir work: Path) {
        val exampleValue = writeSource(work.resolve("roots/a/example/Value.java"),
            "package example;\npublic class Value {\n    public static int get(int n) { return n; }\n}")
        val otherValue = writeSource(work.resolve("roots/b/other/Value.java"),
            "package other;\npublic class Value {\n    public static int get(int n) { return n + 1; }\n}")
        val consumer = writeSource(work.resolve("roots/a/example/Consumer.java"), """
            package example;
            class Consumer {
                int one() { return Value.get(1); }
                int two() { return other.Value.get(2); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(analysis(work, compilation(
            "prod",
            files = listOf(
                member(exampleValue, "src/main/java/example/Value.java", "example-value"),
                member(otherValue, "target/generated-sources/other/Value.java", "other-value", "materialized"),
                member(consumer, "src/main/java/example/Consumer.java", "consumer-original"),
            ),
            roots = listOf(work.resolve("roots/a"), work.resolve("roots/b")),
        )))
        val first = data.methods.single { it.signature == "example.Value.get(int)" }
        val second = data.methods.single { it.signature == "other.Value.get(int)" }
        assertThat(first.id).isNotEqualTo(second.id)
        assertThat(first.location.path).isEqualTo("src/main/java/example/Value.java")
        assertThat(second.location.path).isEqualTo("target/generated-sources/other/Value.java")
        assertThat(data.references.filter { it.targetId == first.id }.map { it.location.range.start.line }).containsExactly(3)
        assertThat(data.references.filter { it.targetId == second.id }.map { it.location.range.start.line }).containsExactly(4)
        assertThat(data.coverage.complete)
            .withFailMessage("diagnostics=%s unresolved=%s", data.diagnostics, data.unresolved).isTrue()
    }

    @Test
    fun `compilation variants sharing one binding key get distinct domain scoped identities`(@TempDir work: Path) {
        val text = "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n    int use() { return price(1); }\n}"
        val first = writeSource(work.resolve("roots/a/example/Pricing.java"), text)
        val second = writeSource(work.resolve("roots/b/example/Pricing.java"), text)
        val data = JavaExtractor.extract(analysis(work,
            compilation("variant-a", files = listOf(member(first, "variant-a/example/Pricing.java", "a-pricing")),
                roots = listOf(work.resolve("roots/a"))),
            compilation("variant-b", files = listOf(member(second, "variant-b/example/Pricing.java", "b-pricing")),
                roots = listOf(work.resolve("roots/b"))),
        ))
        val methods = data.methods.filter { it.signature.contains(".price(int)") }
        assertThat(methods.map { it.id }).doesNotHaveDuplicates().hasSize(2)
        assertThat(methods.single { it.location.path.startsWith("variant-a/") }.id)
            .isEqualTo("9:variant-a:Lexample/Pricing;.price(I)I")
        assertThat(data.references).hasSize(2)
        for (reference in data.references) {
            assertThat(methods.single { it.id == reference.targetId }.location.path).isEqualTo(reference.location.path)
        }
        assertThat(data.unresolved).isEmpty()
        assertThat(data.coverage.complete).isTrue()
    }

    @Test
    fun `each compilation is analysed at its own language level`(@TempDir work: Path) {
        val prod = writeSource(work.resolve("roots/main/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n * 12; }\n}")
        val test = writeSource(work.resolve("roots/test/example/PricingTest.java"), """
            package example;
            record Quote(int amount) {}
            class PricingTest {
                int numeric() {
                    var quote = new Quote(3);
                    return quote.amount();
                }
            }
        """.trimIndent())
        fun run(prodLevel: String, testLevel: String) = JavaExtractor.extract(analysis(work,
            compilation("prod", files = listOf(member(prod, "src/main/java/example/Pricing.java", "pricing-original")),
                roots = listOf(work.resolve("roots/main")), compiler = supported(prodLevel)),
            compilation("test", sourceSet = "test",
                files = listOf(member(test, "src/test/java/example/PricingTest.java", "test-original")),
                roots = listOf(work.resolve("roots/test")), compiler = supported(testLevel)),
        ))
        val scoped = run("11", "21")
        assertThat(scoped.coverage.complete)
            .withFailMessage("diagnostics=%s unresolved=%s", scoped.diagnostics, scoped.unresolved).isTrue()
        assertThat(scoped.methods.map { it.sourceSet }).containsExactlyInAnyOrder("main", "test")
        // The record needs a newer level than production uses; pooling the levels would fail this compilation.
        val pooled = run("11", "11")
        assertThat(pooled.coverage.complete).isFalse()
        assertThat(pooled.diagnostics.filter { it.startsWith("test:") }).isNotEmpty()
    }

    @Test
    fun `compiler and file encodings are explicit and only UTF-8 is supported`(@TempDir work: Path) {
        val file = writeSource(work.resolve("roots/main/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        fun run(compiler: JavaCompilationEnvironment, fileEncoding: String = "UTF-8") = JavaExtractor.extract(analysis(work,
            compilation("prod",
                files = listOf(JavaSourceInput(file, "src/main/java/example/Pricing.java", fileEncoding, citation("pricing-original"))),
                roots = listOf(work.resolve("roots/main")), compiler = compiler)))
        assertThat(run(supported()).coverage.complete).isTrue()
        assertThatThrownBy { run(supported().copy(encoding = "ISO-8859-1")) }
            .isInstanceOf(InspectException::class.java)
            .hasFieldOrPropertyWithValue("code", unsupported)
            .hasMessageContaining("prod").hasMessageContaining("encoding")
        assertThatThrownBy { run(supported(), fileEncoding = "ISO-8859-1") }
            .isInstanceOf(InspectException::class.java)
            .hasFieldOrPropertyWithValue("code", unsupported)
            .hasMessageContaining("prod").hasMessageContaining("encoding")
    }

    @Test
    fun `a jar owned by an upstream compilation joins its callers to that compilations source declaration`(@TempDir work: Path) {
        val fixture = ownership(work)
        val data = fixture.run(listOf(fixture.owned), listOf(JavaOrigin(fixture.owned, citation("prod-output"), "prod")))
        val price = data.methods.single { it.signature.contains("price(int)") }
        val callers = data.references.filter { it.targetId == price.id }
        assertThat(callers.map { it.location.path }).containsExactly("src/test/java/example/PricingTest.java")
        assertThat(callers.map { it.sourceSet }).containsExactly("test")
        assertThat(callers.map { it.enclosing?.signature }).containsExactly("example.PricingTest.numeric()")
        assertThat(data.coverage.complete).isTrue()
    }

    @Test
    fun `a jar with the same binary type name but no ownership never acquires callers of a source declaration`(@TempDir work: Path) {
        val fixture = ownership(work)
        val data = fixture.run(listOf(fixture.rogue), listOf(JavaOrigin(fixture.rogue, citation("rogue"), null)))
        assertThat(data.methods.map { it.signature }).anyMatch { it.contains("price(int)") }
        assertThat(data.references).isEmpty()
        assertThat(data.unresolved).isEmpty()
    }

    @Test
    fun `an unowned jar that shadows an owned one leaves the call unresolved`(@TempDir work: Path) {
        val fixture = ownership(work)
        val data = fixture.run(
            listOf(fixture.rogue, fixture.owned),
            listOf(JavaOrigin(fixture.rogue, citation("rogue"), null), JavaOrigin(fixture.owned, citation("prod-output"), "prod")),
        )
        assertThat(data.references).isEmpty()
        assertThat(data.unresolved.map { it.reason }).containsExactly("target-origin-unresolved")
        assertThat(data.coverage.complete).isFalse()
    }

    @Test
    fun `exported compilations see only their declared source path and classpath`(@TempDir work: Path) {
        val prod = writeSource(work.resolve("roots/main/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        val test = writeSource(work.resolve("roots/test/example/PricingTest.java"),
            "package example;\nclass PricingTest {\n    int numeric() { return Pricing.price(3); }\n}")
        fun run(sourcePath: List<Path>) = JavaExtractor.extract(analysis(work,
            compilation("prod", files = listOf(member(prod, "src/main/java/example/Pricing.java", "pricing-original")),
                roots = listOf(work.resolve("roots/main"))),
            compilation("test", sourceSet = "test",
                files = listOf(member(test, "src/test/java/example/PricingTest.java", "test-original")),
                roots = listOf(work.resolve("roots/test")), sourcePath = sourcePath),
        ))
        // No main-root union is injected: the test compilation cannot see production without declaring it.
        val isolated = run(emptyList())
        assertThat(isolated.references).isEmpty()
        assertThat(isolated.unresolved.filter { it.sourceSet == "test" }).isNotEmpty()
        assertThat(isolated.coverage.complete).isFalse()
        // A declared source path reaches the owning compilation's declaration through the source file origin.
        val declared = run(listOf(work.resolve("roots/main")))
        val price = declared.methods.single { it.signature.contains("price(int)") }
        val callers = declared.references.filter { it.targetId == price.id }
        assertThat(callers.map { it.location.path }).containsExactly("src/test/java/example/PricingTest.java")
        assertThat(price.id).startsWith("4:prod:")
    }

    @Test
    fun `duplicate declarations in one environment stay indeterminate`(@TempDir work: Path) {
        val first = writeSource(work.resolve("roots/a/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        val second = writeSource(work.resolve("roots/b/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n + 1; }\n}")
        val consumer = writeSource(work.resolve("roots/a/example/Consumer.java"),
            "package example;\nclass Consumer {\n    int run() { return Pricing.price(4); }\n}")
        val data = JavaExtractor.extract(analysis(work, compilation(
            "prod",
            files = listOf(
                member(consumer, "src/main/java/example/Consumer.java", "consumer-original"),
                member(first, "src/main/java/example/Pricing.java", "pricing-original"),
                member(second, "target/generated-sources/example/Pricing.java", "pricing-generated", "materialized"),
            ),
            roots = listOf(work.resolve("roots/a"), work.resolve("roots/b")),
        )))
        assertThat(data.references.filter { it.targetId.contains("Pricing;.price") }).isEmpty()
        assertThat(data.unresolved.map { it.reason }).contains("duplicate-declaration-identity")
        assertThat(data.coverage.complete).isFalse()
    }

    @Test
    fun `a newer JDK API cannot be certified under a claimed older release`(@TempDir work: Path) {
        val streams = writeSource(work.resolve("roots/main/example/Streams.java"),
            "package example;\nclass Streams {\n    int size() { return java.util.stream.Stream.of(1, 2).toList().size(); }\n}")
        fun run(release: JavaRelease) = JavaExtractor.extract(analysis(work,
            compilation("prod", files = listOf(member(streams, "src/main/java/example/Streams.java", "streams-original")),
                roots = listOf(work.resolve("roots/main")), compiler = supported("11").copy(release = release))))
        // The worker platform has Stream.toList (Java 16): without a release guard JDT would accept it at level 11.
        assertThat(run(JavaRelease.UNSET).coverage.complete).isTrue()
        assertThatThrownBy { run(JavaRelease("set", "11")) }
            .isInstanceOf(InspectException::class.java)
            .hasFieldOrPropertyWithValue("code", unsupported)
            .hasMessageContaining("release")
        assertThatThrownBy { run(JavaRelease.UNKNOWN) }
            .isInstanceOf(InspectException::class.java)
            .hasFieldOrPropertyWithValue("code", unsupported)
    }

    @Test
    fun `known UTF-8 preview-disabled unset-release environment with the worker platform is supported`() {
        assertThat(supported("11").supportProblem(worker)).isNull()
        assertThat(supported("21").supportProblem(worker)).isNull()
        assertThat(JavaCompilationEnvironment.legacy("21").supportProblem(worker)).isNull()
    }

    @Test
    fun `release selected or unknown platforms are unsupported even when fingerprints match`() {
        assertThat(supported().copy(release = JavaRelease("set", "17")).supportProblem(worker)).contains("release")
        assertThat(supported().copy(release = JavaRelease.UNKNOWN).supportProblem(worker)).contains("release")
    }

    @Test
    fun `platform support requires matching verified fingerprints rather than version strings`() {
        assertThat(supported().copy(platform = emptyMap()).supportProblem(worker)).contains("platform")
        val modules = worker.getValue("modules")
        assertThat(supported().copy(platform = worker + ("modules" to "0".repeat(64))).supportProblem(worker)).contains("platform")
        assertThat(supported().copy(platform = mapOf("rt.jar" to modules)).supportProblem(worker)).contains("platform")
        assertThat(supported().copy(platform = mapOf("release" to worker.getValue("release"))).supportProblem(worker)).contains("platform")
        assertThat(supported().copy(platform = worker + ("rt.jar" to "1".repeat(64))).supportProblem(worker)).contains("platform")
        // A worker that cannot verify its own platform cannot vouch for anyone else's.
        assertThat(supported().supportProblem(worker - "modules")).contains("platform")
    }

    @Test
    fun `encoding preview levels and JPMS options must be known supported and unused`() {
        assertThat(supported().copy(encoding = null).supportProblem(worker)).contains("encoding")
        assertThat(supported().copy(encoding = "ISO-8859-1").supportProblem(worker)).contains("encoding")
        assertThat(supported().copy(preview = null).supportProblem(worker)).contains("preview")
        assertThat(supported().copy(preview = true).supportProblem(worker)).contains("preview")
        assertThat(supported().copy(sourceLevel = null).supportProblem(worker)).contains("source level")
        assertThat(supported().copy(sourceLevel = "99").supportProblem(worker)).contains("source level")
        assertThat(supported().copy(targetLevel = null).supportProblem(worker)).contains("target level")
        assertThat(supported().copy(targetLevel = "99").supportProblem(worker)).contains("target level")
        assertThat(supported().copy(usedModuleOptions = null).supportProblem(worker)).contains("module options")
        assertThat(supported().copy(usedModuleOptions = listOf("addExports")).supportProblem(worker))
            .contains("module options").contains("addExports")
    }

    @Test
    fun `analysis identity covers settings paths origins manifest identity and artifact bytes`(@TempDir work: Path) {
        val file = writeSource(work.resolve("roots/main/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        val jar = work.resolve("artifacts/lib.jar")
        Files.createDirectories(jar.parent)
        Files.writeString(jar, "library bytes")
        val root = work.resolve("roots/main")
        val base = analysis(work, compilation(
            "prod", files = listOf(member(file, "src/main/java/example/Pricing.java", "pricing-original")), roots = listOf(root),
            classpath = listOf(jar), origins = listOf(JavaOrigin(jar, citation("lib"), "upstream")),
        ))
        val prod = base.compilations.single()
        fun changed(change: (JavaCompilationInput) -> JavaCompilationInput) = base.copy(compilations = listOf(change(prod)))
        val variants = listOf(
            base,
            base.copy(buildIdentity = "exported:" + "b".repeat(64)),
            changed { it.copy(compiler = it.compiler.copy(sourceLevel = "17", targetLevel = "17")) },
            changed { it.copy(compiler = it.compiler.copy(targetLevel = "17")) },
            changed { it.copy(compiler = it.compiler.copy(preview = true)) },
            changed { it.copy(compiler = it.compiler.copy(encoding = "ISO-8859-1")) },
            changed { it.copy(compiler = it.compiler.copy(release = JavaRelease("set", "11"))) },
            changed { it.copy(compiler = it.compiler.copy(usedModuleOptions = listOf("addExports"))) },
            changed { it.copy(compiler = it.compiler.copy(platform = worker + ("rt.jar" to "0".repeat(64)))) },
            changed { it.copy(origins = listOf(JavaOrigin(jar, citation("lib"), null))) },
            changed { it.copy(origins = listOf(JavaOrigin(jar, citation("other-lib"), "upstream"))) },
            changed { it.copy(resolutionDomain = "elsewhere") },
            changed { it.copy(id = "renamed") },
            changed { it.copy(sourceSet = "test") },
            changed { it.copy(sourcePath = listOf(root)) },
            changed { it.copy(roots = listOf(root, work.resolve("roots"))) },
            changed { it.copy(files = listOf(member(file, "src/other/Pricing.java", "pricing-original"))) },
            changed { it.copy(files = listOf(member(file, "src/main/java/example/Pricing.java", "pricing-generated", "materialized"))) },
        )
        val ids = variants.map { JavaAnalysisIdentity.compute(it).analysisId }
        assertThat(ids).doesNotHaveDuplicates()
        val before = JavaAnalysisIdentity.compute(base)
        Files.writeString(jar, "different library bytes")
        val after = JavaAnalysisIdentity.compute(base)
        assertThat(after.analysisId).isNotEqualTo(before.analysisId)
        assertThat(after.configurationSha256).isEqualTo(before.configurationSha256)
    }

    @Test
    fun `cache-only inputs keep one shared resolution domain with the legacy path semantics`(@TempDir root: Path) {
        val main = writeSource(root.resolve("src/main/java/example/Pricing.java"), "package example; class Pricing {}")
        val test = writeSource(root.resolve("src/test/java/example/PricingTest.java"), "package example; class PricingTest {}")
        val classpath = ClasspathAnalysis(
            MavenTuple("fixture", "fixture"), emptyList(),
            RepositoryPolicy(true, true, true, "central", "https://repo.maven.apache.org/maven2"),
            listOf("main.jar"), listOf("test.jar", "main.jar"), listOf("src/test/java"),
        )
        val input = JavaAnalysisInput.cacheOnly(
            "fixture", "0123456789abcdef", root, listOf(main), listOf(test),
            listOf(root.resolve("src/main/java")), listOf(root.resolve("src/test/java")), "21", classpath, root.resolve("cache"),
        )
        val (production, tests) = input.compilations
        assertThat(input.compilations.map { it.id }).containsExactly("main", "test")
        assertThat(input.compilations.map { it.sourceSet }).containsExactly("main", "test")
        assertThat(input.compilations.map { it.resolutionDomain }.distinct()).hasSize(1)
        assertThat(production.sourcePath).containsExactly(root.resolve("src/main/java"))
        assertThat(tests.sourcePath).containsExactly(root.resolve("src/main/java"), root.resolve("src/test/java"))
        assertThat(production.classpath).containsExactly(root.resolve("cache/main.jar"))
        assertThat(tests.classpath).containsExactly(root.resolve("cache/main.jar"), root.resolve("cache/test.jar"))
        assertThat(production.files.map { it.displayPath }).containsExactly("src/main/java/example/Pricing.java")
        assertThat(tests.files.map { it.buildArtifact }).containsOnlyNulls()
        assertThat(input.buildIdentity).contains(classpath.write())
        assertThat(input.compilations.map { it.compiler.supportProblem(worker) }).containsOnlyNulls()
        assertThatThrownBy {
            JavaAnalysisInput.cacheOnly("fixture", "0123456789abcdef", root, listOf(main), listOf(test),
                listOf(root.resolve("src/main/java")), listOf(root.resolve("src/test/java")), "99", classpath, root.resolve("cache"))
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("Unsupported Java level 99")
    }

    @Test
    fun `origin index resolves owned binary shadowing binaries and source providers from compiler path order`(@TempDir work: Path) {
        val text = "package example; public class Pricing { public static int price(int n) { return n; } }"
        val owned = jar(work, "owned", "example/Pricing.java" to text)
        val rogue = jar(work, "rogue", "example/Pricing.java" to text.replace("return n;", "return n + 1;"))
        val sourceRoot = work.resolve("roots/source")
        val pricing = writeSource(sourceRoot.resolve("example/Pricing.java"), text)
        val consumer = writeSource(work.resolve("roots/consumer/example/Consumer.java"),
            "package example;\nclass Consumer {\n    int run() { return Pricing.price(3); }\n}")
        fun origin(sourcePath: List<Path>, classpath: List<Path>, origins: List<JavaOrigin>): ResolvedMethodOrigin? {
            val unit = compilation("c", files = listOf(member(consumer, "Consumer.java", "consumer")),
                roots = listOf(work.resolve("roots/consumer")), sourcePath = sourcePath, classpath = classpath, origins = origins)
            return JavaOriginIndex(listOf(unit)).use { index ->
                firstCall(consumer, sourcePath, classpath) { binding -> index.resolve(binding, "c") }
            }
        }
        assertThat(origin(emptyList(), listOf(owned), listOf(JavaOrigin(owned, citation("owned"), "prod"))))
            .isEqualTo(ResolvedMethodOrigin.Binary("prod"))
        assertThat(origin(emptyList(), listOf(rogue), listOf(JavaOrigin(rogue, citation("rogue"), null))))
            .isEqualTo(ResolvedMethodOrigin.Binary(null))
        assertThat(origin(emptyList(), listOf(rogue, owned),
            listOf(JavaOrigin(rogue, citation("rogue"), null), JavaOrigin(owned, citation("owned"), "prod")))).isNull()
        assertThat(origin(listOf(sourceRoot), emptyList(), emptyList()))
            .isEqualTo(ResolvedMethodOrigin.Source(pricing.toRealPath()))
    }

    @Test
    fun `unsafe display paths ambiguous identities and unknown source sets are rejected at the boundary`(@TempDir work: Path) {
        val file = writeSource(work.resolve("roots/main/example/Pricing.java"),
            "package example;\nclass Pricing {\n    static int price(int n) { return n; }\n}")
        val other = writeSource(work.resolve("roots/other/example/Other.java"), "package example;\nclass Other {}")
        val root = work.resolve("roots/main")
        fun run(vararg compilations: JavaCompilationInput) = JavaExtractor.extract(analysis(work, *compilations))
        for (display in listOf("/etc/passwd", "../outside/Pricing.java", "src/./Pricing.java", "src\\Pricing.java", "", "src//Pricing.java")) {
            assertThatThrownBy { run(compilation("prod", files = listOf(member(file, display, "pricing-original")), roots = listOf(root))) }
                .describedAs(display).isInstanceOf(IllegalArgumentException::class.java)
        }
        assertThatThrownBy {
            run(compilation("prod", sourceSet = "other", files = listOf(member(file, "src/Pricing.java", "pricing-original")), roots = listOf(root)))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            run(compilation("", files = listOf(member(file, "src/Pricing.java", "pricing-original")), roots = listOf(root)))
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            run(
                compilation("prod", files = listOf(member(file, "src/Pricing.java", "pricing-original")), roots = listOf(root)),
                compilation("prod", files = listOf(member(other, "src/Other.java", "other-original")), roots = listOf(work.resolve("roots/other"))),
            )
        }.isInstanceOf(IllegalArgumentException::class.java)
        assertThatThrownBy {
            run(
                compilation("prod", domain = "shared", files = listOf(member(file, "src/Pricing.java", "pricing-original")), roots = listOf(root)),
                compilation("test", domain = "shared", sourceSet = "test", files = listOf(member(file, "src/Pricing.java", "pricing-original")), roots = listOf(root)),
            )
        }.isInstanceOf(IllegalArgumentException::class.java).hasMessageContaining("only one source set")
    }

    private class Ownership(
        val owned: Path, val rogue: Path, val run: (List<Path>, List<JavaOrigin>) -> AnalysisData,
    )

    /** Production source, a jar built from it, an unrelated jar with the same type name, and a test compilation. */
    private fun ownership(work: Path): Ownership {
        val text = "package example; public class Pricing { public static int price(int n) { return n * 12; } }"
        val prod = writeSource(work.resolve("roots/main/example/Pricing.java"), text)
        val test = writeSource(work.resolve("roots/test/example/PricingTest.java"),
            "package example;\nclass PricingTest {\n    int numeric() { return Pricing.price(3); }\n}")
        val owned = jar(work, "prod-output", "example/Pricing.java" to text)
        val rogue = jar(work, "rogue", "example/Pricing.java" to
            "package example; public class Pricing { public static int price(int n) { return -n; } public static int extra() { return 1; } }")
        return Ownership(owned, rogue) { classpath, origins ->
            JavaExtractor.extract(analysis(work,
                compilation("prod", domain = "shared",
                    files = listOf(member(prod, "src/main/java/example/Pricing.java", "pricing-original")),
                    roots = listOf(work.resolve("roots/main"))),
                compilation("test", domain = "shared", sourceSet = "test",
                    files = listOf(member(test, "src/test/java/example/PricingTest.java", "test-original")),
                    roots = listOf(work.resolve("roots/test")), classpath = classpath, origins = origins),
            ))
        }
    }

    private fun <T> firstCall(file: Path, sourcePath: List<Path>, classpath: List<Path>, body: (IMethodBinding) -> T): T? {
        val parser = ASTParser.newParser(AST.getJLSLatest())
        parser.setResolveBindings(true)
        parser.setBindingsRecovery(false)
        val options = JavaCore.getOptions()
        JavaCore.setComplianceOptions("21", options)
        parser.setCompilerOptions(options)
        parser.setEnvironment(
            classpath.map { it.toString() }.toTypedArray(), sourcePath.map { it.toString() }.toTypedArray(), null, true,
        )
        var result: T? = null
        var called = false
        parser.createASTs(arrayOf(file.toString()), null, emptyArray<String>(), object : FileASTRequestor() {
            override fun acceptAST(sourceFilePath: String, ast: CompilationUnit) {
                ast.accept(object : ASTVisitor() {
                    override fun visit(node: MethodInvocation): Boolean {
                        val binding = node.resolveMethodBinding()
                        if (!called && binding != null) {
                            called = true
                            result = body(binding)
                        }
                        return true
                    }
                })
            }
        }, NullProgressMonitor())
        check(called) { "No resolved invocation in $file" }
        return result
    }

    private fun jar(work: Path, name: String, vararg sources: Pair<String, String>): Path {
        val classes = work.resolve("jar-classes/$name")
        Files.createDirectories(classes)
        val files = sources.map { (relative, text) -> writeSource(work.resolve("jar-src/$name/$relative"), text).toString() }
        check(javax.tools.ToolProvider.getSystemJavaCompiler().run(null, null, null, "-d", classes.toString(), *files.toTypedArray()) == 0)
        val jar = work.resolve("artifacts/$name.jar")
        Files.createDirectories(jar.parent)
        java.util.jar.JarOutputStream(Files.newOutputStream(jar)).use { output ->
            Files.walk(classes).use { walk ->
                for (file in walk.filter { Files.isRegularFile(it) }.sorted().toList()) {
                    output.putNextEntry(java.util.jar.JarEntry(classes.relativize(file).toString().replace('\\', '/')))
                    Files.copy(file, output)
                    output.closeEntry()
                }
            }
        }
        return jar
    }

    private fun citation(artifact: String, origin: String = "authored") = BuildArtifactCitation(manifest, artifact, origin)

    private fun supported(level: String = "21") = JavaCompilationEnvironment(
        sourceLevel = level, targetLevel = level, encoding = "UTF-8", preview = false,
        release = JavaRelease.UNSET, platform = worker, usedModuleOptions = emptyList(),
    )

    private fun writeSource(path: Path, text: String): Path {
        Files.createDirectories(path.parent)
        return Files.writeString(path, text)
    }

    private fun member(physical: Path, display: String, artifact: String, origin: String = "authored") =
        JavaSourceInput(physical, display, "UTF-8", citation(artifact, origin))

    private fun compilation(
        id: String, files: List<JavaSourceInput>, roots: List<Path>, domain: String = id, sourceSet: String = "main",
        sourcePath: List<Path> = emptyList(), classpath: List<Path> = emptyList(),
        compiler: JavaCompilationEnvironment = supported(), origins: List<JavaOrigin> = emptyList(),
    ) = JavaCompilationInput(id, domain, sourceSet, files, roots, sourcePath, classpath, compiler, origins)

    private fun analysis(work: Path, vararg compilations: JavaCompilationInput, buildIdentity: String = "exported:$manifest") =
        JavaAnalysisInput(
            "fixture", "0123456789abcdef", work, work.resolve("artifacts"), compilations.toList(),
            emptyList(), emptyList(), buildIdentity,
        )
}
