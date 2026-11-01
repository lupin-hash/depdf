plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val defaultAppVersion = (groovy.json.JsonSlurper().parse(rootProject.file("package.json")) as Map<*, *>)["version"] as String

android {
    namespace = "com.pdfcleaner.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.pdfcleaner.app"
        minSdk = 24
        targetSdk = 36
        // CI supplies the same version as the release tag, without another commit/build.
        versionCode = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("appVersion") as String?) ?: defaultAppVersion
    }

    // Optional release signing (used by GitHub Actions when the keystore secrets are set).
    // Updates only install over an existing copy when both are signed with the SAME key.
    val ksPath: String? = System.getenv("KEYSTORE_PATH")
    signingConfigs {
        if (!ksPath.isNullOrEmpty()) {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (!ksPath.isNullOrEmpty()) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    kotlinOptions {
        jvmTarget = "21"
    }
    // Keep the big engine files stored uncompressed (faster to read from assets).
    androidResources {
        noCompress += listOf("whl", "wasm", "zip")
    }
}

dependencies {
    implementation(project(":capacitor-android"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
}

apply(from = "capacitor.build.gradle")
