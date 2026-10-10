package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * MD4 S2 — ConversationKeyIndex (sos-cki-v1).
 * Never contains root K/nsec. Conversation keys are derived natively and sealed to D_enc.
 * HYPER CORE TECH
 */
object SosConversationKeyIndex {
    const val SCHEMA = "sos-cki-v1"
    const val ALG = "nip44-v2"
    const val MAX_ENTRIES_PER_PAGE = 512
    const val MAX_ENTRIES_HARD = 2048
    const val SEAL_INFO = "SOS|cki|v1"
    const val SEAL_SCHEMA = "sos-cki-seal-v1"

    data class Entry(
        val peerP: String,
        val conversationKeyHex: String,
        val keyId: String,
        val derivedAt: Long,
        val alg: String = ALG,
    )

    data class Index(
        val schema: String = SCHEMA,
        val accountP: String,
        val deviceId: String,
        val authorizationId: String,
        val authEpoch: Long,
        val pairingTranscriptHash: String,
        val createdAt: Long,
        val nonce: String,
        val exportSessionId: String,
        val page: Int,
        val pageCount: Int,
        val entries: List<Entry>,
        val coverageNote: String = "KEYS_ONLY",
    )

    data class SealPackage(
        val sealSchema: String = SEAL_SCHEMA,
        val ephPubHex: String,
        val ivB64: String,
        val ctB64: String,
        val accountP: String,
        val deviceId: String,
        val authorizationId: String,
        val authEpoch: Long,
        val pairingTranscriptHash: String,
        val exportSessionId: String,
        val indexNonce: String,
        val dEncPub: String,
        val createdAt: Long,
    ) {
        fun toPublicJson(): JSONObject =
            JSONObject()
                .put("sealSchema", sealSchema)
                .put("ephPub", ephPubHex)
                .put("iv", ivB64)
                .put("ct", ctB64)
                .put("accountP", accountP)
                .put("deviceId", deviceId)
                .put("authorizationId", authorizationId)
                .put("authEpoch", authEpoch)
                .put("pairingTranscriptHash", pairingTranscriptHash)
                .put("exportSessionId", exportSessionId)
                .put("indexNonce", indexNonce)
                .put("D_enc_pub", dEncPub)
                .put("createdAt", createdAt)

        companion object {
            fun fromJson(o: JSONObject): SealPackage =
                SealPackage(
                    sealSchema = o.optString("sealSchema", SEAL_SCHEMA),
                    ephPubHex = SosDeviceKeyCrypto.normalizeHex(o.getString("ephPub")),
                    ivB64 = o.getString("iv"),
                    ctB64 = o.getString("ct"),
                    accountP = SosDeviceKeyCrypto.normalizeHex(o.getString("accountP")),
                    deviceId = SosDeviceKeyCrypto.normalizeHex(o.getString("deviceId")),
                    authorizationId = SosDeviceKeyCrypto.normalizeHex(o.getString("authorizationId")),
                    authEpoch = o.getLong("authEpoch"),
                    pairingTranscriptHash = SosDeviceKeyCrypto.normalizeHex(o.getString("pairingTranscriptHash")),
                    exportSessionId = SosDeviceKeyCrypto.normalizeHex(o.getString("exportSessionId")),
                    indexNonce = SosDeviceKeyCrypto.normalizeHex(o.getString("indexNonce")),
                    dEncPub = SosDeviceKeyCrypto.normalizeHex(o.getString("D_enc_pub")),
                    createdAt = o.getLong("createdAt"),
                )
        }
    }

    fun normalizePeer(peer: String): String? {
        val p = SosDeviceKeyCrypto.normalizeHex(peer)
        return if (SosDeviceKeyCrypto.isHex64(p)) p else null
    }

    fun keyIdFor(accountP: String, peerP: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(SosDeviceKeyCrypto.normalizeHex(accountP).toByteArray(StandardCharsets.UTF_8))
        md.update(0)
        md.update(SosDeviceKeyCrypto.normalizeHex(peerP).toByteArray(StandardCharsets.UTF_8))
        return Hex.encode(md.digest())
    }

