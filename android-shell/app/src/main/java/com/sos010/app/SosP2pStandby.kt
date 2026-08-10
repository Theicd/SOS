package com.sos010.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * מנוע P2P ברקע: WebView חסר-ממשק בתוך תהליך ה-FGS.
 * נשאר חי גם אחרי סגירת כרטיסיית האפליקציה (בניגוד ל-WebView של MainActivity).
 * אותו origin כמו הממשק → localStorage/מפתחות/מודולי P2P הקיימים.
 */
object SosP2pStandby {
    private const val TAG = "SosP2pStandby"
    private const val NUDGE_MS = 12_000L
    private const val WAKE_MS = 60_000L

    // לא לקרוא בשם handler – בתוך WebView.apply זה נתפס כ-View.getHandler() (null) | HYPER CORE TECH
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var appRef: Context? = null
    @Volatile private var wanted = false
    @Volatile private var pageReady = false
    private var webView: WebView? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val nudgeRunnable = object : Runnable {
        override fun run() {
            try {
                if (wanted && !MainActivity.isHostAlive) {
                    startHeadlessIfNeeded("nudge")
                    injectResume()
                }
            } finally {
                if (wanted) mainHandler.postDelayed(this, NUDGE_MS)
            }
        }
    }

    fun ensureStarted(context: Context) {
        appRef = context.applicationContext
        wanted = true
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
        mainHandler.post { startHeadlessIfNeeded("ensure") }
    }

    /** הממשק בחזית – סוגרים את ה-headless כדי לא לכפול PeerConnection | HYPER CORE TECH */
    fun onHostForeground() {
        mainHandler.post { destroyHeadless("host-foreground") }
    }

    /** הכרטיסייה/Activity נסגרו – מריצים P2P ב-headless | HYPER CORE TECH */
    fun onHostBackground(context: Context) {
        appRef = context.applicationContext
        wanted = true
        mainHandler.postDelayed({ startHeadlessIfNeeded("host-background") }, 400L)
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.postDelayed(nudgeRunnable, NUDGE_MS)
    }

    fun maybeWarm(context: Context, peer: String?, reason: String) {
        appRef = context.applicationContext
        wanted = true
        if (!peer.isNullOrBlank() && peer.matches(Regex("^[0-9a-f]{64}$"))) {
            val peers = SosSessionStore.getP2pPeers(context).toMutableList()
            if (!peers.contains(peer.lowercase())) {
                peers.add(0, peer.lowercase())
                SosSessionStore.setP2pPeers(context, peers.joinToString(","))
            }
        }
        Log.i(TAG, "signal/warm reason=$reason peer=${peer?.take(8) ?: "-"}")
        mainHandler.post {
            startHeadlessIfNeeded(reason)
            injectResume(peer)
        }
    }

