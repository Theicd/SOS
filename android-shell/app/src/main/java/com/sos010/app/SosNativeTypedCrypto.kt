package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * F6F — Typed native private-key crypto (NIP44 v2 + typed NIP04 signaling).
 * No generic encrypt/decrypt API. No conversation-key / ECDH / K to callers.
 * Reuses F6D session authority + SosSecureIdentityStore only.
 * HYPER CORE TECH
 */
object SosNativeTypedCrypto {

    const val NIP44_VERSION_USED = "v2"
    const val NIP44_PROTOCOL_CHANGED = false
    const val E2EE_FAMILY = "sos-e2ee"
    const val E2EE_VERSION = 1
    const val E2EE_ALG = "nip44"

    const val MAX_PLAINTEXT_CHARS = 65535
    const val MAX_CIPHERTEXT_CHARS = 87472
    const val MAX_P2P_SIGNAL_CHARS = 64 * 1024
    const val MAX_CALL_SIGNAL_CHARS = 64 * 1024
    const val MAX_FILE_KEY_MATERIAL_CHARS = 4096
    const val MAX_GIFTWRAP_CONTENT = 96 * 1024

    const val GIFT_KIND = 1059
    const val SEAL_KIND = 13
    const val RUMOR_KIND = 25050

    /** Exact typed allowlist — no generic crypto. */
    enum class Op {
        CHAT_ENCRYPT,
        CHAT_DECRYPT,
        P2P_SIGNAL_ENCRYPT,
        P2P_SIGNAL_DECRYPT,
        CALL_SIGNAL_ENCRYPT,
        CALL_SIGNAL_DECRYPT,
        CALL_GIFTWRAP_UNWRAP,
        FILE_KEY_WRAP,
        FILE_KEY_UNWRAP,
        /** Narrow legacy NIP04 for native P2P signaling wire compat only. */
        LEGACY_NIP04_ENCRYPT,
        LEGACY_NIP04_DECRYPT,
    }

    // Design / QA invariants
    const val F6F_TYPED_CRYPTO_ALLOWLIST_PRESENT = true
    const val GENERIC_NATIVE_ENCRYPT_API = false
    const val GENERIC_NATIVE_DECRYPT_API = false
    const val GENERIC_NATIVE_ECDH_API = false
    const val GENERIC_CONVERSATION_KEY_API = false
    const val CHAT_ENCRYPT_RETURNS_PRIVATE_KEY = false
    const val CHAT_ENCRYPT_RETURNS_CONVERSATION_KEY = false
    const val CHAT_DECRYPT_RETURNS_CONVERSATION_KEY = false
    const val CHAT_DECRYPT_RETURNS_RAW_SECRET = false
    const val CALLER_SUPPLIED_PRIVATE_KEY_ACCEPTED = false
    const val ALL_F6F_OPS_REQUIRE_NATIVE_SESSION = true
    const val F6F_RECHECKS_SESSION_BEFORE_PRIVATE_CRYPTO = true
    const val F6F_USES_SECURE_IDENTITY_STORE = true
    const val F6F_TYPED_CRYPTO_READS_LEGACY_RAW_K_DIRECTLY = false
    const val F6F_FAILURE_CAUSES_RAW_K_FALLBACK = false
    const val PROVIDER_CUSTODY_MODE_EXPLICIT = true
    const val NATIVE_K_COPIED_TO_BROWSER = false
    const val BROWSER_K_COPIED_TO_NATIVE_OUTPUT = false
    const val BROWSER_CUSTODIED_MODE_STILL_SUPPORTED = true
    const val NIP04_RUNTIME_REQUIRED = true
    const val F6F_INPUT_SIZE_BOUNDS_PRESENT = true
    const val RAW_FILE_KEY_OVER_DC = false
    const val P2P_BULK_DATA_PATH_CHANGED = false
    const val P2P_FILE_CHUNK_PATH_CHANGED = false
    const val NATIVE_BRIDGE_USED_PER_FILE_CHUNK = false
    const val GENERIC_GIFTWRAP_DECRYPT_API = false
    const val TYPED_CALL_GIFTWRAP_UNWRAP = true
    const val FILE_KEY_WRAP_TYPED = true
    const val FILE_KEY_UNWRAP_TYPED = true
    const val CROSS_DOMAIN_CRYPTO_CONFUSION_HARDENING = "API_TYPED_DOMAIN_ONLY_WIRE_COMPAT"
    const val NIP44_PROTOCOL_UNCHANGED = true

    sealed class CryptoResult {
        data class Ok(val value: JSONObject) : CryptoResult()
        data class Err(val code: String) : CryptoResult()
    }

