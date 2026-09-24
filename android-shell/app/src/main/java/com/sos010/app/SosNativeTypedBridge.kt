package com.sos010.app

import android.content.Context
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.util.Collections
import java.util.LinkedHashSet

/**
 * F6C — Versioned typed crypto bridge dispatcher (protocol v1).
 * Strict allowlist only. No reflection / dynamic method execution.
 * Never returns K/nsec. Uses SosNativeTypedSigner + SosSecureIdentityStore.
 * HYPER CORE TECH
 */
object SosNativeTypedBridge {

    const val PROTOCOL_VERSION = 1
    const val MAX_REQUEST_CHARS = 320 * 1024
    const val MAX_IN_FLIGHT_IDS = 256
    const val MAX_REQUEST_ID_CHARS = 128

    val ALLOWED_OPS: Set<String> = setOf(
        "SIGN_CHAT_EVENT",
        "SIGN_CALL_SEAL",
        "SIGN_CALL_GIFTWRAP",
        "SIGN_PRESENCE_EVENT",
        "SIGN_READ_RECEIPT_EVENT",
    )

    // Design / QA invariants
    const val NATIVE_BRIDGE_DYNAMIC_METHOD_EXECUTION = false
    const val GENERIC_SIGN_BRIDGE_OPERATION = false
    const val GENERIC_DECRYPT_BRIDGE_OPERATION = false
    const val GENERIC_ENCRYPT_BRIDGE_OPERATION = false
    const val BRIDGE_REQUEST_SCHEMA_STRICT = true
    const val BRIDGE_RESPONSE_SCHEMA_STRICT = true
    const val BRIDGE_REQUEST_ID_REQUIRED = true
    const val BRIDGE_RESPONSE_CAN_CONTAIN_RAW_K = false
    const val BRIDGE_RESPONSE_CAN_CONTAIN_NSEC = false
    const val F6C_SESSION_BINDING_EXTENSION_POINT_PRESENT = true
    const val F6C_DOES_NOT_BYPASS_FUTURE_F6D = true
    const val F6C_CLAIMS_XSS_ELIMINATED = false
    const val THIRD_PARTY_WEB_CONTENT_CAN_USE_CRYPTO_BRIDGE = false
    const val TYPED_BRIDGE_REQUIRES_VALID_NATIVE_SESSION = true
    const val ALL_F6C_TYPED_OPS_REQUIRE_SESSION_BINDING = true

    data class DispatchResult(
        val json: String,
        val ok: Boolean,
        val code: String = "",
    )

