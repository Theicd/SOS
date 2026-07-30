package com.sos010.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * מעטפת WebView ל-SOS – אותו ממשק ווב, עם שירות רקע + התראות מערכת.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var pendingWebPermission: PermissionRequest? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var bridgePickRequestId: String? = null
    private val pickedNativeFiles = ConcurrentHashMap<String, Pair<Uri, String>>()

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val req = pendingWebPermission
        pendingWebPermission = null
        if (req != null) {
            grantWebPermissionIfAllowed(req)
        }
        notifyJsPermissionsUpdated()
    }

    // חלק File Chooser – OpenDocument הוא ה-API היציב ביותר לבחירת קבצים | HYPER CORE TECH
    private val openDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        finishFilePick(if (uri != null) arrayOf(uri) else null)
    }

    private val openMultipleDocumentsLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        finishFilePick(if (uris.isNullOrEmpty()) null else uris.toTypedArray())
    }

    private val getContentLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        finishFilePick(if (uri != null) arrayOf(uri) else null)
    }

    private val legacyChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = parseChooserResult(result.resultCode, result.data)
        finishFilePick(uris)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        isHostAlive = true
        WindowCompat.setDecorFitsSystemWindows(window, true)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        loading = findViewById(R.id.loading)

        NotificationHelper.ensureChannels(this)
        requestRuntimePermissions()
        maybeRequestBatteryOptimizationExemption()
        startKeepAliveService()

        setupWebView()
        val startUrl = resolveStartUrl(intent)
        webView.loadUrl(startUrl)

        if (intent?.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false) == true) {
            moveTaskToBack(true)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        CallSoundHelper.stopAll()
        val url = resolveStartUrl(intent)
        if (this::webView.isInitialized && url != webView.url) {
            webView.loadUrl(url)
        }
        if (intent.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false)) {
            moveTaskToBack(true)
        }
    }

    override fun onResume() {
        super.onResume()
        isHostAlive = true
        CallSoundHelper.stopAll()
        NotificationHelper.cancelIncomingCall(this)
        startKeepAliveService()
        if (this::webView.isInitialized) {
            try {
                webView.onResume()
                webView.resumeTimers()
            } catch (_: Exception) {
            }
            webView.evaluateJavascript(
                "window.dispatchEvent(new Event('sos-native-resume'));",
                null
            )
            injectNativeFilePickScript()
        }
    }

    override fun onStop() {
        isHostAlive = false
        startKeepAliveService()
        super.onStop()
    }

    override fun onPause() {
        if (this::webView.isInitialized) {
            try {
                webView.resumeTimers()
            } catch (_: Exception) {
            }
        }
        startKeepAliveService()
        super.onPause()
    }

    override fun onUserLeaveHint() {
        startKeepAliveService()
        super.onUserLeaveHint()
    }

    override fun onDestroy() {
        isHostAlive = false
        try {
            filePathCallback?.onReceiveValue(null)
        } catch (_: Exception) {
        }
        filePathCallback = null
        if (bridgePickRequestId != null) {
            deliverBridgeFiles(bridgePickRequestId!!, null)
            bridgePickRequestId = null
        }
        startKeepAliveService()
        SosForegroundService.scheduleRestart(applicationContext, 800L)
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            startKeepAliveService()
            moveTaskToBack(true)
        }
    }

    private fun resolveStartUrl(intent: Intent?): String {
        val data = intent?.data
        if (data != null && data.scheme == "https" && data.host?.endsWith("sos010.com") == true) {
            return data.toString()
        }
        val openUrl = intent?.getStringExtra(EXTRA_OPEN_URL)
        if (!openUrl.isNullOrBlank()) return openUrl
        return BuildConfig.SOS_START_URL
    }

    private fun setupWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.userAgentString = settings.userAgentString + " SOSNativeShell/${BuildConfig.VERSION_NAME}"
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.safeBrowsingEnabled = true
        }

        webView.addJavascriptInterface(SosJsBridge(this, webView), "SosNativeShell")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url ?: return false
                if (url.host?.endsWith("sos010.com") == true) return false
                if (url.host == NATIVE_FILE_HOST) return true
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, url))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return super.shouldInterceptRequest(view, request)
                if (url.scheme == "https" && url.host == NATIVE_FILE_HOST) {
                    // preflight ל-fetch חוצה-מקור מתוך העמוד
                    if (request.method.equals("OPTIONS", ignoreCase = true)) {
                        val headers = mapOf(
                            "Access-Control-Allow-Origin" to "*",
                            "Access-Control-Allow-Methods" to "GET, OPTIONS",
                            "Access-Control-Allow-Headers" to "*",
                            "Access-Control-Max-Age" to "86400"
                        )
                        return WebResourceResponse(
                            "text/plain",
                            "UTF-8",
                            200,
                            "OK",
                            headers,
                            java.io.ByteArrayInputStream(ByteArray(0))
                        )
                    }
                    val segments = url.pathSegments
                    if (segments.size >= 2 && segments[0] == "file") {
                        val id = segments[1]
                        val entry = pickedNativeFiles[id]
                        if (entry != null) {
                            val (uri, mime) = entry
                            return try {
                                val stream = contentResolver.openInputStream(uri) ?: return null
                                val safeMime = mime.ifBlank { "application/octet-stream" }
                                // חלק CORS (MainActivity.kt) – בלי הכותרות fetch() מהעמוד נחסם ב-WebView | HYPER CORE TECH
                                val headers = mapOf(
                                    "Access-Control-Allow-Origin" to "*",
                                    "Access-Control-Allow-Methods" to "GET, OPTIONS",
                                    "Content-Type" to safeMime,
                                    "Cache-Control" to "no-store"
                                )
                                WebResourceResponse(
                                    safeMime,
                                    "UTF-8",
                                    200,
                                    "OK",
                                    headers,
                                    stream
                                )
                            } catch (e: Exception) {
                                Log.e(TAG, "shouldInterceptRequest file failed", e)
                                null
                            }
                        }
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                loading.visibility = View.VISIBLE
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                loading.visibility = View.GONE
                injectNativeFlag()
                injectNativeFilePickScript()
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                if (consoleMessage != null) {
                    Log.i(
                        TAG,
                        "JS ${consoleMessage.messageLevel()} ${consoleMessage.sourceId()}:${consoleMessage.lineNumber()} ${consoleMessage.message()}"
                    )
                }
                return super.onConsoleMessage(consoleMessage)
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                runOnUiThread { handleWebPermissionRequest(request) }
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                Log.i(TAG, "onShowFileChooser accept=${fileChooserParams?.acceptTypes?.joinToString()}")
                try {
                    this@MainActivity.filePathCallback?.onReceiveValue(null)
                } catch (_: Exception) {
                }
                this@MainActivity.filePathCallback = filePathCallback
                bridgePickRequestId = null
                val accept = fileChooserParams?.acceptTypes?.joinToString(",") ?: "*/*"
                val multiple = fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                toast("פותח בחירת קבצים…")
                scheduleOpenPicker(accept, multiple)
                return true
            }
        }
    }

    /** נקרא מ-SosNativeShell.openFilePicker */
    fun openFilePickerFromJs(requestId: String, accept: String) {
        // JavascriptInterface רץ על thread רקע – חובה להעלות ל-UI עם השהייה קצרה אחרי gesture
        mainHandler.post {
            Log.i(TAG, "openFilePickerFromJs id=$requestId accept=$accept")
            toast("פותח בחירת קבצים…")
            try {
                filePathCallback?.onReceiveValue(null)
            } catch (_: Exception) {
            }
            filePathCallback = null
            bridgePickRequestId = requestId
            scheduleOpenPicker(accept, multiple = false)
        }
    }

    private fun scheduleOpenPicker(accept: String, multiple: Boolean) {
        // השהייה קצרה – WebView לפעמים בולע startActivity אם קוראים מיד מתוך gesture/JS bridge
        mainHandler.postDelayed({
            openPickerNow(accept, multiple)
        }, 120L)
    }

    private fun openPickerNow(accept: String, multiple: Boolean) {
        val mimes = normalizeMimeArray(accept)
        Log.i(TAG, "openPickerNow mimes=${mimes.joinToString()} multiple=$multiple")
        try {
            if (multiple) {
                openMultipleDocumentsLauncher.launch(mimes)
                return
            }
            openDocumentLauncher.launch(mimes)
        } catch (e: Exception) {
            Log.e(TAG, "OpenDocument failed, trying GetContent", e)
            try {
                getContentLauncher.launch("*/*")
            } catch (e2: Exception) {
                Log.e(TAG, "GetContent failed, trying legacy chooser", e2)
                try {
                    val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }
                    legacyChooserLauncher.launch(Intent.createChooser(intent, "בחר קובץ"))
                } catch (e3: Exception) {
                    Log.e(TAG, "All file pickers failed", e3)
                    toast("לא ניתן לפתוח את מנהל הקבצים")
                    finishFilePick(null)
                }
            }
        }
    }

    private fun normalizeMimeArray(accept: String): Array<String> {
        val parts = accept.split(',', ';')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .filter { it == "*/*" || (it.contains('/') && !it.contains(',') && it.length < 100) }
            .distinct()
        if (parts.isEmpty() || parts.contains("*/*")) return arrayOf("*/*")
        return parts.toTypedArray()
    }

    private fun finishFilePick(uris: Array<Uri>?) {
        val webCallback = filePathCallback
        filePathCallback = null
        val bridgeId = bridgePickRequestId
        bridgePickRequestId = null

        if (webCallback != null) {
            try {
                webCallback.onReceiveValue(uris)
            } catch (e: Exception) {
                Log.w(TAG, "filePathCallback failed", e)
            }
        }
        if (bridgeId != null) {
            deliverBridgeFiles(bridgeId, uris)
        }
    }

    private fun parseChooserResult(resultCode: Int, data: Intent?): Array<Uri>? {
        if (resultCode != RESULT_OK || data == null) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 0) {
            val list = ArrayList<Uri>(clip.itemCount)
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i)?.uri?.let { list.add(it) }
            }
            if (list.isNotEmpty()) return list.toTypedArray()
        }
        data.data?.let { return arrayOf(it) }
        return null
    }

    private fun queryDisplayName(uri: Uri): String {
        var name: String? = null
        var cursor: Cursor? = null
        try {
            cursor = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            if (cursor != null && cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) name = cursor.getString(idx)
            }
        } catch (_: Exception) {
        } finally {
            try {
                cursor?.close()
            } catch (_: Exception) {
            }
        }
        if (!name.isNullOrBlank()) return name
        return uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    }

    private fun querySize(uri: Uri): Long {
        var cursor: Cursor? = null
        try {
            cursor = contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            if (cursor != null && cursor.moveToFirst()) {
                val idx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (idx >= 0 && !cursor.isNull(idx)) return cursor.getLong(idx)
            }
        } catch (_: Exception) {
        } finally {
            try {
                cursor?.close()
            } catch (_: Exception) {
            }
        }
        return -1L
    }

    private fun guessMime(name: String, fallback: String): String {
        val lower = name.lowercase()
        return when {
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".heic") || lower.endsWith(".heif") -> "image/heic"
            lower.endsWith(".mp4") -> "video/mp4"
            lower.endsWith(".webm") -> "video/webm"
            lower.endsWith(".mov") -> "video/quicktime"
            lower.endsWith(".mkv") -> "video/x-matroska"
            lower.endsWith(".3gp") -> "video/3gpp"
            else -> fallback.ifBlank { "application/octet-stream" }
        }
    }

    private fun deliverBridgeFiles(requestId: String, uris: Array<Uri>?) {
        if (!this::webView.isInitialized) return
        val filesJson = JSONArray()
        if (uris != null) {
            for (uri in uris) {
                try {
                    try {
                        contentResolver.takePersistableUriPermission(
                            uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    } catch (_: SecurityException) {
                    }
                    val id = UUID.randomUUID().toString()
                    val name = queryDisplayName(uri)
                    val rawMime = contentResolver.getType(uri) ?: ""
                    val mime = guessMime(name, rawMime)
                    val size = querySize(uri)
                    pickedNativeFiles[id] = uri to mime
                    val item = JSONObject()
                        .put("id", id)
                        .put("name", name)
                        .put("type", mime)
                        .put("size", size)
                        .put("url", "https://$NATIVE_FILE_HOST/file/$id")

                    // חלק אמינות (MainActivity.kt) – קבצים עד 16MB גם כ-base64 (fetch חוצה-מקור נכשל בלי CORS) | HYPER CORE TECH
                    val inlineLimit = 16L * 1024L * 1024L
                    if (size in 1..inlineLimit) {
                        try {
                            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                            if (bytes != null && bytes.size <= inlineLimit.toInt()) {
                                item.put(
                                    "base64",
                                    android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                                )
                                item.put("size", bytes.size)
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "inline base64 failed, will use url fetch", e)
                        }
                    }

                    filesJson.put(item)
                } catch (e: Exception) {
                    Log.e(TAG, "deliverBridgeFiles item failed", e)
                }
            }
        }
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("files", filesJson)
        val js = "window.dispatchEvent(new CustomEvent('sos-native-file-pick',{detail:$payload}));"
        Log.i(TAG, "deliverBridgeFiles requestId=$requestId count=${filesJson.length()} hasBase64=${filesJson.length() > 0 && filesJson.optJSONObject(0)?.has("base64") == true}")
        if (filesJson.length() > 0) {
            toast("טוען קובץ…")
        }
        webView.evaluateJavascript(js, null)
    }

    private fun handleWebPermissionRequest(request: PermissionRequest) {
        val need = mutableListOf<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        need += Manifest.permission.RECORD_AUDIO
                    }
                }
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                        != PackageManager.PERMISSION_GRANTED
                    ) {
                        need += Manifest.permission.CAMERA
                    }
                }
            }
        }
        if (need.isEmpty()) {
            grantWebPermissionIfAllowed(request)
            return
        }
        pendingWebPermission = request
        permissionLauncher.launch(need.distinct().toTypedArray())
    }

    private fun grantWebPermissionIfAllowed(request: PermissionRequest) {
        val granted = mutableListOf<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        granted += resource
                    }
                }
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        granted += resource
                    }
                }
                else -> granted += resource
            }
        }
        try {
            if (granted.isNotEmpty()) {
                request.grant(granted.toTypedArray())
            } else {
                request.deny()
            }
        } catch (_: Exception) {
        }
    }

    private fun notifyJsPermissionsUpdated() {
        if (!this::webView.isInitialized) return
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('sos-native-permissions',{detail:{mic:$mic,camera:$cam}}));",
            null
        )
    }

    private fun injectNativeFlag() {
        val js = """
            (function(){
              try {
                window.SOS_NATIVE_SHELL = true;
                window.SOS_NATIVE_HAS_FCM = ${BuildConfig.HAS_FCM};
                window.SOS_NATIVE_SHELL_VERSION = ${JSONObject.quote(BuildConfig.VERSION_NAME)};
                document.documentElement.setAttribute('data-sos-native','1');
                window.dispatchEvent(new Event('sos-native-ready'));
              } catch (e) {}
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun injectNativeFilePickScript() {
        if (!this::webView.isInitialized) return
        try {
            val script = assets.open("sos-native-file-pick.js").bufferedReader().use { it.readText() }
            webView.evaluateJavascript(script, null)
            Log.i(TAG, "injected sos-native-file-pick.js")
        } catch (e: Exception) {
            Log.e(TAG, "failed to inject sos-native-file-pick.js", e)
            toast("שגיאת טעינת בוחר קבצים")
        }
    }

    private fun toast(msg: String) {
        try {
            Toast.makeText(applicationContext, msg, Toast.LENGTH_SHORT).show()
        } catch (_: Exception) {
        }
    }

    private fun requestRuntimePermissions() {
        val needed = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.POST_NOTIFICATIONS
            }
        }
        listOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA
        ).forEach { perm ->
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needed += perm
            }
        }
        if (Build.VERSION.SDK_INT >= 31) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.BLUETOOTH_CONNECT
            }
        }
        if (needed.isNotEmpty()) {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    fun requestMediaPermissionsFromJs(needCamera: Boolean) {
        runOnUiThread {
            val needed = mutableListOf<String>()
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.RECORD_AUDIO
            }
            if (needCamera && ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED
            ) {
                needed += Manifest.permission.CAMERA
            }
            if (needed.isEmpty()) {
                notifyJsPermissionsUpdated()
                return@runOnUiThread
            }
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun maybeRequestBatteryOptimizationExemption() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        } catch (_: Exception) {
        }
    }

    private fun startKeepAliveService() {
        SosForegroundService.start(this)
    }

    companion object {
        private const val TAG = "SosMain"
        const val NATIVE_FILE_HOST = "sos-native.app"

        const val EXTRA_OPEN_URL = "open_url"
        const val EXTRA_START_IN_BACKGROUND = "start_in_background"

        @JvmField
        @Volatile
        var isHostAlive: Boolean = false
    }
}