    class Engine(
        private val identity: SosSecureIdentityStore.Engine,
        private var sessionGate: SosNativeTypedSigner.SessionAuthorityGate =
            SosNativeTypedSigner.DefaultSessionGate,
        private val random: SecureRandom = SecureRandom(),
        private val nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
    ) {
        fun setSessionGate(gate: SosNativeTypedSigner.SessionAuthorityGate) {
            sessionGate = gate
        }

        fun chatEncrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            recipientPubkey: String,
            plaintext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.CHAT_ENCRYPT, binding) { priv, _ ->
                if (plaintext.isEmpty() || plaintext.length > MAX_PLAINTEXT_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_PLAINTEXT")
                }
                val peer = requirePeer(recipientPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val ct = nip44Encrypt(priv, peer, plaintext)
                    ?: return@withIdentityCrypto CryptoResult.Err("ENCRYPT_FAILED")
                CryptoResult.Ok(
                    JSONObject()
                        .put("family", E2EE_FAMILY)
                        .put("v", E2EE_VERSION)
                        .put("alg", E2EE_ALG)
                        .put("ct", ct),
                )
            }

        fun chatDecrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            peerPubkey: String,
            ciphertext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.CHAT_DECRYPT, binding) { priv, _ ->
                if (ciphertext.isEmpty() || ciphertext.length > MAX_CIPHERTEXT_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_CIPHERTEXT")
                }
                val peer = requirePeer(peerPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val plain = nip44Decrypt(priv, peer, ciphertext)
                    ?: return@withIdentityCrypto CryptoResult.Err("DECRYPT_FAILED")
                CryptoResult.Ok(JSONObject().put("plaintext", plain))
            }

        fun p2pSignalEncrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            recipientPubkey: String,
            plaintext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.P2P_SIGNAL_ENCRYPT, binding) { priv, _ ->
                if (plaintext.length > MAX_P2P_SIGNAL_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_PLAINTEXT")
                }
                val peer = requirePeer(recipientPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                // Wire: Secure P2P native signaling remains NIP04 (protocol unchanged).
                val ct = try {
                    SosNostrCrypto.nip04Encrypt(priv, peer, plaintext)
                } catch (_: Exception) {
                    return@withIdentityCrypto CryptoResult.Err("ENCRYPT_FAILED")
                }
                CryptoResult.Ok(JSONObject().put("ciphertext", ct).put("alg", "nip04"))
            }

        fun p2pSignalDecrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            senderPubkey: String,
            ciphertext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.P2P_SIGNAL_DECRYPT, binding) { priv, _ ->
                if (ciphertext.length > MAX_P2P_SIGNAL_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_CIPHERTEXT")
                }
                val peer = requirePeer(senderPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val plain = SosNostrCrypto.nip04Decrypt(priv, peer, ciphertext)
                    ?: return@withIdentityCrypto CryptoResult.Err("DECRYPT_FAILED")
                CryptoResult.Ok(JSONObject().put("plaintext", plain).put("alg", "nip04"))
            }

        fun callSignalEncrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            recipientPubkey: String,
            plaintext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.CALL_SIGNAL_ENCRYPT, binding) { priv, _ ->
                if (plaintext.isEmpty() || plaintext.length > MAX_CALL_SIGNAL_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_PLAINTEXT")
                }
                val peer = requirePeer(recipientPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val ct = nip44Encrypt(priv, peer, plaintext)
                    ?: return@withIdentityCrypto CryptoResult.Err("ENCRYPT_FAILED")
                CryptoResult.Ok(JSONObject().put("ciphertext", ct).put("alg", E2EE_ALG))
            }

        fun callSignalDecrypt(
            binding: SosNativeTypedSigner.SessionBinding,
            senderPubkey: String,
            ciphertext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.CALL_SIGNAL_DECRYPT, binding) { priv, _ ->
                if (ciphertext.isEmpty() || ciphertext.length > MAX_CIPHERTEXT_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_CIPHERTEXT")
                }
                val peer = requirePeer(senderPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val plain = nip44Decrypt(priv, peer, ciphertext)
                    ?: return@withIdentityCrypto CryptoResult.Err("DECRYPT_FAILED")
                CryptoResult.Ok(JSONObject().put("plaintext", plain).put("alg", E2EE_ALG))
            }

        fun fileKeyWrap(
            binding: SosNativeTypedSigner.SessionBinding,
            recipientPubkey: String,
            keyMaterial: String,
        ): CryptoResult =
            withIdentityCrypto(Op.FILE_KEY_WRAP, binding) { priv, _ ->
                if (keyMaterial.isEmpty() || keyMaterial.length > MAX_FILE_KEY_MATERIAL_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_KEY_MATERIAL")
                }
                val peer = requirePeer(recipientPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val ct = nip44Encrypt(priv, peer, keyMaterial)
                    ?: return@withIdentityCrypto CryptoResult.Err("ENCRYPT_FAILED")
                // Returns wrapped envelope ciphertext only — not raw identity K.
                CryptoResult.Ok(JSONObject().put("ciphertext", ct).put("alg", E2EE_ALG))
            }

        fun fileKeyUnwrap(
            binding: SosNativeTypedSigner.SessionBinding,
            senderPubkey: String,
            ciphertext: String,
        ): CryptoResult =
            withIdentityCrypto(Op.FILE_KEY_UNWRAP, binding) { priv, _ ->
                if (ciphertext.isEmpty() || ciphertext.length > MAX_CIPHERTEXT_CHARS) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_OR_EMPTY_CIPHERTEXT")
                }
                val peer = requirePeer(senderPubkey) ?: return@withIdentityCrypto CryptoResult.Err("MALFORMED_PEER_PUBKEY")
                val keyMat = nip44Decrypt(priv, peer, ciphertext)
                    ?: return@withIdentityCrypto CryptoResult.Err("DECRYPT_FAILED")
                // File AES material for local chunk crypto — not identity K.
                CryptoResult.Ok(JSONObject().put("keyMaterial", keyMat).put("alg", E2EE_ALG))
            }

        /**
         * Typed giftwrap unwrap — validates kind/schema/recipient/sigs.
         * Returns typed call payload only (not raw seal dump / secrets).
         */
        fun callGiftwrapUnwrap(
            binding: SosNativeTypedSigner.SessionBinding,
            wrapEvent: JSONObject,
        ): CryptoResult =
            withIdentityCrypto(Op.CALL_GIFTWRAP_UNWRAP, binding) { priv, selfPub ->
                if (wrapEvent.optInt("kind") != GIFT_KIND) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_GIFTWRAP_KIND")
                }
                val content = wrapEvent.optString("content")
                if (content.length > MAX_GIFTWRAP_CONTENT) {
                    return@withIdentityCrypto CryptoResult.Err("OVERSIZED_GIFTWRAP")
                }
                if (!SosNostrCrypto.verifyEvent(wrapEvent)) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_GIFTWRAP_SIG")
                }
                if (pTag(wrapEvent) != selfPub) {
                    return@withIdentityCrypto CryptoResult.Err("WRONG_RECIPIENT")
                }
                val sealJson = nip44Decrypt(priv, wrapEvent.optString("pubkey"), content)
                    ?: return@withIdentityCrypto CryptoResult.Err("OUTER_DECRYPT_FAILED")
                val seal = try {
                    JSONObject(sealJson)
                } catch (_: Exception) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_SEAL_JSON")
                }
                if (seal.optInt("kind") != SEAL_KIND) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_SEAL_KIND")
                }
                if (!SosNostrCrypto.verifyEvent(seal)) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_SEAL_SIG")
                }
                val rumorJson = nip44Decrypt(priv, seal.optString("pubkey"), seal.optString("content"))
                    ?: return@withIdentityCrypto CryptoResult.Err("SEAL_DECRYPT_FAILED")
                val rumor = try {
                    JSONObject(rumorJson)
                } catch (_: Exception) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_RUMOR_JSON")
                }
                if (rumor.optInt("kind") != RUMOR_KIND) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_RUMOR_KIND")
                }
                if (!rumor.optString("pubkey").equals(seal.optString("pubkey"), ignoreCase = true)) {
                    return@withIdentityCrypto CryptoResult.Err("AUTHOR_MISMATCH")
                }
                val payload = try {
                    JSONObject(rumor.optString("content"))
                } catch (_: Exception) {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_PAYLOAD")
                }
                if (payload.optString("family") != "sos-call-signal") {
                    return@withIdentityCrypto CryptoResult.Err("INVALID_PAYLOAD_FAMILY")
                }
                // Typed result only — no conversation key / K / full raw chain dump required by app.
                CryptoResult.Ok(
                    JSONObject()
                        .put("media", payload.optString("media"))
                        .put("action", payload.optString("action"))
                        .put("sessionId", payload.optString("sessionId"))
                        .put("signalId", payload.optString("signalId"))
                        .put("sender", payload.optString("sender").lowercase())
                        .put("recipient", payload.optString("recipient").lowercase())
                        .put("sentAt", payload.optLong("sentAt"))
                        .put("data", payload.opt("data") ?: JSONObject.NULL)
                        .put("sealPubkey", seal.optString("pubkey").lowercase()),
                )
            }

        /** Rejected public surfaces — documented fail-closed. */
        fun rejectGenericEncrypt(): CryptoResult = CryptoResult.Err("GENERIC_ENCRYPT_UNAVAILABLE")
        fun rejectGenericDecrypt(): CryptoResult = CryptoResult.Err("GENERIC_DECRYPT_UNAVAILABLE")
        fun rejectConversationKey(): CryptoResult = CryptoResult.Err("CONVERSATION_KEY_UNAVAILABLE")
        fun rejectGenericGiftwrap(): CryptoResult = CryptoResult.Err("GENERIC_GIFTWRAP_UNAVAILABLE")

        private fun withIdentityCrypto(
            op: Op,
            binding: SosNativeTypedSigner.SessionBinding,
            block: (privHex: String, selfPub: String) -> CryptoResult,
        ): CryptoResult {
            // Reject caller-supplied private key fields if somehow present in binding misuse — N/A on binding.
            val state = identity.readState()
            when (state) {
                SosSecureIdentityStore.State.MISMATCH ->
                    return CryptoResult.Err("MISMATCH_SECURE_IDENTITY")
                SosSecureIdentityStore.State.INVALID ->
                    return CryptoResult.Err("INVALID_SECURE_IDENTITY")
                SosSecureIdentityStore.State.RECOVERY_REQUIRED ->
                    return CryptoResult.Err("RECOVERY_REQUIRED_IDENTITY")
                SosSecureIdentityStore.State.NEW_USER,
                SosSecureIdentityStore.State.WEB_ONLY,
                ->
                    return CryptoResult.Err("NO_SECURE_IDENTITY")
                SosSecureIdentityStore.State.IDENTITY_OK,
                SosSecureIdentityStore.State.NATIVE_ONLY,
                -> { }
            }
            val id = identity.readIdentityForNativeUse()
                ?: return CryptoResult.Err("NO_SECURE_IDENTITY")
            if (!SosSecureIdentityStore.isHex64(id.privateKeyHex) ||
                !SosSecureIdentityStore.isHex64(id.publicKeyHex)
            ) {
                return CryptoResult.Err("INVALID_SECURE_IDENTITY")
            }

            // Session gate before crypto (probe op maps to F6B session check).
            when (val gate = sessionGate.check(SosNativeTypedSigner.Op.SIGN_CHAT_EVENT, binding, id.publicKeyHex)) {
                is SosNativeTypedSigner.CheckResult.Err -> return CryptoResult.Err(gate.code)
                SosNativeTypedSigner.CheckResult.Ok -> { }
            }
            // Recheck immediately before private-key use (TOCTOU).
            when (val gate2 = sessionGate.check(SosNativeTypedSigner.Op.SIGN_CHAT_EVENT, binding, id.publicKeyHex)) {
                is SosNativeTypedSigner.CheckResult.Err -> return CryptoResult.Err(gate2.code)
                SosNativeTypedSigner.CheckResult.Ok -> { }
            }

            return try {
                scrub(block(id.privateKeyHex, id.publicKeyHex))
            } catch (_: Exception) {
                CryptoResult.Err("NATIVE_CRYPTO_FAILED")
            }
        }

        private fun scrub(result: CryptoResult): CryptoResult {
            if (result !is CryptoResult.Ok) return result
            val v = result.value
            v.remove("privateKey")
            v.remove("privkey")
            v.remove("nsec")
            v.remove("k")
            v.remove("conversationKey")
            v.remove("sharedSecret")
            v.remove("ecdh")
            v.remove("secretKey")
            return result
        }

        private fun requirePeer(raw: String?): String? {
            val p = SosSecureIdentityStore.normalizeHex(raw)
            if (!SosSecureIdentityStore.isHex64(p)) return null
            // Reject obvious private-key-as-peer misuse: all-zero / too-small scalars not detectable
            // as pubkeys reliably; hex64 + used only as peer is enough with ECDH fail-closed.
            return p
        }

        private fun nip44Encrypt(priv: String, peer: String, plaintext: String): String? {
            return try {
                val key = SosNostrCrypto.nip44ConversationKey(priv, peer) ?: return null
                val nonce = ByteArray(32)
                random.nextBytes(nonce)
                SosNostrCrypto.nip44Encrypt(key, plaintext, nonce)
            } catch (_: Exception) {
                null
            }
        }

        private fun nip44Decrypt(priv: String, peer: String, ciphertext: String): String? {
            return try {
                val key = SosNostrCrypto.nip44ConversationKey(priv, peer) ?: return null
                SosNostrCrypto.nip44Decrypt(key, ciphertext)
            } catch (_: Exception) {
                null
            }
        }

        private fun pTag(ev: JSONObject): String {
            val tags = ev.optJSONArray("tags") ?: return ""
            for (i in 0 until tags.length()) {
                val t = tags.optJSONArray(i) ?: continue
                if (t.optString(0) == "p") return t.optString(1).lowercase()
            }
            return ""
        }
    }

    fun engineForTests(
        identity: SosSecureIdentityStore.Engine,
        sessionGate: SosNativeTypedSigner.SessionAuthorityGate = SosNativeTypedSigner.TestPermissiveSessionGate,
    ): Engine = Engine(identity = identity, sessionGate = sessionGate)

    fun allowlistNames(): List<String> = Op.values().map { it.name }
}
