package com.sos010.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.withLock

/**
 * MD1 — Secure per-device identity (D_sign + D_enc) with platform-wrapped storage.
 *
 * Android Keystore does NOT support non-exportable secp256k1 or X25519 wire keys.
 * Architecture: software-generate approved algorithms → AES-GCM wrap with non-exportable
 * AndroidKeyStore key → app-private prefs (backup excluded).
 *
 * Storage class = PLATFORM_WRAPPED (not HARDWARE_NONEXPORTABLE for the wire key itself).
 * No pairing, DeviceAuthorization, recovery capsule, or WebView secret export.
 * HYPER CORE TECH
 */
object SosDeviceIdentityStore {

    const val PREFS_NAME = "sos_native_device_identity_v1"
    const val KEYSTORE_WRAP_ALIAS = "sos_device_key_wrap_v1"
    const val FORMAT_VERSION = 1
    const val SCHEME = SosDeviceKeyPolicy.KEY_FORMAT_VERSION

    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    private const val KEY_META_JSON = "meta_json"
    private const val KEY_SIGN_CT = "sign_ct_b64"
    private const val KEY_SIGN_IV = "sign_iv_b64"
    private const val KEY_ENC_CT = "enc_ct_b64"
    private const val KEY_ENC_IV = "enc_iv_b64"
    private const val KEY_FORMAT = "format_version"

    enum class State {
        ABSENT,
        OK,
        RECOVERY_REQUIRED,
        UNSUPPORTED,
    }

    enum class Purpose { SIGN, ENC }

    data class PublicMetadata(
        val version: String,
        val formatVersion: Int,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val createdAt: Long,
        val storageClass: SosDeviceKeyPolicy.StorageClass,
        val hardwareBacked: Boolean,
        val recoveryEligible: Boolean,
        val state: State,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("version", version)
            .put("formatVersion", formatVersion)
            .put("deviceId", deviceId)
            .put("DSignPub", dSignPub)
            .put("DEncPub", dEncPub)
            .put("createdAt", createdAt)
            .put("storageClass", storageClass.name)
            .put("hardwareBacked", hardwareBacked)
            .put("recoveryEligible", recoveryEligible)
            .put("state", state.name)
            .put("dSignPublicEncoding", SosDeviceKeyPolicy.D_SIGN_PUBLIC_ENCODING)
            .put("dEncPublicEncoding", SosDeviceKeyPolicy.D_ENC_PUBLIC_ENCODING)
            .put("maxLinkedDevices", SosDeviceKeyPolicy.MAX_LINKED_DEVICES)
            .put("deviceIdentityScope", SosDeviceKeyPolicy.DEVICE_IDENTITY_SCOPE)
            .put("signingAlgorithm", SosDeviceKeyPolicy.DEVICE_SIGNING_ALGORITHM)
            .put("encryptionAlgorithm", SosDeviceKeyPolicy.DEVICE_ENCRYPTION_ALGORITHM)
    }

    sealed class CreateResult {
        data class Ok(val metadata: PublicMetadata) : CreateResult()
        data class Err(val code: String, val state: State) : CreateResult()
    }

    sealed class OpResult {
        data class Ok(val signatureHex: String = "", val sharedSecretHex: String = "") : OpResult()
        data class Err(val code: String) : OpResult()
    }

    interface BlobCrypto {
        fun encrypt(plaintext: ByteArray, aad: ByteArray): EncryptedBlob
        fun decrypt(blob: EncryptedBlob, aad: ByteArray): ByteArray?
        /** True when wrap key is AndroidKeyStore (or equivalent platform binding). */
        fun isPlatformBound(): Boolean
        /** Best-effort TEE/StrongBox flag; false is allowed for PLATFORM_WRAPPED. */
        fun isHardwareBacked(): Boolean
    }

    data class EncryptedBlob(val ciphertext: ByteArray, val iv: ByteArray)

