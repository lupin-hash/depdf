package com.pdfcleaner.app

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.BridgeWebChromeClient
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.WindowCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Hosts the DePDF web app through Capacitor 8.
 *
 * Everything is served from the APK through Capacitor on a virtual https origin, so the app
 * works fully offline and the PDF engine (PyMuPDF compiled to WebAssembly) runs on the device.
 * The only network use is the update check (api.github.com); the web layer itself is blocked from the network.
 */
class MainActivity : BridgeActivity() {

    private lateinit var root: android.view.View
    private lateinit var web: WebView

    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: File? = null
    private var treeUri: Uri? = null

    /** File name of a PDF sent to the app ("Open with" / Share), until the web page picks it up. */
    @Volatile private var incomingName: String = ""

    // OpenMultipleDocuments collects every URI from ClipData; WebChromeClient's
    // parseResult helper only handles a single result URI on Android.
    private val multipleChooserLauncher =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            finishFileChooser(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        }

    private val singleChooserLauncher =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            finishFileChooser(uri?.let { arrayOf(it) })
        }

    private fun finishFileChooser(uris: Array<Uri>?) {
        val callback = chooserCallback
        chooserCallback = null
        callback?.onReceiveValue(uris)
    }

    private val folderLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uri = result.data?.data
            val json = JSONObject()
            if (result.resultCode == RESULT_OK && uri != null) {
                try {
                    contentResolver.takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
                } catch (_: Exception) { }
                treeUri = uri
                getPreferences(MODE_PRIVATE).edit().putString("tree", uri.toString()).apply()
                json.put("ok", true).put("name", folderLabel(uri))
            } else {
                json.put("ok", false)
            }
            web.evaluateJavascript(
                "window.__onFolderPicked && window.__onFolderPicked(${JSONObject.quote(json.toString())})", null
            )
        }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            web.evaluateJavascript("(window.__onBack && window.__onBack()) === true") { v ->
                if (v != "true") {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        }
    }

    private val saveLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val src = pendingSave
            pendingSave = null
            val target = result.data?.data
            if (src == null) return@registerForActivityResult
            if (result.resultCode == RESULT_OK && target != null) {
                Thread {
                    try {
                        contentResolver.openOutputStream(target, "w")?.use { out ->
                            src.inputStream().use { it.copyTo(out) }
                        }
                        toast("Saved")
                    } catch (e: Exception) {
                        toast("Couldn't save: ${e.message}")
                    }
                    src.delete()
                }.start()
            } else {
                src.delete()
            }
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, backCallback)
        treeUri = getPreferences(MODE_PRIVATE).getString("tree", null)?.let { Uri.parse(it) }

        // Capacitor owns the WebView and applies system-bar/cutout/IME insets.
        // SystemBars injects safe-area CSS values; do not pad the root again.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        web = bridge.webView
        root = window.decorView
        root.setBackgroundColor(ContextCompat.getColor(this, R.color.page_bg))
        applySystemBars()

        // Debuggable builds can be inspected from chrome://inspect.
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // remembers your settings (never passwords or PDFs)
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(web.settings, false) // the app has its own dark theme
        }

        bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                // The page may only load its own bundled files. Anything else is blocked, so the part of
                // the app that handles your PDFs can never reach the internet.
                if (request.url.host != HOST) {
                    return WebResourceResponse(
                        "text/plain", "utf-8", 403, "Blocked",
                        emptyMap(), ByteArrayInputStream(ByteArray(0))
                    )
                }
                if (request.url.path?.startsWith("/_incoming/") == true) {
                    return IncomingHandler(this@MainActivity).handle(request.url.path!!.removePrefix("/_incoming/"))
                        ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: Exception) { /* no handler */ }
                return true
            }
        })
        web.webChromeClient = object : BridgeWebChromeClient(bridge) {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                chooserCallback?.onReceiveValue(null)
                chooserCallback = callback
                return try {
                    val types = arrayOf("application/pdf")
                    if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        multipleChooserLauncher.launch(types)
                    } else {
                        singleChooserLauncher.launch(types)
                    }
                    true
                } catch (e: Exception) {
                    finishFileChooser(null)
                    false
                }
            }

            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.d("PDFCleaner", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "AndroidBridge")

        handleIncoming(intent)
        // Capacitor loads the bundled app and injects its JavaScript runtime.
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::web.isInitialized) handleIncoming(intent)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        web.evaluateJavascript("window.__syncSystemBars && window.__syncSystemBars()", null)
    }

    override fun onDestroy() {
        chooserCallback?.onReceiveValue(null)
        super.onDestroy()
    }

    // ---------------------------------------------------------------- helpers

    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= 29) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        val c = WindowCompat.getInsetsController(window, root)
        c.isAppearanceLightStatusBars = !night
        c.isAppearanceLightNavigationBars = !night
    }

    private fun toast(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }

    /** A PDF opened with / shared to this app: copy it into the cache so the page can fetch it. */
    private fun handleIncoming(intent: Intent?) {
        if (intent == null) return
        val uri: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            else -> null
        }
        if (uri == null) return
        Thread {
            try {
                val dir = File(cacheDir, "incoming").apply { mkdirs() }
                val dst = File(dir, "current.pdf")
                contentResolver.openInputStream(uri)?.use { input ->
                    dst.outputStream().use { input.copyTo(it) }
                } ?: throw IOException("Cannot open the shared file")
                incomingName = displayName(uri) ?: "document.pdf"
                runOnUiThread { web.evaluateJavascript("window.__onIncoming && window.__onIncoming()", null) }
            } catch (e: Exception) {
                toast("Couldn't open the PDF: ${e.message}")
            }
        }.start()
    }

    private fun displayName(uri: Uri): String? = try {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    // ---------------------------------------------------------------- JS bridge

    /** Exposed to the page as window.AndroidBridge. */
    inner class Bridge {
        /** Explicit user copies go directly to Android's system clipboard. */
        @JavascriptInterface
        fun copyText(text: String): Boolean = try {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("DePDF text", text))
            true
        } catch (_: Exception) {
            false
        }

        /** Match system icons and the legacy WebView inset background to the app theme. */
        @JavascriptInterface
        fun syncAppearance(background: String, dark: Boolean) {
            runOnUiThread {
                try {
                    root.setBackgroundColor(Color.parseColor(background))
                    val controller = WindowCompat.getInsetsController(window, root)
                    controller.isAppearanceLightStatusBars = !dark
                    controller.isAppearanceLightNavigationBars = !dark
                } catch (_: IllegalArgumentException) { }
            }
        }

        private var out: FileOutputStream? = null
        private var tmp: File? = null
        private var mime: String = "application/octet-stream"

        @JavascriptInterface
        fun begin(name: String, mimeType: String) {
            out?.close()
            val dir = File(cacheDir, "export").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }              // drop earlier exports
            val safe = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").ifBlank { "output.pdf" }
            tmp = File(dir, safe)
            mime = mimeType
            out = FileOutputStream(tmp)
        }

        @JavascriptInterface
        fun chunk(base64: String) {
            out?.write(Base64.decode(base64, Base64.DEFAULT))
        }

        /** mode = "save" (system "save as" picker) or "share" (share sheet). */
        @JavascriptInterface
        fun finish(mode: String) {
            out?.close()
            out = null
            val file = tmp ?: return
            runOnUiThread {
                try {
                    when (mode) {
                        "share" -> shareFile(file, mime)
                        "folder" -> saveToFolder(file, mime, false)
                        "folder_quiet" -> saveToFolder(file, mime, true)
                        else -> saveFile(file, mime)
                    }
                } catch (e: Exception) {
                    toast("Couldn't ${if (mode == "share") "share" else "save"}: ${e.message}")
                }
            }
        }

        /** Opens the system folder picker; the result arrives via window.__onFolderPicked(json). */
        @JavascriptInterface
        fun pickFolder() {
            runOnUiThread {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    )
                    treeUri?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
                }
                try {
                    folderLauncher.launch(intent)
                } catch (e: Exception) {
                    toast("No folder picker available")
                }
            }
        }

        /** App version name, e.g. "1.0". */
        @JavascriptInterface
        fun getVersion(): String = appVersion()

        /** Starts an update check; the result arrives via window.__onUpdateResult(json). */
        @JavascriptInterface
        fun checkUpdate() {
            Thread {
                val json = fetchUpdateInfo()
                runOnUiThread {
                    web.evaluateJavascript(
                        "window.__onUpdateResult && window.__onUpdateResult(${JSONObject.quote(json)})", null
                    )
                }
            }.start()
        }

        /** Opens a page of the configured GitHub repository (release page / APK) in the browser. */
        @JavascriptInterface
        fun openUrl(url: String) {
            val repo = updateRepo()
            if (repo.isEmpty() || !(url == "https://github.com/$repo" || url.startsWith("https://github.com/$repo/"))) return
            runOnUiThread {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                } catch (_: Exception) { toast("No app can open this link") }
            }
        }

        /** Returns the name of a PDF sent to the app (and forgets it), or "". */
        @JavascriptInterface
        fun takeIncomingName(): String {
            val n = incomingName
            incomingName = ""
            return n
        }
    }

    // ---------------------------------------------------------------- update check

    @Suppress("DEPRECATION")
    private fun appVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
    } catch (_: Exception) {
        "0"
    }

    /** "owner/repo" from res/values/update.xml, or "" when not configured / invalid. */
    private fun updateRepo(): String {
        val repo = getString(R.string.update_repo).trim()
        return if (Regex("[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+").matches(repo)) repo else ""
    }

    private fun versionParts(v: String): List<Int> =
        v.trim().removePrefix("v").removePrefix("V").split(Regex("[^0-9]+"))
            .filter { it.isNotEmpty() }.map { it.toIntOrNull() ?: 0 }

    private fun isNewer(latest: String, current: String): Boolean {
        val a = versionParts(latest)
        val b = versionParts(current)
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /**
     * One HTTPS GET to the GitHub API for the latest release. Sends no personal data and no files.
     * Returns JSON: {status: ok|update|none|not_configured|error, current, latest, url, apk, notes, error}.
     */
    private fun fetchUpdateInfo(): String {
        val out = JSONObject()
        val current = appVersion()
        out.put("current", current)
        val repo = updateRepo()
        if (repo.isEmpty()) {
            out.put("status", "not_configured")
            return out.toString()
        }
        var conn: HttpURLConnection? = null
        try {
            conn = (URL("https://api.github.com/repos/$repo/releases/latest").openConnection() as HttpURLConnection).apply {
                connectTimeout = 10000
                readTimeout = 10000
                setRequestProperty("Accept", "application/vnd.github+json")
                setRequestProperty("User-Agent", "DePDF-update-check")
            }
            val code = conn.responseCode
            if (code == 404) {
                out.put("status", "none")
                return out.toString()
            }
            if (code != 200) {
                out.put("status", "error").put("error", "GitHub answered with code $code")
                return out.toString()
            }
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val tag = json.optString("tag_name")
            val prefix = "https://github.com/$repo"
            val page = json.optString("html_url").takeIf { it.startsWith("$prefix/") } ?: "$prefix/releases/latest"
            var apk = ""
            val assets = json.optJSONArray("assets")
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    val u = a.optString("browser_download_url")
                    if (a.optString("name").endsWith(".apk", ignoreCase = true) && u.startsWith("$prefix/")) {
                        apk = u
                        break
                    }
                }
            }
            out.put("latest", tag)
            out.put("url", page)
            out.put("apk", apk)
            out.put("notes", json.optString("body").trim().take(800))
            out.put("status", if (tag.isNotEmpty() && isNewer(tag, current)) "update" else "ok")
        } catch (e: java.net.UnknownHostException) {
            out.put("status", "error").put("error", "No internet connection")
        } catch (e: java.net.SocketTimeoutException) {
            out.put("status", "error").put("error", "The connection timed out")
        } catch (e: Exception) {
            out.put("status", "error").put("error", e.message ?: "Update check failed")
        } finally {
            conn?.disconnect()
        }
        return out.toString()
    }

    private fun folderLabel(tree: Uri): String = try {
        val id = Uri.decode(DocumentsContract.getTreeDocumentId(tree))
        id.substringAfter(':', "").ifBlank { "Device storage" }
    } catch (_: Exception) {
        "folder"
    }

    /** Writes a finished file into the folder the user picked. */
    private fun saveToFolder(file: File, mime: String, quiet: Boolean = false) {
        val tree = treeUri
        if (tree == null) {
            saveFile(file, mime)
            return
        }
        Thread {
            try {
                val parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
                val doc = DocumentsContract.createDocument(contentResolver, parent, mime, file.name)
                    ?: throw IOException("Can't create the file")
                contentResolver.openOutputStream(doc, "w")?.use { out ->
                    file.inputStream().use { it.copyTo(out) }
                }
                if (!quiet) toast("Saved to ${folderLabel(tree)}")
            } catch (e: Exception) {
                toast("Couldn't save: ${e.message}")
            }
            file.delete()
        }.start()
    }

    private fun saveFile(file: File, mime: String) {
        pendingSave = file
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, file.name)
        }
        saveLauncher.launch(intent)
    }

    private fun shareFile(file: File, mime: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, file.name))
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
    }
}

/** Serves a PDF that was opened with / shared to the app, from the app's private cache. */
private class IncomingHandler(private val context: Context) {
    fun handle(path: String): WebResourceResponse? {
        if (path != "current.pdf") return null
        val f = File(context.cacheDir, "incoming/current.pdf")
        if (!f.isFile) return null
        return WebResourceResponse(
            "application/pdf", null, 200, "OK",
            mapOf("Cache-Control" to "no-store"),
            FileInputStream(f)
        )
    }
}
