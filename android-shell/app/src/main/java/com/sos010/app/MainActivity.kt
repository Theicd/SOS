package com.sos010.app

import android.app.NotificationManager
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.Color
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
import androidx.core.view.inputmethod.InputContentInfoCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * מעטפת WebView ל-SOS – אותו ממשק ווב, עם שירות רקע + התראות מערכת.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: SosWebView
    private lateinit var loading: ProgressBar
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var pendingWebPermission: PermissionRequest? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var bridgePickRequestId: String? = null
    private val pickedNativeFiles = ConcurrentHashMap<String, Pair<Uri, String>>()
    private val keyboardContentInfo = ConcurrentHashMap<String, InputContentInfoCompat>()
    @Volatile private var webPageReady = false
    @Volatile private var openedFromCallIntent = false
    private var pendingDeepLinkPeer: String? = null
    private var pendingIncomingCall: String? = null
    private var pendingCallAction: String? = null
    private var pendingAutoAccept: Boolean = false
    private var warmForCallPeer: String? = null
    private var warmForCallType: String? = null
    private var suppressCallCancelUntil = 0L

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
        maybeRequestFullScreenIntentPermission()
        maybeRequestBatteryOptimizationExemption()
        startKeepAliveService()

        setupWebView()
        captureDeepLinkFromIntent(intent)
        captureCallActionFromIntent(intent)
        captureWarmForCallFromIntent(intent)
        val startUrl = resolveStartUrl(intent)
        webView.loadUrl(startUrl)

        maybeDeferBackgroundStart(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)

        // לחיצה על אייקון האפליקציה – תמיד חזרה לפיד הבית, לא לשיחה האחרונה מהתרעה | HYPER CORE TECH
        if (isLauncherHomeIntent(intent)) {
            openedFromCallIntent = false
            pendingDeepLinkPeer = null
            pendingIncomingCall = null
            pendingCallAction = null
            pendingAutoAccept = false
            CallSoundHelper.stopAll()
            SosSessionStore.clearLastUrl(applicationContext)
            SosSessionStore.setLastUrl(applicationContext, BuildConfig.SOS_START_URL)
            returnToHomeFeed()
            if (intent.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false)) {
                moveTaskToBack(true)
            }
            return
        }

        captureDeepLinkFromIntent(intent)
        captureCallActionFromIntent(intent)
        captureWarmForCallFromIntent(intent)
        // שיחה נכנסת – לא עוצרים צלצול מיד; Web יקבל deeplink בלי reload | HYPER CORE TECH
        if (!openedFromCallIntent && pendingCallAction != CALL_ACTION_ANSWER && warmForCallPeer.isNullOrBlank()) {
            CallSoundHelper.stopAll()
        }
        if (webPageReady && isWarmSosPage()) {
            injectPendingDeepLink()
            injectPendingCallAction()
            injectWarmForCall()
        } else {
            val url = resolveStartUrl(intent)
            if (this::webView.isInitialized) {
                webPageReady = false
                webView.loadUrl(url)
            }
        }
        maybeDeferBackgroundStart(intent)
    }

    override fun onResume() {
        super.onResume()
        isHostAlive = true
        // חוסם צליל חוזר כשה-WebView מתעורר ומקבל אירועים ישנים | HYPER CORE TECH
        NotificationHelper.suppressAlertsFor(3000L)
        NotificationHelper.clearMessageNotifications(this)
        val ringingPeer = SosIncomingCallSession.activePeer(this)
        if (!ringingPeer.isNullOrBlank() && !openedFromCallIntent) {
            // פתיחת מסך בזמן צלצול – מעבירים ל-UI שיחה בלי לעצור את הצלצול | HYPER CORE TECH
            pendingDeepLinkPeer = ringingPeer
            pendingIncomingCall = SosIncomingCallSession.activeCallType(this)
            openedFromCallIntent = true
            suppressCallCancelUntil = System.currentTimeMillis() + 8000L
        } else if (!openedFromCallIntent && System.currentTimeMillis() >= suppressCallCancelUntil) {
            CallSoundHelper.stopAll()
            NotificationHelper.cancelIncomingCall(this)
        } else if (openedFromCallIntent) {
            // נותנים ל-Web להרים UI שיחה; מסירים כרטיס התראה בלי לעצור צלצול | HYPER CORE TECH
            suppressCallCancelUntil = System.currentTimeMillis() + 8000L
            mainHandler.postDelayed({
                NotificationHelper.cancelIncomingCall(this@MainActivity, stopSound = false)
                openedFromCallIntent = false
            }, 2500L)
        }
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
            if (webPageReady) {
                injectPendingDeepLink()
                injectPendingCallAction()
                injectWarmForCall()
            }
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
            return stripChatParam(data.toString())
        }
        val openUrl = intent?.getStringExtra(EXTRA_OPEN_URL)
        if (!openUrl.isNullOrBlank()) {
            // במענה/חימום – בלי chat= כדי לא לפתוח פאנל הודעות | HYPER CORE TECH
            val action = intent.getStringExtra(EXTRA_CALL_ACTION)
            if (action == CALL_ACTION_ANSWER || intent.getBooleanExtra(EXTRA_WARM_FOR_CALL, false)) {
                return stripChatParam(openUrl)
            }
            return openUrl
        }

        // פתיחה מאייקון / MAIN – תמיד דף הבית, בלי sticky chat מהתרעה קודמת | HYPER CORE TECH
        if (isLauncherHomeIntent(intent)) {
            SosSessionStore.clearLastUrl(applicationContext)
            return BuildConfig.SOS_START_URL
        }

        if (intent?.getBooleanExtra(EXTRA_WARM_FOR_CALL, false) == true) {
            return SosCallUrls.warmPage()
        }

        val remembered = SosSessionStore.getLastUrl(this)
        if (remembered.isNotBlank()) return remembered
        return BuildConfig.SOS_START_URL
    }

    private fun stripChatParam(url: String): String {
        return try {
            val uri = Uri.parse(url)
            val b = uri.buildUpon().clearQuery()
            val names = uri.queryParameterNames
            for (name in names) {
                if (name.equals("chat", ignoreCase = true)) continue
                uri.getQueryParameters(name).forEach { value ->
                    b.appendQueryParameter(name, value)
                }
            }
            b.build().toString()
        } catch (_: Exception) {
            url.replace(Regex("([?&])chat=[^&#]*"), "$1").replace("?&", "?").trimEnd('?', '&')
        }
    }

    /** Intent של לחיצה על האייקון (לא התרעה / לא deep-link / לא ענה-דחה) */
    private fun isLauncherHomeIntent(intent: Intent?): Boolean {
        if (intent == null) return true
        val callAction = intent.getStringExtra(EXTRA_CALL_ACTION)
        if (!callAction.isNullOrBlank()) return false
        if (intent.action == CallActionReceiver.ACTION_ANSWER ||
            intent.action == CallActionReceiver.ACTION_DECLINE
        ) return false
        if (!intent.getStringExtra(EXTRA_OPEN_URL).isNullOrBlank()) return false
        val data = intent.data
        if (data != null && data.scheme == "https") return false
        val action = intent.action
        if (action == Intent.ACTION_VIEW) return false
        // MAIN / null / ברירת מחדל של launcher
        if (action == Intent.ACTION_MAIN || action.isNullOrBlank()) return true
        val cats = intent.categories
        return cats != null && cats.contains(Intent.CATEGORY_LAUNCHER)
    }

    /** סוגר שיחה/overlays ומחזיר לפיד – בלי לרענן את כל ה-SPA אם כבר חם | HYPER CORE TECH */
    private fun returnToHomeFeed() {
        if (!this::webView.isInitialized) return
        if (webPageReady && isWarmSosPage()) {
            val js = """
                (function(){
                  try {
                    var App = window.NostrApp || {};
                    if (typeof App.clearSosDeepLinkFlags === 'function') App.clearSosDeepLinkFlags();
                    if (typeof App.closeChatPanel === 'function') App.closeChatPanel();
                    if (typeof App.closeAllOverlays === 'function') App.closeAllOverlays();
                    if (typeof App.closeNotificationsPanel === 'function') App.closeNotificationsPanel();
                    document.documentElement.removeAttribute('data-sos-deeplink');
                    document.body.classList.remove('sos-deeplink-chat');
                    try {
                      var u = new URL(window.location.href);
                      u.searchParams.delete('chat');
                      u.searchParams.delete('incomingCall');
                      history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams) : '') + u.hash);
                    } catch (e) {}
                  } catch (e) {}
                })();
            """.trimIndent()
            try {
                webView.evaluateJavascript(js, null)
            } catch (_: Exception) {
            }
        } else {
            webPageReady = false
            webView.loadUrl(BuildConfig.SOS_START_URL)
        }
    }

    /** בדחייה – משאירים את ה-WebView פעיל כמה שניות כדי לשלוח disconnect | HYPER CORE TECH */
    private fun maybeDeferBackgroundStart(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_START_IN_BACKGROUND, false) != true) return
        val action = intent.getStringExtra(EXTRA_CALL_ACTION)
            ?: when (intent.action) {
                CallActionReceiver.ACTION_DECLINE -> CALL_ACTION_DECLINE
                else -> null
            }
        if (action == CALL_ACTION_DECLINE) {
            mainHandler.postDelayed({
                try {
                    moveTaskToBack(true)
                } catch (_: Exception) {
                }
            }, 5500L)
        } else {
            moveTaskToBack(true)
        }
    }

    private fun captureDeepLinkFromIntent(intent: Intent?) {
        val url = intent?.getStringExtra(EXTRA_OPEN_URL)
            ?: intent?.data?.toString()
            ?: ""
        val peerFromExtra = intent?.getStringExtra(EXTRA_CALL_PEER)
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }
        val peer = peerFromExtra
            ?: extractQueryParam(url, "chat")
                ?.trim()
                ?.lowercase()
                ?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }
        val callFromExtra = intent?.getStringExtra(EXTRA_CALL_TYPE)?.trim()?.lowercase()
        val call = when {
            callFromExtra == "video" || callFromExtra == "v" || callFromExtra?.startsWith("v-") == true -> "video"
            !callFromExtra.isNullOrBlank() -> "voice"
            else -> extractQueryParam(url, "incomingCall")
                ?.trim()
                ?.lowercase()
                ?.let { raw ->
                    when {
                        raw == "video" || raw == "v" || raw.startsWith("v-") -> "video"
                        raw.isNotEmpty() -> "voice"
                        else -> null
                    }
                }
        }
        if (!peer.isNullOrBlank()) pendingDeepLinkPeer = peer
        if (!call.isNullOrBlank()) {
            pendingIncomingCall = call
            openedFromCallIntent = true
        }
    }

    private fun captureCallActionFromIntent(intent: Intent?) {
        if (intent == null) return
        val action = intent.getStringExtra(EXTRA_CALL_ACTION)
            ?: when (intent.action) {
                CallActionReceiver.ACTION_ANSWER -> CALL_ACTION_ANSWER
                CallActionReceiver.ACTION_DECLINE -> CALL_ACTION_DECLINE
                else -> null
            }
        if (action.isNullOrBlank()) return
        pendingCallAction = action
        if (action == CALL_ACTION_ANSWER) {
            pendingAutoAccept = true
            openedFromCallIntent = true
            NotificationHelper.cancelIncomingCall(applicationContext, stopSound = false)
            // מסתירים loading מיד במענה | HYPER CORE TECH
            if (this::loading.isInitialized) loading.visibility = View.GONE
        }
        if (action == CALL_ACTION_DECLINE) {
            pendingAutoAccept = false
            val peer = intent.getStringExtra(EXTRA_CALL_PEER) ?: pendingDeepLinkPeer
            SosIncomingCallSession.markDeclined(applicationContext, peer)
            SosPendingCallStore.clear(applicationContext)
            NotificationHelper.cancelIncomingCall(applicationContext, stopSound = true)
            CallSoundHelper.stopAll()
        }
    }

    /** חימום WebView בזמן צלצול – בלי לבטל התראה ובלי לפתוח UI שיחה | HYPER CORE TECH */
    private fun captureWarmForCallFromIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(EXTRA_WARM_FOR_CALL, false) != true) return
        val peer = intent.getStringExtra(EXTRA_CALL_PEER)
            ?.trim()
            ?.lowercase()
            ?.takeIf { it.matches(Regex("^[0-9a-f]{64}$")) }
        val type = when (intent.getStringExtra(EXTRA_CALL_TYPE)?.trim()?.lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        if (!peer.isNullOrBlank()) {
            warmForCallPeer = peer
            warmForCallType = type
            if (pendingDeepLinkPeer.isNullOrBlank()) pendingDeepLinkPeer = peer
        }
        if (this::loading.isInitialized) loading.visibility = View.GONE
    }

    private fun injectWarmForCall() {
        val peer = warmForCallPeer ?: return
        if (!this::webView.isInitialized) return
        val type = warmForCallType ?: "voice"
        val peerJs = JSONObject.quote(peer)
        val typeJs = JSONObject.quote(type)
        val rawEventJs = JSONObject.quote(SosPendingCallStore.getRawEventJson(applicationContext))
        val js = """
            (function(){
              try {
                window.__sosIncomingCallActive = true;
                document.documentElement.setAttribute('data-sos-deeplink', '1');
                document.body.classList.add('sos-call-active');
                var App = window.NostrApp || {};
                if (typeof App.initVoiceCall === 'function') App.initVoiceCall({ force: true, lookbackSec: 120 });
                if (typeof App.initVideoCall === 'function') App.initVideoCall({ force: true, lookbackSec: 120 });
                if (typeof App.prepareIncomingCallFromNative === 'function') {
                  App.prepareIncomingCallFromNative($peerJs, $typeJs, $rawEventJs);
                } else if (typeof App.nativeRequestMediaPermissions === 'function') {
                  App.nativeRequestMediaPermissions($typeJs === 'video');
                }
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            webView.evaluateJavascript(js, null)
            Log.i(TAG, "warm-for-call peer=${peer.take(8)} type=$type")
        } catch (err: Exception) {
            Log.w(TAG, "warm inject failed: ${err.message}")
        }
        listOf(500L, 1500L, 3500L).forEach { delay ->
            mainHandler.postDelayed({
                if (!this::webView.isInitialized) return@postDelayed
                try {
                    webView.evaluateJavascript(js, null)
                } catch (_: Exception) {
                }
            }, delay)
        }
    }

    private fun extractQueryParam(url: String, key: String): String? {
        if (url.isBlank()) return null
        return try {
            Uri.parse(url).getQueryParameter(key)
        } catch (_: Exception) {
            val match = Regex("[?&]$key=([^&#]+)").find(url) ?: return null
            Uri.decode(match.groupValues[1])
        }
    }

    private fun isWarmSosPage(): Boolean {
        if (!this::webView.isInitialized || !webPageReady) return false
        val current = webView.url?.lowercase().orEmpty()
        if (current.isBlank() || current.startsWith("about:")) return false
        return current.contains("sos010.com") || current.contains("videos.html")
    }

    private fun injectPendingDeepLink() {
        val peer = pendingDeepLinkPeer
        val call = pendingIncomingCall
        if (peer.isNullOrBlank() && call.isNullOrBlank()) return
        if (!this::webView.isInitialized) return
        val autoAccept = pendingAutoAccept && pendingCallAction == CALL_ACTION_ANSWER
        val peerJs = JSONObject.quote(peer ?: "")
        val callJs = JSONObject.quote(call ?: "")
        val pendingOfferRaw = SosPendingCallStore.getJson(applicationContext)
        val pendingRawEvent = SosPendingCallStore.getRawEventJson(applicationContext)
        val offerJs = JSONObject.quote(pendingOfferRaw)
        val rawEventJs = JSONObject.quote(pendingRawEvent)
        val js = """
            (function(){
              try {
                window.__sosIncomingCallActive = true;
                window.dispatchEvent(new CustomEvent('sos-native-deeplink', {
                  detail: {
                    chat: $peerJs,
                    incomingCall: $callJs,
                    pendingOffer: $offerJs,
                    pendingRawEvent: $rawEventJs,
                    autoAccept: ${if (autoAccept) "true" else "false"},
                    ts: Date.now()
                  }
                }));
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            webView.evaluateJavascript(js, null)
            Log.i(TAG, "injected deeplink peer=${peer?.take(8)} call=$call autoAccept=$autoAccept")
        } catch (err: Exception) {
            Log.w(TAG, "deeplink inject failed: ${err.message}")
        }
        pendingDeepLinkPeer = null
        pendingIncomingCall = null
        // לא מנקים pendingCallAction כאן – injectPendingCallAction חייב להריץ accept ישיר | HYPER CORE TECH
        if (autoAccept) {
            SosIncomingCallSession.markAnswered(applicationContext, peer)
        }
    }

    private fun injectPendingCallAction() {
        val action = pendingCallAction ?: return
        if (action == CALL_ACTION_ANSWER) {
            // אם deeplink כבר נוקה – accept ישיר
            val peer = intent?.getStringExtra(EXTRA_CALL_PEER)?.lowercase().orEmpty()
            val type = intent?.getStringExtra(EXTRA_CALL_TYPE)?.lowercase() ?: "voice"
            if (peer.isNotBlank()) injectNativeAccept(peer, type)
            pendingCallAction = null
            pendingAutoAccept = false
            return
        }
        if (action != CALL_ACTION_DECLINE) return
        val peer = intent?.getStringExtra(EXTRA_CALL_PEER)
            ?.trim()
            ?.lowercase()
            .orEmpty()
        val type = intent?.getStringExtra(EXTRA_CALL_TYPE)?.lowercase() ?: "voice"
        injectNativeDecline(peer, type)
        pendingCallAction = null
    }

    private fun injectNativeAccept(peer: String, callType: String) {
        if (!this::webView.isInitialized || peer.isBlank()) return
        val peerJs = JSONObject.quote(peer)
        val typeJs = JSONObject.quote(callType)
        val rawEventJs = JSONObject.quote(SosPendingCallStore.getRawEventJson(applicationContext))
        val js = """
            (function(){
              try {
                var App = window.NostrApp || {};
                if (typeof App.initVoiceCall === 'function') App.initVoiceCall({ force: true, lookbackSec: 120 });
                if (typeof App.initVideoCall === 'function') App.initVideoCall({ force: true, lookbackSec: 120 });
                if (typeof App.acceptIncomingCallFromNative === 'function') {
                  App.acceptIncomingCallFromNative($peerJs, $typeJs, $rawEventJs);
                }
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            webView.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
        // retries מהירים – העמוד אמור להיות חם מחימום בזמן צלצול | HYPER CORE TECH
        listOf(200L, 600L, 1200L, 2500L, 4500L).forEach { delay ->
            mainHandler.postDelayed({
                if (!this::webView.isInitialized) return@postDelayed
                try {
                    webView.evaluateJavascript(js, null)
                } catch (_: Exception) {
                }
            }, delay)
        }
    }

    private fun injectNativeDecline(peer: String, callType: String) {
        if (!this::webView.isInitialized) return
        val peerJs = JSONObject.quote(peer)
        val typeJs = JSONObject.quote(callType)
        val js = """
            (function(){
              try {
                var App = window.NostrApp || {};
                if (typeof App.initVoiceCall === 'function') App.initVoiceCall({ force: true, lookbackSec: 120 });
                if (typeof App.initVideoCall === 'function') App.initVideoCall({ force: true, lookbackSec: 120 });
                if (typeof App.declineIncomingCallFromNative === 'function') {
                  App.declineIncomingCallFromNative($peerJs, $typeJs);
                } else if ($typeJs === 'video' && typeof App.endVideoCall === 'function') {
                  App.endVideoCall();
                } else if (typeof App.endVoiceCall === 'function') {
                  App.endVoiceCall();
                }
                window.__sosIncomingCallActive = false;
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            webView.evaluateJavascript(js, null)
            Log.i(TAG, "injected decline peer=${peer.take(8)}")
        } catch (_: Exception) {
        }
        listOf(600L, 1200L, 2500L, 4000L, 6000L).forEach { delay ->
            mainHandler.postDelayed({
                if (!this::webView.isInitialized) return@postDelayed
                try {
                    webView.evaluateJavascript(js, null)
                } catch (_: Exception) {
                }
            }, delay)
        }
    }

    /** ניקוי deep-link ממתינים – נקרא מה-Web אחרי סגירת שיחה / חזרה לפיד */
    fun clearPendingDeepLinkFromJs() {
        pendingDeepLinkPeer = null
        pendingIncomingCall = null
        pendingCallAction = null
        pendingAutoAccept = false
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

        // רקע שחור במעטפת — מונע הבזק לבן לפני טעינת וידאו/פוסטר | HYPER CORE TECH
        webView.setBackgroundColor(Color.BLACK)
        webView.setBackgroundResource(android.R.color.black)

        webView.addJavascriptInterface(SosJsBridge(this, webView), "SosNativeShell")
        webView.richContentListener = SosWebView.RichContentListener { info, mime ->
            onKeyboardRichContent(info, mime)
        }

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
                webPageReady = false
                // בנתיב שיחה/חימום – בלי מסך טעינה מעל | HYPER CORE TECH
                val quiet = !pendingDeepLinkPeer.isNullOrBlank() ||
                    !pendingIncomingCall.isNullOrBlank() ||
                    pendingCallAction == CALL_ACTION_ANSWER ||
                    !warmForCallPeer.isNullOrBlank()
                if (quiet) {
                    loading.visibility = View.GONE
                } else {
                    loading.visibility = View.VISIBLE
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                loading.visibility = View.GONE
                webPageReady = true
                if (!url.isNullOrBlank()) {
                    // לא שומרים sticky chat= — רק כתובת בית נקייה | HYPER CORE TECH
                    SosSessionStore.setLastUrl(applicationContext, url)
                }
                injectNativeFlag()
                injectNativeFilePickScript()
                injectWarmForCall()
                injectPendingDeepLink()
                injectPendingCallAction()
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

    /** GIF/תמונה מהמקלדת המובנית (Commit Content) → צינור קבצי הצ'אט | HYPER CORE TECH */
    private fun onKeyboardRichContent(info: InputContentInfoCompat, mime: String) {
        mainHandler.post {
            try {
                deliverKeyboardMedia(info, mime)
            } catch (e: Exception) {
                Log.e(TAG, "onKeyboardRichContent failed", e)
                toast("לא ניתן לטעון את ה-GIF")
                try {
                    info.releasePermission()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun deliverKeyboardMedia(info: InputContentInfoCompat, mimeHint: String) {
        if (!this::webView.isInitialized) return
        val uri = info.contentUri
        val id = UUID.randomUUID().toString()
        val nameGuess = uri.lastPathSegment?.substringAfterLast('/') ?: "keyboard-gif.gif"
        val rawMime = contentResolver.getType(uri) ?: mimeHint
        val mime = guessMime(nameGuess, rawMime.ifBlank { "image/gif" })
        val safeName = when {
            nameGuess.contains('.') -> nameGuess
            mime == "image/gif" -> "keyboard.gif"
            mime == "image/png" -> "keyboard.png"
            mime == "image/webp" -> "keyboard.webp"
            mime.startsWith("image/") -> "keyboard.jpg"
            else -> "keyboard-media.bin"
        }
        pickedNativeFiles[id] = uri to mime
        keyboardContentInfo[id] = info

        val item = JSONObject()
            .put("id", id)
            .put("name", safeName)
            .put("type", mime)
            .put("url", "https://$NATIVE_FILE_HOST/file/$id")

        val inlineLimit = 16L * 1024L * 1024L
        try {
            val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes != null && bytes.isNotEmpty() && bytes.size <= inlineLimit.toInt()) {
                item.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                item.put("size", bytes.size)
            } else if (bytes != null) {
                item.put("size", bytes.size)
            } else {
                item.put("size", querySize(uri))
            }
        } catch (e: Exception) {
            Log.w(TAG, "keyboard media read failed, falling back to url", e)
            item.put("size", querySize(uri))
        }

        val payload = JSONObject().put("file", item)
        val js = "window.dispatchEvent(new CustomEvent('sos-native-keyboard-media',{detail:$payload}));"
        Log.i(TAG, "deliverKeyboardMedia id=$id mime=$mime size=${item.opt("size")}")
        toast("מצרף GIF…")
        webView.evaluateJavascript(js, null)

        mainHandler.postDelayed({
            try {
                keyboardContentInfo.remove(id)?.releasePermission()
            } catch (_: Exception) {
            }
        }, 30_000L)
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

    private fun maybeRequestFullScreenIntentPermission() {
        if (Build.VERSION.SDK_INT < 34) return
        try {
            val prefs = getSharedPreferences("sos_native_session", MODE_PRIVATE)
            if (prefs.getBoolean("fsi_prompted_v1", false)) return
            val nm = getSystemService(NotificationManager::class.java) ?: return
            if (nm.canUseFullScreenIntent()) {
                prefs.edit().putBoolean("fsi_prompted_v1", true).apply()
                return
            }
            prefs.edit().putBoolean("fsi_prompted_v1", true).apply()
            val intent = Intent(
                Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                Uri.parse("package:$packageName")
            )
            startActivity(intent)
            Toast.makeText(
                this,
                "אפשר ל-SOS התראות מסך מלא לשיחות נכנסות",
                Toast.LENGTH_LONG
            ).show()
        } catch (_: Exception) {
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
        const val EXTRA_CALL_ACTION = "call_action"
        const val EXTRA_CALL_PEER = "call_peer"
        const val EXTRA_CALL_TYPE = "call_type"
        const val EXTRA_WARM_FOR_CALL = "warm_for_call"
        const val CALL_ACTION_ANSWER = "answer"
        const val CALL_ACTION_DECLINE = "decline"

        @JvmField
        @Volatile
        var isHostAlive: Boolean = false

        /** מעיר/מחמם את ה-WebView ברקע בזמן צלצול כדי שענה יהיה מיידי | HYPER CORE TECH */
        fun warmHostForIncomingCall(context: Context, peer: String, callType: String) {
            val app = context.applicationContext
            val pk = peer.trim().lowercase()
            if (pk.length != 64) return
            val type = when (callType.trim().lowercase()) {
                "video", "v", "v-offer" -> "video"
                else -> "voice"
            }
            val intent = Intent(app, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_NO_USER_ACTION
                putExtra(EXTRA_START_IN_BACKGROUND, true)
                putExtra(EXTRA_WARM_FOR_CALL, true)
                putExtra(EXTRA_CALL_PEER, pk)
                putExtra(EXTRA_CALL_TYPE, type)
                putExtra(EXTRA_OPEN_URL, SosCallUrls.warmPage())
            }
            try {
                app.startActivity(intent)
            } catch (_: Exception) {
            }
        }
    }
}