    interface PrefsBackend {
        fun getString(key: String): String?
        fun getInt(key: String, default: Int): Int
        fun putAll(values: Map<String, Any>)
        fun clearAll()
        fun hasIdentity(): Boolean
    }

    class Engine(
        private val prefs: PrefsBackend,
        private val crypto: BlobCrypto,
        private val random: SecureRandom = SecureRandom(),
        private val createLock: ReentrantLock = ReentrantLock(),
    ) {
        fun state(): State {
            if (!prefs.hasIdentity()) return State.ABSENT
            val fmt = prefs.getInt(KEY_FORMAT, 0)
            if (fmt != FORMAT_VERSION) return State.RECOVERY_REQUIRED
            return when (loadVerifiedPrivate(Purpose.SIGN)) {
                is LoadOk -> when (loadVerifiedPrivate(Purpose.ENC)) {
                    is LoadOk -> State.OK
                    else -> State.RECOVERY_REQUIRED
                }
                else -> State.RECOVERY_REQUIRED
            }
        }

        fun getPublicMetadata(): PublicMetadata? {
            val raw = prefs.getString(KEY_META_JSON) ?: return null
            return try {
                val o = JSONObject(raw)
                val st = state()
                PublicMetadata(
                    version = o.optString("version", SCHEME),
                    formatVersion = o.optInt("formatVersion", FORMAT_VERSION),
                    deviceId = o.getString("deviceId"),
                    dSignPub = SosDeviceKeyCrypto.normalizeHex(o.getString("DSignPub")),
                    dEncPub = SosDeviceKeyCrypto.normalizeHex(o.getString("DEncPub")),
                    createdAt = o.getLong("createdAt"),
                    storageClass = SosDeviceKeyPolicy.StorageClass.valueOf(o.getString("storageClass")),
                    hardwareBacked = o.optBoolean("hardwareBacked", false),
                    recoveryEligible = o.optBoolean("recoveryEligible", false),
                    state = st,
                )
            } catch (_: Exception) {
                null
            }
        }

        /**
         * Create exactly one local device identity for this installation.
         * Concurrent callers serialize; second create returns existing OK metadata.
         * Never reads root K. Never auto-repairs corrupt identity.
         */
        fun createOrGet(): CreateResult = createLock.withLock {
            when (state()) {
                State.OK -> {
                    val meta = getPublicMetadata()
                        ?: return@withLock CreateResult.Err("META_MISSING", State.RECOVERY_REQUIRED)
                    return@withLock CreateResult.Ok(meta)
                }
                State.RECOVERY_REQUIRED ->
                    return@withLock CreateResult.Err("CORRUPT_NO_AUTO_REGEN", State.RECOVERY_REQUIRED)
                State.UNSUPPORTED ->
                    return@withLock CreateResult.Err("UNSUPPORTED", State.UNSUPPORTED)
                State.ABSENT -> Unit
            }

            val generated = SosDeviceKeyCrypto.generate(random)
            val storageClass = if (crypto.isPlatformBound()) {
                SosDeviceKeyPolicy.StorageClass.PLATFORM_WRAPPED
            } else {
                SosDeviceKeyPolicy.StorageClass.SOFTWARE_ONLY
            }
            val createdAt = System.currentTimeMillis()

            try {
                val signAad = buildAad(generated.deviceId, Purpose.SIGN, generated.signPubHex)
                val encAad = buildAad(generated.deviceId, Purpose.ENC, generated.encPubHex)
                val signBlob = crypto.encrypt(generated.signPriv, signAad)
                val encBlob = crypto.encrypt(generated.encPriv, encAad)
                // Sample after wrap-key materialization (Keystore create-on-encrypt).
                val hardwareBacked = crypto.isHardwareBacked()
                val recoveryEligible = SosDeviceKeyPolicy.recoveryEligibleFor(storageClass, hardwareBacked)

                val meta = PublicMetadata(
                    version = SCHEME,
                    formatVersion = FORMAT_VERSION,
                    deviceId = generated.deviceId,
                    dSignPub = generated.signPubHex,
                    dEncPub = generated.encPubHex,
                    createdAt = createdAt,
                    storageClass = storageClass,
                    hardwareBacked = hardwareBacked,
                    recoveryEligible = recoveryEligible,
                    state = State.OK,
                )

                prefs.putAll(
                    mapOf(
                        KEY_FORMAT to FORMAT_VERSION,
                        KEY_META_JSON to meta.toJson().toString(),
                        KEY_SIGN_CT to b64(signBlob.ciphertext),
                        KEY_SIGN_IV to b64(signBlob.iv),
                        KEY_ENC_CT to b64(encBlob.ciphertext),
                        KEY_ENC_IV to b64(encBlob.iv),
                    ),
                )

                // Verify round-trip before returning
                if (state() != State.OK) {
                    prefs.clearAll()
                    return@withLock CreateResult.Err("POST_CREATE_VERIFY_FAIL", State.RECOVERY_REQUIRED)
                }
                return@withLock CreateResult.Ok(meta)
            } finally {
                SosDeviceKeyCrypto.zeroize(generated.signPriv, generated.encPriv)
            }
        }

        /** Typed D_sign — domain-separated Schnorr. No private key returned. */
        fun signDevicePayload(payload: ByteArray): OpResult {
            if (state() != State.OK) return OpResult.Err("STATE_${state()}")
            return when (val loaded = loadVerifiedPrivate(Purpose.SIGN)) {
                is LoadOk -> {
                    try {
                        val sig = SosDeviceKeyCrypto.signDevicePayload(loaded.priv, payload)
                        OpResult.Ok(signatureHex = Hex.encode(sig))
                    } catch (_: Exception) {
                        OpResult.Err("SIGN_FAIL")
                    } finally {
                        SosDeviceKeyCrypto.zeroize(loaded.priv)
                    }
                }
                is LoadErr -> OpResult.Err(loaded.code)
            }
        }

        fun verifyDevicePayload(payload: ByteArray, signatureHex: String): Boolean {
            val meta = getPublicMetadata() ?: return false
            return try {
                SosDeviceKeyCrypto.verifyDevicePayload(
                    meta.dSignPub,
                    payload,
                    Hex.decode(SosDeviceKeyCrypto.normalizeHex(signatureHex)),
                )
            } catch (_: Exception) {
                false
            }
        }

        /** Typed D_enc ECDH with peer X25519 public (hex). Shared secret hex only — no priv export. */
        fun deviceEcdh(peerEncPubHex: String): OpResult {
            if (state() != State.OK) return OpResult.Err("STATE_${state()}")
            if (!SosDeviceKeyCrypto.isHex64(peerEncPubHex)) return OpResult.Err("BAD_PEER_PUB")
            return when (val loaded = loadVerifiedPrivate(Purpose.ENC)) {
                is LoadOk -> {
                    try {
                        val ss = SosDeviceKeyCrypto.deviceEcdh(loaded.priv, peerEncPubHex)
                        OpResult.Ok(sharedSecretHex = Hex.encode(ss)).also {
                            SosDeviceKeyCrypto.zeroize(ss)
                        }
                    } catch (_: Exception) {
                        OpResult.Err("ECDH_FAIL")
                    } finally {
                        SosDeviceKeyCrypto.zeroize(loaded.priv)
                    }
                }
                is LoadErr -> OpResult.Err(loaded.code)
            }
        }

        /**
         * Local key deletion only — does NOT claim remote DeviceRevocation (MD8).
         */
        fun deleteLocalDeviceIdentity(): Boolean = createLock.withLock {
            prefs.clearAll()
            true
        }

        private sealed class LoadResult
        private data class LoadOk(val priv: ByteArray, val pubHex: String) : LoadResult()
        private data class LoadErr(val code: String) : LoadResult()

        private fun loadVerifiedPrivate(purpose: Purpose): LoadResult {
            val meta = getPublicMetadataRaw() ?: return LoadErr("META_MISSING")
            val deviceId = meta.optString("deviceId", "")
            val pubHex = when (purpose) {
                Purpose.SIGN -> SosDeviceKeyCrypto.normalizeHex(meta.optString("DSignPub"))
                Purpose.ENC -> SosDeviceKeyCrypto.normalizeHex(meta.optString("DEncPub"))
            }
            if (deviceId.isBlank() || !SosDeviceKeyCrypto.isHex64(deviceId)) return LoadErr("BAD_DEVICE_ID")
            if (!SosDeviceKeyCrypto.isHex64(pubHex)) return LoadErr("BAD_PUB")

            val ctKey = if (purpose == Purpose.SIGN) KEY_SIGN_CT else KEY_ENC_CT
            val ivKey = if (purpose == Purpose.SIGN) KEY_SIGN_IV else KEY_ENC_IV
            val ctB64 = prefs.getString(ctKey) ?: return LoadErr("MISSING_CT")
            val ivB64 = prefs.getString(ivKey) ?: return LoadErr("MISSING_IV")
            val ct = try {
                Base64.getDecoder().decode(ctB64)
            } catch (_: Exception) {
                return LoadErr("BAD_CT")
            }
            val iv = try {
                Base64.getDecoder().decode(ivB64)
            } catch (_: Exception) {
                return LoadErr("BAD_IV")
            }
            if (iv.size != IV_BYTES) return LoadErr("BAD_IV_LEN")

            val aad = buildAad(deviceId, purpose, pubHex)
            val plain = crypto.decrypt(EncryptedBlob(ct, iv), aad) ?: return LoadErr("UNWRAP_FAIL")
            if (plain.size != 32) {
                SosDeviceKeyCrypto.zeroize(plain)
                return LoadErr("BAD_PRIV_LEN")
            }

            val match = when (purpose) {
                Purpose.SIGN -> SosDeviceKeyCrypto.signPubMatches(plain, pubHex)
                Purpose.ENC -> SosDeviceKeyCrypto.encPubMatches(plain, pubHex)
            }
            if (!match) {
                SosDeviceKeyCrypto.zeroize(plain)
                return LoadErr("KEYPAIR_MISMATCH")
            }
            return LoadOk(plain, pubHex)
        }

        private fun getPublicMetadataRaw(): JSONObject? {
            val raw = prefs.getString(KEY_META_JSON) ?: return null
            return try {
                JSONObject(raw)
            } catch (_: Exception) {
                null
            }
        }

        companion object {
            fun buildAad(deviceId: String, purpose: Purpose, pubHex: String): ByteArray {
                val fp = SosDeviceKeyCrypto.pubFingerprint(pubHex)
                val purposeTag = when (purpose) {
                    Purpose.SIGN -> "sign"
                    Purpose.ENC -> "enc"
                }
                // SOS|device-key|v1|{deviceId}|{purpose}|{pubFingerprint}
                val s = "SOS|device-key|v1|$deviceId|$purposeTag|$fp"
                return s.toByteArray(StandardCharsets.UTF_8)
            }

            private fun b64(bytes: ByteArray): String =
                Base64.getEncoder().encodeToString(bytes)
        }
    }