    /** Testable engine — no Android WebView required. */
    class Engine(
        private val signer: SosNativeTypedSigner.Engine,
        private val sessionAuthority: SosNativeSessionAuthority.Engine? = null,
        private val trustedContext: () -> Boolean = { true },
        private val nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        private val requireSessionBinding: Boolean = true,
    ) {
        private val seenIds = Collections.synchronizedSet(object : LinkedHashSet<String>() {
            override fun add(element: String): Boolean {
                val added = super.add(element)
                while (size > MAX_IN_FLIGHT_IDS) {
                    val it = iterator()
                    if (it.hasNext()) {
                        it.next()
                        it.remove()
                    } else break
                }
                return added
            }
        })

        fun capabilitiesJson(): String {
            return JSONObject()
                .put("ok", true)
                .put("nativeTypedCryptoVersion", PROTOCOL_VERSION)
                .put("nativeTypedCrypto", true)
                .put("protocolVersion", PROTOCOL_VERSION)
                .put("operations", JSONArray(ALLOWED_OPS.toList()))
                .put("returnsPrivateKey", false)
                .put("returnsNsec", false)
                .put("genericSign", false)
                .put("genericDecrypt", false)
                .put("genericEncrypt", false)
                .put("requiresSessionBinding", requireSessionBinding)
                .put("nativeSessionAuthority", true)
                .toString()
        }

        fun dispatch(rawRequest: String?): DispatchResult {
            if (!trustedContext()) {
                return err("", "UNTRUSTED_CONTEXT")
            }
            val raw = rawRequest ?: ""
            if (raw.length > MAX_REQUEST_CHARS) {
                return err("", "OVERSIZED_REQUEST")
            }
            val req = try {
                JSONObject(raw)
            } catch (_: Exception) {
                return err("", "MALFORMED_JSON")
            }

            // Reject unexpected top-level keys where practical
            val allowedKeys = setOf(
                "v", "version", "protocolVersion", "op", "operation",
                "requestId", "id", "sessionGeneration", "accountPubkey",
                "sessionCapability", "capability", "params", "payload",
            )
            val keys = req.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                if (k !in allowedKeys) {
                    return err(req.optString("requestId", req.optString("id")), "UNEXPECTED_FIELD")
                }
            }

            val version = when {
                req.has("v") -> req.optInt("v", -1)
                req.has("version") -> req.optInt("version", -1)
                req.has("protocolVersion") -> req.optInt("protocolVersion", -1)
                else -> -1
            }
            if (version != PROTOCOL_VERSION) {
                return err(req.optString("requestId", req.optString("id")), "UNSUPPORTED_VERSION")
            }

            val requestId = req.optString("requestId", req.optString("id")).trim()
            if (requestId.isEmpty() || requestId.length > MAX_REQUEST_ID_CHARS) {
                return err(requestId, "REQUEST_ID_REQUIRED")
            }
            if (!seenIds.add(requestId)) {
                // Duplicate: safe no-op style response (do not re-apply)
                return DispatchResult(
                    JSONObject()
                        .put("requestId", requestId)
                        .put("ok", false)
                        .put("errorCode", "DUPLICATE_REQUEST_ID")
                        .toString(),
                    ok = false,
                    code = "DUPLICATE_REQUEST_ID",
                )
            }

            val op = req.optString("op", req.optString("operation")).trim().uppercase()
            if (op.isEmpty() || op !in ALLOWED_OPS) {
                return err(requestId, "UNSUPPORTED_OPERATION")
            }

            // Reject generic aliases explicitly
            if (op.contains("ARBITRARY") || op.contains("GENERIC") || op == "SIGN_HASH" || op == "SIGN_BYTES") {
                return err(requestId, "UNSUPPORTED_OPERATION")
            }

            val params = when {
                req.has("params") && req.opt("params") is JSONObject -> req.getJSONObject("params")
                req.has("payload") && req.opt("payload") is JSONObject -> req.getJSONObject("payload")
                else -> JSONObject()
            }

            val sessionGen = when {
                req.has("sessionGeneration") -> req.optLong("sessionGeneration", -1L)
                params.has("sessionGeneration") -> params.optLong("sessionGeneration", -1L)
                else -> 0L
            }
            val account = SosSecureIdentityStore.normalizeHex(
                req.optString("accountPubkey", params.optString("accountPubkey")),
            )
            val capability = req.optString(
                "sessionCapability",
                req.optString("capability", params.optString("sessionCapability")),
            ).trim()

            // F6D: validate native session BEFORE typed signer (claims are not authority).
            if (requireSessionBinding) {
                val auth = sessionAuthority
                    ?: return err(requestId, "SESSION_REQUIRED")
                when (val vr = auth.validateForCrypto(capability, null)) {
                    is SosNativeSessionAuthority.ValidateResult.Err ->
                        return err(requestId, vr.code)
                    is SosNativeSessionAuthority.ValidateResult.Ok -> { /* ok */ }
                }
            }

            val binding = SosNativeTypedSigner.SessionBinding(
                sessionGeneration = sessionGen,
                accountPubkey = account,
                sessionCapability = capability,
            )

            val signResult = when (op) {
                "SIGN_CHAT_EVENT" -> {
                    val content = params.optString("content")
                    val recipient = params.optString("recipientPubkey", params.optString("recipient"))
                    val createdAt = if (params.has("createdAt")) params.optLong("createdAt") else null
                    if (hasDisallowedParamKeys(params, setOf("content", "recipientPubkey", "recipient", "createdAt", "sessionGeneration", "accountPubkey", "sessionCapability", "extraTags"))) {
                        return err(requestId, "UNEXPECTED_FIELD")
                    }
                    signer.signChatEvent(
                        binding,
                        SosNativeTypedSigner.ChatSignRequest(
                            content = content,
                            recipientPubkey = recipient,
                            createdAt = createdAt,
                            extraTags = params.optJSONArray("extraTags"),
                        ),
                    )
                }
                "SIGN_PRESENCE_EVENT" -> {
                    if (hasDisallowedParamKeys(params, setOf("content", "recipientPubkey", "recipient", "createdAt", "sessionGeneration", "accountPubkey", "sessionCapability"))) {
                        return err(requestId, "UNEXPECTED_FIELD")
                    }
                    signer.signPresenceEvent(
                        binding,
                        SosNativeTypedSigner.PresenceSignRequest(
                            content = params.optString("content"),
                            recipientPubkey = params.optString("recipientPubkey", params.optString("recipient")),
                            createdAt = if (params.has("createdAt")) params.optLong("createdAt") else null,
                        ),
                    )
                }
                "SIGN_READ_RECEIPT_EVENT" -> {
                    if (hasDisallowedParamKeys(params, setOf("content", "recipientPubkey", "recipient", "createdAt", "eventIdTag", "sessionGeneration", "accountPubkey", "sessionCapability"))) {
                        return err(requestId, "UNEXPECTED_FIELD")
                    }
                    signer.signReadReceiptEvent(
                        binding,
                        SosNativeTypedSigner.ReadReceiptSignRequest(
                            content = params.optString("content"),
                            recipientPubkey = params.optString("recipientPubkey", params.optString("recipient")),
                            createdAt = if (params.has("createdAt")) params.optLong("createdAt") else null,
                            eventIdTag = params.optString("eventIdTag").ifBlank { null },
                        ),
                    )
                }
                "SIGN_CALL_SEAL" -> {
                    if (hasDisallowedParamKeys(params, setOf("content", "createdAt", "sessionGeneration", "accountPubkey", "sessionCapability"))) {
                        return err(requestId, "UNEXPECTED_FIELD")
                    }
                    signer.signCallSealEvent(
                        binding,
                        SosNativeTypedSigner.CallSealSignRequest(
                            content = params.optString("content"),
                            createdAt = if (params.has("createdAt")) params.optLong("createdAt") else null,
                        ),
                    )
                }
                "SIGN_CALL_GIFTWRAP" -> {
                    if (hasDisallowedParamKeys(params, setOf("content", "recipientPubkey", "recipient", "createdAt", "sessionGeneration", "accountPubkey", "sessionCapability"))) {
                        return err(requestId, "UNEXPECTED_FIELD")
                    }
                    signer.signCallGiftwrapEvent(
                        binding,
                        SosNativeTypedSigner.CallGiftwrapSignRequest(
                            content = params.optString("content"),
                            recipientPubkey = params.optString("recipientPubkey", params.optString("recipient")),
                            createdAt = if (params.has("createdAt")) params.optLong("createdAt") else null,
                        ),
                    )
                }
                else -> SosNativeTypedSigner.SignResult.Err("UNSUPPORTED_OPERATION")
            }

            return when (signResult) {
                is SosNativeTypedSigner.SignResult.Ok -> {
                    val event = scrubSecrets(signResult.event)
                    DispatchResult(
                        JSONObject()
                            .put("requestId", requestId)
                            .put("ok", true)
                            .put("op", op)
                            .put("result", event)
                            .toString(),
                        ok = true,
                    )
                }
                is SosNativeTypedSigner.SignResult.Err -> {
                    val code = mapSignerError(signResult.code)
                    err(requestId, code)
                }
            }
        }

