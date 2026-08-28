import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
    application
}

dependencies {
    implementation(libs.slf4j.api)
    implementation(libs.logback.classic)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.assertj.core)
    testImplementation(libs.awaitility)
    testRuntimeOnly(libs.junit.platform.launcher)
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

application {
    mainClass.set("com.leveret.inspect.runtime.AppKt")
    applicationName = "leveret-inspect"
}

distributions {
    main {
        contents {
            from("src/main/assembly")
        }
    }
}

/** Operator-facing hard-stop helper; the application plugin generates only the monitor script. */
val stopScripts by tasks.registering(CreateStartScripts::class) {
    mainClass.set("com.leveret.inspect.runtime.Shutdowner")
    applicationName = "leveret-inspect-stop"
    outputDir = layout.buildDirectory.dir("stopScripts").get().asFile
    classpath = tasks.startScripts.get().classpath
}

tasks.named<Sync>("installDist") { from(stopScripts) { into("bin") } }

tasks.named<Tar>("distTar") { from(stopScripts) { into("${project.name}-${project.version}/bin") } }

tasks.named<Zip>("distZip") { from(stopScripts) { into("${project.name}-${project.version}/bin") } }

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