    fun engineForTests(
        prefs: PrefsBackend,
        crypto: BlobCrypto,
        random: SecureRandom = SecureRandom(),
    ): Engine = Engine(prefs, crypto, random)

    fun production(context: Context): Engine =
        Engine(
            prefs = SharedPrefsBackend(context.applicationContext),
            crypto = KeystoreBlobCrypto(),
        )

    class SharedPrefsBackend(context: Context) : PrefsBackend {
        private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        override fun getString(key: String): String? = prefs.getString(key, null)
        override fun getInt(key: String, default: Int): Int = prefs.getInt(key, default)
        override fun putAll(values: Map<String, Any>) {
            val ed = prefs.edit()
            for ((k, v) in values) {
                when (v) {
                    is String -> ed.putString(k, v)
                    is Int -> ed.putInt(k, v)
                    is Long -> ed.putLong(k, v)
                    is Boolean -> ed.putBoolean(k, v)
                    else -> error("unsupported_pref_type")
                }
            }
            ed.apply()
        }
        override fun clearAll() {
            prefs.edit().clear().apply()
        }
        override fun hasIdentity(): Boolean =
            !prefs.getString(KEY_META_JSON, null).isNullOrBlank() &&
                !prefs.getString(KEY_SIGN_CT, null).isNullOrBlank() &&
                !prefs.getString(KEY_ENC_CT, null).isNullOrBlank()
    }

