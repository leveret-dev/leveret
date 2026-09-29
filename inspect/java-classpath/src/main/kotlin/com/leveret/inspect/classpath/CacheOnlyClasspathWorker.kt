package com.leveret.inspect.classpath

import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import org.apache.maven.model.Dependency
import org.apache.maven.model.Model
import org.apache.maven.model.Parent
import org.apache.maven.model.Repository
import org.apache.maven.model.building.DefaultModelBuilderFactory
import org.apache.maven.model.building.DefaultModelBuildingRequest
import org.apache.maven.model.building.FileModelSource
import org.apache.maven.model.building.ModelBuildingRequest
import org.apache.maven.model.building.ModelSource
import org.apache.maven.model.resolution.ModelResolver
import org.apache.maven.repository.internal.ArtifactDescriptorReaderDelegate
import org.apache.maven.repository.internal.MavenRepositorySystemUtils
import org.codehaus.plexus.util.xml.Xpp3Dom
import org.eclipse.aether.RepositorySystem
import org.eclipse.aether.RepositorySystemSession
import org.eclipse.aether.artifact.DefaultArtifact
import org.eclipse.aether.collection.CollectRequest
import org.eclipse.aether.collection.DependencyCollectionException
import org.eclipse.aether.graph.DependencyFilter
import org.eclipse.aether.repository.LocalRepository
import org.eclipse.aether.repository.RemoteRepository
import org.eclipse.aether.repository.RepositoryPolicy
import org.eclipse.aether.resolution.ArtifactDescriptorRequest
import org.eclipse.aether.resolution.ArtifactDescriptorResult
import org.eclipse.aether.resolution.ArtifactRequest
import org.eclipse.aether.resolution.ArtifactResolutionException
import org.eclipse.aether.resolution.DependencyRequest
import org.eclipse.aether.resolution.DependencyResolutionException
import org.eclipse.aether.resolution.VersionRangeRequest
import org.eclipse.aether.supplier.RepositorySystemSupplier
import org.eclipse.aether.transport.file.FileTransporterFactory
import org.eclipse.aether.util.artifact.JavaScopes
import org.eclipse.aether.util.filter.DependencyFilterUtils
import org.eclipse.aether.util.version.GenericVersionScheme
import org.eclipse.aether.spi.connector.transport.TransporterFactory
import org.eclipse.aether.transport.http.ChecksumExtractor

object CacheOnlyClasspathWorker {
    const val MODEL_BUILDER_VERSION = "3.9.16"
    const val RESOLVER_VERSION = "1.9.27"
    const val CENTRAL_ID = "central"
    const val CENTRAL_URL = "https://repo.maven.apache.org/maven2"

    fun analyze(pom: Path, localRepository: Path): ClasspathAnalysis {
        Files.createDirectories(localRepository)
        val system = CacheOnlyRepositorySystemSupplier().get()
        try {
            val session = newSession(system, localRepository)
            val central = centralRepository()
            val modelResult = try {
                buildModel(system, session, pom, listOf(central))
            } catch (e: ArtifactResolutionException) {
                return ClasspathAnalysis(
                    tuple = MavenTuple(MODEL_BUILDER_VERSION, RESOLVER_VERSION),
                    activeProfiles = emptyList(),
                    repositoryPolicy = cachePolicy(),
                    mainClasspath = emptyList(),
                    testClasspath = emptyList(),
                    testSourceRoots = emptyList(),
                    diagnostics = listOf(ClasspathDiagnostic(null, "model-unavailable", e.results.firstOrNull()?.request?.artifact?.let {
                        "${it.groupId}:${it.artifactId}:${it.version}"
                    }, e.message ?: "Model metadata unavailable")),
                )
            }
            val model = modelResult.effectiveModel
            val descriptor = ArtifactDescriptorResult(ArtifactDescriptorRequest())
            ArtifactDescriptorReaderDelegate().populateResult(session, descriptor, model)
            val rootType = session.artifactTypeRegistry.get(model.packaging)
            val collect = CollectRequest()
            collect.rootArtifact = DefaultArtifact(
                model.groupId,
                model.artifactId,
                rootType?.classifier ?: "",
                rootType?.extension ?: "jar",
                model.version,
            )
            collect.dependencies = descriptor.dependencies
            collect.managedDependencies = descriptor.managedDependencies
            collect.repositories = listOf(central)
            val collection = try {
                system.collectDependencies(session, collect)
            } catch (e: DependencyCollectionException) {
                e.result
            }
            val root = collection.root
            val diagnostics = collection.exceptions.map {
                ClasspathDiagnostic(null, "dependency-collection", null, it.message ?: it.javaClass.name)
            }.toMutableList()
            val main = if (root == null) emptyList() else resolveClasspath(
                system, session, root, JavaScopes.COMPILE, localRepository, "main", diagnostics,
            )
            val test = if (root == null) emptyList() else resolveClasspath(
                system, session, root, JavaScopes.TEST, localRepository, "test", diagnostics,
            )
            if (root == null && diagnostics.isEmpty()) {
                diagnostics += ClasspathDiagnostic(null, "dependency-collection", null, "Dependency tree unavailable")
            }
            val basedir = pom.toAbsolutePath().normalize().parent
            return ClasspathAnalysis(
                tuple = MavenTuple(MODEL_BUILDER_VERSION, RESOLVER_VERSION),
                activeProfiles = modelResult.modelIds.flatMap { id ->
                    modelResult.getActivePomProfiles(id).map { it.id }
                }.distinct(),
                repositoryPolicy = cachePolicy(),
                mainClasspath = main,
                testClasspath = test,
                testSourceRoots = testSourceRoots(model, basedir),
                diagnostics = diagnostics.distinct(),
            )
        } finally {
            system.shutdown()
        }
    }

