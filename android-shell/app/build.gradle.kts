plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val hasGoogleServices = file("google-services.json").exists()
if (hasGoogleServices) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.sos010.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.sos010.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 41
        versionName = "1.0.40"
        buildConfigField("String", "SOS_START_URL", "\"https://sos010.com/videos.html?shell=77\"")
        buildConfigField("boolean", "HAS_FCM", hasGoogleServices.toString())
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // P2P Native בשירות הרקע | HYPER CORE TECH
    implementation("io.github.webrtc-sdk:android:125.6422.06.1")
    implementation("fr.acinq.secp256k1:secp256k1-kmp-jni-android:0.15.0")
    implementation("fr.acinq.secp256k1:secp256k1-kmp-jvm:0.15.0")

    // FCM תמיד בקומפילציה; בלי google-services.json ההתראות מגיעות דרך Foreground + bridge
    implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
    implementation("com.google.firebase:firebase-messaging-ktx")
}
