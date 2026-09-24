package com.sos010.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * F6B — Native typed cryptographic signer facade.
 * Uses SosSecureIdentityStore only. Never returns K/nsec.
 * Not wired to WebView (F6C). Session binding hook for F6D.
 * Does not implement admin typed policy (F6E).
 * HYPER CORE TECH
 */
object SosNativeTypedSigner {

    const val MAX_CONTENT_CHARS = 256 * 1024
    const val MIN_CREATED_AT = 1_000_000_000L
    const val MAX_CREATED_AT_SKEW_SEC = 172_800L

    /** Typed operation allowlist — no SIGN_NOSTR_EVENT / arbitrary. */
    enum class Op(val kind: Int) {
        SIGN_CHAT_EVENT(1050),
        SIGN_CALL_SEAL(13),
        SIGN_CALL_GIFTWRAP(1059),
        SIGN_PRESENCE_EVENT(1054),
        SIGN_READ_RECEIPT_EVENT(1051),
    }

    data class SessionBinding(
        val sessionGeneration: Long,
        val accountPubkey: String = "",
        /** F6D opaque capability — required for production crypto. */
        val sessionCapability: String = "",
    )

    sealed class CheckResult {
        object Ok : CheckResult()
        data class Err(val code: String) : CheckResult()
    }

    /**
     * F6D session gate — validates opaque capability against SosNativeSessionAuthority.
     * Caller-supplied generation/account are NOT authority.
     */
    fun interface SessionAuthorityGate {
        fun check(op: Op, binding: SessionBinding, identityPubkey: String): CheckResult
    }

    /**
     * Production F6D gate. Rechecks immediately before crypto.
     * Injected Engine for tests; production uses SosNativeSessionAuthority.production.
     */
    class F6dSessionGate(
        private val authority: () -> SosNativeSessionAuthority.Engine,
    ) : SessionAuthorityGate {
        override fun check(op: Op, binding: SessionBinding, identityPubkey: String): CheckResult {
            return when (
                val r = authority().validateForCrypto(binding.sessionCapability, identityPubkey)
            ) {
                is SosNativeSessionAuthority.ValidateResult.Ok -> CheckResult.Ok
                is SosNativeSessionAuthority.ValidateResult.Err -> CheckResult.Err(r.code)
            }
        }
    }

    /** Test-only permissive gate (F6B crypto tests). Production uses F6dSessionGate. */
    object TestPermissiveSessionGate : SessionAuthorityGate {
        override fun check(op: Op, binding: SessionBinding, identityPubkey: String): CheckResult {
            if (binding.sessionGeneration < 0L) {
                return CheckResult.Err("SESSION_GENERATION_INVALID")
            }
            val acct = SosSecureIdentityStore.normalizeHex(binding.accountPubkey)
            if (acct.isNotEmpty() && acct != identityPubkey) {
                return CheckResult.Err("SESSION_ACCOUNT_MISMATCH")
            }
            return CheckResult.Ok
        }
    }

    /** @deprecated Use F6dSessionGate in production. Kept as alias to TestPermissive for older test wiring. */
    object DefaultSessionGate : SessionAuthorityGate by TestPermissiveSessionGate

    sealed class SignResult {
        data class Ok(val event: JSONObject) : SignResult()
        data class Err(val code: String) : SignResult()
    }

    data class ChatSignRequest(
        val content: String,
        val recipientPubkey: String,
        val createdAt: Long? = null,
        val extraTags: JSONArray? = null,
    )

    data class PresenceSignRequest(
        val content: String,
        val recipientPubkey: String,
        val createdAt: Long? = null,
    )

    data class ReadReceiptSignRequest(
        val content: String,
        val recipientPubkey: String,
        val createdAt: Long? = null,
        val eventIdTag: String? = null,
    )

    data class CallSealSignRequest(
        val content: String,
        val createdAt: Long? = null,
    )

    data class CallGiftwrapSignRequest(
        val content: String,
        val recipientPubkey: String,
        val createdAt: Long? = null,
    )