    private fun cachePolicy() = com.leveret.inspect.classpath.RepositoryPolicy(
        offline = true,
        descriptorRepositoriesIgnored = true,
        targetRepositoriesDiscarded = true,
        approvedRemoteId = CENTRAL_ID,
        approvedRemoteUrl = CENTRAL_URL,
    )

    private fun newSession(system: RepositorySystem, localRepository: Path): org.eclipse.aether.DefaultRepositorySystemSession {
        val session = MavenRepositorySystemUtils.newSession()
        session.isOffline = true
        session.setIgnoreArtifactDescriptorRepositories(true)
        session.localRepositoryManager =
            system.newLocalRepositoryManager(session, LocalRepository(localRepository.toFile()))
        session.setSystemProperties(systemProperties())
        session.setUserProperties(emptyMap<String, String>())
        return session
    }

    private fun buildModel(
        system: RepositorySystem,
        session: RepositorySystemSession,
        pom: Path,
        repositories: List<RemoteRepository>,
    ) = DefaultModelBuilderFactory().newInstance().build(
        DefaultModelBuildingRequest()
            .setPomFile(pom.toFile())
            .setProcessPlugins(false)
            .setTwoPhaseBuilding(false)
            .setValidationLevel(ModelBuildingRequest.VALIDATION_LEVEL_MINIMAL)
            .setSystemProperties(System.getProperties())
            .setUserProperties(Properties())
            .setModelResolver(CacheOnlyModelResolver(system, session, repositories)),
    )

    private fun resolveClasspath(
        system: RepositorySystem,
        session: RepositorySystemSession,
        root: org.eclipse.aether.graph.DependencyNode,
        scope: String,
        localRepository: Path,
        sourceSet: String,
        diagnostics: MutableList<ClasspathDiagnostic>,
    ): List<String> {
        val filter: DependencyFilter = DependencyFilterUtils.classpathFilter(scope)
        val result = try {
            system.resolveDependencies(session, DependencyRequest(root, filter))
        } catch (e: DependencyResolutionException) {
            e.result
        }
        val repo = localRepository.toAbsolutePath().normalize()
        val paths = mutableListOf<String>()
        for (artifact in result.artifactResults) {
            val file = artifact.artifact?.file
            if (artifact.isResolved && file?.isFile == true) {
                paths += repo.relativize(file.toPath().toAbsolutePath().normalize()).toString().replace('\\', '/')
            } else {
                val key = artifact.request?.artifact
                diagnostics += ClasspathDiagnostic(
                    sourceSet, "missing-artifact",
                    key?.let { "${it.groupId}:${it.artifactId}:${it.version}" },
                    artifact.exceptions.joinToString("; ") { it.message ?: it.javaClass.name }.ifEmpty { "Artifact unavailable" },
                )
            }
        }
        result.collectExceptions.forEach {
            diagnostics += ClasspathDiagnostic(sourceSet, "dependency-collection", null, it.message ?: it.javaClass.name)
        }
        return paths
    }
    private fun testSourceRoots(model: Model, basedir: Path): List<String> {
        val roots = mutableListOf<String>()
        roots += relativize(basedir, model.build?.testSourceDirectory ?: "src/test/java")
        val plugins = model.build?.plugins.orEmpty()
        for (plugin in plugins) {
            if (plugin.artifactId != "build-helper-maven-plugin") continue
            for (execution in plugin.executions) {
                if ("add-test-source" !in execution.goals) continue
                val config = execution.configuration as? Xpp3Dom ?: continue
                val sources = config.getChild("sources") ?: continue
                for (source in sources.getChildren("source")) {
                    val value = source.value ?: continue
                    roots += relativize(basedir, value)
                }
            }
        }
        return roots.distinct()
    }

