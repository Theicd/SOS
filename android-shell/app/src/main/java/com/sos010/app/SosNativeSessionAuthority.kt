package com.sos010.app

import android.content.Context
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference

/**
 * F6D — Native session / revocation authority for typed crypto.
 * Separate from identity custody (SosSecureIdentityStore).
 * Opaque capability is NOT derived from K and is memory-only (process restart → rebind).
 * Caller-supplied generation/account are claims; native state is authority.
 * HYPER CORE TECH
 */
object SosNativeSessionAuthority {

    const val PREFS_NAME = "sos_native_session_authority_v1"
    private const val KEY_WATERMARK_GEN = "watermark_generation"
    private const val KEY_WATERMARK_ACCOUNT = "watermark_account"
    private const val CAPABILITY_BYTES = 32

    // Design / QA invariants
    const val NATIVE_SESSION_AUTHORITY_PRESENT = true
    const val NATIVE_SESSION_AUTHORITY_CONTAINS_PRIVATE_K = false
    const val NATIVE_SESSION_AUTHORITY_CONTAINS_NSEC = false
    const val REQUEST_SUPPLIED_GENERATION_IS_AUTHORITY = false
    const val REQUEST_SUPPLIED_ACCOUNT_IS_AUTHORITY = false
    const val NATIVE_SESSION_CAPABILITY_PRESENT = true
    const val NATIVE_SESSION_CAPABILITY_DERIVED_FROM_PRIVATE_K = false
    const val NATIVE_BIND_ACCOUNT_MUST_MATCH_SECURE_IDENTITY = true
    const val NATIVE_BIND_DIFFERENT_ACCOUNT_ACCEPTED = false
    const val NATIVE_BIND_CAN_ROTATE_IDENTITY = false
    const val STALE_WEBVIEW_CAN_SELF_REBIND = false
    const val STALE_WEBVIEW_CAN_FETCH_NEW_CAPABILITY = false
    const val SECURE_IDENTITY_EXISTS_IMPLIES_ACTIVE_SESSION = false
    const val SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION = false
    const val F6D_CLAIMS_XSS_ELIMINATED = false
    const val ADMIN_NATIVE_TYPED_OPS_EXPOSED_IN_F6D = false
    const val F6D_ADMIN_POLICY_EXTENSION_POINT_READY = true
    const val F6F_CAN_REUSE_NATIVE_SESSION_AUTHORITY = true
    const val NATIVE_SESSION_VALIDATION_COMPLEXITY = "O(1)"

    data class Snapshot(
        val active: Boolean,
        val generation: Long,
        val accountPubkey: String,
        /** Present only in memory while active — never persisted. */
        val capability: String = "",
    )

    sealed class BindResult {
        data class Ok(val generation: Long, val accountPubkey: String, val capability: String) : BindResult()
        data class Err(val code: String) : BindResult()
    }

    sealed class ValidateResult {
        data class Ok(val generation: Long, val accountPubkey: String) : ValidateResult()
        data class Err(val code: String) : ValidateResult()
    }

    interface IdentityPubkeySource {
        fun currentSecurePubkey(): String
    }

    interface WatermarkStore {
        fun getGeneration(): Long
        fun getAccount(): String
        fun put(generation: Long, account: String)
        fun clear()
    }