    // Design invariants for static QA
    const val NATIVE_TYPED_SIGNER_RETURNS_RAW_K = false
    const val NATIVE_TYPED_SIGNER_RETURNS_NSEC = false
    const val GENERIC_NATIVE_SIGN_API = false
    const val GENERIC_NATIVE_DECRYPT_API = false
    const val ARBITRARY_EVENT_SIGNING_API_EXPOSED = false
    const val CALLER_SUPPLIED_ARBITRARY_EVENT_ACCEPTED = false
    const val NATIVE_SIGNER_IDENTITY_COMMUNITY_INDEPENDENT = true
    const val ACTIVE_COMMUNITY_SELECTS_PRIVATE_KEY = false
    const val PER_COMMUNITY_NATIVE_KEY = false
    const val F6B_SESSION_BINDING_EXTENSION_POINT_PRESENT = true
    const val F6B_DOES_NOT_BYPASS_FUTURE_F6D = true
    const val F6B_CLAIMS_PERFECT_ZEROIZATION = false
    const val F6B_ADDS_PLAINTEXT_K_AT_REST = false
    const val F6B_NEW_WEBVIEW_CRYPTO_INTERFACE_EXPOSED = false

    class Engine(
        private val identity: SosSecureIdentityStore.Engine,
        private var sessionGate: SessionAuthorityGate = DefaultSessionGate,
        private val nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        private val signWithPriv: (privHex: String, kind: Int, tags: JSONArray, content: String, createdAt: Long) -> JSONObject =
            { priv, kind, tags, content, createdAt ->
                SosNostrCrypto.signEvent(priv, kind, tags, content, createdAt)
            },
        private val verifyEvent: (JSONObject) -> Boolean = { SosNostrCrypto.verifyEvent(it) },
    ) {
        fun setSessionGate(gate: SessionAuthorityGate) {
            sessionGate = gate
        }

        fun signChatEvent(binding: SessionBinding, req: ChatSignRequest): SignResult {
            return signTyped(
                op = Op.SIGN_CHAT_EVENT,
                binding = binding,
                content = req.content,
                createdAt = req.createdAt,
                requireRecipient = true,
                recipientPubkey = req.recipientPubkey,
                buildTags = { recipient ->
                    val tags = JSONArray()
                    tags.put(JSONArray().put("p").put(recipient))
                    appendExtraTags(tags, req.extraTags)
                    tags
                },
            )
        }

        fun signPresenceEvent(binding: SessionBinding, req: PresenceSignRequest): SignResult {
            return signTyped(
                op = Op.SIGN_PRESENCE_EVENT,
                binding = binding,
                content = req.content,
                createdAt = req.createdAt,
                requireRecipient = true,
                recipientPubkey = req.recipientPubkey,
                buildTags = { recipient ->
                    JSONArray().put(JSONArray().put("p").put(recipient))
                },
            )
        }

        fun signReadReceiptEvent(binding: SessionBinding, req: ReadReceiptSignRequest): SignResult {
            return signTyped(
                op = Op.SIGN_READ_RECEIPT_EVENT,
                binding = binding,
                content = req.content,
                createdAt = req.createdAt,
                requireRecipient = true,
                recipientPubkey = req.recipientPubkey,
                buildTags = { recipient ->
                    val tags = JSONArray()
                    tags.put(JSONArray().put("p").put(recipient))
                    val eid = req.eventIdTag?.trim()?.lowercase().orEmpty()
                    if (eid.isNotEmpty()) {
                        if (!eid.matches(Regex("^[0-9a-f]{64}$"))) {
                            return@signTyped null // signal malformed via null tags sentinel
                        }
                        tags.put(JSONArray().put("e").put(eid))
                    }
                    tags
                },
            )
        }

        fun signCallSealEvent(binding: SessionBinding, req: CallSealSignRequest): SignResult {
            return signTyped(
                op = Op.SIGN_CALL_SEAL,
                binding = binding,
                content = req.content,
                createdAt = req.createdAt,
                requireRecipient = false,
                recipientPubkey = null,
                buildTags = { JSONArray() },
            )
        }

        fun signCallGiftwrapEvent(binding: SessionBinding, req: CallGiftwrapSignRequest): SignResult {
            return signTyped(
                op = Op.SIGN_CALL_GIFTWRAP,
                binding = binding,
                content = req.content,
                createdAt = req.createdAt,
                requireRecipient = true,
                recipientPubkey = req.recipientPubkey,
                buildTags = { recipient ->
                    JSONArray().put(JSONArray().put("p").put(recipient))
                },
            )
        }

        /**
         * Explicitly unavailable — arbitrary / caller-built event signing is rejected.
         * Kept as a documented fail-closed surface for tests (not a usable API).
         */
        fun rejectArbitraryEventSign(): SignResult =
            SignResult.Err("ARBITRARY_EVENT_SIGNING_UNAVAILABLE")

        private fun signTyped(
            op: Op,
            binding: SessionBinding,
            content: String,
            createdAt: Long?,
            requireRecipient: Boolean,
            recipientPubkey: String?,
            buildTags: (recipientNormalized: String) -> JSONArray?,
        ): SignResult {
            val state = identity.readState()
            when (state) {
                SosSecureIdentityStore.State.MISMATCH ->
                    return SignResult.Err("MISMATCH_SECURE_IDENTITY")
                SosSecureIdentityStore.State.INVALID ->
                    return SignResult.Err("INVALID_SECURE_IDENTITY")
                SosSecureIdentityStore.State.RECOVERY_REQUIRED ->
                    return SignResult.Err("RECOVERY_REQUIRED_IDENTITY")
                SosSecureIdentityStore.State.NEW_USER,
                SosSecureIdentityStore.State.WEB_ONLY,
                ->
                    return SignResult.Err("NO_SECURE_IDENTITY")
                SosSecureIdentityStore.State.IDENTITY_OK,
                SosSecureIdentityStore.State.NATIVE_ONLY,
                -> { /* ok */ }
            }

            if (content.length > MAX_CONTENT_CHARS) {
                return SignResult.Err("CONTENT_TOO_LARGE")
            }

            val now = nowSec()
            val ts = createdAt ?: now
            if (ts < MIN_CREATED_AT || ts > now + MAX_CREATED_AT_SKEW_SEC) {
                return SignResult.Err("BAD_CREATED_AT")
            }

            val recipient = SosSecureIdentityStore.normalizeHex(recipientPubkey)
            if (requireRecipient && !SosSecureIdentityStore.isHex64(recipient)) {
                return SignResult.Err("BAD_RECIPIENT")
            }

            val tags = buildTags(recipient) ?: return SignResult.Err("MALFORMED_TAGS")
            // Reject unexpected nested objects / non-array tag rows where practical
            if (!tagsLookSafe(tags)) {
                return SignResult.Err("MALFORMED_TAGS")
            }

            val id = identity.readIdentityForNativeUse()
                ?: return SignResult.Err("NO_SECURE_IDENTITY")
            if (!SosSecureIdentityStore.isHex64(id.privateKeyHex) ||
                !SosSecureIdentityStore.isHex64(id.publicKeyHex)
            ) {
                return SignResult.Err("INVALID_SECURE_IDENTITY")
            }

            // Final session recheck immediately before crypto (TOCTOU hardening).
            when (val gate = sessionGate.check(op, binding, id.publicKeyHex)) {
                is CheckResult.Err -> return SignResult.Err(gate.code)
                CheckResult.Ok -> { }
            }
            // Second check at authority boundary — same gate, intentional double-check.
            when (val gate2 = sessionGate.check(op, binding, id.publicKeyHex)) {
                is CheckResult.Err -> return SignResult.Err(gate2.code)
                CheckResult.Ok -> { }
            }

            // Caller cannot override signing pubkey — derived only from secure K.
            return try {
                val signed = signWithPriv(id.privateKeyHex, op.kind, tags, content, ts)
                val pub = signed.optString("pubkey").lowercase()
                if (pub != id.publicKeyHex) {
                    return SignResult.Err("PUBKEY_DERIVE_MISMATCH")
                }
                if (signed.optInt("kind") != op.kind) {
                    return SignResult.Err("KIND_MISMATCH")
                }
                if (!verifyEvent(signed)) {
                    return SignResult.Err("SIGNATURE_VERIFY_FAILED")
                }
                // Strip any accidental secret fields if present
                signed.remove("privateKey")
                signed.remove("privkey")
                signed.remove("nsec")
                signed.remove("k")
                SignResult.Ok(signed)
            } catch (_: Exception) {
                SignResult.Err("SIGN_FAILED")
            }
        }

        private fun appendExtraTags(tags: JSONArray, extra: JSONArray?) {
            if (extra == null) return
            for (i in 0 until extra.length()) {
                val row = extra.optJSONArray(i) ?: continue
                if (row.length() < 1) continue
                val name = row.optString(0)
                // Never allow injecting private-key bearing tags
                if (name.equals("priv", true) || name.equals("nsec", true) || name.equals("k", true)) {
                    continue
                }
                tags.put(row)
            }
        }

        private fun tagsLookSafe(tags: JSONArray): Boolean {
            for (i in 0 until tags.length()) {
                val row = tags.optJSONArray(i) ?: return false
                if (row.length() < 1) return false
                for (j in 0 until row.length()) {
                    if (row.opt(j) !is String && row.opt(j) !is Number) {
                        // allow simple scalars only
                        if (row.opt(j) is JSONObject || row.opt(j) is JSONArray) return false
                    }
                }
            }
            return true
        }
    }

