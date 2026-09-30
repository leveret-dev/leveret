dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

rootProject.name = "leveret-inspect"

include("runtime")
include("persistence")
include("java-classpath")
include("java-analysis")
