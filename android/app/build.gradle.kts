import java.util.Properties

plugins {
    id("com.android.application")
}

// 화면은 웹 빌드 결과(저장소 루트의 dist/)를 그대로 앱 에셋으로 넣는다.
//  - carpoom-standalone.html: 모바일 앱(MobileActivity)
//  - pleos-standalone.html:   Pleos 차량 앱(CarActivity)
// dist/가 없으면 저장소 루트에서 먼저 `npm run build`를 실행한다.
val webPages = listOf("carpoom-standalone.html", "pleos-standalone.html").map { rootProject.file("../dist/$it") }
val webAssets = layout.buildDirectory.dir("generated/web")
val copyWeb by tasks.registering(Copy::class) {
    doFirst {
        webPages.forEach {
            require(it.exists()) { "dist/${it.name}이 없습니다. 저장소 루트에서 npm run build를 먼저 실행하세요." }
        }
    }
    from(webPages)
    // 시작 화면 영상(낮, 밤)
    from(rootProject.file("../assets/pleos")) { include("intro-*.mp4") }
    into(webAssets)
}

// 릴리스 서명: android/keystore.properties가 있으면 그 키로 서명하고,
// 없으면 디버그 키로 서명해 누구나 설치 가능한 APK를 만들 수 있게 한다.
val keystoreFile = rootProject.file("keystore.properties")
val keystore = Properties().apply { if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) } }

android {
    namespace = "com.tikitacar.carpoom"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.tikitacar.carpoom"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (keystoreFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    sourceSets.getByName("main").assets.srcDir(webAssets)
}

tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