    fun stop() {
        wanted = false
        mainHandler.removeCallbacks(nudgeRunnable)
        mainHandler.post { destroyHeadless("stop") }
        releaseWake()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun startHeadlessIfNeeded(reason: String) {
        val app = appRef ?: return
        if (!wanted) return
        if (!SosSessionStore.isP2pStandbyEnabled(app)) return
        if (MainActivity.isHostAlive) {
            Log.i(TAG, "skip headless – host alive ($reason)")
            return
        }
        if (SosSessionStore.getPubkey(app).length != 64) {
            Log.w(TAG, "no pubkey – headless idle")
            return
        }
        if (webView != null) {
            injectResume()
            acquireWake(app)
            return
        }
        try {
            Log.i(TAG, "starting headless WebView ($reason)")
            acquireWake(app)
            CookieManager.getInstance().setAcceptCookie(true)
            val wv = WebView(app).apply {
                setBackgroundColor(Color.BLACK)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.databaseEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                settings.cacheMode = WebSettings.LOAD_DEFAULT
                settings.userAgentString =
                    settings.userAgentString + " SOSNativeShell/${BuildConfig.VERSION_NAME} SOSP2pHeadless/1"
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    settings.safeBrowsingEnabled = false
                }
                CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                addJavascriptInterface(SosJsBridge(app, this), "SosNativeShell")
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        pageReady = true
                        injectNativeFlags()
                        injectResume()
                        // חיזוק אחרי אתחול מודולים איטי – mainHandler בלבד (לא View.handler) | HYPER CORE TECH
                        listOf(1500L, 4000L, 9000L).forEach { delay ->
                            mainHandler.postDelayed({
                                if (webView === view && !MainActivity.isHostAlive) injectResume()
                            }, delay)
                        }
                        Log.i(TAG, "headless page ready url=${url?.take(64)}")
                    }
                }
            }
            webView = wv
            pageReady = false
            wv.resumeTimers()
            wv.onResume()
            // דף מינימלי בלי פיד/סאונד – אותו origin כדי לשמור מפתחות | HYPER CORE TECH
            wv.loadUrl("https://sos010.com/p2p-standby.html?shell=77&p2pHeadless=1")
        } catch (err: Exception) {
            Log.e(TAG, "headless start failed: ${err.message}", err)
            destroyHeadless("start-failed")
        }
    }

    private fun destroyHeadless(reason: String) {
        val wv = webView ?: return
        Log.i(TAG, "destroy headless ($reason)")
        webView = null
        pageReady = false
        try {
            wv.stopLoading()
            wv.loadUrl("about:blank")
            wv.removeJavascriptInterface("SosNativeShell")
            wv.destroy()
        } catch (err: Exception) {
            Log.w(TAG, "destroy failed: ${err.message}")
        }
        releaseWake()
    }

    private fun injectNativeFlags() {
        val wv = webView ?: return
        val js = """
            (function(){
              try {
                window.__sosP2pHeadless = true;
                window.SOS_NATIVE_SHELL = true;
                window.SOS_NATIVE_HAS_FCM = ${BuildConfig.HAS_FCM};
                window.SOS_NATIVE_SHELL_VERSION = ${JSONObject.quote(BuildConfig.VERSION_NAME)};
                document.documentElement.setAttribute('data-sos-native','1');
                document.documentElement.setAttribute('data-sos-p2p-headless','1');
                try {
                  document.querySelectorAll('audio,video').forEach(function(el){
                    try { el.pause(); el.muted = true; el.removeAttribute('src'); el.load(); } catch (e) {}
                  });
                } catch (e) {}
                window.dispatchEvent(new Event('sos-native-ready'));
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            wv.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
    }

    private fun injectResume(peer: String? = null) {
        val wv = webView ?: return
        if (MainActivity.isHostAlive) return
        val app = appRef ?: return
        val peers = SosSessionStore.getP2pPeers(app)
        val arr = JSONArray()
        peers.forEach { arr.put(it) }
        if (!peer.isNullOrBlank() && peer.matches(Regex("^[0-9a-f]{64}$"))) {
            var found = false
            for (i in 0 until arr.length()) {
                if (arr.optString(i).equals(peer, true)) {
                    found = true
                    break
                }
            }
            if (!found) arr.put(peer.lowercase())
        }
        val peersJs = arr.toString()
        val peerJs = JSONObject.quote(peer?.lowercase().orEmpty())
        val js = """
            (function(){
              try {
                window.__sosP2pHeadless = true;
                window.__sosP2pPeers = $peersJs;
                var App = window.NostrApp || {};
                var dc = App.dataChannel;
                if (!dc) return;
                if (typeof dc.init === 'function') dc.init();
                if (typeof dc.resumeStandby === 'function') {
                  dc.resumeStandby($peerJs || null);
                }
                (window.__sosP2pPeers || []).forEach(function(p){
                  try {
                    if (typeof dc.connect === 'function') dc.connect(p);
                    else if (typeof dc.forceConnect === 'function') dc.forceConnect(p);
                  } catch (e) {}
                });
                window.dispatchEvent(new CustomEvent('sos-native-p2p-warm', {
                  detail: { peer: $peerJs, headless: true }
                }));
              } catch (e) {}
            })();
        """.trimIndent()
        try {
            wv.evaluateJavascript(js, null)
        } catch (err: Exception) {
            Log.w(TAG, "injectResume failed: ${err.message}")
        }
    }

    private fun acquireWake(context: Context) {
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:p2p-headless").also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
            // חידוש TTL בכל קריאה – שומר CPU ער בזמן headless / מסך כבוי | HYPER CORE TECH
            lock.acquire(WAKE_MS)
        } catch (err: Exception) {
            Log.w(TAG, "wake lock failed: ${err.message}")
        }
    }

    private fun releaseWake() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        wakeLock = null
    }
}
