package com.sos010.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * F6A — Android Keystore–backed secure identity custody (same K/P only).
 * Not session authority (F7). Not WebView cutover (F6C).
 * Legacy SosSessionStore plaintext may remain until later phases — never deleted here.
 * HYPER CORE TECH
 */
object SosSecureIdentityStore {

    const val PREFS_NAME = "sos_native_identity_secure_v1"
    const val KEYSTORE_ALIAS = "sos_identity_wrap_v1"
    const val BLOB_VERSION = 1
    const val AAD_TEXT = "SOS|android-identity|v1"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    private const val KEY_CIPHERTEXT = "ciphertext_b64"
    private const val KEY_IV = "iv_b64"
    private const val KEY_PUBKEY = "pubkey"
    private const val KEY_BLOB_VERSION = "blob_version"
    private const val KEY_AAD_VERSION = "aad_version"
    private const val KEY_UPDATED_AT = "updated_at"

    /** Identity custody states aligned with Stage5 / F6 design. */
    enum class State {
        IDENTITY_OK,
        NEW_USER,
        WEB_ONLY,
        NATIVE_ONLY,
        MISMATCH,
        INVALID,
        RECOVERY_REQUIRED,
    }

    data class PublicMetadata(
        val hasSecureIdentity: Boolean,
        val valid: Boolean,
        val state: State,
        val pubkey: String,
        val blobVersion: Int,
    )

    data class NativeIdentity(
        val privateKeyHex: String,
        val publicKeyHex: String,
    )

    sealed class WriteResult {
        data class Ok(val pubkey: String, val migratedFromLegacy: Boolean = false) : WriteResult()
        data class Err(val code: String, val state: State) : WriteResult()
    }

    interface BlobCrypto {
        fun encrypt(plaintext: ByteArray, aad: ByteArray): EncryptedBlob
        fun decrypt(blob: EncryptedBlob, aad: ByteArray): ByteArray?
    }

    data class EncryptedBlob(val ciphertext: ByteArray, val iv: ByteArray)

    interface PrefsBackend {
        fun getString(key: String): String?
        fun getInt(key: String, default: Int): Int
        fun getLong(key: String, default: Long): Long
        fun putAll(values: Map<String, Any>)
        fun clearSecureKeys()
        fun hasCiphertext(): Boolean
    }

