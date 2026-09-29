import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(libs.maven.resolver.supplier)
    implementation(libs.maven.resolver.provider)
    implementation(libs.maven.model.builder)
    implementation(libs.slf4j.api)
    implementation(libs.gson)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testRuntimeOnly(libs.junit.platform.launcher)
    testRuntimeOnly(libs.logback.classic)
}

configurations.configureEach {
    resolutionStrategy {
        force(
            "org.apache.maven:maven-resolver-provider:3.9.16",
            "org.apache.maven:maven-model-builder:3.9.16",
            "org.apache.maven:maven-model:3.9.16",
            "org.apache.maven:maven-artifact:3.9.16",
            "org.apache.maven:maven-builder-support:3.9.16",
            "org.apache.maven:maven-repository-metadata:3.9.16",
            "org.apache.maven.resolver:maven-resolver-api:1.9.27",
            "org.apache.maven.resolver:maven-resolver-spi:1.9.27",
            "org.apache.maven.resolver:maven-resolver-util:1.9.27",
            "org.apache.maven.resolver:maven-resolver-impl:1.9.27",
            "org.apache.maven.resolver:maven-resolver-named-locks:1.9.27",
            "org.apache.maven.resolver:maven-resolver-connector-basic:1.9.27",
            "org.apache.maven.resolver:maven-resolver-transport-file:1.9.27",
            "org.apache.maven.resolver:maven-resolver-supplier:1.9.27",
        )
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_25)
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_25
    targetCompatibility = JavaVersion.VERSION_25
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
