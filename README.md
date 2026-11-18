# DePDF

**A privacy-focused, on-device workspace for reviewing, organizing, and preparing PDF documents.**

DePDF provides tools to inspect PDF files, make selected adjustments, and export separate copies for personal, educational, and professional document workflows. It is designed to make document review and preparation easier while giving users control over the changes they apply. Available operations depend on the structure of each PDF and the options selected.

PDF processing runs locally on your device using **PyMuPDF** through **Pyodide/WebAssembly**. DePDF does not need to upload your documents to an online PDF-processing service.

> **Important:** Cleaning can permanently remove content from the exported copy. Always keep your original PDF and carefully review the result before using or sharing it.

---

## What can I use DePDF for?

DePDF can support general document-preparation workflows, including:

- Reviewing PDF content and file information before sharing or archiving.
- Preparing separate copies of documents you are authorized to edit for study, collaboration, internal use, or recordkeeping.
- Applying selected page or content adjustments to improve readability and consistency.
- Reviewing document elements as part of a privacy-conscious document-handling workflow.
- Opening password-protected PDFs when you have the correct password and are authorized to access them.

DePDF is a **general-purpose PDF review and preparation tool**. The app does not determine whether a particular change is lawful, permitted by an organization, or appropriate for a specific document. Users are responsible for following applicable laws, policies, confidentiality requirements, copyright, licensing, and document-retention rules.

---

## Main features

### 1. Analyze before cleaning

Use **Analyze** to inspect a PDF before exporting a cleaned copy. The report can show information such as:

- Page count and selectable text characters.
- Document metadata and properties.
- Annotations and stamps.
- Hyperlinks.
- Embedded attachments.
- Hidden or tracker text detected by the engine.
- Image objects and possible image watermarks.
- Matches for text phrases you entered for headers, footers, or watermarks.
- Saved PDF revision/history information that the engine can identify.

Analysis also shows which cleanup operations are enabled. Select a result card or cleanup item to view more details. Run Analyze again after changing your options so the report reflects the current settings.

### 2. Clean selected PDF content

DePDF lets you choose cleanup operations before exporting:

| Cleanup option | What it does |
|---|---|
| Header and footer bands | Removes content inside selected percentage bands at the top or bottom of each page. |
| Custom areas | Removes content inside rectangular regions that you draw or define using page percentages. |
| Header and footer text | Finds and removes entered phrases in the header or footer zones. Similar text can also be matched. |
| Watermark text | Finds and removes entered text watermark phrases. Enter multiple phrases separated by semicolons. |
| Image watermarks | Detects certain large, faint image watermarks. You can also select image object IDs reported by Analyze. |
| Annotations and stamps | Optionally removes PDF annotations, comments, and stamps. |
| Hyperlinks | Optionally removes PDF links. |
| Hidden / tracker text | Optionally removes text detected as invisible, transparent, very small, off-page, or matching its background. Invisible OCR/search text is preserved by this option. |
| Document properties | Removes PDF metadata from exported Clean and Unlock copies. This is mandatory. |
| Embedded files and scripts | Removes embedded attachments and document scripts from exported Clean and Unlock copies. This is mandatory. |
| Saved revision history | Exports a fresh, non-incremental PDF and removes prior saved revisions and unreachable deleted objects that the engine can identify. |

**Important cleanup behavior:** Header/footer bands and custom areas erase everything inside the selected region, not only a particular phrase. Check the preview and analysis results carefully. Selecting an image object ID may remove a shared image everywhere it is used in the document. The app warns about this when you enter image IDs.

### 3. Preview and review PDFs

- View the original PDF before cleaning.
- Switch between the original and cleaned preview after a cleanup operation.
- Navigate pages using the visible previous/next page controls.
- Pinch to zoom and drag to pan on touch devices.
- On a computer, use **Ctrl/Cmd + mouse wheel**, `+`, `-`, or `0` to control zoom.
- Select existing PDF text, extend the selection, and copy the selected text, a line, or the page's selectable text.

Text selection requires a selectable text layer already present in the PDF. **DePDF does not perform OCR and cannot select text that exists only as pixels in a scanned image.**

### 4. Unlock password-protected PDFs

When you open an encrypted PDF, DePDF asks for its password. Enter the correct password to open it and save an unlocked copy. DePDF does not guess, crack, or bypass passwords.

The app can remember an unlocked copy on the device so that you do not have to enter the password every time for that same original PDF. In **Settings → Saved PDF passwords**, you can forget the saved unlocked copies. Forgetting them does not delete the original PDFs; you will need the password again to reopen protected files.

### 5. Batch processing

Use **Work in batches** to add and process multiple PDFs in one workflow. You can:

- Add multiple PDF files.
- Enter the same password for several files or provide different passwords for individual files.
- Open an individual batch item to review or change its cleanup options.
- Analyze the batch and view results for each file.
- Clean eligible files one after another and save separate output files.

Batch and file-size limits depend on device resources. Large PDFs or batches can take longer and may not work on devices with limited memory. Keep DePDF open while a job is running.

### 6. Name exported copies

Before saving, you can:

