package com.sos010.app

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * F6G — Native-owned admin confirm → revalidate → sign orchestrator.
 * WebView sends typed intent once; never receives approval secret.
 * HYPER CORE TECH
 */
object SosNativeAdminConfirmationOrchestrator {

    const val CONFIRMED_ADMIN_SIGNING_USES_TYPED_POLICY = true
    const val GENERIC_ADMIN_SIGNING_AFTER_CONFIRM = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION = true

    @Volatile private var confirmEngine: SosNativeTrustedConfirmation.Engine? = null
    @Volatile private var activityRef: WeakReference<Activity>? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun attachActivity(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    fun onPause() {
        confirmEngine?.onBackground()
    }

    fun onLogout() {
        confirmEngine?.invalidateAll("logout")
    }

    fun onAccountSwitch() {
        confirmEngine?.invalidateAll("account_switch")
    }

    fun onActivityRecreation() {
        confirmEngine?.onActivityRecreation()
    }

    fun engineForTests(eng: SosNativeTrustedConfirmation.Engine) {
        confirmEngine = eng
    }

    private fun engine(app: Context): SosNativeTrustedConfirmation.Engine {
        confirmEngine?.let { return it }
        val sessionAuth = SosNativeSessionAuthority.production(app)
        val eng = SosNativeTrustedConfirmation.Engine(
            sessionValidator = { cap, account ->
                when (val r = sessionAuth.validateForCrypto(cap, account)) {
                    is SosNativeSessionAuthority.ValidateResult.Ok -> null
                    is SosNativeSessionAuthority.ValidateResult.Err -> r.code
                }
            },
        )
        confirmEngine = eng
        return eng
    }

    fun requestTypedAdminOperation(
        context: Context,
        webView: WebView,
        requestJson: String?,
    ): String {
        return try {
            if (!SosNativeTypedBridge.isTrustedWebViewUrl(webView.url)) {
                return err("UNTRUSTED_CONTEXT")
            }
            val app = context.applicationContext
            val req = JSONObject(requestJson ?: "{}")
            if (req.has("approve") || req.has("approved") || req.has("confirmationToken") ||
                req.has("approvalToken") || req.has("authorization")
            ) {
                return err("WEBVIEW_APPROVAL_FORBIDDEN")
            }
            if (req.has("title") || req.has("body") || req.has("confirmText")) {
                return err("WEBVIEW_SECURITY_TEXT_FORBIDDEN")
            }

            val opName = req.optString("operation", req.optString("op")).trim().uppercase()
            val op = try {
                SosNativeAdminPolicy.AdminOp.valueOf(opName)
            } catch (_: Exception) {
                return err("UNSUPPORTED_OPERATION")
            }
            val communityId = req.optString("communityId").trim()
            val requestId = req.optString("requestId", req.optString("id")).trim()
            val capability = req.optString("sessionCapability", req.optString("capability")).trim()
            val account = SosSecureIdentityStore.normalizeHex(
                req.optString("accountPubkey", req.optString("account")),
            )
            val paramsObj = req.optJSONObject("params") ?: JSONObject()
            val params = jsonToMap(paramsObj)
            val target = SosSecureIdentityStore.normalizeHex(
                params["targetPubkey"]?.toString()
                    ?: params["memberPubkey"]?.toString()
                    ?: "",
            )
            val verified = parseVerified(req.optJSONObject("verifiedControl"))

            val intent = SosNativeTrustedConfirmation.IntentSpec(
                requestId = requestId,
                operation = op,
                communityId = communityId,
                accountPubkey = account,
                sessionCapability = capability,
                params = params,
                targetPubkey = target,
                verifiedSnapshot = verified,
            )

            val conf = engine(app)
            when (val created = conf.create(intent)) {
                is SosNativeTrustedConfirmation.CreateResult.Err -> return err(created.code)
                is SosNativeTrustedConfirmation.CreateResult.Ok -> {
                    val challengeId = created.challengeId
                    mainHandler.post {
                        presentAndComplete(app, webView, conf, challengeId, intent, created.pending)
                    }
                    return JSONObject()
                        .put("ok", true)
                        .put("status", "CONFIRMATION_PENDING")
                        .put("requestId", requestId)
                        .put("operation", op.name)
                        .put("communityId", communityId)
                        .toString()
                }
            }
        } catch (_: Exception) {
            err("NATIVE_CONFIRM_FAILED")
        }
    }

    private fun presentAndComplete(
        app: Context,
        webView: WebView,
        conf: SosNativeTrustedConfirmation.Engine,
        challengeId: String,
        intent: SosNativeTrustedConfirmation.IntentSpec,
        pending: SosNativeTrustedConfirmation.PendingPublic,
    ) {
        val act = activityRef?.get()
        if (act == null || act.isFinishing) {
            conf.cancel(challengeId, "no_activity")
            deliver(webView, intent.requestId, errObj("NO_ACTIVITY").toString())
            return
        }
        val presenter = SosNativeTrustedConfirmationDialogPresenter(act)
        presenter.present(
            pending = pending,
            challengeId = challengeId,
            requireSecureFlag = true,
            onApprove = {
                when (val ap = conf.approveFromNativeUi(challengeId)) {
                    is SosNativeTrustedConfirmation.ApproveResult.Err ->
                        deliver(webView, intent.requestId, errObj(ap.code).toString())
                    is SosNativeTrustedConfirmation.ApproveResult.Ok -> {
                        val signed = signAfterConfirm(app, conf, intent, ap.authorization)
                        deliver(webView, intent.requestId, signed)
                    }
                }
            },
            onCancel = {
                conf.cancel(challengeId, "user_cancel")
                deliver(webView, intent.requestId, errObj("CONFIRMATION_CANCELLED").toString())
            },
        )
    }

    private fun signAfterConfirm(
        app: Context,
        conf: SosNativeTrustedConfirmation.Engine,
        intent: SosNativeTrustedConfirmation.IntentSpec,
        authorization: SosNativeTrustedConfirmation.Authorization,
    ): String {
        val consumeErr = conf.consumeForSign(authorization, intent)
        if (consumeErr != null) return errObj(consumeErr).toString()

        val sessionAuth = SosNativeSessionAuthority.production(app)
        val identity = productionIdentity(app)
        val gate = SosNativeTypedSigner.F6dSessionGate { sessionAuth }
        val signer = SosNativeAdminTypedSigner.Engine(
            identity = identity,
            sessionGate = gate,
        )
        val binding = SosNativeTypedSigner.SessionBinding(
            sessionGeneration = 0L,
            accountPubkey = intent.accountPubkey,
            sessionCapability = intent.sessionCapability,
        )
        val request = SosNativeAdminPolicy.TypedAdminRequest(
            operation = intent.operation,
            communityId = intent.communityId,
            params = intent.params,
        )
        return when (
            val result = signer.attemptTypedAdminSign(
                binding = binding,
                request = request,
                verified = intent.verifiedSnapshot,
                authorization = authorization,
            )
        ) {
            is SosNativeAdminTypedSigner.AdminSignResult.Ok ->
                JSONObject()
                    .put("ok", true)
                    .put("status", "SIGNED")
                    .put("requestId", intent.requestId)
                    .put("result", result.event)
                    .toString()
            is SosNativeAdminTypedSigner.AdminSignResult.Err ->
                errObj(result.code).put("requestId", intent.requestId).toString()
        }
    }

    private fun productionIdentity(app: Context): SosSecureIdentityStore.Engine {
        return SosSecureIdentityStore.engineForTests(
            prefs = object : SosSecureIdentityStore.PrefsBackend {
                private val prefs =
                    app.getSharedPreferences(SosSecureIdentityStore.PREFS_NAME, Context.MODE_PRIVATE)
                override fun getString(key: String): String? = prefs.getString(key, null)
                override fun getInt(key: String, default: Int): Int = prefs.getInt(key, default)
                override fun getLong(key: String, default: Long): Long = prefs.getLong(key, default)
                override fun putAll(values: Map<String, Any>) {
                    val ed = prefs.edit()
                    values.forEach { (k, v) ->
                        when (v) {
                            is String -> ed.putString(k, v)
                            is Int -> ed.putInt(k, v)
                            is Long -> ed.putLong(k, v)
                        }
                    }
                    ed.commit()
                }
                override fun clearSecureKeys() { }
                override fun hasCiphertext(): Boolean =
                    !prefs.getString("ciphertext_b64", null).isNullOrBlank()
            },
            crypto = SosSecureIdentityStore.KeystoreBlobCrypto(),
            derivePubkey = { SosNostrCrypto.pubkeyFromPriv(it) },
            legacyReader = {
                SosSessionStore.getPrivkey(app) to SosSessionStore.getPubkey(app)
            },
        )
    }

    private fun parseVerified(obj: JSONObject?): SosNativeAdminPolicy.VerifiedControlSnapshot? {
        if (obj == null) return null
        return try {
            val proven = obj.optBoolean("baseProvenLatest", false)
            SosNativeAdminPolicy.VerifiedControlSnapshot.fromVerifiedControlBody(obj, proven)
        } catch (_: Exception) {
            null
        }
    }

    private fun jsonToMap(o: JSONObject): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out[k] = o.opt(k)
        }
        return out
    }

    private fun deliver(webView: WebView, requestId: String, payloadJson: String) {
        mainHandler.post {
            try {
                val safe = JSONObject(payloadJson).toString()
                val js =
                    "(function(){try{var p=$safe;" +
                        "if(window.SosNativeAdminConfirm&&typeof window.SosNativeAdminConfirm.onResult==='function')" +
                        "{window.SosNativeAdminConfirm.onResult(p);}else if(typeof window.__sosNativeAdminConfirmResult==='function')" +
                        "{window.__sosNativeAdminConfirmResult(p);}}catch(e){}})();"
                webView.evaluateJavascript(js, null)
            } catch (_: Exception) {
            }
        }
    }

    private fun err(code: String): String = errObj(code).toString()
    private fun errObj(code: String): JSONObject =
        JSONObject().put("ok", false).put("errorCode", code)
}