    /** Test / production engine — never expose raw K to WebView APIs. */
    class Engine(
        private val prefs: PrefsBackend,
        private val crypto: BlobCrypto,
        private val derivePubkey: (String) -> String,
        private val legacyReader: () -> Pair<String, String> = { "" to "" },
    ) {
        fun hasSecureIdentity(): Boolean = prefs.hasCiphertext()

        fun getPublicIdentityMetadata(): PublicMetadata {
            val classified = classify()
            val pub = normalizeHex(prefs.getString(KEY_PUBKEY))
            return PublicMetadata(
                hasSecureIdentity = prefs.hasCiphertext(),
                valid = classified == State.IDENTITY_OK || classified == State.NATIVE_ONLY,
                state = classified,
                pubkey = pub,
                blobVersion = prefs.getInt(KEY_BLOB_VERSION, 0),
            )
        }

        fun readState(): State = classify()

        /**
         * Native-only read for later F6B/F6F consumers.
         * Must never be plumbed to WebView JSON bridges.
         */
        fun readIdentityForNativeUse(): NativeIdentity? {
            return when (val r = decryptIdentity()) {
                is DecryptOk -> NativeIdentity(r.priv, r.pub)
                else -> null
            }
        }

        fun <T> withIdentityKey(block: (NativeIdentity) -> T): T? {
            val id = readIdentityForNativeUse() ?: return null
            return try {
                block(id)
            } finally {
                // Best-effort: no perfect JVM zeroization claim.
            }
        }

        /**
         * Seal SAME account identity. Rejects different P overwrite.
         * Does not delete legacy SharedPreferences.
         */
        fun writeIdentitySameAccount(privateKeyHex: String?, expectedPubkey: String? = null): WriteResult {
            val priv = normalizeHex(privateKeyHex)
            if (!isHex64(priv)) {
                return WriteResult.Err("INVALID_PRIVATE_KEY", State.INVALID)
            }
            val derived = try {
                normalizeHex(derivePubkey(priv))
            } catch (_: Exception) {
                return WriteResult.Err("DERIVE_FAILED", State.INVALID)
            }
            if (!isHex64(derived)) {
                return WriteResult.Err("DERIVE_FAILED", State.INVALID)
            }
            val expected = normalizeHex(expectedPubkey)
            if (expected.isNotEmpty() && expected != derived) {
                return WriteResult.Err("EXPECTED_PUBKEY_MISMATCH", State.MISMATCH)
            }

            if (prefs.hasCiphertext()) {
                when (val existing = decryptIdentity()) {
                    is DecryptOk -> {
                        if (existing.pub != derived || existing.priv != priv) {
                            return WriteResult.Err("DIFFERENT_IDENTITY_OVERWRITE", State.MISMATCH)
                        }
                        // Same identity rewrite — safe re-seal with fresh IV
                    }
                    is DecryptCorrupt -> {
                        return WriteResult.Err("EXISTING_CORRUPT_NO_OVERWRITE", State.RECOVERY_REQUIRED)
                    }
                    else -> {
                        // ciphertext present but empty pubkey metadata — treat as recovery
                        return WriteResult.Err("EXISTING_UNREADABLE", State.RECOVERY_REQUIRED)
                    }
                }
            }

            return sealAndCommit(priv, derived, migratedFromLegacy = false)
        }

        /**
         * If no secure blob and legacy SosSessionStore has valid same K/P:
         * copy into secure store. Legacy retained (no delete).
         */
        fun migrateFromLegacySessionStoreIfNeeded(): WriteResult {
            if (prefs.hasCiphertext()) {
                return when (val existing = decryptIdentity()) {
                    is DecryptOk -> WriteResult.Ok(existing.pub, migratedFromLegacy = false)
                    else -> WriteResult.Err("SECURE_CORRUPT", State.RECOVERY_REQUIRED)
                }
            }
            val (legPriv, legPub) = legacyReader()
            val priv = normalizeHex(legPriv)
            val pubHint = normalizeHex(legPub)
            if (!isHex64(priv)) {
                return WriteResult.Err("NO_LEGACY_IDENTITY", if (pubHint.isEmpty()) State.NEW_USER else State.INVALID)
            }
            val derived = try {
                normalizeHex(derivePubkey(priv))
            } catch (_: Exception) {
                return WriteResult.Err("LEGACY_DERIVE_FAILED", State.INVALID)
            }
            if (!isHex64(derived)) {
                return WriteResult.Err("LEGACY_DERIVE_FAILED", State.INVALID)
            }
            if (pubHint.isNotEmpty() && pubHint != derived) {
                return WriteResult.Err("LEGACY_MISMATCH", State.MISMATCH)
            }
            val sealed = sealAndCommit(priv, derived, migratedFromLegacy = true)
            return sealed
        }

        /** API only — does not delete legacy SosSessionStore plaintext. */
        fun clearSecureIdentity(): WriteResult {
            prefs.clearSecureKeys()
            return WriteResult.Ok(pubkey = "", migratedFromLegacy = false)
        }

        private fun sealAndCommit(priv: String, pub: String, migratedFromLegacy: Boolean): WriteResult {
            val previous = snapshotPrefs()
            return try {
                val payload = JSONObject()
                    .put("v", BLOB_VERSION)
                    .put("k", priv)
                    .put("p", pub)
                    .toString()
                    .toByteArray(StandardCharsets.UTF_8)
                val aad = AAD_TEXT.toByteArray(StandardCharsets.UTF_8)
                val blob = crypto.encrypt(payload, aad)
                // Validate round-trip before commit
                val round = crypto.decrypt(blob, aad)
                    ?: return restore(previous, WriteResult.Err("ENCRYPT_VERIFY_FAILED", State.RECOVERY_REQUIRED))
                val verified = parsePayload(round)
                    ?: return restore(previous, WriteResult.Err("ENCRYPT_VERIFY_PARSE", State.RECOVERY_REQUIRED))
                if (verified.priv != priv || verified.pub != pub) {
                    return restore(previous, WriteResult.Err("ENCRYPT_VERIFY_MISMATCH", State.RECOVERY_REQUIRED))
                }
                prefs.putAll(
                    mapOf(
                        KEY_CIPHERTEXT to b64(blob.ciphertext),
                        KEY_IV to b64(blob.iv),
                        KEY_PUBKEY to pub,
                        KEY_BLOB_VERSION to BLOB_VERSION,
                        KEY_AAD_VERSION to 1,
                        KEY_UPDATED_AT to System.currentTimeMillis(),
                    )
                )
                WriteResult.Ok(pub, migratedFromLegacy = migratedFromLegacy)
            } catch (_: Exception) {
                restore(previous, WriteResult.Err("WRITE_FAILED", State.RECOVERY_REQUIRED))
            }
        }

        private fun classify(): State {
            val legacy = legacyReader()
            val legPriv = normalizeHex(legacy.first)
            val legPub = normalizeHex(legacy.second)
            val hasLegacy = isHex64(legPriv)
            val hasSecure = prefs.hasCiphertext()

            if (!hasSecure && !hasLegacy) {
                return if (legPub.isEmpty()) State.NEW_USER else State.INVALID
            }
            if (!hasSecure && hasLegacy) {
                return try {
                    val d = normalizeHex(derivePubkey(legPriv))
                    if (legPub.isNotEmpty() && legPub != d) State.MISMATCH else State.WEB_ONLY
                } catch (_: Exception) {
                    State.INVALID
                }
            }

            return when (val dec = decryptIdentity()) {
                is DecryptOk -> {
                    if (hasLegacy) {
                        val lp = normalizeHex(legPriv)
                        if (isHex64(lp) && (lp != dec.priv || (legPub.isNotEmpty() && legPub != dec.pub))) {
                            State.MISMATCH
                        } else {
                            State.IDENTITY_OK
                        }
                    } else {
                        State.NATIVE_ONLY
                    }
                }
                is DecryptCorrupt -> State.RECOVERY_REQUIRED
                else -> State.INVALID
            }
        }

        private sealed class DecryptResult
        private data class DecryptOk(val priv: String, val pub: String) : DecryptResult()
        private object DecryptCorrupt : DecryptResult()
        private object DecryptEmpty : DecryptResult()

        private fun decryptIdentity(): DecryptResult {
            val ctB64 = prefs.getString(KEY_CIPHERTEXT) ?: return DecryptEmpty
            val ivB64 = prefs.getString(KEY_IV) ?: return DecryptCorrupt
            if (ctB64.isBlank() || ivB64.isBlank()) return DecryptEmpty
            return try {
                val blob = EncryptedBlob(ciphertext = unb64(ctB64), iv = unb64(ivB64))
                if (blob.iv.size != IV_BYTES) return DecryptCorrupt
                val plain = crypto.decrypt(blob, AAD_TEXT.toByteArray(StandardCharsets.UTF_8))
                    ?: return DecryptCorrupt
                val parsed = parsePayload(plain) ?: return DecryptCorrupt
                val metaPub = normalizeHex(prefs.getString(KEY_PUBKEY))
                if (metaPub.isNotEmpty() && metaPub != parsed.pub) return DecryptCorrupt
                DecryptOk(parsed.priv, parsed.pub)
            } catch (_: Exception) {
                DecryptCorrupt
            }
        }

        private data class Parsed(val priv: String, val pub: String)

        private fun parsePayload(bytes: ByteArray): Parsed? {
            return try {
                val json = JSONObject(String(bytes, StandardCharsets.UTF_8))
                val v = json.optInt("v", -1)
                if (v != BLOB_VERSION) return null
                val priv = normalizeHex(json.optString("k"))
                val pub = normalizeHex(json.optString("p"))
                if (!isHex64(priv) || !isHex64(pub)) return null
                // Secret field hygiene: reject unexpected secret aliases in future versions by requiring exact keys
                Parsed(priv, pub)
            } catch (_: Exception) {
                null
            }
        }

        private fun snapshotPrefs(): Map<String, Any?> {
            return mapOf(
                KEY_CIPHERTEXT to prefs.getString(KEY_CIPHERTEXT),
                KEY_IV to prefs.getString(KEY_IV),
                KEY_PUBKEY to prefs.getString(KEY_PUBKEY),
                KEY_BLOB_VERSION to prefs.getInt(KEY_BLOB_VERSION, 0),
                KEY_AAD_VERSION to prefs.getInt(KEY_AAD_VERSION, 0),
                KEY_UPDATED_AT to prefs.getLong(KEY_UPDATED_AT, 0L),
            )
        }

        private fun restore(previous: Map<String, Any?>, err: WriteResult): WriteResult {
            val restoreMap = LinkedHashMap<String, Any>()
            previous.forEach { (k, v) ->
                when (v) {
                    null -> { /* skip */ }
                    is String -> if (v.isNotEmpty()) restoreMap[k] = v
                    is Int -> restoreMap[k] = v
                    is Long -> restoreMap[k] = v
                }
            }
            if (restoreMap.isEmpty()) {
                prefs.clearSecureKeys()
            } else {
                prefs.putAll(restoreMap)
            }
            return err
        }
    }