- Enter a complete new filename.
- Add a suffix or other text to the existing filename.
- Remove one or more text fragments from the filename (separate fragments with commas).

Cleaned copies use `_clean` by default; unlocked copies use `_unlocked` by default. Your original file is not overwritten by these export actions.

### 7. Personalization and updates

Settings include:

- System, light, and dark appearance options.
- Accent color choices.
- A **Lighter visuals** option to reduce blur and motion on slower devices.
- A reset option for app settings.
- App version information and a manual update check in supported Android builds.
- Credits for the projects used by DePDF.

The Android app does not automatically check for updates. When you tap **Check for updates**, the native update checker makes an HTTPS request to GitHub to look for release information. It does not send your PDFs or PDF contents.

---

## How to use DePDF

1. **Open a PDF.** Choose a PDF from your device. You can also drag and drop a PDF in supported desktop browsers.
2. **Review the original.** Use the page controls and zoom to inspect the document.
3. **Choose cleaning options.** Open the cleaning-options tool and select only the changes you need.
4. **Analyze.** Read the report and open the result details. Check what DePDF found and what it plans to remove.
5. **Adjust if needed.** Change your options and analyze again. Do not proceed until the planned cleanup is appropriate for your document.
6. **Clean or unlock.** Continue to the export dialog and choose the output name.
7. **Save and inspect.** Save the new PDF, open it, and verify that important content remains correct and unwanted content has been removed.

For multiple documents, choose **Work in batches** from the home screen and follow the same analyze-and-clean process for the batch.

---

## Privacy and local processing

DePDF is built to process PDF content on the device:

- The PDF engine runs in a web worker using PyMuPDF through Pyodide/WebAssembly.
- In the Android app, the web layer is blocked from making general network requests. The optional manual update check is handled by the native Android layer and contacts GitHub over HTTPS.
- In a browser/PWA, the first launch may need to load the PDF engine and other app resources. The service worker can cache resources for later offline use when supported by the browser and hosting setup.
- The app's PDF processing workflow does not upload the PDF to a DePDF server.

This describes the app's intended processing design; it is not a promise that every browser, device, operating-system backup, file manager, or third-party service has no access to files stored or selected on that device. Protect your device and manage your own copies and backups.

---

## Important limitations

- **No OCR:** Scanned pages that contain only images do not become selectable text. DePDF preserves an existing searchable OCR layer, but it does not create one.
- **Detection is not perfect:** Some PDF objects, proprietary editor records, hidden data, or unusual document structures may not be recognized. No cleanup tool can promise to identify every possible trace in every PDF.
- **Visual cleanup can remove wanted content:** A selected band or area removes everything inside it. Phrase matching and automatic image-watermark detection can also produce imperfect results. Always inspect the exported copy.
- **Image IDs may be shared:** Removing an image object can remove it from multiple pages or locations where the same object is reused.
- **Digital signatures:** Rewriting a PDF changes the file. Existing digital signatures and their validation records cannot be relied on after a Clean or Unlock export.
- **External copies remain:** DePDF does not delete the original PDF, copies in other folders, email attachments, cloud versions, device backups, or files previously shared with others.
- **No anonymity guarantee:** Removing metadata and known history does not guarantee anonymity, erase all provenance, or remove information that is part of the visible page content.
- **Device resources matter:** Very large PDFs and batches may be slow or may exceed available memory. Keep the app open during processing and consider splitting large documents.

---

## Disclaimer and responsible use

Use DePDF only with PDF documents that you own or have explicit permission to modify or access. You are responsible for ensuring that your use of the app and the changes you make comply with applicable laws, contracts, institutional policies, confidentiality obligations, copyright, licensing, and document-retention requirements.

Do not use DePDF to misrepresent a document, violate another party's rights, interfere with records that must be preserved, or access materials without authorization. Password-protected documents should only be opened when you have the correct password and are authorized to access them.

Cleaning and unlocking exports may permanently remove text, images, annotations, links, metadata, attachments, scripts, or saved revision data. These changes may be irreversible in the exported copy and may invalidate digital signatures. Keep an untouched backup of the original and verify the output before relying on it, submitting it, publishing it, or sharing it.

**DePDF is provided “as is” and “as available,” without warranties to the extent permitted by applicable law.** The developer does not guarantee that every unwanted item will be detected or removed, that every output will be suitable for a particular purpose, or that the app will be uninterrupted or error-free. To the extent permitted by law, the developer is not responsible for misuse, unauthorized edits, lost data, damaged documents, or losses arising from use of the app. Nothing in this disclaimer excludes rights or liabilities that cannot lawfully be excluded.

By using DePDF, you acknowledge that you are responsible for your files, your selected cleanup options, and how you use the exported documents.

---

## Supported platforms

The repository includes the **Capacitor 8 Android project** and the web application in `www/`.

### Android

- Minimum Android version: **Android 7.0 (API 24)**.
- Target SDK: **36**.
- Requires a reasonably current Android System WebView.
- The app is bundled with its web interface and PDF engine assets, so no web hosting is needed for normal Android use.
- Android supports opening a PDF through the system file picker, sharing a PDF to DePDF from compatible apps, saving through the Android system file picker, and sharing exported files through the Android share sheet.

