package com.leveret.inspect.java

import com.leveret.inspect.classpath.ClasspathAnalysis
import com.leveret.inspect.classpath.MavenTuple
import com.leveret.inspect.classpath.RepositoryPolicy
import java.nio.file.Files
import java.nio.file.Path
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class JavaExtractorTest {
    @Test
    fun `numeric overload retains unchanged test call and excludes string overload`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        val test = dir.resolve("src/test/java/example/PricingTest.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, "package example;\nfinal class Pricing {\n    static int price(int quantity) { return quantity * 12; }\n    static int price(String code) { return code.length(); }\n}\n")
        Files.writeString(test, "package example;\nfinal class PricingTest {\n    int numeric() { return Pricing.price(3); }\n    int textual() { return Pricing.price(\"ABC\"); }\n}\n")
        val data = JavaExtractor.extract(input(dir, listOf(main), listOf(test)))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        val references = data.references.filter { it.targetId == numeric.id }
        assertThat(references.map { it.location.path }).containsExactly("src/test/java/example/PricingTest.java")
        assertThat(references.map { it.location.range }).containsExactly(Range(Position(3, 27), Position(3, 43)))
        assertThat(references.map { it.enclosing?.signature }).containsExactly("example.PricingTest.numeric()")
        assertThat(references.map { it.sourceSet }).containsExactly("test")
        assertThat(references.map { it.basis }).containsExactly("checked")
        assertThat(data.coverage.complete).withFailMessage("diagnostics=%s unresolved=%s", data.diagnostics, data.unresolved).isTrue()
    }

    @Test
    fun `missing argument type remains unresolved without erasing checked call`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        val test = dir.resolve("src/test/java/example/PricingTest.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, "package example; class Pricing { static int price(int n) { return n; } static int price(String s) { return 0; } }")
        Files.writeString(test, "package example; class PricingTest { int checked() { return Pricing.price(3); } int unknown() { return Pricing.price(MissingInputs.quantity()); } }")
        val data = JavaExtractor.extract(input(dir, listOf(main), listOf(test)))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.count { it.targetId == numeric.id }).isEqualTo(1)
        assertThat(data.unresolved.map { it.reason }).anyMatch { it.contains("binding") || it.contains("compiler") }
        assertThat(data.coverage.complete).isFalse()
    }

    @Test
    fun `method references in initializer and lambda do not invent callers`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        val test = dir.resolve("src/test/java/example/PricingTest.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, "package example; class Pricing { static int price(int n) { return n; } }\n")
        Files.writeString(test, """
            package example;
            import java.util.function.IntUnaryOperator;
            class PricingTest {
                IntUnaryOperator fromInitializer = Pricing::price;
                IntUnaryOperator fromLambda() { return x -> Pricing.price(x); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(input(dir, listOf(main), listOf(test)))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        val references = data.references.filter { it.targetId == numeric.id }
        assertThat(references.map { it.kind }).containsExactly("method-reference", "call")
        assertThat(references.map { it.enclosing }).containsExactly(null, null)
        assertThat(data.coverage.complete).isTrue()
    }

    @Test
    fun `source content participates in analysis identity`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(main, "package example; class Pricing { int value() { return 10; } }")
        val before = JavaExtractor.extract(input(dir, listOf(main), emptyList())).summary.analysisId
        Files.writeString(main, "package example; class Pricing { int value() { return 12; } }")
        val after = JavaExtractor.extract(input(dir, listOf(main), emptyList())).summary.analysisId
        assertThat(after).isNotEqualTo(before)
    }

    @Test
    fun `UTF16 columns and CRLF are measured on the expression`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(
            main,
            "package example;\r\nclass Pricing {\r\n" +
                "  int price(int n) { return n; }\r\n" +
                "  int caller() { String emoji = \"😀\"; return price(1); }\r\n}\r\n",
        )
        val data = JavaExtractor.extract(input(dir, listOf(main), emptyList()))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.single { it.targetId == numeric.id }.location.range)
            .isEqualTo(Range(Position(4, 45), Position(4, 53)))
    }

    @Test
    fun `ambiguous null call is not a checked overload`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(
            main,
            "package example; class Pricing { int price(String s) { return 1; } " +
                "int price(Integer n) { return 2; } int caller() { return price(null); } }",
        )
        val data = JavaExtractor.extract(input(dir, listOf(main), emptyList()))
        assertThat(data.references).isEmpty()
        assertThat(data.unresolved).hasSize(1)
        assertThat(data.coverage.complete).isFalse()
    }

    @Test
    fun `conflicting source-set assignment is rejected`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(dir.resolve("src/test/java"))
        Files.writeString(main, "package example; class Pricing { int price(int n) { return n; } }")
        org.assertj.core.api.Assertions.assertThatThrownBy {
            JavaExtractor.extract(input(dir, listOf(main), listOf(main)))
        }.isInstanceOf(IllegalArgumentException::class.java)
            .hasMessageContaining("Conflicting declaration identity")
    }

    @Test
    fun `super calls and generic varargs bind their declarations`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(main, """
            package example;
            class Pricing {
                <T extends Number> int price(T... values) { return values.length; }
            }
            class Child extends Pricing {
                int caller() { return super.price(1, 2); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(input(dir, listOf(main), emptyList()))
        val target = data.methods.single { it.signature.contains(".price(") }
        assertThat(data.references.filter { it.targetId == target.id }.map { it.location.range.start.line })
            .containsExactly(6)
        assertThat(data.coverage.complete).isTrue()
    }

    @Test
    fun `test-only dependency cannot resolve a production call`(@TempDir dir: Path) {
        val dependencySource = dir.resolve("dependency/example/TestOnly.java")
        val compiled = dir.resolve("compiled")
        Files.createDirectories(dependencySource.parent)
        Files.createDirectories(compiled)
        Files.writeString(dependencySource, "package example; public class TestOnly { public static int value() { return 3; } }")
        assertThat(javax.tools.ToolProvider.getSystemJavaCompiler().run(
            null, null, null, "-d", compiled.toString(), dependencySource.toString(),
        )).isZero()
        val cache = dir.resolve("cache")
        Files.createDirectories(cache)
        val jar = cache.resolve("test-only.jar")
        java.util.jar.JarOutputStream(Files.newOutputStream(jar)).use { output ->
            output.putNextEntry(java.util.jar.JarEntry("example/TestOnly.class"))
            Files.copy(compiled.resolve("example/TestOnly.class"), output)
            output.closeEntry()
        }
        val main = dir.resolve("src/main/java/example/Pricing.java")
        val test = dir.resolve("src/test/java/example/PricingTest.java")
        Files.createDirectories(main.parent)
        Files.createDirectories(test.parent)
        Files.writeString(main, """
            package example;
            class Pricing {
                static int price(int n) { return n; }
                int checked() { return price(3); }
                int unknown() { return price(TestOnly.value()); }
            }
        """.trimIndent())
        Files.writeString(test, "package example; class PricingTest { int checked() { return Pricing.price(TestOnly.value()); } }")
        val base = input(dir, listOf(main), listOf(test))
        val data = JavaExtractor.extract(base.copy(classpath = base.classpath.copy(testClasspath = listOf("test-only.jar"))))
        val target = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.filter { it.targetId == target.id }.map { it.sourceSet }).containsExactly("main", "test")
        assertThat(data.unresolved.map { it.sourceSet }).contains("main")
        assertThat(data.coverage.complete).isFalse()
    }

    @Test
    fun `missing nested generic bound cannot certify an overload`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(main, """
            package example;
            class Pricing {
                static int price(int n) { return n; }
                static <T extends java.util.List<Missing>> int price(T n) { return 0; }
                int checked() { return price(3); }
                int unresolved() { return price(java.util.List.of()); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(input(dir, listOf(main), emptyList()))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.filter { it.targetId == numeric.id }).hasSize(1)
        assertThat(data.coverage.complete).isFalse()
        assertThat(data.unresolved).isNotEmpty()
    }

    @Test
    fun `missing receiver and parameter types do not become checked calls`(@TempDir dir: Path) {
        val main = dir.resolve("src/main/java/example/Pricing.java")
        Files.createDirectories(main.parent)
        Files.writeString(main, """
            package example;
            class Pricing {
                static int price(int n) { return n; }
                static int price(Missing n) { return 0; }
                int checked() { return price(3); }
                int unresolved() { return Ghost.price(3); }
            }
        """.trimIndent())
        val data = JavaExtractor.extract(input(dir, listOf(main), emptyList()))
        val numeric = data.methods.single { it.signature.contains("price(int)") }
        assertThat(data.references.filter { it.targetId == numeric.id }).hasSize(1)
        assertThat(data.unresolved.map { it.reason }).isNotEmpty()
        assertThat(data.coverage.complete).isFalse()
    }

    private fun input(root: Path, main: List<Path>, test: List<Path>) = JavaAnalysisInput(
        repositoryId = "fixture", revision = "0123456789abcdef", sourceRoot = root,
        mainFiles = main, testFiles = test, mainRoots = listOf(root.resolve("src/main/java")),
        testRoots = listOf(root.resolve("src/test/java")), javaLevel = "21",
        classpath = ClasspathAnalysis(
            MavenTuple("fixture", "fixture"), emptyList(), RepositoryPolicy(true, true, true, "central", "https://repo.maven.apache.org/maven2"),
            emptyList(), emptyList(), listOf("src/test/java"),
        ),
        artifactRoot = root.resolve("cache"),
    )
}
