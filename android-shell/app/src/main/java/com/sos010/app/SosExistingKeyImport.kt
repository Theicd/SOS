package com.sos010.app

import android.content.Context
import org.json.JSONObject
import java.math.BigInteger
import java.util.concurrent.atomic.AtomicBoolean

/**
 * F6J-R2-FIX1 — existing-key / existing-account import.
 *
 * Write-only: accepts hex K once, validates, seals via SosSecureIdentityStore,
 * binds native session to derived P. Never returns K/nsec.
 *
 * Explicit import may replace a different sealed identity (account switch).
 * Silent/legacy writers still use writeIdentitySameAccount (no overwrite).
 */
object SosExistingKeyImport {
    const val CODE_IMPORT_OK = "IMPORT_OK"
    const val CODE_INVALID_KEY = "INVALID_KEY"
    const val CODE_UNTRUSTED_ORIGIN = "UNTRUSTED_ORIGIN"
    const val CODE_SECURE_STORE_FAILED = "SECURE_STORE_FAILED"
    const val CODE_SESSION_BIND_FAILED = "SESSION_BIND_FAILED"
    const val CODE_ACCOUNT_MISMATCH = "ACCOUNT_MISMATCH"
    const val CODE_IMPORT_IN_PROGRESS = "IMPORT_IN_PROGRESS"
    const val CODE_NATIVE_CRYPTO_FAILED = "NATIVE_CRYPTO_FAILED"

    /** secp256k1 curve order n */
    private val CURVE_N = BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
        16,
    )

    private val inFlight = AtomicBoolean(false)

    data class Result(
        val ok: Boolean,
        val code: String,
        val pubkey: String = "",
        val generation: Long = -1L,
    ) {
        fun toJson(): String =
            JSONObject()
                .put("ok", ok)
                .put("code", code)
                .put("errorCode", if (ok) JSONObject.NULL else code)
                .put("pubkey", pubkey)
                .put("accountPubkey", pubkey)
                .put("privateKeyAvailable", false)
                .put("typedCrypto", true)
                .put("generation", if (generation >= 0L) generation else JSONObject.NULL)
                .toString()
    }

    fun normalizeIncomingPriv(raw: String?): String {
        var s = raw?.trim().orEmpty()
        if (s.isEmpty()) return ""
        if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2)
        // nsec must be decoded in JS before bridge; refuse bech32 here (no persist).
        if (s.startsWith("nsec", ignoreCase = true)) return ""
        return SosSecureIdentityStore.normalizeHex(s)
    }

    fun isValidSecp256k1Priv(privHex: String): Boolean {
        if (!SosSecureIdentityStore.isHex64(privHex)) return false
        return try {
            val n = BigInteger(privHex, 16)
            n > BigInteger.ZERO && n < CURVE_N
        } catch (_: Exception) {
            false
        }
    }

    /**
     * @param trustedCaller must already be checked by bridge (fail-closed).
     * @param claimGeneration optional web session generation; if <0 native picks watermark+1.
     */
    fun importExisting(
        context: Context,
        privRaw: String?,
        trustedCaller: Boolean,
        claimGeneration: Long = -1L,
        sessionAuthority: SosNativeSessionAuthority.Engine =
            SosNativeSessionAuthority.production(context),
    ): Result {
        if (!trustedCaller) {
            return Result(ok = false, code = CODE_UNTRUSTED_ORIGIN)
        }
        if (!inFlight.compareAndSet(false, true)) {
            return Result(ok = false, code = CODE_IMPORT_IN_PROGRESS)
        }
        return try {
            importExistingUnlocked(context, privRaw, claimGeneration, sessionAuthority)
        } catch (_: Exception) {
            Result(ok = false, code = CODE_NATIVE_CRYPTO_FAILED)
        } finally {
            inFlight.set(false)
        }
    }

    private fun importExistingUnlocked(
        context: Context,
        privRaw: String?,
        claimGeneration: Long,
        sessionAuthority: SosNativeSessionAuthority.Engine,
    ): Result {
        val app = context.applicationContext
        val priv = normalizeIncomingPriv(privRaw)
        if (!isValidSecp256k1Priv(priv)) {
            return Result(ok = false, code = CODE_INVALID_KEY)
        }
        val derived = try {
            SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(priv))
        } catch (_: Exception) {
            return Result(ok = false, code = CODE_INVALID_KEY)
        }
        if (!SosSecureIdentityStore.isHex64(derived)) {
            return Result(ok = false, code = CODE_INVALID_KEY)
        }

        // Explicit account import/switch: clear prior sealed identity if different P.
        val existingPub = SosSecureIdentityStore.normalizeHex(
            SosSecureIdentityStore.getPublicIdentityMetadata(app).pubkey,
        )
        if (SosSecureIdentityStore.isHex64(existingPub) && existingPub != derived) {
            if (SosSecureIdentityStore.clearSecureIdentity(app) !is SosSecureIdentityStore.WriteResult.Ok) {
                return Result(ok = false, code = CODE_SECURE_STORE_FAILED)
            }
            try {
                sessionAuthority.revoke("existing_key_account_switch")
            } catch (_: Exception) {
            }
        }

        SosSessionStore.setPubkey(app, derived)
        SosSessionStore.setPrivkey(app, priv)
        when (val sealed = SosSecureIdentityStore.writeIdentitySameAccount(app, priv, derived)) {
            is SosSecureIdentityStore.WriteResult.Ok -> {
                if (SosSecureIdentityStore.normalizeHex(sealed.pubkey) != derived) {
                    return Result(ok = false, code = CODE_ACCOUNT_MISMATCH)
                }
            }
            is SosSecureIdentityStore.WriteResult.Err -> {
                val code = when (sealed.code) {
                    "DIFFERENT_IDENTITY_OVERWRITE", "EXPECTED_PUBKEY_MISMATCH" -> CODE_ACCOUNT_MISMATCH
                    "INVALID_PRIVATE_KEY", "DERIVE_FAILED" -> CODE_INVALID_KEY
                    else -> CODE_SECURE_STORE_FAILED
                }
                return Result(ok = false, code = code)
            }
        }

        // Verify stored public metadata matches derived P (same identity).
        val storedPub = SosSecureIdentityStore.normalizeHex(
            SosSecureIdentityStore.getPublicIdentityMetadata(app).pubkey,
        )
        if (storedPub != derived) {
            return Result(ok = false, code = CODE_ACCOUNT_MISMATCH)
        }

        // Fresh session bind to imported P (no previous capability after revoke/cold).
        try {
            sessionAuthority.revoke("existing_key_import_rebind")
        } catch (_: Exception) {
        }
        val recommended = sessionAuthority.recommendedBindGeneration()
        val gen = when {
            claimGeneration >= recommended -> claimGeneration
            else -> recommended
        }
        when (val r = sessionAuthority.bind(gen, derived, previousCapability = null)) {
            is SosNativeSessionAuthority.BindResult.Ok -> {
                if (r.accountPubkey != derived) {
                    return Result(ok = false, code = CODE_ACCOUNT_MISMATCH)
                }
                return Result(
                    ok = true,
                    code = CODE_IMPORT_OK,
                    pubkey = derived,
                    generation = r.generation,
                )
            }
            is SosNativeSessionAuthority.BindResult.Err -> {
                val code = when (r.code) {
                    "SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH" -> CODE_ACCOUNT_MISMATCH
                    else -> CODE_SESSION_BIND_FAILED
                }
                return Result(ok = false, code = code)
            }
        }
    }
}