    /** Android Keystore AES-256-GCM wrap — non-exportable wrap key. */
    class KeystoreBlobCrypto(
        private val alias: String = KEYSTORE_WRAP_ALIAS,
    ) : BlobCrypto {
        override fun isPlatformBound(): Boolean = true
        override fun isHardwareBacked(): Boolean {
            return try {
                val key = getOrCreateKey()
                val factory = javax.crypto.SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
                val info = factory.getKeySpec(key, android.security.keystore.KeyInfo::class.java)
                    as android.security.keystore.KeyInfo
                info.isInsideSecureHardware
            } catch (_: Exception) {
                false
            }
        }

        override fun encrypt(plaintext: ByteArray, aad: ByteArray): EncryptedBlob {
            val key = getOrCreateKey()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(aad)
            val iv = cipher.iv
            require(iv != null && iv.size == IV_BYTES) { "bad_iv" }
            return EncryptedBlob(ciphertext = cipher.doFinal(plaintext), iv = iv.copyOf())
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

    /** Soft AES for JVM unit tests — NOT recovery-eligible. */
    class SoftAesGcmCrypto(
        keyBytes: ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) },
        private val random: SecureRandom = SecureRandom(),
    ) : BlobCrypto {
        private val key = SecretKeySpec(keyBytes.copyOf(), "AES")
        override fun isPlatformBound(): Boolean = false
        override fun isHardwareBacked(): Boolean = false
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

    /** Platform-bound soft crypto for tests that need recoveryEligible=true path. */
    class SoftPlatformBoundAesGcmCrypto(
        keyBytes: ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) },
        private val random: SecureRandom = SecureRandom(),
        private val hardwareBacked: Boolean = true,
    ) : BlobCrypto {
        private val inner = SoftAesGcmCrypto(keyBytes, random)
        override fun isPlatformBound(): Boolean = true
        override fun isHardwareBacked(): Boolean = hardwareBacked
        override fun encrypt(plaintext: ByteArray, aad: ByteArray) = inner.encrypt(plaintext, aad)
        override fun decrypt(blob: EncryptedBlob, aad: ByteArray) = inner.decrypt(blob, aad)
    }

    class MemoryPrefsBackend : PrefsBackend {
        private val map = LinkedHashMap<String, Any>()
        override fun getString(key: String): String? = map[key] as? String
        override fun getInt(key: String, default: Int): Int = (map[key] as? Int) ?: default
        override fun putAll(values: Map<String, Any>) {
            map.putAll(values)
        }
        override fun clearAll() {
            map.clear()
        }
        override fun hasIdentity(): Boolean =
            map[KEY_META_JSON] != null && map[KEY_SIGN_CT] != null && map[KEY_ENC_CT] != null

        fun corruptSignCiphertext() {
            map[KEY_SIGN_CT] = Base64.getEncoder().encodeToString(ByteArray(48) { 0x41 })
        }

        fun corruptEncCiphertext() {
            map[KEY_ENC_CT] = Base64.getEncoder().encodeToString(ByteArray(48) { 0x42 })
        }

        fun putMetaField(key: String, value: Any) {
            val raw = map[KEY_META_JSON] as? String ?: return
            val o = JSONObject(raw)
            o.put(key, value)
            map[KEY_META_JSON] = o.toString()
        }
    }
}
