package com.leveret.inspect.java

import java.nio.file.Files
import java.nio.file.Path
import org.eclipse.jdt.core.JavaCore
import org.eclipse.jdt.core.dom.AST
import org.eclipse.jdt.core.dom.ASTNode
import org.eclipse.jdt.core.dom.AbstractTypeDeclaration
import org.eclipse.jdt.core.dom.AnonymousClassDeclaration
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
    private const val UNSUPPORTED = "unsupported-exported-environment"

    fun extract(input: JavaAnalysisInput): AnalysisData {
        val worker = JavaCompilationEnvironment.workerPlatform()
        for (compilation in input.compilations) {
            compilation.compiler.supportProblem(worker)?.let { throw InspectException(UNSUPPORTED, "Compilation ${compilation.id}: $it") }
            for (file in compilation.files) {
                if (!JavaCompilationEnvironment.isUtf8(file.encoding)) {
                    throw InspectException(UNSUPPORTED, "Compilation ${compilation.id}: encoding ${file.encoding} of ${file.displayPath} " +
                        "differs from the compiler encoding ${compilation.compiler.encoding}")
                }
            }
        }
        val identity = JavaAnalysisIdentity.compute(input)
        val methods = linkedMapOf<String, JavaMethod>()
        val constructors = linkedMapOf<String, JavaMethod>()
        val declaredAt = HashMap<String, Path>()
        val declaredKeys = HashSet<String>()
        val fileOwners = HashMap<Path, MutableList<JavaCompilationInput>>()
        val duplicateIds = mutableSetOf<String>()
        val pending = mutableListOf<PendingReference>()
        val unresolved = mutableListOf<UnresolvedSite>()
        val references = mutableListOf<JavaReference>()
        val files = mutableListOf<SourceFile>()
        val diagnostics = input.diagnostics.toMutableList()
        val root = input.pathRoot.toRealPath()
        val artifact = input.artifactRoot.toAbsolutePath().normalize()
        JavaOriginIndex(input.compilations).use { index ->
            for (compilation in input.compilations) {
                if (compilation.files.isEmpty()) continue
                val scope = compilation.sourceSet
                val domain = compilation.resolutionDomain
                val parser = ASTParser.newParser(AST.getJLSLatest())
                parser.setResolveBindings(true)
                parser.setBindingsRecovery(false)
                parser.setStatementsRecovery(false)
                val options = JavaCore.getOptions()
                JavaCore.setComplianceOptions(checkNotNull(compilation.compiler.sourceLevel), options)
                parser.setCompilerOptions(options)
                val artifactRoot = if (compilation.classpath.isEmpty()) artifact else artifact.toRealPath()
                val sourcePath = compilation.sourcePath.filter { Files.exists(it) }.map { JavaAnalysisIdentity.contained(root, it).toString() }
                parser.setEnvironment(
                    compilation.classpath.map { JavaAnalysisIdentity.contained(artifactRoot, it).toString() }.toTypedArray(),
                    sourcePath.toTypedArray(),
                    if (sourcePath.isEmpty()) null else Array(sourcePath.size) { "UTF-8" },
                    true,
                )
                val members = LinkedHashMap<String, JavaSourceInput>()
                for (file in compilation.files) {
                    val real = JavaAnalysisIdentity.contained(root, file.physicalPath)
                    members[real.toString()] = file
                    fileOwners.getOrPut(real) { mutableListOf() }.add(compilation)
                }
                val requested = members.keys.toTypedArray()
                val examined = mutableSetOf<String>()
                parser.createASTs(requested, Array(requested.size) { "UTF-8" }, emptyArray<String>(), object : FileASTRequestor() {
                    override fun acceptAST(sourceFilePath: String, ast: CompilationUnit) {
                        val file = members[sourceFilePath] ?: return
                        val real = Path.of(sourceFilePath)
                        examined += sourceFilePath
                        files += SourceFile(file.displayPath, scope, true)
                        index.declare(compilation.id, real, topLevelTypes(ast))
                        val problems = ast.problems.filter { it.isError }
                        diagnostics += problems.map { "$scope:${file.displayPath}:${it.sourceLineNumber}: ${it.message}" }
                        ast.accept(object : ASTVisitor() {
                            override fun visit(node: MethodDeclaration): Boolean {
                                val binding = node.resolveBinding()?.methodDeclaration
                                if (binding != null && !binding.isRecovered && !recoveredSignature(binding)) {
                                    val id = methodId(domain, binding.key)
                                    val method = JavaMethod(
                                        id, signature(binding), location(ast, file, node),
                                        range(ast, node.name.startPosition, node.name.length), scope,
                                    )
                                    val destination = if (node.isConstructor) constructors else methods
                                    val previous = destination.putIfAbsent(id, method)
                                    if (previous == null) {
                                        declaredAt[id] = real
                                        if (!node.isConstructor) declaredKeys += binding.key
                                    } else if (previous != method) {
                                        val declarations = if (duplicateIds.add(id)) listOf(previous, method) else listOf(method)
                                        for (declaration in declarations) {
                                            val start = declaration.nameRange.start
                                            unresolved += UnresolvedSite(
                                                "duplicate:${declaration.sourceSet}:${declaration.location.path}:${start.line}:${start.column}",
                                                Location(declaration.location.path, declaration.nameRange, declaration.location.buildArtifact),
                                                declaration.sourceSet, "duplicate-declaration-identity",
                                            )
                                        }
                                        diagnostics += "$scope:${file.displayPath}: duplicate declaration identity $id"
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
                                val site = location(ast, file, node)
                                val siteId = "${file.displayPath}:${node.startPosition}:${node.length}:$kind"
                                val errors = problems.filter { it.sourceStart < node.startPosition + node.length && it.sourceEnd >= node.startPosition }
                                val suspect = binding == null || binding.isRecovered || recoveredSignature(binding) ||
                                    expressions.any { expression -> recoveredType(expression.resolveTypeBinding()) } || errors.isNotEmpty()
                                if (suspect) {
                                    unresolved += UnresolvedSite(siteId, site, scope,
                                        if (errors.isNotEmpty()) "compiler: ${errors.first().message}" else "binding-unresolved")
                                } else {
                                    if (implicitMember(binding)) return
                                    val enclosing = generateSequence(node.parent) { it.parent }.takeWhile { it !is org.eclipse.jdt.core.dom.LambdaExpression }
                                        .firstOrNull { it is MethodDeclaration || it is org.eclipse.jdt.core.dom.Initializer ||
                                            it is org.eclipse.jdt.core.dom.AbstractTypeDeclaration || it is AnonymousClassDeclaration }
                                        as? MethodDeclaration
                                    val enclosingBinding = enclosing?.resolveBinding()?.methodDeclaration
                                    pending += PendingReference(
                                        siteId, binding.methodDeclaration.key, JavaOriginIndex.declaringType(binding), site,
                                        enclosingBinding?.key, enclosingBinding?.let { JavaOriginIndex.declaringType(it).topLevel }, compilation, kind,
                                    )
                                }
                            }
                        })
                    }
                }, NullProgressMonitor())
                for ((path, file) in members) {
                    if (path !in examined) {
                        files += SourceFile(file.displayPath, scope, false, "AST unavailable")
                        diagnostics += "$scope:${file.displayPath}: AST unavailable"
                    }
                }
            }
            // A call joins a selected source declaration only when the lookup over its frozen entries establishes the origin.
            for (candidate in pending) {
                val caller = candidate.compilation
                fun gap(reason: String) {
                    unresolved += UnresolvedSite(candidate.id, candidate.location, caller.sourceSet, reason)
                }
                // Two files declaring one type leave every call into it indeterminate, even if JDT bound only one copy.
                if (candidate.type.fromSource && index.duplicated(caller.id, candidate.type.topLevel)) {
                    gap("duplicate-declaration-identity")
                    continue
                }
                if (candidate.key !in declaredKeys) {
                    if (candidate.type.fromSource) gap("target-outside-verified-sources")
                    continue
                }
                val origin = index.resolve(candidate.type, caller.id)
                if (origin == null) {
                    gap("target-origin-unresolved")
                    continue
                }
                val targetDomain = when (origin) {
                    is ResolvedMethodOrigin.Source -> fileOwners[origin.file].orEmpty().let { owners ->
                        owners.firstOrNull { it === caller } ?: owners.singleOrNull()
                    }?.resolutionDomain
                    is ResolvedMethodOrigin.Binary -> origin.ownerCompilationId?.let { owner ->
                        input.compilations.firstOrNull { it.id == owner }?.resolutionDomain
                    }
                }
                val targetId = targetDomain?.let { methodId(it, candidate.key) }
                if (targetId != null && targetId in duplicateIds) {
                    gap("duplicate-declaration-identity")
                    continue
                }
                if (targetId == null || methods[targetId] == null) {
                    if (candidate.type.fromSource) gap("target-outside-verified-sources")
                    continue
                }
                if (origin is ResolvedMethodOrigin.Source && declaredAt[targetId] != origin.file) {
                    gap("target-origin-unresolved")
                    continue
                }
                val enclosingId = candidate.enclosingKey?.let { methodId(caller.resolutionDomain, it) }
                val enclosing = enclosingId
                    ?.takeUnless { it in duplicateIds || index.duplicated(caller.id, candidate.enclosingType) }
                    ?.let { methods[it] ?: constructors[it] }
                references += JavaReference(candidate.id, targetId, candidate.location, enclosing, caller.sourceSet, candidate.kind)
            }
        }
        files += input.skippedFiles
        diagnostics += input.skippedFiles.map { "${it.sourceSet}:${it.path}: ${it.reason}" }
        if (identity != JavaAnalysisIdentity.compute(input)) {
            throw InspectException("snapshot-mismatch", "Analysis inputs changed during extraction")
        }
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

    private fun implicitMember(binding: IMethodBinding): Boolean {
        val method = binding.methodDeclaration
        if (method.isSyntheticRecordMethod) return true
        if (!method.declaringClass.isEnum) return false
        return (method.name == "values" && method.parameterTypes.isEmpty()) ||
            (method.name == "valueOf" && method.parameterTypes.singleOrNull()?.qualifiedName == "java.lang.String")
    }

    private fun recoveredSignature(binding: IMethodBinding): Boolean {
        val declaration = binding.methodDeclaration
        return declaration.isRecovered || recoveredType(declaration.declaringClass) ||
            (!declaration.isConstructor && recoveredType(declaration.returnType)) ||
            declaration.parameterTypes.any(::recoveredType) ||
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

    private fun location(unit: CompilationUnit, file: JavaSourceInput, node: ASTNode) =
        Location(file.displayPath, range(unit, node.startPosition, node.length), file.buildArtifact)

    /** Length-delimited domain plus the JDT binding key: equal keys in different resolution domains stay different methods. */
    private fun methodId(domain: String, bindingKey: String) = "${domain.length}:$domain:$bindingKey"

    private fun topLevelTypes(unit: CompilationUnit): List<String> {
        val prefix = unit.getPackage()?.name?.fullyQualifiedName?.let { "$it." } ?: ""
        return unit.types().filterIsInstance<AbstractTypeDeclaration>().map { prefix + it.name.identifier }
    }

    private fun range(unit: CompilationUnit, offset: Int, length: Int): Range {
        fun position(index: Int) = Position(unit.getLineNumber(index), unit.getColumnNumber(index))
        return Range(position(offset), position(offset + length))
    }

    private data class PendingReference(
        val id: String, val key: String, val type: DeclaringType, val location: Location,
        val enclosingKey: String?, val enclosingType: String?, val compilation: JavaCompilationInput, val kind: String,
    )
}