    // —— Production Context API ——

    fun readState(context: Context): State = engine(context).readState()

    fun hasSecureIdentity(context: Context): Boolean = engine(context).hasSecureIdentity()

    fun getPublicIdentityMetadata(context: Context): PublicMetadata =
        engine(context).getPublicIdentityMetadata()

    fun writeIdentitySameAccount(
        context: Context,
        privateKeyHex: String?,
        expectedPubkey: String? = null,
    ): WriteResult = engine(context).writeIdentitySameAccount(privateKeyHex, expectedPubkey)

    fun migrateFromLegacySessionStoreIfNeeded(context: Context): WriteResult =
        engine(context).migrateFromLegacySessionStoreIfNeeded()

    fun clearSecureIdentity(context: Context): WriteResult = engine(context).clearSecureIdentity()

    fun readIdentityForNativeUse(context: Context): NativeIdentity? =
        engine(context).readIdentityForNativeUse()

    fun <T> withIdentityKey(context: Context, block: (NativeIdentity) -> T): T? =
        engine(context).withIdentityKey(block)

    fun engineForTests(
        prefs: PrefsBackend,
        crypto: BlobCrypto,
        derivePubkey: (String) -> String,
        legacyReader: () -> Pair<String, String> = { "" to "" },
    ): Engine = Engine(prefs, crypto, derivePubkey, legacyReader)