        private fun hasDisallowedParamKeys(params: JSONObject, allowed: Set<String>): Boolean {
            val keys = params.keys()
            while (keys.hasNext()) {
                if (keys.next() !in allowed) return true
            }
            return false
        }

        private fun scrubSecrets(event: JSONObject): JSONObject {
            event.remove("privateKey")
            event.remove("privkey")
            event.remove("nsec")
            event.remove("k")
            event.remove("secretKey")
            return event
        }

        private fun mapSignerError(code: String): String = when (code) {
            "NO_SECURE_IDENTITY", "INVALID_SECURE_IDENTITY",
            "MISMATCH_SECURE_IDENTITY", "RECOVERY_REQUIRED_IDENTITY",
            -> "INVALID_IDENTITY"
            "SESSION_ACCOUNT_MISMATCH", "SESSION_GENERATION_INVALID",
            "SESSION_REQUIRED", "SESSION_REVOKED",
            "SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH",
            -> code
            "SIGN_FAILED", "SIGNATURE_VERIFY_FAILED", "PUBKEY_DERIVE_MISMATCH", "KIND_MISMATCH",
            -> "NATIVE_CRYPTO_FAILED"
            else -> code.ifBlank { "NATIVE_CRYPTO_FAILED" }
        }

        private fun err(requestId: String, code: String): DispatchResult {
            val o = JSONObject().put("ok", false).put("errorCode", code)
            if (requestId.isNotEmpty()) o.put("requestId", requestId)
            // Never attach stack / secret fields
            return DispatchResult(o.toString(), ok = false, code = code)
        }
    }

    fun isTrustedWebViewUrl(url: String?): Boolean {
        val raw = url?.trim().orEmpty()
        if (raw.isEmpty()) return false
        return try {
            when {
                raw.startsWith("file:///android_asset/") -> true
                raw.startsWith("https://") -> {
                    // Avoid android.net.Uri in JVM unit tests — parse host manually.
                    val after = raw.removePrefix("https://")
                    val hostPort = after.substringBefore('/').substringBefore('?').substringBefore('#')
                    val host = hostPort.substringBefore(':').lowercase()
                    host == "sos010.com" || host.endsWith(".sos010.com")
                }
                else -> false
            }
        } catch (_: Exception) {
            false
        }
    }

    fun engineForTests(
        signer: SosNativeTypedSigner.Engine,
        trusted: Boolean = true,
        nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        sessionAuthority: SosNativeSessionAuthority.Engine? = null,
        requireSessionBinding: Boolean = false,
    ): Engine = Engine(
        signer = signer,
        sessionAuthority = sessionAuthority,
        trustedContext = { trusted },
        nowSec = nowSec,
        requireSessionBinding = requireSessionBinding,
    )

    fun productionEngine(context: Context, webView: WebView): Engine {
        val app = context.applicationContext
        val sessionAuth = SosNativeSessionAuthority.production(app)
        val identity = productionIdentityEngine(app)
        val signer = SosNativeTypedSigner.engineForTests(
            identity = identity,
            sessionGate = SosNativeTypedSigner.F6dSessionGate { sessionAuth },
        )
        return Engine(
            signer = signer,
            sessionAuthority = sessionAuth,
            trustedContext = {
                try {
                    isTrustedWebViewUrl(webView.url)
                } catch (_: Exception) {
                    false
                }
            },
            requireSessionBinding = true,
        )
    }

    private fun productionIdentityEngine(app: Context): SosSecureIdentityStore.Engine {
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
                override fun clearSecureKeys() { /* bridge must not clear */ }
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
}