    private fun relativize(basedir: Path, raw: String): String {
        val path = Path.of(raw)
        val resolved = if (path.isAbsolute) path else basedir.resolve(path)
        return basedir.toAbsolutePath().normalize()
            .relativize(resolved.toAbsolutePath().normalize())
            .toString()
            .replace('\\', '/')
    }

    private fun centralRepository(): RemoteRepository =
        RemoteRepository.Builder(CENTRAL_ID, "default", CENTRAL_URL)
            .setReleasePolicy(
                RepositoryPolicy(true, RepositoryPolicy.UPDATE_POLICY_NEVER, RepositoryPolicy.CHECKSUM_POLICY_IGNORE),
            )
            .setSnapshotPolicy(
                RepositoryPolicy(false, RepositoryPolicy.UPDATE_POLICY_NEVER, RepositoryPolicy.CHECKSUM_POLICY_IGNORE),
            )
            .build()

    private fun systemProperties(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for ((key, value) in System.getProperties()) {
            if (key is String && value is String) {
                out[key] = value
            }
        }
        return out
    }
}

private class CacheOnlyRepositorySystemSupplier : RepositorySystemSupplier() {
    override fun getTransporterFactories(
        extractors: Map<String, ChecksumExtractor>,
    ): Map<String, TransporterFactory> =
        mapOf(FileTransporterFactory.NAME to FileTransporterFactory())
}

private class CacheOnlyModelResolver(
    private val system: RepositorySystem,
    private val session: RepositorySystemSession,
    private val repositories: List<RemoteRepository>,
) : ModelResolver {
    override fun resolveModel(groupId: String, artifactId: String, version: String): ModelSource {
        val artifact = DefaultArtifact(groupId, artifactId, "", "pom", version)
        val resolved = system.resolveArtifact(session, ArtifactRequest(artifact, repositories, "project"))
        return FileModelSource(resolved.artifact.file)
    }

    override fun resolveModel(parent: Parent): ModelSource {
        parent.version = resolveVersion(parent.groupId, parent.artifactId, parent.version)
        return resolveModel(parent.groupId, parent.artifactId, parent.version)
    }

    override fun resolveModel(dependency: Dependency): ModelSource {
        dependency.version = resolveVersion(dependency.groupId, dependency.artifactId, dependency.version)
        return resolveModel(dependency.groupId, dependency.artifactId, dependency.version)
    }

    override fun addRepository(repository: Repository) {}

    override fun addRepository(repository: Repository, replace: Boolean) {}

    override fun newCopy(): ModelResolver = CacheOnlyModelResolver(system, session, repositories)

    private fun resolveVersion(groupId: String, artifactId: String, version: String): String {
        val constraint = GenericVersionScheme().parseVersionConstraint(version)
            as org.eclipse.aether.version.VersionConstraint
        val range = constraint.range
        if (range != null && range.upperBound == null) {
            throw UnboundedVersionRangeException(
                "The requested version range '$version' for $groupId:$artifactId does not specify an upper bound",
            )
        }
        if (range == null) {
            return version
        }
        val artifact = DefaultArtifact(groupId, artifactId, "", "pom", version)
        val result = system.resolveVersionRange(session, VersionRangeRequest(artifact, repositories, "project"))
        return result.highestVersion?.toString()
            ?: throw UnboundedVersionRangeException(
                "No versions matched the requested version range '$version' for $groupId:$artifactId",
            )
    }
}

object WorkerMain {
    @JvmStatic
    fun main(args: Array<String>) {
        var pom: Path? = null
        var project: Path? = null
        var localRepo: Path? = null
        var output: Path? = null
        var index = 0
        while (index < args.size) {
            when (args[index]) {
                "--pom" -> pom = Path.of(args[++index])
                "--project" -> project = Path.of(args[++index])
                "--local-repo" -> localRepo = Path.of(args[++index])
                "--output" -> output = Path.of(args[++index])
            }
            index++
        }
        val repo = requireNotNull(localRepo) { "--local-repo is required" }
        val analysis = when {
            pom != null -> CacheOnlyClasspathWorker.analyze(pom, repo)
            project != null -> GradleLockfileClasspathWorker.analyze(project, repo)
            else -> error("--pom or --project is required")
        }
        Files.writeString(requireNotNull(output) { "--output is required" }, analysis.write())
    }
}