    private fun engine(context: Context): Engine {
        val app = context.applicationContext
        return Engine(
            prefs = AndroidPrefsBackend(app),
            crypto = KeystoreBlobCrypto(),
            derivePubkey = { hex -> SosNostrCrypto.pubkeyFromPriv(hex) },
            legacyReader = {
                SosSessionStore.getPrivkey(app) to SosSessionStore.getPubkey(app)
            },
        )
    }

    private class AndroidPrefsBackend(context: Context) : PrefsBackend {
        private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
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
            prefs.edit()
                .remove(KEY_CIPHERTEXT)
                .remove(KEY_IV)
                .remove(KEY_PUBKEY)
                .remove(KEY_BLOB_VERSION)
                .remove(KEY_AAD_VERSION)
                .remove(KEY_UPDATED_AT)
                .commit()
        }
        override fun hasCiphertext(): Boolean = !prefs.getString(KEY_CIPHERTEXT, null).isNullOrBlank()
    }

    /** Android Keystore AES-256-GCM, non-exportable. */
    class KeystoreBlobCrypto(
        private val alias: String = KEYSTORE_ALIAS,
    ) : BlobCrypto {
        override fun encrypt(plaintext: ByteArray, aad: ByteArray): EncryptedBlob {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad)
            val iv = cipher.iv
            require(iv != null && iv.size == IV_BYTES) { "bad_iv" }
            val ct = cipher.doFinal(plaintext)
            return EncryptedBlob(ciphertext = ct, iv = iv.copyOf())
        }

        override fun decrypt(blob: EncryptedBlob, aad: ByteArray): ByteArray? {
            return try {
                val key = getOrCreateKey()
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob.iv))
                cipher.updateAAD(aad)
                cipher.doFinal(blob.ciphertext)
            } catch (_: Exception) {
                null
            }
        }

        private fun getOrCreateKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry
            if (existing != null) return existing.secretKey
            val keyGen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            val spec = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
            keyGen.init(spec)
            return keyGen.generateKey()
        }
    }

    /** In-memory AES-GCM for JVM unit tests (not Keystore). */
    class SoftAesGcmCrypto(
        keyBytes: ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) },
        private val random: SecureRandom = SecureRandom(),
    ) : BlobCrypto {
        private val key = SecretKeySpec(keyBytes.copyOf(), "AES")
        override fun encrypt(plaintext: ByteArray, aad: ByteArray): EncryptedBlob {
            val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(aad)
            return EncryptedBlob(ciphertext = cipher.doFinal(plaintext), iv = iv)
        }
        override fun decrypt(blob: EncryptedBlob, aad: ByteArray): ByteArray? {
            return try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, blob.iv))
                cipher.updateAAD(aad)
                cipher.doFinal(blob.ciphertext)
            } catch (_: Exception) {
                null
            }
        }
    }

    class MemoryPrefsBackend : PrefsBackend {
        private val map = LinkedHashMap<String, Any>()
        override fun getString(key: String): String? = map[key] as? String
        override fun getInt(key: String, default: Int): Int = (map[key] as? Int) ?: default
        override fun getLong(key: String, default: Long): Long = (map[key] as? Long) ?: default
        override fun putAll(values: Map<String, Any>) {
            values.forEach { (k, v) -> map[k] = v }
        }
        override fun clearSecureKeys() {
            map.clear()
        }
        override fun hasCiphertext(): Boolean = !(map[KEY_CIPHERTEXT] as? String).isNullOrBlank()
        fun corruptCiphertext() {
            map[KEY_CIPHERTEXT] = "AAAA"
        }
        fun corruptIv() {
            map[KEY_IV] = Base64.getEncoder().encodeToString(ByteArray(4))
        }
        fun putRaw(key: String, value: Any) {
            map[key] = value
        }
        fun getRaw(key: String): Any? = map[key]
    }

    fun normalizeHex(value: String?): String {
        val n = value?.trim()?.lowercase().orEmpty().removePrefix("0x")
        return if (n.matches(Regex("^[0-9a-f]{64}$"))) n else ""
    }

    fun isHex64(value: String?): Boolean = normalizeHex(value).length == 64

    private fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    private fun unb64(s: String): ByteArray = Base64.getDecoder().decode(s)

    // Design invariants for static QA
    const val SECURE_IDENTITY_STORE_IS_SESSION_AUTHORITY = false
    const val NATIVE_IDENTITY_COMMUNITY_INDEPENDENT = true
    const val PER_COMMUNITY_NATIVE_IDENTITY = false
    const val F6A_CLAIMS_PERFECT_ZEROIZATION = false
    const val LEGACY_DELETE_ALLOWED = false
}
