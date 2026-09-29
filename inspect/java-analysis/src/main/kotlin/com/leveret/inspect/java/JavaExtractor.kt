package com.leveret.inspect.java

import java.nio.file.Path
import org.eclipse.jdt.core.JavaCore
import org.eclipse.jdt.core.dom.AST
import org.eclipse.jdt.core.dom.ASTNode
import org.eclipse.jdt.core.dom.ASTParser
import org.eclipse.jdt.core.dom.ASTVisitor
import org.eclipse.jdt.core.dom.CompilationUnit
import org.eclipse.jdt.core.dom.Expression
import org.eclipse.jdt.core.dom.ExpressionMethodReference
import org.eclipse.jdt.core.dom.FileASTRequestor
import org.eclipse.jdt.core.dom.IMethodBinding
import org.eclipse.jdt.core.dom.ITypeBinding
import org.eclipse.jdt.core.dom.MethodDeclaration
import org.eclipse.jdt.core.dom.MethodInvocation
import org.eclipse.jdt.core.dom.SuperMethodInvocation
import org.eclipse.jdt.core.dom.SuperMethodReference
import org.eclipse.jdt.core.dom.TypeMethodReference
import org.eclipse.core.runtime.NullProgressMonitor

object JavaExtractor {
    fun extract(input: JavaAnalysisInput): AnalysisData {
        require(JavaCore.isSupportedJavaVersion(input.javaLevel)) { "Unsupported Java level ${input.javaLevel}" }
        val identity = JavaAnalysisIdentity.compute(input)
        val methods = linkedMapOf<String, JavaMethod>()
        val pending = mutableListOf<PendingReference>()
        val unresolved = mutableListOf<UnresolvedSite>()
        val files = mutableListOf<SourceFile>()
        val diagnostics = input.classpath.diagnostics.map { "${it.sourceSet ?: "all"}: ${it.reason}: ${it.message}" }.toMutableList()
        val root = input.sourceRoot.toRealPath()
        val artifact = input.artifactRoot.toAbsolutePath().normalize()
        for ((scope, sources, roots, paths) in listOf(
            Batch("main", input.mainFiles, input.mainRoots, input.classpath.mainClasspath),
            Batch("test", input.testFiles, input.mainRoots + input.testRoots,
                (input.classpath.mainClasspath + input.classpath.testClasspath).distinct()),
        )) {
            if (sources.isEmpty()) continue
            val parser = ASTParser.newParser(AST.getJLSLatest())
            parser.setResolveBindings(true)
            parser.setBindingsRecovery(false)
            parser.setStatementsRecovery(false)
            val options = JavaCore.getOptions()
            JavaCore.setComplianceOptions(input.javaLevel, options)
            parser.setCompilerOptions(options)
            parser.setEnvironment(
                paths.map { JavaAnalysisIdentity.contained(artifact.toRealPath(), artifact.resolve(it)).toString() }.toTypedArray(),
                roots.filter { java.nio.file.Files.exists(it) }.map { JavaAnalysisIdentity.contained(root, it).toString() }.toTypedArray(),
                null,
                true,
            )
            val requested = sources.map { JavaAnalysisIdentity.contained(root, it).toString() }.toSet()
            parser.createASTs(requested.toTypedArray(), null, emptyArray<String>(), object : FileASTRequestor() {
                override fun acceptAST(sourceFilePath: String, ast: CompilationUnit) {
                    if (sourceFilePath !in requested) return
                    val relative = JavaAnalysisIdentity.relative(root, Path.of(sourceFilePath))
                    files += SourceFile(relative, scope, true)
                    val problems = ast.problems.filter { it.isError }
                    diagnostics += problems.map { "$scope:$relative:${it.sourceLineNumber}: ${it.message}" }
                    ast.accept(object : ASTVisitor() {
                        override fun visit(node: MethodDeclaration): Boolean {
                            if (!node.isConstructor) {
                                val binding = node.resolveBinding()?.methodDeclaration
                                if (binding != null && !binding.isRecovered && !recoveredSignature(binding)) {
                                    val method = JavaMethod(
                                        binding.key, signature(binding), location(ast, relative, node),
                                        range(ast, node.name.startPosition, node.name.length), scope,
                                    )
                                    require(methods.putIfAbsent(method.id, method) == null || methods[method.id] == method) {
                                        "Conflicting declaration identity ${method.id}"
                                    }
                                }
                            }
                            return true
                        }
                        override fun visit(node: MethodInvocation): Boolean {
                            record(node, node.resolveMethodBinding(), "call", node.arguments().filterIsInstance<Expression>() + listOfNotNull(node.expression))
                            return true
                        }
                        override fun visit(node: SuperMethodInvocation): Boolean {
                            record(node, node.resolveMethodBinding(), "call", node.arguments().filterIsInstance<Expression>())
                            return true
                        }
                        override fun visit(node: ExpressionMethodReference): Boolean {
                            record(node, node.resolveMethodBinding(), "method-reference", listOf(node.expression))
                            return true
                        }
                        override fun visit(node: TypeMethodReference): Boolean {
                            record(node, node.resolveMethodBinding(), "method-reference", emptyList())
                            return true
                        }
                        override fun visit(node: SuperMethodReference): Boolean {
                            record(node, node.resolveMethodBinding(), "method-reference", emptyList())
                            return true
                        }
                        private fun record(node: ASTNode, binding: IMethodBinding?, kind: String, expressions: List<Expression>) {
                            val site = location(ast, relative, node)
                            val siteId = "$relative:${node.startPosition}:${node.length}:$kind"
                            val errors = problems.filter { it.sourceStart < node.startPosition + node.length && it.sourceEnd >= node.startPosition }
                            val suspect = binding == null || binding.isRecovered || recoveredSignature(binding) ||
                                expressions.any { expression -> recoveredType(expression.resolveTypeBinding()) } || errors.isNotEmpty()
                            if (suspect) {
                                unresolved += UnresolvedSite(siteId, site, scope,
                                    if (errors.isNotEmpty()) "compiler: ${errors.first().message}" else "binding-unresolved")
                            } else {
                                val enclosing = generateSequence(node.parent) { it.parent }.takeWhile { it !is org.eclipse.jdt.core.dom.LambdaExpression }
                                    .firstOrNull { it is MethodDeclaration || it is org.eclipse.jdt.core.dom.Initializer || it is org.eclipse.jdt.core.dom.AbstractTypeDeclaration }
                                    as? MethodDeclaration
                                pending += PendingReference(
                                    siteId, binding!!.methodDeclaration.key, site,
                                    enclosing?.resolveBinding()?.methodDeclaration?.key, scope, kind, binding.declaringClass.isFromSource,
                                )
                            }
                        }
                    })
                }
            }, NullProgressMonitor())
            for (file in sources) {
                val path = JavaAnalysisIdentity.relative(root, file)
                if (files.none { it.path == path && it.sourceSet == scope }) {
                    files += SourceFile(path, scope, false, "AST unavailable")
                    diagnostics += "$scope:$path: AST unavailable"
                }
            }
        }
        val references = mutableListOf<JavaReference>()
        for (candidate in pending) {
            if (methods[candidate.targetId] == null) {
                if (candidate.sourceTarget) {
                    unresolved += UnresolvedSite(candidate.id, candidate.location, candidate.sourceSet, "target-outside-verified-sources")
                }
            } else {
                references += JavaReference(
                    candidate.id, candidate.targetId, candidate.location,
                    candidate.enclosingId?.let(methods::get), candidate.sourceSet, candidate.kind,
                )
            }
        }
        files += input.skippedFiles
        diagnostics += input.skippedFiles.map { "${it.sourceSet}:${it.path}: ${it.reason}" }
        require(identity == JavaAnalysisIdentity.compute(input)) { "Analysis inputs changed during extraction" }
        val coverage = AnalysisCoverage(
            diagnostics.isEmpty() && unresolved.isEmpty() && files.all { it.examined },
            files.count { it.sourceSet == "main" && it.examined }, files.count { it.sourceSet == "test" && it.examined },
            files.count { it.sourceSet == "main" && !it.examined }, files.count { it.sourceSet == "test" && !it.examined },
            unresolved.count { it.sourceSet == "main" }, unresolved.count { it.sourceSet == "test" }, diagnostics.size,
        )
        return AnalysisData(
            AnalysisSummary(identity.analysisId, input.repositoryId, input.revision, identity.configurationSha256, coverage),
            methods.values.sortedWith(compareBy({ it.location.path }, { it.location.range.start.line }, { it.location.range.start.column }, { it.id })),
            references.sortedWith(compareBy({ it.location.path }, { it.location.range.start.line }, { it.location.range.start.column }, { it.id })),
            unresolved.sortedWith(compareBy({ it.location.path }, { it.location.range.start.line }, { it.location.range.start.column }, { it.id })),
            files, diagnostics,
        )
    }

