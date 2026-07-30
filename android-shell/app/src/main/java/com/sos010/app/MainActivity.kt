package com.sos010.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.view.View
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
    @Volatile private var pendingWebPermission: PermissionRequest? = null
    /** חלק בחירת קובץ (MainActivity.kt) – callback מ-WebView ל-input[type=file] | HYPER CORE TECH */
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    /** חלק בחירת קובץ (MainActivity.kt) – בקשת pick דרך SosNativeShell.openFilePicker | HYPER CORE TECH */
    private var bridgePickRequestId: String? = null
    /** קבצים שנבחרו ל-fetch מ-https://sos-native.app/file/{id} | HYPER CORE TECH */
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

    // חלק File Chooser (MainActivity.kt) – פתיחת מנהל קבצים לצ'אט ולקומפוזר במובייל | HYPER CORE TECH
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val webCallback = filePathCallback
        filePathCallback = null
        val bridgeId = bridgePickRequestId
        bridgePickRequestId = null

        val uris = try {
            parseChooserResult(result.resultCode, result.data)
        } catch (e: Exception) {
            Log.w(TAG, "parseChooserResult failed", e)
            null
        }

        // גם בביטול חייבים להחזיר null — אחרת ה-WebView ננעל ולא יפתח שוב
        if (webCallback != null) {
            try {
                webCallback.onReceiveValue(uris)
            } catch (e: Exception) {
                Log.w(TAG, "filePathCallback.onReceiveValue failed", e)
            }
        }
        if (bridgeId != null) {
            deliverBridgeFiles(bridgeId, uris)
        }
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
        }
    }

    override fun onStop() {
        // הממשק לא בחזית – שירות הרקע מטפל בצלצול שיחות נכנסות
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

            // חלק קבצים (MainActivity.kt) – מגיש content:// שנבחר ב-picker ל-fetch מה-WebView | HYPER CORE TECH
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return super.shouldInterceptRequest(view, request)
                if (url.scheme == "https" && url.host == NATIVE_FILE_HOST) {
                    val segments = url.pathSegments
                    if (segments.size >= 2 && segments[0] == "file") {
                        val id = segments[1]
                        val entry = pickedNativeFiles[id]
                        if (entry != null) {
                            val (uri, mime) = entry
                            return try {
                                val stream = contentResolver.openInputStream(uri)
                                if (stream == null) {
                                    Log.w(TAG, "openInputStream null for $id")
                                    null
                                } else {
                                    WebResourceResponse(
                                        mime.ifBlank { "application/octet-stream" },
                                        null,
                                        stream
                                    )
                                }
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
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                runOnUiThread {
                    handleWebPermissionRequest(request)
                }
            }

            // חלק בחירת קובץ (MainActivity.kt) – חובה ל-WebView; מתקן MIME לא חוקי כמו image/*,video/* | HYPER CORE TECH
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

                return launchFileChooser(fileChooserParams, fromBridge = false)
            }
        }
    }

    /**
     * נקרא מ-SosNativeShell.openFilePicker – עוקף input HTML שלא תמיד מפעיל onShowFileChooser ב-WebView.
     */
    fun openFilePickerFromJs(requestId: String, accept: String) {
        runOnUiThread {
            Log.i(TAG, "openFilePickerFromJs id=$requestId accept=$accept")
            try {
                filePathCallback?.onReceiveValue(null)
            } catch (_: Exception) {
            }
            filePathCallback = null
            bridgePickRequestId = requestId
            val launched = launchFileChooser(acceptHint = accept, params = null, fromBridge = true)
            if (!launched) {
                bridgePickRequestId = null
                deliverBridgeFiles(requestId, null)
            }
        }
    }

    private fun launchFileChooser(
        params: WebChromeClient.FileChooserParams? = null,
        acceptHint: String? = null,
        fromBridge: Boolean
    ): Boolean {
        val intent = buildOpenDocumentIntent(params, acceptHint)
        return try {
            // בלי createChooser מקונן – DocumentsUI נפתח ישירות (אמין יותר ב-OEM)
            fileChooserLauncher.launch(intent)
            true
        } catch (e: ActivityNotFoundException) {
            Log.e(TAG, "OPEN_DOCUMENT not found, trying GET_CONTENT", e)
            try {
                fileChooserLauncher.launch(buildGetContentIntent(params, acceptHint))
                true
            } catch (e2: Exception) {
                Log.e(TAG, "GET_CONTENT also failed", e2)
                failPendingFilePick(fromBridge)
                false
            }
        } catch (e: Exception) {
            Log.e(TAG, "launchFileChooser failed", e)
            failPendingFilePick(fromBridge)
            false
        }
    }

    private fun failPendingFilePick(fromBridge: Boolean) {
        if (!fromBridge) {
            val cb = filePathCallback
            filePathCallback = null
            try {
                cb?.onReceiveValue(null)
            } catch (_: Exception) {
            }
        }
    }

    private fun normalizeMimeList(raw: List<String>): List<String> {
        val split = raw.flatMap { type ->
            type.split(',', ';')
                .map { it.trim() }
                .filter { it.isNotEmpty() }
        }.distinct()
        return split.filter { candidate ->
            candidate == "*/*" ||
                (candidate.contains('/') && !candidate.contains(',') && candidate.length < 100)
        }
    }

    private fun acceptTypesFrom(params: WebChromeClient.FileChooserParams?, acceptHint: String?): List<String> {
        val fromParams = params?.acceptTypes?.toList().orEmpty()
        val fromHint = if (!acceptHint.isNullOrBlank()) listOf(acceptHint) else emptyList()
        return normalizeMimeList(fromParams + fromHint)
    }

    // חלק Intent (MainActivity.kt) – ACTION_OPEN_DOCUMENT אמין יותר מ-GET_CONTENT ב-WebView | HYPER CORE TECH
    private fun buildOpenDocumentIntent(
        params: WebChromeClient.FileChooserParams?,
        acceptHint: String?
    ): Intent {
        val mimeTypes = acceptTypesFrom(params, acceptHint)
        Log.i(TAG, "OPEN_DOCUMENT mimes=${mimeTypes.joinToString()}")
        return Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            when {
                mimeTypes.isEmpty() || mimeTypes.contains("*/*") -> type = "*/*"
                mimeTypes.size == 1 -> type = mimeTypes[0]
                else -> {
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                }
            }
            if (params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
        }
    }

    private fun buildGetContentIntent(
        params: WebChromeClient.FileChooserParams?,
        acceptHint: String?
    ): Intent {
        val mimeTypes = acceptTypesFrom(params, acceptHint)
        return Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            when {
                mimeTypes.isEmpty() || mimeTypes.contains("*/*") -> type = "*/*"
                mimeTypes.size == 1 -> type = mimeTypes[0]
                else -> {
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                }
            }
            if (params?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            }
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
        return try {
            WebChromeClient.FileChooserParams.parseResult(resultCode, data)
        } catch (_: Exception) {
            null
        }
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
                        // לא כל URI תומך ב-persistable – מספיק הרשאה זמנית מה-picker
                    }
                    val id = UUID.randomUUID().toString()
                    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                    val name = queryDisplayName(uri)
                    pickedNativeFiles[id] = uri to mime
                    filesJson.put(
                        JSONObject()
                            .put("id", id)
                            .put("name", name)
                            .put("type", mime)
                            .put("url", "https://$NATIVE_FILE_HOST/file/$id")
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "deliverBridgeFiles item failed", e)
                }
            }
        }
        val payload = JSONObject()
            .put("requestId", requestId)
            .put("files", filesJson)
        val js = "window.dispatchEvent(new CustomEvent('sos-native-file-pick',{detail:$payload}));"
        Log.i(TAG, "deliverBridgeFiles requestId=$requestId count=${filesJson.length()}")
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
              try { window.__sosWireNativeFilePick && window.__sosWireNativeFilePick(); } catch (e) {}
              try {
                if (window.__sosNativeFilePickInjected) return;
                window.__sosNativeFilePickInjected = true;
                var inflight = false;
                function pick(accept) {
                  return new Promise(function(resolve) {
                    if (!window.SosNativeShell || typeof SosNativeShell.openFilePicker !== 'function') {
                      resolve(null); return;
                    }
                    if (inflight) { resolve(null); return; }
                    inflight = true;
                    var id = 'fp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                    var done = false;
                    function finish(files) {
                      if (done) return;
                      done = true; inflight = false;
                      window.removeEventListener('sos-native-file-pick', onRes);
                      resolve(files);
                    }
                    async function onRes(ev) {
                      var d = ev && ev.detail;
                      if (!d || d.requestId !== id) return;
                      var metas = (d.files || []);
                      if (!metas.length) { finish([]); return; }
                      var out = [];
                      for (var i = 0; i < metas.length; i++) {
                        var m = metas[i] || {};
                        var url = m.url || (m.id ? ('https://sos-native.app/file/' + m.id) : '');
                        if (!url) continue;
                        try {
                          var res = await fetch(url);
                          var blob = await res.blob();
                          out.push(new File([blob], m.name || ('file-' + (i + 1)), { type: m.type || blob.type || 'application/octet-stream' }));
                        } catch (err) { console.warn('[SOS-NATIVE] file load failed', err); }
                      }
                      finish(out);
                    }
                    window.addEventListener('sos-native-file-pick', onRes);
                    try { SosNativeShell.openFilePicker(id, String(accept || '*/*')); }
                    catch (err) { finish(null); return; }
                    setTimeout(function(){ finish(null); }, 180000);
                  });
                }
                async function onChat(e) {
                  e.preventDefault(); e.stopPropagation();
                  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                  var files = await pick((document.getElementById('chatComposerFileInput') || {}).accept || '*/*');
                  if (!files || !files[0]) return;
                  var App = window.NostrApp || {};
                  if (typeof App.handleChatFileSelection === 'function') App.handleChatFileSelection(files[0]);
                }
                async function onCompose(e) {
                  e.preventDefault(); e.stopPropagation();
                  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                  var files = await pick((document.getElementById('composeMediaInput') || {}).accept || 'image/*,video/*');
                  if (!files || !files[0]) return;
                  var App = window.NostrApp || {};
                  if (typeof App.handleComposeMediaFile === 'function') App.handleComposeMediaFile(files[0]);
                  else if (typeof window.handleComposeMediaFile === 'function') window.handleComposeMediaFile(files[0]);
                  else if (typeof window.handleMediaInput === 'function') window.handleMediaInput({ target: { files: files, value: '' } });
                }
                function bind(el, handler) {
                  if (!el || el.getAttribute('data-sos-native-pick') === '1') return;
                  el.setAttribute('data-sos-native-pick', '1');
                  el.addEventListener('click', handler, true);
                }
                window.__sosWireNativeFilePick = function() {
                  bind(document.getElementById('chatComposerFileButton'), onChat);
                  bind(document.getElementById('chatComposerFileInput'), onChat);
                  bind(document.getElementById('composeUploadChoice'), onCompose);
                  bind(document.getElementById('composeMediaInput'), onCompose);
                };
                window.__sosWireNativeFilePick();
                setTimeout(window.__sosWireNativeFilePick, 800);
                setTimeout(window.__sosWireNativeFilePick, 2500);
                console.log('[SOS-NATIVE] file picker injected v' + ${JSONObject.quote(BuildConfig.VERSION_NAME)});
              } catch (err) { console.warn('[SOS-NATIVE] file picker inject failed', err); }
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
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

    /** נקרא מגשר JS כשמתחילים שיחה – פותח דיאלוג אם חסר */
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
