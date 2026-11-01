# DePDF: Capacitor 8 Android app

An Android app using Capacitor 8 with a Kotlin host and an offline web interface.
Everything is bundled in the APK (`www/`), so it works **fully offline** and your PDFs are processed **on the device** by the same PyMuPDF engine (WebAssembly). The only network use is the optional **Check for updates** feature (one request to GitHub, started by you). The part of the app that handles your PDFs is blocked from the network, so your files are never uploaded.

## Build & run

1. Install Node.js 22+, JDK 21, and Android Studio with Android SDK platform 36. Run `npm ci` and `npm run sync:android` from this folder. Sync copies web assets and configures Capacitor; it does not compile an APK.
2. Run `npm run open:android` to open this project in Android Studio. Let Gradle sync (Gradle 8.14.3 and Android Gradle Plugin 8.13.0).
3. Plug in a phone/tablet (USB debugging on) or start an emulator, then press **Run**.
4. For an APK to install/share: **Build -> Build Bundle(s) / APK(s) -> Build APK(s)** (`app/build/outputs/apk/debug/`). For Play Store use **Build -> Generate Signed Bundle / APK**.

minSdk 24 (Android 7.0), targetSdk 36. Requires a reasonably current Android System WebView (auto-updated by Google Play).

## What the native layer adds

- Serves the web app from the APK via Capacitor’s local HTTPS server (correct `application/wasm` type, no hosting needed).
- File picker for single and multi-select (Batch).
- **Save** opens the system "Save as" picker (choose Downloads, Drive, anywhere). **Share** opens the Android share sheet.
- **Open with / Share to DePDF** from Files, Gmail, WhatsApp and others loads the PDF straight in.
- Edge-to-edge layout using Capacitor 8 SystemBars: transparent system bars, safe-area spacing for cutouts and navigation controls, keyboard resizing, and system icons matching the selected app theme. Older WebViews receive native padding to avoid clipping.

## Updating the UI

The web app lives in `www/` (`index.html`, `app.css`, `app.js`, `worker.js`, `engine/pdf_engine.py`, `vendor/`). Edit these source files, then run `npm run sync:android` to refresh the Android assets. Compile only when you want to test on a device or generate an APK. The Kotlin code is in `app/src/main/java/com/pdfcleaner/app/MainActivity.kt`.

## PDF viewer gestures

Pinch to zoom, drag to pan, or double-tap to toggle zoom. On a computer, use Ctrl/Cmd + wheel or `+`, `-`, and `0`. Zoom animations respect reduced-motion settings.

Press and hold text to select it, then extend the selection with its handles and tap **Copy**. In a single PDF, drag the floating eraser over words to highlight them. Releasing the eraser copies only the touched words, in reading order, to Android's clipboard. This gesture does not erase PDF content. Tapping the eraser still opens cleaning options; dragging it in a batch item only repositions it. Text copying requires an existing selectable text layer; this does not add OCR to scanned images.

## Viewer regression checks (no APK)

Run `npm ci` then `npm run test:viewer`. The tests require a local Chromium executable at `/usr/bin/chromium`, or set `CHROMIUM_PATH` to its location. They exercise the bundled PDF engine, zoom, selection, and touch/mouse eraser gestures in a browser, with a simulated Android clipboard bridge. They do not compile Android code or verify the actual device clipboard.

## Hidden / tracker text option

Off by default (Other cleanup -> *Remove hidden / tracker text*). It detects and deletes text a reader cannot see: invisible render mode, fully transparent, under 2 pt, outside the page, or the same color as its background. Invisible OCR/search layers on scanned pages are always kept, and hidden text that overlaps visible text is skipped rather than risk deleting visible content. A responsible-use disclaimer sits in the settings column, and *Analyze* reports how many hidden spans were found.

## Updates

Settings has an **App updates** card with a **Check for updates** button (and an opt-in daily auto-check). If a newer GitHub release exists, an **Update available** banner appears at the top and the card shows the release notes and a **Download** button that opens the APK in your browser.

- This adds the `INTERNET` permission. It is used by one function (`MainActivity.fetchUpdateInfo`): a single HTTPS GET to `api.github.com`. Nothing from your device is sent.
- The web layer is blocked from the network in `shouldInterceptRequest`.
- The update checker uses `lupin-hash/depdf`, configured in `app/src/main/res/values/update.xml`.
- Every push to `main` starts one build in `.github/workflows/build-apk.yml`. It chooses a version, builds one APK, then creates its matching GitHub tag and release. Tag pushes do not start a second build. Pull requests do not build release APKs.
- The first release uses `package.json`’s version (`1.0.0` initially). Later pushes bump the latest version tag’s patch number: `1.0.6` → `1.0.7`. The APK’s version name and release version always match; Android’s version code uses the workflow run number.
- To choose an exact version for the next main push, run `npm version 1.0.6 --no-git-tag-version`, then commit and push the resulting `package.json` and `package-lock.json` changes with your app changes. A package version newer than all existing release tags is used exactly.
- Alternatively, attach `v1.0.6` (or `1.0.6`) to the new commit and push the branch and tag together: `git push --atomic origin main v1.0.6`. The main workflow uses that existing tag’s exact version. Pushing a tag by itself deliberately does not build; do not push main first and expect a later tag to change an APK already built.
- **Actions → Build APK → Run workflow**, with `main` selected, also accepts an optional exact version such as `1.0.6`. Leaving it blank uses automatic versioning. A completed release on the same commit is reused on retries. Existing tags are never moved, and a version already assigned to another commit is rejected.
- The workflow publishes the same APK to the Actions artifact and GitHub release; these are two download locations for one build. It does not create an extra version-bump commit. Commits marked `[skip ci]` skip automatic builds.


## Source and generated files

`www/` contains the editable HTML, CSS, JavaScript, and bundled PDF engine. Capacitor sync generates `app/src/main/assets/public/`, native config, and Gradle integration files; these outputs are ignored by Git. Run `npm ci` followed by `npm run sync:android` after cloning and whenever web sources or Capacitor config change. The GitHub workflow performs these steps before any requested APK build.