    fun buildEntries(
        accountPrivHex: String,
        accountP: String,
        peerPubs: List<String>,
        nowMs: Long = System.currentTimeMillis(),
    ): Result<List<Entry>> {
        val self = SosDeviceKeyCrypto.normalizeHex(accountP)
        if (!SosDeviceKeyCrypto.isHex64(self)) return Result.failure(IllegalArgumentException("BAD_ACCOUNT_P"))
        if (peerPubs.size > MAX_ENTRIES_HARD) return Result.failure(IllegalArgumentException("INDEX_TOO_LARGE"))
        val seen = linkedSetOf<String>()
        val out = ArrayList<Entry>(peerPubs.size)
        for (raw in peerPubs) {
            val peer = normalizePeer(raw) ?: return Result.failure(IllegalArgumentException("BAD_PEER"))
            if (peer == self) continue
            if (!seen.add(peer)) return Result.failure(IllegalArgumentException("DUPLICATE_PEER"))
            val ck = SosNostrCrypto.nip44ConversationKey(accountPrivHex, peer)
                ?: return Result.failure(IllegalArgumentException("CONVERSATION_KEY_DERIVE_FAIL"))
            try {
                out.add(
                    Entry(
                        peerP = peer,
                        conversationKeyHex = Hex.encode(ck),
                        keyId = keyIdFor(self, peer),
                        derivedAt = nowMs,
                    ),
                )
            } finally {
                ck.fill(0)
            }
        }
        out.sortBy { it.peerP }
        return Result.success(out)
    }

    fun paginate(entries: List<Entry>, pageSize: Int = MAX_ENTRIES_PER_PAGE): List<List<Entry>> {
        val size = pageSize.coerceIn(1, MAX_ENTRIES_PER_PAGE)
        if (entries.isEmpty()) return listOf(emptyList())
        val pages = ArrayList<List<Entry>>()
        var i = 0
        while (i < entries.size) {
            pages.add(entries.subList(i, minOf(i + size, entries.size)))
            i += size
        }
        return pages
    }

    fun toCanonicalJson(index: Index): ByteArray {
        val entries = JSONArray()
        index.entries.sortedBy { it.peerP }.forEach { e ->
            entries.put(
                JSONObject()
                    .put("peerP", SosDeviceKeyCrypto.normalizeHex(e.peerP))
                    .put("conversationKey", SosDeviceKeyCrypto.normalizeHex(e.conversationKeyHex))
                    .put("alg", e.alg)
                    .put("keyId", SosDeviceKeyCrypto.normalizeHex(e.keyId))
                    .put("derivedAt", e.derivedAt),
            )
        }
        val o =
            JSONObject()
                .put("schema", index.schema)
                .put("accountP", SosDeviceKeyCrypto.normalizeHex(index.accountP))
                .put("deviceId", SosDeviceKeyCrypto.normalizeHex(index.deviceId))
                .put("authorizationId", SosDeviceKeyCrypto.normalizeHex(index.authorizationId))
                .put("authEpoch", index.authEpoch)
                .put("pairingTranscriptHash", SosDeviceKeyCrypto.normalizeHex(index.pairingTranscriptHash))
                .put("createdAt", index.createdAt)
                .put("nonce", SosDeviceKeyCrypto.normalizeHex(index.nonce))
                .put("exportSessionId", SosDeviceKeyCrypto.normalizeHex(index.exportSessionId))
                .put("page", index.page)
                .put("pageCount", index.pageCount)
                .put("coverageNote", index.coverageNote)
                .put("entries", entries)
        // Deterministic: org.json preserves insertion order for our puts.
        return o.toString().toByteArray(StandardCharsets.UTF_8)
    }

