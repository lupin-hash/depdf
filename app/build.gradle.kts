plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pdfcleaner.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pdfcleaner.app"
        minSdk = 24
        targetSdk = 35
        // CI passes -PappVersion=1.2 -PappVersionCode=N when it builds a tagged release.
        versionCode = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("appVersion") as String?) ?: "1.0"
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
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // Keep the big engine files stored uncompressed (faster to read from assets).
    androidResources {
        noCompress += listOf("whl", "wasm", "zip")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