    private fun recoveredSignature(binding: IMethodBinding): Boolean {
        val declaration = binding.methodDeclaration
        return declaration.isRecovered || recoveredType(declaration.declaringClass) ||
            recoveredType(declaration.returnType) || declaration.parameterTypes.any(::recoveredType) ||
            declaration.typeParameters.any(::recoveredType) || binding.parameterTypes.any(::recoveredType) ||
            binding.typeArguments.any(::recoveredType)
    }

    private fun recoveredType(type: ITypeBinding?): Boolean {
        if (type == null) return true
        val seen = mutableSetOf<String>()
        fun check(value: ITypeBinding): Boolean {
            if (value.isRecovered) return true
            if (!seen.add(value.key ?: return true)) return false
            return value.typeArguments.any(::check) || value.typeBounds.any(::check) ||
                (value.isArray && check(value.elementType)) ||
                (value.isWildcardType && value.bound?.let(::check) == true)
        }
        return check(type)
    }

    private fun signature(binding: IMethodBinding): String {
        val method = binding.methodDeclaration
        val owner = method.declaringClass.qualifiedName.takeIf { it.isNotEmpty() }
            ?: method.declaringClass.binaryName?.takeIf { it.isNotEmpty() }
            ?: method.declaringClass.key
        return "$owner.${method.name}(${method.parameterTypes.joinToString(",") { it.qualifiedName }})"
    }

    private fun location(unit: CompilationUnit, path: String, node: ASTNode) = Location(path, range(unit, node.startPosition, node.length))

    private fun range(unit: CompilationUnit, offset: Int, length: Int): Range {
        fun position(index: Int) = Position(unit.getLineNumber(index), unit.getColumnNumber(index))
        return Range(position(offset), position(offset + length))
    }

    private data class Batch(val scope: String, val sources: List<Path>, val roots: List<Path>, val classpath: List<String>)
    private data class PendingReference(
        val id: String, val targetId: String, val location: Location, val enclosingId: String?, val sourceSet: String,
        val kind: String, val sourceTarget: Boolean,
    )
}