    fun parseIndex(plain: ByteArray): Result<Index> {
        return try {
            val o = JSONObject(String(plain, StandardCharsets.UTF_8))
            if (o.getString("schema") != SCHEMA) return Result.failure(IllegalArgumentException("BAD_SCHEMA"))
            val arr = o.getJSONArray("entries")
            if (arr.length() > MAX_ENTRIES_PER_PAGE) return Result.failure(IllegalArgumentException("PAGE_TOO_LARGE"))
            val seen = HashSet<String>()
            val entries = ArrayList<Entry>(arr.length())
            for (i in 0 until arr.length()) {
                val e = arr.getJSONObject(i)
                val peer = SosDeviceKeyCrypto.normalizeHex(e.getString("peerP"))
                if (!SosDeviceKeyCrypto.isHex64(peer)) return Result.failure(IllegalArgumentException("BAD_PEER"))
                if (!seen.add(peer)) return Result.failure(IllegalArgumentException("DUPLICATE_PEER"))
                val ck = SosDeviceKeyCrypto.normalizeHex(e.getString("conversationKey"))
                if (ck.length != 64) return Result.failure(IllegalArgumentException("BAD_CONVERSATION_KEY"))
                if (e.getString("alg") != ALG) return Result.failure(IllegalArgumentException("BAD_ALG"))
                entries.add(
                    Entry(
                        peerP = peer,
                        conversationKeyHex = ck,
                        keyId = SosDeviceKeyCrypto.normalizeHex(e.getString("keyId")),
                        derivedAt = e.getLong("derivedAt"),
                        alg = ALG,
                    ),
                )
            }
            Result.success(
                Index(
                    accountP = SosDeviceKeyCrypto.normalizeHex(o.getString("accountP")),
                    deviceId = SosDeviceKeyCrypto.normalizeHex(o.getString("deviceId")),
                    authorizationId = SosDeviceKeyCrypto.normalizeHex(o.getString("authorizationId")),
                    authEpoch = o.getLong("authEpoch"),
                    pairingTranscriptHash = SosDeviceKeyCrypto.normalizeHex(o.getString("pairingTranscriptHash")),
                    createdAt = o.getLong("createdAt"),
                    nonce = SosDeviceKeyCrypto.normalizeHex(o.getString("nonce")),
                    exportSessionId = SosDeviceKeyCrypto.normalizeHex(o.getString("exportSessionId")),
                    page = o.getInt("page"),
                    pageCount = o.getInt("pageCount"),
                    entries = entries,
                    coverageNote = o.optString("coverageNote", "KEYS_ONLY"),
                ),
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun bindingBytes(
        accountP: String,
        deviceId: String,
        authorizationId: String,
        authEpoch: Long,
        pairingTranscriptHash: String,
        exportSessionId: String,
        dEncPub: String,
        nonce: String,
    ): ByteArray {
        val lines =
            listOf(
                SEAL_INFO,
                "accountP=${SosDeviceKeyCrypto.normalizeHex(accountP)}",
                "deviceId=${SosDeviceKeyCrypto.normalizeHex(deviceId)}",
                "authorizationId=${SosDeviceKeyCrypto.normalizeHex(authorizationId)}",
                "authEpoch=$authEpoch",
                "pairingTranscriptHash=${SosDeviceKeyCrypto.normalizeHex(pairingTranscriptHash)}",
                "exportSessionId=${SosDeviceKeyCrypto.normalizeHex(exportSessionId)}",
                "D_enc_pub=${SosDeviceKeyCrypto.normalizeHex(dEncPub)}",
                "nonce=${SosDeviceKeyCrypto.normalizeHex(nonce)}",
            )
        return MessageDigest.getInstance("SHA-256")
            .digest(lines.joinToString("\n").toByteArray(StandardCharsets.UTF_8))
    }

    fun sealToDenc(
        index: Index,
        dEncPubHex: String,
        random: SecureRandom = SecureRandom(),
    ): Result<SealPackage> {
        val dEncPub = SosDeviceKeyCrypto.normalizeHex(dEncPubHex)
        if (!SosDeviceKeyCrypto.isHex64(dEncPub)) return Result.failure(IllegalArgumentException("BAD_D_ENC"))
        if (SosDeviceKeyCrypto.normalizeHex(index.deviceId).isEmpty()) {
            return Result.failure(IllegalArgumentException("BAD_DEVICE"))
        }
        val plain = toCanonicalJson(index)
        val (ephPriv, ephPub) = SosX25519.generateKeyPair(random)
        return try {
            val shared = SosX25519.sharedSecret(ephPriv, Hex.decode(dEncPub))
            val binding =
                bindingBytes(
                    index.accountP,
                    index.deviceId,
                    index.authorizationId,
                    index.authEpoch,
                    index.pairingTranscriptHash,
                    index.exportSessionId,
                    dEncPub,
                    index.nonce,
                )
            val cek = SosPairingCrypto.sessionKey(shared, binding) // HKDF re-use with different binding
            try {
                val sealed = SosPairingCrypto.seal(cek, binding, plain, random)
                Result.success(
                    SealPackage(
                        ephPubHex = Hex.encode(ephPub),
                        ivB64 = sealed.ivB64,
                        ctB64 = sealed.ctB64,
                        accountP = index.accountP,
                        deviceId = index.deviceId,
                        authorizationId = index.authorizationId,
                        authEpoch = index.authEpoch,
                        pairingTranscriptHash = index.pairingTranscriptHash,
                        exportSessionId = index.exportSessionId,
                        indexNonce = index.nonce,
                        dEncPub = dEncPub,
                        createdAt = index.createdAt,
                    ),
                )
            } finally {
                SosDeviceKeyCrypto.zeroize(cek)
                SosDeviceKeyCrypto.zeroize(shared)
            }
        } catch (e: Exception) {
            Result.failure(e)
        } finally {
            SosDeviceKeyCrypto.zeroize(ephPriv)
        }
    }

    fun openSealed(
        pkg: SealPackage,
        dEncPriv: ByteArray,
        expectAccountP: String,
        expectDeviceId: String,
        expectDEncPub: String,
        spentExportSessions: Set<String>,
        minAuthEpoch: Long = 1L,
        nowMs: Long = System.currentTimeMillis(),
        authExpiresAt: Long? = null,
    ): Result<Index> {
        if (pkg.sealSchema != SEAL_SCHEMA) return Result.failure(IllegalArgumentException("BAD_SEAL_SCHEMA"))
        val exportId = SosDeviceKeyCrypto.normalizeHex(pkg.exportSessionId)
        if (spentExportSessions.contains(exportId)) {
            return Result.failure(IllegalArgumentException("REPLAY_EXPORT_SESSION"))
        }
        if (SosDeviceKeyCrypto.normalizeHex(pkg.accountP) != SosDeviceKeyCrypto.normalizeHex(expectAccountP)) {
            return Result.failure(IllegalArgumentException("ACCOUNT_MISMATCH"))
        }
        if (SosDeviceKeyCrypto.normalizeHex(pkg.deviceId) != SosDeviceKeyCrypto.normalizeHex(expectDeviceId)) {
            return Result.failure(IllegalArgumentException("DEVICE_MISMATCH"))
        }
        if (SosDeviceKeyCrypto.normalizeHex(pkg.dEncPub) != SosDeviceKeyCrypto.normalizeHex(expectDEncPub)) {
            return Result.failure(IllegalArgumentException("D_ENC_MISMATCH"))
        }
        if (pkg.authEpoch < minAuthEpoch) return Result.failure(IllegalArgumentException("AUTH_EPOCH_MISMATCH"))
        if (authExpiresAt != null && nowMs > authExpiresAt) {
            return Result.failure(IllegalArgumentException("EXPIRED"))
        }
        if (!SosDeviceKeyCrypto.isHex64(pkg.indexNonce)) {
            return Result.failure(IllegalArgumentException("BAD_INDEX_NONCE"))
        }
        val shared = SosX25519.sharedSecret(dEncPriv, Hex.decode(pkg.ephPubHex))
        val binding =
            bindingBytes(
                pkg.accountP,
                pkg.deviceId,
                pkg.authorizationId,
                pkg.authEpoch,
                pkg.pairingTranscriptHash,
                pkg.exportSessionId,
                pkg.dEncPub,
                pkg.indexNonce,
            )
        val cek = SosPairingCrypto.sessionKey(shared, binding)
        return try {
            val plain =
                SosPairingCrypto.open(
                    cek,
                    binding,
                    SosPairingCrypto.SealedMessage(pkg.ivB64, pkg.ctB64),
                ) ?: return Result.failure(IllegalArgumentException("AEAD_FAIL"))
            val parsed = parseIndex(plain)
            if (parsed.isFailure) return parsed
            val index = parsed.getOrThrow()
            if (SosDeviceKeyCrypto.normalizeHex(index.nonce) != SosDeviceKeyCrypto.normalizeHex(pkg.indexNonce)) {
                return Result.failure(IllegalArgumentException("NONCE_MISMATCH"))
            }
            if (SosDeviceKeyCrypto.normalizeHex(index.exportSessionId) != exportId) {
                return Result.failure(IllegalArgumentException("SESSION_MISMATCH"))
            }
            if (SosDeviceKeyCrypto.normalizeHex(index.accountP) != SosDeviceKeyCrypto.normalizeHex(expectAccountP)) {
                return Result.failure(IllegalArgumentException("INDEX_ACCOUNT_MISMATCH"))
            }
            if (SosDeviceKeyCrypto.normalizeHex(index.deviceId) != SosDeviceKeyCrypto.normalizeHex(expectDeviceId)) {
                return Result.failure(IllegalArgumentException("INDEX_DEVICE_MISMATCH"))
            }
            Result.success(index)
        } finally {
            SosDeviceKeyCrypto.zeroize(cek)
            SosDeviceKeyCrypto.zeroize(shared)
        }
    }

    fun newNonce(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })

    fun newExportSessionId(random: SecureRandom = SecureRandom()): String =
        Hex.encode(ByteArray(32).also { random.nextBytes(it) })
}