    /** Testable engine — in-memory capability; optional watermark persistence. */
    class Engine(
        private val identity: IdentityPubkeySource,
        private val watermark: WatermarkStore = MemoryWatermarkStore(),
        private val random: SecureRandom = SecureRandom(),
    ) {
        private val state = AtomicReference(Snapshot(active = false, generation = -1L, accountPubkey = "", capability = ""))

        fun snapshotPublic(): Snapshot {
            val s = state.get()
            // Never expose capability via public snapshot API used by JS revalidate
            return Snapshot(active = s.active, generation = s.generation, accountPubkey = s.accountPubkey, capability = "")
        }

        fun isActive(): Boolean = state.get().active

        /**
         * Bind current session. Issues a NEW opaque capability only on success.
         * Does not trust caller generation/account as authority without identity match + transition rules.
         */
        fun bind(
            claimGeneration: Long,
            claimAccountPubkey: String?,
            previousCapability: String? = null,
        ): BindResult {
            val account = SosSecureIdentityStore.normalizeHex(claimAccountPubkey)
            if (claimGeneration < 0L || claimGeneration == Long.MAX_VALUE) {
                return BindResult.Err("MALFORMED_GENERATION")
            }
            if (!SosSecureIdentityStore.isHex64(account)) {
                return BindResult.Err("MALFORMED_ACCOUNT")
            }
            val securePub = SosSecureIdentityStore.normalizeHex(identity.currentSecurePubkey())
            if (!SosSecureIdentityStore.isHex64(securePub)) {
                return BindResult.Err("NO_SECURE_IDENTITY")
            }
            if (account != securePub) {
                return BindResult.Err("SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH")
            }

            val watermarkGen = watermark.getGeneration()
            if (watermarkGen > 0L && claimGeneration < watermarkGen) {
                return BindResult.Err("REPLAYED_BIND")
            }

            val current = state.get()
            if (current.active) {
                val prev = previousCapability?.trim().orEmpty()
                if (prev.isEmpty() || prev != current.capability) {
                    return BindResult.Err("STALE_REBIND")
                }
                if (claimGeneration < current.generation) {
                    return BindResult.Err("REPLAYED_BIND")
                }
                // Same generation+account with valid previous capability: rotate capability (invalidate old).
                // Higher generation: account-switch / revoke-rebind path.
            } else {
                // Unbound (cold start / after revoke / process restart): previousCapability must be empty.
                // Presenting an old capability while unbound is a replay attempt.
                val prev = previousCapability?.trim().orEmpty()
                if (prev.isNotEmpty()) {
                    return BindResult.Err("REPLAYED_OLD_CAPABILITY")
                }
            }

            val capability = newCapability()
            val next = Snapshot(
                active = true,
                generation = claimGeneration,
                accountPubkey = account,
                capability = capability,
            )
            state.set(next)
            watermark.put(claimGeneration, account)
            return BindResult.Ok(claimGeneration, account, capability)
        }

        /** Force revoke — used by logout / clearUserSession. Does not require capability (DoS-only if abused). */
        fun revoke(reason: String = "revoke"): Snapshot {
            @Suppress("UNUSED_VARIABLE")
            val _reason = reason
            val cur = state.get()
            // Advance watermark so old generation cannot rebind
            val bump = if (cur.generation >= 0L) cur.generation + 1L else watermark.getGeneration().coerceAtLeast(0L) + 1L
            val acct = cur.accountPubkey.ifBlank { watermark.getAccount() }
            if (bump > 0L) watermark.put(bump, acct)
            val cleared = Snapshot(active = false, generation = -1L, accountPubkey = "", capability = "")
            state.set(cleared)
            return cleared
        }

        /**
         * O(1) crypto gate. Caller-supplied generation/account ignored as authority.
         * Recheck immediately before typed signing.
         */
        fun validateForCrypto(sessionCapability: String?, expectedIdentityPubkey: String?): ValidateResult {
            val cap = sessionCapability?.trim().orEmpty()
            if (cap.isEmpty() || cap.length > 128) {
                return ValidateResult.Err("SESSION_REQUIRED")
            }
            val cur = state.get()
            if (!cur.active) {
                return ValidateResult.Err("SESSION_REQUIRED")
            }
            if (cap != cur.capability) {
                return ValidateResult.Err("SESSION_REVOKED")
            }
            val identity = SosSecureIdentityStore.normalizeHex(expectedIdentityPubkey)
            if (SosSecureIdentityStore.isHex64(identity) && identity != cur.accountPubkey) {
                return ValidateResult.Err("SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH")
            }
            val secureNow = SosSecureIdentityStore.normalizeHex(this.identity.currentSecurePubkey())
            if (!SosSecureIdentityStore.isHex64(secureNow) || secureNow != cur.accountPubkey) {
                return ValidateResult.Err("SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH")
            }
            return ValidateResult.Ok(cur.generation, cur.accountPubkey)
        }

        /** Public metadata only — never returns capability (prevents stale self-fetch). */
        fun revalidatePublicJson(): JSONObject {
            val s = snapshotPublic()
            return JSONObject()
                .put("ok", true)
                .put("active", s.active)
                .put("generation", if (s.active) s.generation else JSONObject.NULL)
                .put("accountPubkey", s.accountPubkey)
                .put("capabilityAvailable", false)
        }

        private fun newCapability(): String {
            val bytes = ByteArray(CAPABILITY_BYTES)
            random.nextBytes(bytes)
            return bytes.joinToString("") { b -> "%02x".format(b) }
        }
    }

    class MemoryWatermarkStore : WatermarkStore {
        @Volatile private var gen: Long = 0L
        @Volatile private var account: String = ""
        override fun getGeneration(): Long = gen
        override fun getAccount(): String = account
        override fun put(generation: Long, account: String) {
            gen = generation
            this.account = SosSecureIdentityStore.normalizeHex(account)
        }
        override fun clear() {
            gen = 0L
            account = ""
        }
    }

    class PrefsWatermarkStore(context: Context) : WatermarkStore {
        private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        override fun getGeneration(): Long = prefs.getLong(KEY_WATERMARK_GEN, 0L)
        override fun getAccount(): String = prefs.getString(KEY_WATERMARK_ACCOUNT, "") ?: ""
        override fun put(generation: Long, account: String) {
            prefs.edit()
                .putLong(KEY_WATERMARK_GEN, generation)
                .putString(KEY_WATERMARK_ACCOUNT, SosSecureIdentityStore.normalizeHex(account))
                .commit()
        }
        override fun clear() {
            prefs.edit().remove(KEY_WATERMARK_GEN).remove(KEY_WATERMARK_ACCOUNT).commit()
        }
    }

    @Volatile
    private var production: Engine? = null

    fun engineForTests(
        identityPubkey: String,
        watermark: WatermarkStore = MemoryWatermarkStore(),
        random: SecureRandom = SecureRandom(),
    ): Engine = Engine(
        identity = object : IdentityPubkeySource {
            override fun currentSecurePubkey(): String = identityPubkey
        },
        watermark = watermark,
        random = random,
    )

    fun engineForTests(
        identity: IdentityPubkeySource,
        watermark: WatermarkStore = MemoryWatermarkStore(),
        random: SecureRandom = SecureRandom(),
    ): Engine = Engine(identity, watermark, random)

    fun production(context: Context): Engine {
        production?.let { return it }
        val app = context.applicationContext
        val eng = Engine(
            identity = object : IdentityPubkeySource {
                override fun currentSecurePubkey(): String {
                    val meta = SosSecureIdentityStore.getPublicIdentityMetadata(app)
                    return meta.pubkey.ifBlank { SosSessionStore.getPubkey(app) }
                }
            },
            watermark = PrefsWatermarkStore(app),
        )
        production = eng
        return eng
    }

    /** Test hook — reset singleton between unit tests when needed. */
    fun resetProductionForTests() {
        production = null
    }
}