### Browser / PWA

The web interface can be served from a compatible web server. Offline behavior depends on the browser, service-worker support, and whether the required app and PDF-engine resources have been cached. A first launch may require an internet connection to load the PDF engine when resources are not bundled or cached.

The repository's native build instructions below are for Android. A separately distributed Windows launcher or desktop package may have its own installation and update procedure; it is not produced by the Android build commands in this README.

---

## Build and run (Android)

### Requirements

- Node.js **22 or newer**
- JDK **21**
- Android Studio
- Android SDK Platform **36**

### Steps

1. Clone this repository and open a terminal in the project folder.
2. Install dependencies and synchronize the Android project:

   ```bash
   npm ci
   npm run sync:android
   ```

   Capacitor sync copies the web assets and configures the Android project. It does not compile an APK.

3. Open the Android project:

   ```bash
   npm run open:android
   ```

4. Allow Gradle to sync. The project uses Gradle **8.14.3** and Android Gradle Plugin **8.13.0**.
5. Connect an Android device with USB debugging enabled or start an emulator, then press **Run** in Android Studio.

### Build an APK or Play Store bundle

In Android Studio:

- For a local test APK: **Build → Build Bundle(s) / APK(s) → Build APK(s)**. The debug APK is normally written to `app/build/outputs/apk/debug/`.
- For distribution through Google Play: **Build → Generate Signed Bundle / APK** and follow the signing steps. Use a properly protected release signing key.

---

## Updating the web interface

The editable web application is in `www/`:

- `www/index.html` — app interface and dialogs.
- `www/app.css` — styles and layout.
- `www/app.js` — interface behavior and workflows.
- `www/worker.js` — worker that runs PDF operations.
- `www/engine/pdf_engine.py` — PyMuPDF-based PDF processing engine.
- `www/vendor/` — bundled runtime and dependencies.

After changing web assets or Capacitor configuration, run:

```bash
npm ci
npm run sync:android
```

Then build and test the Android app when needed. Capacitor sync generates files under `app/src/main/assets/public/` and related native integration files; these generated outputs are ignored by Git and should be recreated by the sync command.

The Kotlin host is located at:

```text
app/src/main/java/com/pdfcleaner/app/MainActivity.kt
```

---

## Tests

### Browser viewer tests

Run:

```bash
npm ci
npm run test:viewer
```

The tests require a local Chromium executable at `/usr/bin/chromium`, or set `CHROMIUM_PATH` to its location. They cover the bundled PDF engine, zoom, text selection, touch/mouse tool repositioning, page navigation, clickable analysis details, safe rendering of untrusted document properties, cleanup-preview agreement, and per-file batch options.

These tests do not compile Android code or verify the actual device clipboard.

### Optional PDF engine tests

With Python and PyMuPDF installed, run:

```bash
PYTHONDONTWRITEBYTECODE=1 python tests/analysis-engine.test.py
```

These tests check affected-text previews against cleaned PDF copies, original-file and searchable OCR-layer preservation, and history removal on normal, encrypted, and large PDFs.

---

## Release and update workflow

The Android app includes a manual **Check for updates** feature. The update check uses the repository configured in `app/src/main/res/values/update.xml`. It does not automatically check for updates when the app starts.

The GitHub Actions workflow at `.github/workflows/build-apk.yml` builds and publishes an APK when changes are pushed to `main`, subject to the workflow's release-signing configuration.

- The first release uses the version in `package.json` (initially `1.0.0`).
- Later pushes automatically increment the patch version unless an explicit newer version is supplied.
- To set an exact version before the next main-branch push, run `npm version 1.0.6 --no-git-tag-version`, then commit the resulting `package.json` and `package-lock.json` changes with your app changes.
- Alternatively, create a version tag such as `v1.0.6` on the new commit and push the branch and tag together:

  ```bash
  git push --atomic origin main v1.0.6
  ```

- **Actions → Build APK → Run workflow** also accepts an optional exact version. Leaving it blank uses automatic versioning.
- The workflow publishes the same APK as an Actions artifact and a GitHub release. These are two download locations for one build.
- Publishing requires the configured release signing key and credentials. Missing signing configuration stops the workflow rather than publishing a debuggable APK.
- Commits marked `[skip ci]` skip automatic builds. Pull requests do not publish release APKs; pushing a tag alone does not trigger a second build.

Check the workflow file for the current implementation before changing release automation.

---

## Credits

DePDF uses and acknowledges these open-source projects:

- [PyMuPDF](https://pymupdf.readthedocs.io/) — PDF processing.
- [Pyodide](https://pyodide.org/) — Python runtime for WebAssembly.
- [Capacitor](https://capacitorjs.com/) — Android application foundation.

Project names and trademarks belong to their respective owners. Each dependency is distributed under its own license; review the applicable licenses before redistributing builds.

---

## About this project

DePDF is an on-device PDF workspace built around a simple principle: **review the document, make deliberate changes, and verify the exported copy.** It supports general document-preparation workflows while keeping PDF processing on the user's device.
