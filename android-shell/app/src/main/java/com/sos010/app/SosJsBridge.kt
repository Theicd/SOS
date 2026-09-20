package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * גשר JS ← Native. נחשף כ-window.SosNativeShell בתוך ה-WebView.
 * לא מתנגש עם AndroidBridge של רשת החירום.
 */
class SosJsBridge(
    private val context: Context,
    private val webView: WebView
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var cachedFcmToken: String = ""
    private companion object {
        private const val TAG = "SosJsBridge"
    }

    private fun clampText(value: String?, max: Int, fallback: String = ""): String {
        val raw = value?.trim().orEmpty()
        if (raw.isEmpty()) return fallback
        return if (raw.length <= max) raw else raw.take(max)
    }

    private fun isSafeHttpsOpenUrl(url: String?): Boolean {
        val raw = url?.trim().orEmpty()
        if (raw.isEmpty()) return true
        return try {
            val uri = android.net.Uri.parse(raw)
            val host = uri.host?.lowercase().orEmpty()
            uri.scheme == "https" && (host == "sos010.com" || host.endsWith(".sos010.com"))
        } catch (_: Exception) {
            false
        }
    }

    init {
        refreshFcmToken()
    }

    @JavascriptInterface
    fun isNativeShell(): Boolean = true

    /** true רק כשהממשק בחזית – ל-JS: התראות / אי־סימון נצפה ברקע | HYPER CORE TECH */
    @JavascriptInterface
    fun isHostAlive(): Boolean = MainActivity.isHostAlive

    @JavascriptInterface
    fun hasFcm(): Boolean = BuildConfig.HAS_FCM

    @JavascriptInterface
    fun getFcmToken(): String = cachedFcmToken

    @JavascriptInterface
    fun refreshFcmToken() {
        if (!BuildConfig.HAS_FCM) return
        try {
            val clazz = Class.forName("com.google.firebase.messaging.FirebaseMessaging")
            val instance = clazz.getMethod("getInstance").invoke(null)
            val task = clazz.getMethod("getToken").invoke(instance)
            val addOnSuccess = task.javaClass.getMethod(
                "addOnSuccessListener",
                Class.forName("com.google.android.gms.tasks.OnSuccessListener")
            )
            val listener = java.lang.reflect.Proxy.newProxyInstance(
                context.classLoader,
                arrayOf(Class.forName("com.google.android.gms.tasks.OnSuccessListener"))
            ) { _, method, args ->
                if (method.name == "onSuccess" && args != null && args.isNotEmpty()) {
                    cachedFcmToken = args[0]?.toString() ?: ""
                    mainHandler.post {
                        webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('sos-fcm-token',{detail:${JSONObject.quote(cachedFcmToken)}}));",
                            null
                        )
                    }
                }
                null
            }
            addOnSuccess.invoke(task, listener)
        } catch (_: Throwable) {
            // Firebase לא מוגדר / אין google-services.json
        }
    }

    @JavascriptInterface
    fun showNotification(title: String?, body: String?, openUrl: String?, tag: String?) {
        val safeUrl = if (isSafeHttpsOpenUrl(openUrl)) openUrl else null
        val safeTag = clampText(tag, 120).ifEmpty { null }
        NotificationHelper.showMessage(
            context.applicationContext,
            clampText(title, 120, "SOS").ifBlank { "SOS" },
            clampText(body, 500, "יש לך עדכון חדש").ifBlank { "יש לך עדכון חדש" },
            safeUrl,
            safeTag,
            eventId = null,
            peerKey = null
        )
    }

    /** התראת הודעה עם מזהה אירוע – מונע כפילות מול שירות הרקע | HYPER CORE TECH */
    @JavascriptInterface
    fun showChatNotification(
        title: String?,
        body: String?,
        openUrl: String?,
        tag: String?,
        eventId: String?,
        peerKey: String?
    ) {
        val safeUrl = if (isSafeHttpsOpenUrl(openUrl)) openUrl else null
        val safePeer = SosSessionStore.normalizeHexPubkey(peerKey).ifEmpty { null }
        val safeEvent = clampText(eventId, 128).ifEmpty { null }
        val safeTag = clampText(tag, 120).ifEmpty { null }
        NotificationHelper.showMessage(
            context.applicationContext,
            clampText(title, 120, "SOS").ifBlank { "SOS" },
            clampText(body, 500, "יש לך עדכון חדש").ifBlank { "יש לך עדכון חדש" },
            safeUrl,
            safeTag,
            eventId = safeEvent,
            peerKey = safePeer
        )
    }

    @JavascriptInterface
    fun clearMessageNotifications() {
        NotificationHelper.clearMessageNotifications(context.applicationContext)
    }

    /** שמירת pubkey לשירות הרקע – חובה לקבלת הודעות כשהממשק סגור | HYPER CORE TECH */
    @JavascriptInterface
    fun setUserPubkey(pubkey: String?) {
        val appCtx = context.applicationContext
        val incoming = SosSessionStore.normalizeHexPubkey(pubkey)
        if (incoming.isEmpty()) return
        if (!SosSessionStore.shouldPersistPubkey(SosSessionStore.getPubkey(appCtx), incoming)) {
            SosRelayWatcher.ensureStarted(appCtx)
            SosP2pStandby.ensureStarted(appCtx)
            return
        }
        SosSessionStore.setPubkey(appCtx, incoming)
        SosForegroundService.start(appCtx)
        SosRelayWatcher.ensureStarted(appCtx)
        SosP2pStandby.ensureStarted(appCtx)
    }

    /** מפתח פרטי ל-P2P Native ברקע (אחרי סגירת כרטיסייה) | HYPER CORE TECH */
    @JavascriptInterface
    fun setUserPrivkey(privkey: String?) {
        val appCtx = context.applicationContext
        val incoming = SosSessionStore.normalizeHexPubkey(privkey)
        if (incoming.isEmpty()) return
        if (incoming == SosSessionStore.getPrivkey(appCtx)) return
        SosSessionStore.setPrivkey(appCtx, incoming)
    }

    @JavascriptInterface
    fun notifyWebViewP2pReady() {
        SosP2pOwner.markWebViewReady()
    }

    /** הפעלת/כיבוי שמירת P2P במצב המתנה (ברירת מחדל: דלוק) | HYPER CORE TECH */
    @JavascriptInterface
    fun setP2pStandbyEnabled(enabled: Boolean) {
        SosSessionStore.setP2pStandbyEnabled(context.applicationContext, enabled)
        if (enabled) {
            SosP2pStandby.ensureStarted(context.applicationContext)
        }
    }

    /** סנכרון רשימת peers מועדפים ל-P2P Native ברקע (CSV) | HYPER CORE TECH */
    @JavascriptInterface
    fun syncP2pPeers(peersCsv: String?) {
        SosSessionStore.setP2pPeers(context.applicationContext, peersCsv)
        // שומרים רשימה בלבד – בלי להרים Native לכל ה-peers | HYPER CORE TECH
    }

    /** העברת קובץ פעילה – WakeLock + pump ל-WebView במסך כבוי | HYPER CORE TECH */
    @JavascriptInterface
    fun setP2pTransferActive(active: Boolean) {
        SosP2pTransferKeeper.setActive(context.applicationContext, active)
        if (active) {
            MainActivity.pumpWebViewKeepAlive()
        }
    }

    /** שמירת שם+תמונה של איש קשר להתראות רקע בסגנון וואטסאפ | HYPER CORE TECH */
    @JavascriptInterface
    fun cacheContact(pubkey: String?, name: String?, picture: String?) {
        val pk = SosSessionStore.normalizeHexPubkey(pubkey)
        if (pk.isEmpty()) return
        // Do NOT clamp data:image Base64 mid-stream — SosContactCache persists
        // a bounded local avatarfile. http(s) URLs stay length-bounded inside put().
        val pic = picture?.trim().orEmpty()
        SosContactCache.put(
            context.applicationContext,
            pk,
            clampText(name, 120),
            pic
        )
    }

    /**
     * Mark outer kind-1059 event id as durably HANDLED after JS processing
     * completed or deterministic rejection. Safe to call multiple times.
     */
    @JavascriptInterface
    fun ackSecureWrapHandled(eventId: String?) {
        val id = eventId?.trim()?.lowercase().orEmpty()
        if (id.length < 8) return
        SosSecureWrapHandledStore.markHandled(context.applicationContext, id)
        SosPendingCallStore.removeSecureWrap(context.applicationContext, id)
    }

    /** Re-queue an encrypted wrap after temporary processing failure (keys/runtime). */
    @JavascriptInterface
    fun requeueSecureWrap(eventJson: String?) {
        SosPendingCallStore.enqueueSecureWrap(context.applicationContext, eventJson)
    }

    @JavascriptInterface
    fun clearUserSession() {
        SosSessionStore.clear(context.applicationContext)
        SosContactCache.clear(context.applicationContext)
        SosRelayWatcher.stopAll()
    }

    @JavascriptInterface
    fun keepAlive() {
        val intent = android.content.Intent(context, SosForegroundService::class.java)
        androidx.core.content.ContextCompat.startForegroundService(context, intent)
        SosRelayWatcher.ensureStarted(context.applicationContext)
    }

    @JavascriptInterface
    fun startCallRingtone() {
        CallSoundHelper.startRingtone(context.applicationContext)
    }

    @JavascriptInterface
    fun stopCallRingtone() {
        CallSoundHelper.stopRingtone()
        // לא סוגרים מסך שיחה נייטיבי – רק צלצול/התראה | HYPER CORE TECH
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
    }

    @JavascriptInterface
    fun isIncomingCallSuppressed(peer: String?): Boolean {
        return SosIncomingCallSession.isSuppressed(context.applicationContext, peer)
    }

    @JavascriptInterface
    fun markIncomingCallDeclined(peer: String?) {
        val app = context.applicationContext
        // Connected/answered hangup must not be recorded as decline or send SOS to the launcher.
        if (SosIncomingCallSession.isAnsweredPhase(app)) {
            Log.i(TAG, "DECLINE_IGNORED_AFTER_ANSWER")
            SosDebugLog.i("call", "DECLINE_IGNORED_AFTER_ANSWER")
            markIncomingCallEnded(peer)
            return
        }
        // Terminal: tombstone active session BEFORE clearing UI/sounds.
        SosSecureCallSessionStore.markActiveDeclined(app)
        SosIncomingCallSession.markDeclined(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = true)
        NotificationHelper.cancelSecureVerifierWake(context.applicationContext)
        CallSoundHelper.stopAll()
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        MainActivity.cancelKeepFrontAfterDecline()
        clearHostWarmState()
        Log.i(TAG, "DECLINE_CANCEL_KEEPFRONT")
        SosDebugLog.i("call", "DECLINE_CANCEL_KEEPFRONT")
    }

    @JavascriptInterface
    fun markIncomingCallEnded(peer: String?) {
        val active = SosSecureCallSessionStore.activeSessionHash(context.applicationContext)
        if (active != null) {
            SosSecureCallSessionStore.markByHash(
                context.applicationContext,
                active,
                SosSecureCallSessionStore.STATE_ENDED
            )
        }
        SosIncomingCallSession.markRemoteEnded(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
        CallSoundHelper.stopAll()
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun markIncomingCallAnswered(peer: String?) {
        SosIncomingCallSession.markAnswered(context.applicationContext, peer)
        Log.i(TAG, "ANSWER_CLEARS_PENDING_DECLINE")
        SosDebugLog.i("call", "ANSWER_CLEARS_PENDING_DECLINE")
        rememberPendingOfferId()
        NotificationHelper.cancelIncomingCall(context.applicationContext, stopSound = true, dismissUi = false)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun notifyNativeCallConnected(peer: String?) {
        IncomingCallActivity.notifyCallConnected(context.applicationContext, peer)
        clearHostWarmState()
    }

    @JavascriptInterface
    fun notifyNativeCallEnded(peer: String?) {
        SosIncomingCallSession.markRemoteEnded(context.applicationContext, peer)
        rememberPendingOfferId()
        SosPendingCallStore.clear(context.applicationContext)
        IncomingCallActivity.notifyCallEnded(context.applicationContext, peer)
        clearHostWarmState()
    }

    private fun clearHostWarmState() {
        try {
            MainActivity.clearWarmOnHost("js-bridge")
        } catch (_: Exception) {
        }
    }

    private fun rememberPendingOfferId() {
        try {
            val id = SosPendingCallStore.extractEventId(context.applicationContext)
            SosIncomingCallSession.rememberHandledOffer(context.applicationContext, id)
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun startCallDialtone() {
        CallSoundHelper.startDialtone(context.applicationContext)
    }

    @JavascriptInterface
    fun stopCallDialtone() {
        CallSoundHelper.stopDialtone()
    }

    @JavascriptInterface
    fun stopCallSounds() {
        CallSoundHelper.stopAll()
        NotificationHelper.cancelIncomingCall(context.applicationContext)
    }

    /**
     * After JS authenticates Gift Wrap offer — ONLY then may Native ring.
     * peer/media come from decrypted inner payload, never from outer Relay tags.
     * Session tombstone / ring-once guards suppress decline/end replays.
     */
    @JavascriptInterface
    fun notifySecureCallOfferVerified(peer: String?, media: String?, sessionId: String?) {
        val pk = SosSessionStore.normalizeHexPubkey(peer)
        if (pk.isEmpty()) return
        val sid = sessionId?.trim().orEmpty()
        val kind = when (media?.trim()?.lowercase()) {
            "video", "v" -> "video"
            else -> "voice"
        }
        mainHandler.post {
            try {
                if (sid.isNotEmpty() && SosSecureCallSessionStore.isTombstoned(context.applicationContext, sid)) {
                    Log.i(TAG, "CALL_SESSION_TOMBSTONE_DROP")
                    SosDebugLog.i("call", "CALL_SESSION_TOMBSTONE_DROP")
                    return@post
                }
                // One ring per authenticated sessionId.
                if (sid.isNotEmpty() && !SosSecureCallSessionStore.markRinged(context.applicationContext, sid)) {
                    Log.i(TAG, "CALL_SESSION_TOMBSTONE_DROP")
                    SosDebugLog.i("call", "CALL_SESSION_TOMBSTONE_DROP")
                    return@post
                }
                if (sid.isNotEmpty()) {
                    SosSecureCallSessionStore.rememberActiveSession(context.applicationContext, sid)
                }
                SosPendingCallStore.updateSecureWrapPeer(context.applicationContext, pk, kind)
                // Mark authenticated offer handled (outer wrap id if available).
                val offerId = SosPendingCallStore.extractEventId(context.applicationContext)
                SosIncomingCallSession.rememberHandledOffer(context.applicationContext, offerId)
                if (SosIncomingCallSession.isSameActiveCall(context.applicationContext, pk)) {
                    return@post
                }
                val title = if (kind == "video") "שיחת וידאו נכנסת" else "שיחה קולית נכנסת"
                val caller = SosContactCache.displayName(context.applicationContext, pk, "מישהו")
                val openUrl = SosCallUrls.acceptPage(kind)
                // Background warm keeps isHostAlive=false; still show Native ring for verified secure offers.
                if (!MainActivity.isHostAlive) {
                    MainActivity.warmHostForIncomingCall(context.applicationContext, pk, kind)
                    NotificationHelper.showIncomingCall(
                        context.applicationContext,
                        title,
                        "$caller מתקשר אליך ב-SOS",
                        openUrl,
                        kind,
                        peerPubkey = pk,
                        callerName = caller
                    )
                }
                Log.i(TAG, "SECURE_CALL_OFFER_VERIFIED")
                SosDebugLog.i("call", "SECURE_WRAP_AUTH_OK")
                SosDebugLog.i("call", "SECURE_NATIVE_RING_AUTHORIZED")
                SosDebugLog.i("call", "SECURE_VERIFIER_RING_AUTH")
                android.util.Log.i(TAG, "SECURE_VERIFIER_RING_AUTH")
            } catch (err: Exception) {
                Log.w(TAG, "secure offer verified failed: ${err.message}")
            }
        }
    }

    @JavascriptInterface
    fun isSecureCallSessionTombstoned(sessionId: String?): Boolean {
        return SosSecureCallSessionStore.isTombstoned(context.applicationContext, sessionId)
    }

    @JavascriptInterface
    fun markSecureCallSessionTerminal(sessionId: String?, state: String?): Boolean {
        val st = state?.trim()?.uppercase().orEmpty()
        return SosSecureCallSessionStore.mark(context.applicationContext, sessionId, st)
    }

    /** Verify-only warm finished with no fresh ring — release background WebView ownership. */
    @JavascriptInterface
    fun requestVerifyOnlyIdleShutdown() {
        mainHandler.post {
            try {
                SecureCallWakeActivity.currentOrNull()?.requestShutdown("idle")
            } catch (_: Exception) {
            }
            try {
                MainActivity.verifyOnlyIdleShutdown()
            } catch (_: Exception) {
            }
        }
    }

    /** Authenticated disconnect / dismiss after secure unwrap. */
    @JavascriptInterface
    fun notifySecureCallDismissed(peer: String?) {
        val pk = SosSessionStore.normalizeHexPubkey(peer)
        mainHandler.post {
            try {
                val offerId = SosPendingCallStore.extractEventId(context.applicationContext)
                SosIncomingCallSession.rememberHandledOffer(context.applicationContext, offerId)
                if (pk.isNotEmpty()) {
                    SosIncomingCallSession.markRemoteEnded(context.applicationContext, pk)
                }
                SosPendingCallStore.clear(context.applicationContext)
                NotificationHelper.cancelIncomingCall(context.applicationContext)
                CallSoundHelper.stopAll()
                if (pk.isNotEmpty()) IncomingCallActivity.dismiss(context.applicationContext, pk)
                Log.i(TAG, "SECURE_CALL_DISMISSED")
            } catch (err: Exception) {
                Log.w(TAG, "secure dismiss failed: ${err.message}")
            }
        }
    }

    /** שמירת offer שיחה נכנסת (JSON) לשחזור מסך ענה אחרי deep-link | HYPER CORE TECH */
    @JavascriptInterface
    fun cacheIncomingCallOffer(peer: String?, callType: String?, offerJson: String?) {
        val pk = SosSessionStore.normalizeHexPubkey(peer)
        if (pk.isEmpty()) return
        val kind = clampText(callType, 32, "voice")
        val json = offerJson?.trim().orEmpty()
        if (json.isEmpty() || json.length > 65536) return
        SosPendingCallStore.save(context.applicationContext, pk, kind, json)
    }

    @JavascriptInterface
    fun getIncomingCallOffer(): String {
        return SosPendingCallStore.getJson(context.applicationContext)
    }

    /** EVENT גולמי מה-RelayWatcher (מוצפן) – לפענוח ב-Web בלחיצת ענה | HYPER CORE TECH */
    @JavascriptInterface
    fun getIncomingCallRawEvent(): String {
        return SosPendingCallStore.getRawEventJson(context.applicationContext)
    }

    /** Drain opaque secure wrap queue (encrypted 1059 events only). Prefer peek + ACK. */
    @JavascriptInterface
    fun drainPendingSecureWraps(): String {
        return try {
            SosPendingCallStore.drainSecureWraps(context.applicationContext).toString()
        } catch (_: Exception) {
            "[]"
        }
    }

    /** Peek opaque secure wrap queue without deleting. */
    @JavascriptInterface
    fun peekPendingSecureWraps(): String {
        return try {
            SosPendingCallStore.peekSecureWraps(context.applicationContext).toString()
        } catch (_: Exception) {
            "[]"
        }
    }

    /** Count of opaque secure wraps currently queued (peek, non-destructive). */
    @JavascriptInterface
    fun peekPendingSecureWrapCount(): Int {
        return try {
            SosPendingCallStore.peekSecureWrapCount(context.applicationContext)
        } catch (_: Exception) {
            0
        }
    }

    /** Verifier-only identity bootstrap from Native session store (no plaintext logs). */
    @JavascriptInterface
    fun getVerifierSessionJson(): String {
        return try {
            val app = context.applicationContext
            val pub = SosSessionStore.getPubkey(app)
            val priv = SosSessionStore.getPrivkey(app)
            if (pub.length != 64 || priv.length != 64) return "{}"
            JSONObject()
                .put("pubkey", pub)
                .put("privkey", priv)
                .toString()
        } catch (_: Exception) {
            "{}"
        }
    }

    @JavascriptInterface
    fun clearIncomingCallOffer() {
        SosPendingCallStore.clear(context.applicationContext)
    }

    /** עדכון כתובת אחרונה אחרי ניקוי ?chat= מה-deep-link | HYPER CORE TECH */
    @JavascriptInterface
    fun rememberWebUrl(url: String?) {
        SosSessionStore.setLastUrl(context.applicationContext, url)
    }

    /** איפוס sticky שיחה – בפתיחה מאייקון / חזרה לפיד | HYPER CORE TECH */
    @JavascriptInterface
    fun clearRememberedChatUrl() {
        SosSessionStore.clearLastUrl(context.applicationContext)
        SosSessionStore.setLastUrl(context.applicationContext, BuildConfig.SOS_START_URL)
    }

    /** מונע פתיחה חוזרת של שיחה ב־resume אחרי שיצאנו ממנה | HYPER CORE TECH */
    @JavascriptInterface
    fun clearPendingDeepLink() {
        mainHandler.post {
            (context as? MainActivity)?.clearPendingDeepLinkFromJs()
        }
    }

    @JavascriptInterface
    fun requestMediaPermissions(needCamera: Boolean) {
        val act = context as? MainActivity ?: return
        act.requestMediaPermissionsFromJs(needCamera)
    }

    @JavascriptInterface
    fun hasMicPermission(): Boolean {
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.RECORD_AUDIO
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun hasCameraPermission(): Boolean {
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }

    /**
     * חלק בחירת קובץ (SosJsBridge.kt) – פותח DocumentsUI ישירות מה-APK.
     * עוקף input[type=file] שב-WebView לפעמים לא מפעיל onShowFileChooser.
     */
    @JavascriptInterface
    fun openFilePicker(requestId: String?, accept: String?) {
        android.util.Log.i("SosJsBridge", "openFilePicker req=$requestId accept=$accept")
        val act = context as? MainActivity
        if (act == null) {
            android.util.Log.e("SosJsBridge", "openFilePicker: context is not MainActivity (${context.javaClass.name})")
            return
        }
        val id = requestId?.ifBlank { null }
        if (id == null) {
            android.util.Log.e("SosJsBridge", "openFilePicker: empty requestId")
            return
        }
        act.openFilePickerFromJs(id, accept?.ifBlank { null } ?: "*/*")
    }

    /** בדיקה ידנית מ-console: SosNativeShell.testFilePicker() */
    @JavascriptInterface
    fun testFilePicker() {
        openFilePicker("test_" + System.currentTimeMillis(), "*/*")
    }

    /** מציג חיווי בחירת קובץ נייטיב (מיידי, מרכז המסך) | HYPER CORE TECH */
    @JavascriptInterface
    fun showFilePickLoading(label: String?) {
        val act = context as? MainActivity ?: return
        act.showNativeFilePickLoading(label?.ifBlank { null } ?: "טוען...")
    }

    /** מסתיר חיווי בחירת קובץ מיד כשהתצוגה המקדימה עלתה | HYPER CORE TECH */
    @JavascriptInterface
    fun hideFilePickLoading() {
        val act = context as? MainActivity ?: return
        act.hideNativeFilePickLoadingImmediate()
    }

    /** הסתרה מיידית של חיווי בחירת קובץ | HYPER CORE TECH */
    @JavascriptInterface
    fun hideFilePickLoadingNow() {
        val act = context as? MainActivity ?: return
        act.hideNativeFilePickLoadingImmediate()
    }

    @JavascriptInterface
    fun getShellVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getShellVersionCode(): Int = BuildConfig.VERSION_CODE

    /** פתיחת מסך לוגי המעטפת (מה שהיה ב־FAB LOG) | HYPER CORE TECH */
    @JavascriptInterface
    fun openDebugLog() {
        mainHandler.post {
            try {
                SosDebugLog.i("ui", "open debug log from JS menu")
                val intent = android.content.Intent(context, SosDebugLogActivity::class.java)
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (e: Exception) {
                android.util.Log.e("SosJsBridge", "openDebugLog failed", e)
            }
        }
    }

    /**
     * שמירת קובץ להורדות מ־JS (blob/base64) – WebView לא מכבד a[download] | HYPER CORE TECH
     * @return "ok" | "error:..."
     */
    @JavascriptInterface
    fun saveToDownloads(base64Data: String?, fileName: String?, mimeType: String?): String {
        val raw = base64Data?.trim().orEmpty()
        if (raw.isEmpty()) return "error:empty-data"
        if (raw.length > 12_000_000) return "error:too-large"
        val name = sanitizeFileName(fileName)
        val mime = mimeType?.trim()?.ifBlank { null } ?: guessMime(name)
        return try {
            val payload = raw.substringAfter("base64,", raw)
            val bytes = android.util.Base64.decode(payload, android.util.Base64.DEFAULT)
            if (bytes.isEmpty()) return "error:empty-bytes"
            if (bytes.size > 8_000_000) return "error:too-large"
            val saved = writeBytesToDownloads(bytes, name, mime)
            mainHandler.post {
                android.widget.Toast.makeText(
                    context.applicationContext,
                    "נשמר בהורדות: ${saved.second}",
                    android.widget.Toast.LENGTH_SHORT
                ).show()
            }
            SosDebugLog.i("dl", "saved base64 ${saved.second} (${bytes.size} bytes)")
            "ok:${saved.second}"
        } catch (e: Exception) {
            android.util.Log.e("SosJsBridge", "saveToDownloads failed", e)
            SosDebugLog.e("dl", "saveToDownloads failed: ${e.message}")
            "error:${e.message ?: "save-failed"}"
        }
    }

    /**
     * הורדת URL ישירות להורדות (http/https) | HYPER CORE TECH
     */
    @JavascriptInterface
    fun downloadUrlToDownloads(url: String?, fileName: String?, mimeType: String?): String {
        val src = url?.trim().orEmpty()
        if (src.isEmpty()) return "error:empty-url"
        if (!(src.startsWith("http://") || src.startsWith("https://"))) {
            return "error:unsupported-url"
        }
        val name = sanitizeFileName(fileName)
        val mimeHint = mimeType?.trim()?.ifBlank { null }
        return try {
            val client = okhttp3.OkHttpClient.Builder()
                .followRedirects(true)
                .followSslRedirects(true)
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(5, java.util.concurrent.TimeUnit.MINUTES)
                .build()
            val req = okhttp3.Request.Builder()
                .url(src)
                .header("User-Agent", "SOSNativeShell/${BuildConfig.VERSION_NAME}")
                .get()
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
                val body = resp.body ?: throw IllegalStateException("empty body")
                val declared = body.contentLength()
                if (declared > 50L * 1024L * 1024L) throw IllegalStateException("too-large")
                val bytes = body.bytes()
                if (bytes.size > 50 * 1024 * 1024) throw IllegalStateException("too-large")
                val mime = mimeHint
                    ?: resp.header("Content-Type")?.substringBefore(';')?.trim()
                    ?: guessMime(name)
                val saved = writeBytesToDownloads(bytes, name, mime)
                mainHandler.post {
                    android.widget.Toast.makeText(
                        context.applicationContext,
                        "נשמר בהורדות: ${saved.second}",
                        android.widget.Toast.LENGTH_SHORT
                    ).show()
                }
                SosDebugLog.i("dl", "saved url ${saved.second} (${bytes.size} bytes)")
                "ok:${saved.second}"
            }
        } catch (e: Exception) {
            android.util.Log.e("SosJsBridge", "downloadUrlToDownloads failed", e)
            SosDebugLog.e("dl", "downloadUrlToDownloads failed: ${e.message}")
            "error:${e.message ?: "download-failed"}"
        }
    }

    private fun sanitizeFileName(fileName: String?): String {
        val raw = fileName?.trim().orEmpty().ifBlank { "sos-file" }
        val cleaned = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
        return if (cleaned.contains('.')) cleaned else "$cleaned.bin"
    }

    private fun guessMime(name: String): String {
        val lower = name.lowercase()
        return when {
            lower.endsWith(".mp4") || lower.endsWith(".m4v") -> "video/mp4"
            lower.endsWith(".webm") -> "video/webm"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".gif") -> "image/gif"
            lower.endsWith(".webp") -> "image/webp"
            lower.endsWith(".pdf") -> "application/pdf"
            lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".csv") -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    /** @return Pair(uriString, displayName) */
    private fun writeBytesToDownloads(
        bytes: ByteArray,
        displayName: String,
        mime: String
    ): Pair<String, String> {
        val resolver = context.contentResolver
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, displayName)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mime)
                put(
                    android.provider.MediaStore.Downloads.RELATIVE_PATH,
                    android.os.Environment.DIRECTORY_DOWNLOADS
                )
                put(android.provider.MediaStore.Downloads.IS_PENDING, 1)
            }
            val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("MediaStore insert failed")
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: error("openOutputStream failed")
            values.clear()
            values.put(android.provider.MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri.toString() to displayName
        }
        @Suppress("DEPRECATION")
        val dir = android.os.Environment.getExternalStoragePublicDirectory(
            android.os.Environment.DIRECTORY_DOWNLOADS
        )
        if (!dir.exists()) dir.mkdirs()
        var out = java.io.File(dir, displayName)
        if (out.exists()) {
            val stem = displayName.substringBeforeLast('.', displayName)
            val ext = displayName.substringAfterLast('.', "")
            out = java.io.File(
                dir,
                if (ext.isNotEmpty()) "$stem-${System.currentTimeMillis()}.$ext"
                else "$displayName-${System.currentTimeMillis()}"
            )
        }
        java.io.FileOutputStream(out).use { it.write(bytes) }
        android.media.MediaScannerConnection.scanFile(
            context,
            arrayOf(out.absolutePath),
            arrayOf(mime),
            null
        )
        return out.absolutePath to out.name
    }

    /**
     * חלק עדכון APK (SosJsBridge.kt) – מוריד ומתקין גרסה חדשה מעל הקיימת | HYPER CORE TECH
     */
    @JavascriptInterface
    fun installApkUpdate(apkUrl: String?) {
        val url = apkUrl?.trim().orEmpty()
        if (url.isEmpty() || url.length > 2048) return
        if (!(url.startsWith("https://"))) return
        val act = context as? MainActivity
        if (act == null) {
            android.util.Log.e("SosJsBridge", "installApkUpdate: context is not MainActivity")
            return
        }
        act.startApkUpdateInstall(url)
    }

    /** חלק Back (SosJsBridge.kt) – מחזיר את האפליקציה לרקע (כמו לחיצה כפולה לסגירה) | HYPER CORE TECH */
    @JavascriptInterface
    fun moveAppToBackground() {
        val act = context as? MainActivity ?: return
        act.runOnUiThread {
            act.moveAppToBackgroundFromJs()
        }
    }

    /** So-Call: Web מוכן עם רשימת שיחות – מסתירים splash native | HYPER CORE TECH */
    @JavascriptInterface
    fun notifySoCallReady() {
        val act = context as? MainActivity ?: return
        act.runOnUiThread {
            act.hideSoCallSplashFromJs()
        }
    }
}
