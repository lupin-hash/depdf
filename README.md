# DePDF: Android Studio project

A native Android app (Kotlin, one Activity) that hosts the DePDF web app in a WebView.
Everything is bundled in the APK (`app/src/main/assets/www`), so it works **fully offline** and your PDFs are processed **on the device** by the same PyMuPDF engine (WebAssembly). The only network use is the optional **Check for updates** feature (one request to GitHub, started by you). The part of the app that handles your PDFs is blocked from the network, so your files are never uploaded.

## Build & run

1. Android Studio (Koala or newer) -> **Open** -> choose this folder. Let Gradle sync (needs internet once to download Gradle 8.9, the Android Gradle Plugin and the SDK platform 35 if missing).
2. Plug in a phone/tablet (USB debugging on) or start an emulator, then press **Run**.
3. For an APK to install/share: **Build -> Build Bundle(s) / APK(s) -> Build APK(s)** (`app/build/outputs/apk/debug/`). For Play Store use **Build -> Generate Signed Bundle / APK**.

minSdk 24 (Android 7.0), targetSdk 35. Requires a reasonably current Android System WebView (auto-updated by Google Play).

## What the native layer adds

- Serves the web app from the APK via `WebViewAssetLoader` (correct `application/wasm` type, no hosting needed).
- File picker for single and multi-select (Batch).
- **Save** opens the system "Save as" picker (choose Downloads, Drive, anywhere). **Share** opens the Android share sheet.
- **Open with / Share to DePDF** from Files, Gmail, WhatsApp and others loads the PDF straight in.
- Edge-to-edge layout with keyboard/status-bar insets, light/dark following the system, rotation without reloading the engine.

## Updating the UI

The web app lives in `app/src/main/assets/www` (`index.html`, `app.css`, `app.js`, `worker.js`, `engine/pdf_engine.py`, `vendor/`). Edit and rebuild. The Kotlin code is in `app/src/main/java/com/pdfcleaner/app/MainActivity.kt`.

## Hidden / tracker text option

Off by default (Other cleanup -> *Remove hidden / tracker text*). It detects and deletes text a reader cannot see: invisible render mode, fully transparent, under 2 pt, outside the page, or the same color as its background. Invisible OCR/search layers on scanned pages are always kept, and hidden text that overlaps visible text is skipped rather than risk deleting visible content. A responsible-use disclaimer sits in the settings column, and *Analyze* reports how many hidden spans were found.

## One-click build on Windows

- **SETUP.bat** (first time): finds Java and the Android SDK (it uses the ones bundled with Android Studio), writes `local.properties`, accepts SDK licenses, builds the app, saves `PDFCleaner-debug.apk`, installs and launches it on a connected phone/emulator, and opens the project in Android Studio.
- **SYNC.bat** (after every change): rebuilds, reinstalls on the connected phone and launches the app. With no device connected it just builds `PDFCleaner-debug.apk`.

Requirements: Android Studio installed and opened once, internet for the first build, USB debugging on for a phone.

## Upload to GitHub

Run **GITHUB.bat** (first create an empty repository on github.com) and follow the prompts. Full beginner walkthrough, including how to download the APK that GitHub builds for you (`.github/workflows/build-apk.yml`): see **GITHUB_GUIDE.md**.

## Updates

Settings has an **App updates** card with a **Check for updates** button (and an opt-in daily auto-check). If a newer GitHub release exists, an **Update available** banner appears at the top and the card shows the release notes and a **Download** button that opens the APK in your browser.

- This adds the `INTERNET` permission. It is used by one function (`MainActivity.fetchUpdateInfo`): a single HTTPS GET to `api.github.com`. Nothing from your device is sent.
- The web layer is blocked from the network in `shouldInterceptRequest`.
- The repository to check is stored in `app/src/main/res/values/update.xml`; **GITHUB.bat** fills it in for you.
- Publish a new version with **RELEASE.bat** (see GITHUB_GUIDE.md, Part 5).

