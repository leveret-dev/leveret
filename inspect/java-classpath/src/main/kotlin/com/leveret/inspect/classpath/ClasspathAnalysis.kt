package com.leveret.inspect.classpath

data class MavenTuple(
    val modelBuilder: String,
    val resolver: String,
)

data class RepositoryPolicy(
    val offline: Boolean,
    val descriptorRepositoriesIgnored: Boolean,
    val targetRepositoriesDiscarded: Boolean,
    val approvedRemoteId: String,
    val approvedRemoteUrl: String,
)

data class ClasspathAnalysis(
    val tuple: MavenTuple,
    val activeProfiles: List<String>,
    val repositoryPolicy: RepositoryPolicy,
    val mainClasspath: List<String>,
    val testClasspath: List<String>,
    val testSourceRoots: List<String>,
    val missClasses: List<String> = emptyList(),
) {
    fun write(): String = buildString {
        appendLine("tuple.modelBuilder=${tuple.modelBuilder}")
        appendLine("tuple.resolver=${tuple.resolver}")
        appendLine("profiles=${activeProfiles.joinToString(",")}")
        appendLine("policy.offline=${repositoryPolicy.offline}")
        appendLine("policy.descriptorRepositoriesIgnored=${repositoryPolicy.descriptorRepositoriesIgnored}")
        appendLine("policy.targetRepositoriesDiscarded=${repositoryPolicy.targetRepositoriesDiscarded}")
        appendLine("policy.approvedRemoteId=${repositoryPolicy.approvedRemoteId}")
        appendLine("policy.approvedRemoteUrl=${repositoryPolicy.approvedRemoteUrl}")
        appendLine("main:")
        mainClasspath.forEach { appendLine(it) }
        appendLine("test:")
        testClasspath.forEach { appendLine(it) }
        appendLine("testRoots:")
        testSourceRoots.forEach { appendLine(it) }
        appendLine("miss:")
        missClasses.forEach { appendLine(it) }
    }

    companion object {
        fun read(text: String): ClasspathAnalysis {
            var modelBuilder = ""
            var resolver = ""
            var profiles = emptyList<String>()
            var offline = false
            var descriptorIgnored = false
            var targetDiscarded = false
            var remoteId = ""
            var remoteUrl = ""
            val main = mutableListOf<String>()
            val test = mutableListOf<String>()
            val roots = mutableListOf<String>()
            val misses = mutableListOf<String>()
            var section = ""
            for (raw in text.split('\n')) {
                val line = raw.trimEnd()
                when {
                    line == "main:" -> section = "main"
                    line == "test:" -> section = "test"
                    line == "testRoots:" -> section = "roots"
                    line == "miss:" -> section = "miss"
                    section == "main" && line.isNotEmpty() -> main += line
                    section == "test" && line.isNotEmpty() -> test += line
                    section == "roots" && line.isNotEmpty() -> roots += line
                    section == "miss" && line.isNotEmpty() -> misses += line
                    line.startsWith("tuple.modelBuilder=") -> modelBuilder = line.substringAfter("=")
                    line.startsWith("tuple.resolver=") -> resolver = line.substringAfter("=")
                    line.startsWith("profiles=") ->
                        profiles = line.substringAfter("=").split(',').filter { it.isNotEmpty() }
                    line.startsWith("policy.offline=") -> offline = line.substringAfter("=").toBoolean()
                    line.startsWith("policy.descriptorRepositoriesIgnored=") ->
                        descriptorIgnored = line.substringAfter("=").toBoolean()
                    line.startsWith("policy.targetRepositoriesDiscarded=") ->
                        targetDiscarded = line.substringAfter("=").toBoolean()
                    line.startsWith("policy.approvedRemoteId=") -> remoteId = line.substringAfter("=")
                    line.startsWith("policy.approvedRemoteUrl=") -> remoteUrl = line.substringAfter("=")
                }
            }
            return ClasspathAnalysis(
                tuple = MavenTuple(modelBuilder, resolver),
                activeProfiles = profiles,
                repositoryPolicy = RepositoryPolicy(
                    offline = offline,
                    descriptorRepositoriesIgnored = descriptorIgnored,
                    targetRepositoriesDiscarded = targetDiscarded,
                    approvedRemoteId = remoteId,
                    approvedRemoteUrl = remoteUrl,
                ),
                mainClasspath = main,
                testClasspath = test,
                testSourceRoots = roots,
                missClasses = misses,
            )
        }
    }
}

class UnboundedVersionRangeException(message: String) : RuntimeException(message)

class MissingLockedArtifactException(message: String) : RuntimeException(message)