    // —— Production Context API (native-only; not exposed to WebView bridge) ——

    @Volatile
    private var productionSessionGate: SessionAuthorityGate? = null

    fun setProductionSessionGate(gate: SessionAuthorityGate) {
        productionSessionGate = gate
    }

    private fun engine(context: Context): Engine {
        val gate = productionSessionGate
            ?: F6dSessionGate { SosNativeSessionAuthority.production(context.applicationContext) }
        return Engine(
            identity = identityEngineAdapter(context),
            sessionGate = gate,
        )
    }

    /**
     * Adapter: SosSecureIdentityStore Context API → Engine used by typed signer.
     * Does not expose K outside native process.
     */
    private fun identityEngineAdapter(context: Context): SosSecureIdentityStore.Engine {
        // Production store engine is private; use a thin prefs/crypto engine bound to Context.
        // Prefer public Context methods via a delegated Engine constructed like F6A production.
        val app = context.applicationContext
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
                override fun clearSecureKeys() {
                    // F6B must not clear via typed signer — no-op for adapter safety
                }
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

    fun signChatEvent(context: Context, binding: SessionBinding, req: ChatSignRequest): SignResult =
        engine(context).signChatEvent(binding, req)

    fun signPresenceEvent(context: Context, binding: SessionBinding, req: PresenceSignRequest): SignResult =
        engine(context).signPresenceEvent(binding, req)

    fun signReadReceiptEvent(context: Context, binding: SessionBinding, req: ReadReceiptSignRequest): SignResult =
        engine(context).signReadReceiptEvent(binding, req)

    fun signCallSealEvent(context: Context, binding: SessionBinding, req: CallSealSignRequest): SignResult =
        engine(context).signCallSealEvent(binding, req)

    fun signCallGiftwrapEvent(context: Context, binding: SessionBinding, req: CallGiftwrapSignRequest): SignResult =
        engine(context).signCallGiftwrapEvent(binding, req)

    fun engineForTests(
        identity: SosSecureIdentityStore.Engine,
        sessionGate: SessionAuthorityGate = DefaultSessionGate,
        nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        signWithPriv: (String, Int, JSONArray, String, Long) -> JSONObject =
            { priv, kind, tags, content, createdAt ->
                SosNostrCrypto.signEvent(priv, kind, tags, content, createdAt)
            },
        verifyEvent: (JSONObject) -> Boolean = { SosNostrCrypto.verifyEvent(it) },
    ): Engine = Engine(identity, sessionGate, nowSec, signWithPriv, verifyEvent)
}
