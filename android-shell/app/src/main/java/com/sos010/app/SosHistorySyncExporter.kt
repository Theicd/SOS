package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * MD4 S2 — Android ConversationKeyIndex exporter.
 * Derives NIP-44 keys under Root K inside SecureIdentityStore only; returns sealed packages to D_enc.
 * No UI. No chat-history bootstrap. No root K / nsec in outputs.
 * HYPER CORE TECH
 */
object SosHistorySyncExporter {
    data class ExportPage(
        val page: Int,
        val pageCount: Int,
        val seal: SosConversationKeyIndex.SealPackage,
        val entryCount: Int,
    )

    data class ExportResult(
        val exportSessionId: String,
        val accountP: String,
        val deviceId: String,
        val authorizationId: String,
        val pages: List<ExportPage>,
    ) {
        fun toPublicJson(): JSONObject {
            val arr = JSONArray()
            pages.forEach { p ->
                arr.put(
                    JSONObject()
                        .put("page", p.page)
                        .put("pageCount", p.pageCount)
                        .put("entryCount", p.entryCount)
                        .put("seal", p.seal.toPublicJson()),
                )
            }
            return JSONObject()
                .put("ok", true)
                .put("schema", SosConversationKeyIndex.SCHEMA)
                .put("exportSessionId", exportSessionId)
                .put("accountP", accountP)
                .put("deviceId", deviceId)
                .put("authorizationId", authorizationId)
                .put("pageCount", pages.size)
                .put("pages", arr)
                .put("ROOT_K_EXPORTED", false)
                .put("NSEC_EXPORTED", false)
                .put("PLAINTEXT_KEYS_EXPORTED", false)
        }
    }

    sealed class Result {
        data class Ok(val value: ExportResult) : Result()
        data class Err(val code: String) : Result()
    }

    /**
     * Validate DeviceAuthorization, derive conversation keys for [peerPubs], seal pages to auth.D_enc.
     * [spentExportSessions] rejects replay of prior exportSessionId values.
     */
    fun exportSealedIndex(
        phoneIdentity: SosSecureIdentityStore.Engine,
        auth: SosDeviceAuthorization.Authorization,
        peerPubs: List<String>,
        exportSessionId: String? = null,
        nowMs: Long = System.currentTimeMillis(),
        minAuthEpoch: Long = SosDeviceAuthorization.AUTH_EPOCH_INITIAL,
        spentExportSessions: Set<String> = emptySet(),
        pageSize: Int = SosConversationKeyIndex.MAX_ENTRIES_PER_PAGE,
        random: SecureRandom = SecureRandom(),
        expectPairingTranscriptHash: String? = null,
        revoked: Boolean = false,
    ): Result {
        if (revoked) return Result.Err("REVOKED")
        when (val v = SosDeviceAuthorization.verifyStrict(auth, nowMs)) {
            is SosDeviceAuthorization.VerifyResult.Err -> return Result.Err(v.code)
            SosDeviceAuthorization.VerifyResult.Ok -> Unit
        }
        if (SosDeviceAuthorization.Capability.DEVICE_HISTORY_SYNC !in auth.capabilities) {
            return Result.Err("MISSING_DEVICE_HISTORY_SYNC")
        }
        if (auth.authEpoch < minAuthEpoch) return Result.Err("AUTH_EPOCH_MISMATCH")
        if (expectPairingTranscriptHash != null &&
            SosDeviceKeyCrypto.normalizeHex(expectPairingTranscriptHash) !=
            SosDeviceKeyCrypto.normalizeHex(auth.pairingTranscriptHash)
        ) {
            return Result.Err("PAIRING_TRANSCRIPT_MISMATCH")
        }
        if (!SosDeviceKeyCrypto.isHex64(auth.dEncPub)) return Result.Err("BAD_D_ENC")
        if (!SosDeviceKeyCrypto.isHex64(auth.dSignPub)) return Result.Err("BAD_D_SIGN")

        val sessionId =
            SosDeviceKeyCrypto.normalizeHex(
                exportSessionId ?: SosConversationKeyIndex.newExportSessionId(random),
            )
        if (!SosDeviceKeyCrypto.isHex64(sessionId)) return Result.Err("BAD_EXPORT_SESSION")
        if (spentExportSessions.contains(sessionId)) return Result.Err("REPLAY_EXPORT_SESSION")

        val id = phoneIdentity.readIdentityForNativeUse() ?: return Result.Err("NO_ROOT_IDENTITY")
        return try {
            if (SosDeviceKeyCrypto.normalizeHex(id.publicKeyHex) !=
                SosDeviceKeyCrypto.normalizeHex(auth.accountP)
            ) {
                return Result.Err("ACCOUNT_MISMATCH")
            }
            if (peerPubs.size > SosConversationKeyIndex.MAX_ENTRIES_HARD) {
                return Result.Err("INDEX_TOO_LARGE")
            }
            val entries =
                SosConversationKeyIndex.buildEntries(
                    accountPrivHex = id.privateKeyHex,
                    accountP = auth.accountP,
                    peerPubs = peerPubs,
                    nowMs = nowMs,
                ).getOrElse { return Result.Err(it.message ?: "DERIVE_FAIL") }

            val pages = SosConversationKeyIndex.paginate(entries, pageSize)
            val pageCount = pages.size
            val out = ArrayList<ExportPage>(pageCount)
            for ((idx, pageEntries) in pages.withIndex()) {
                val index =
                    SosConversationKeyIndex.Index(
                        accountP = auth.accountP,
                        deviceId = auth.deviceId,
                        authorizationId = auth.authorizationId,
                        authEpoch = auth.authEpoch,
                        pairingTranscriptHash = auth.pairingTranscriptHash,
                        createdAt = nowMs,
                        nonce = SosConversationKeyIndex.newNonce(random),
                        exportSessionId = sessionId,
                        page = idx,
                        pageCount = pageCount,
                        entries = pageEntries,
                    )
                val sealed =
                    SosConversationKeyIndex.sealToDenc(index, auth.dEncPub, random)
                        .getOrElse { return Result.Err(it.message ?: "SEAL_FAIL") }
                // Never include plaintext conversation keys in export result.
                out.add(
                    ExportPage(
                        page = idx,
                        pageCount = pageCount,
                        seal = sealed,
                        entryCount = pageEntries.size,
                    ),
                )
            }
            Result.Ok(
                ExportResult(
                    exportSessionId = sessionId,
                    accountP = auth.accountP,
                    deviceId = auth.deviceId,
                    authorizationId = auth.authorizationId,
                    pages = out,
                ),
            )
        } finally {
            // Best-effort; JVM string zeroization is limited.
        }
    }

    sealed class PeerParse {
        data class Ok(val peers: List<String>) : PeerParse()
        data class Err(val code: String) : PeerParse()
    }

    fun parsePeers(peersJson: String?): PeerParse {
        return try {
            val arr = JSONArray(peersJson ?: "[]")
            if (arr.length() > SosConversationKeyIndex.MAX_ENTRIES_HARD) {
                return PeerParse.Err("INDEX_TOO_LARGE")
            }
            val peers = ArrayList<String>(arr.length())
            for (i in 0 until arr.length()) {
                peers.add(arr.getString(i))
            }
            PeerParse.Ok(peers)
        } catch (_: Exception) {
            PeerParse.Err("BAD_PEERS_JSON")
        }
    }

    /**
     * Production helper: export using current sealed phone identity + authorization JSON.
     * Returns public JSON only (sealed packages). Never returns conversationKey plaintext or root K.
     */
    fun exportSealedIndexJson(
        phoneIdentity: SosSecureIdentityStore.Engine,
        authJson: String,
        peersJson: String,
        nowMs: Long = System.currentTimeMillis(),
        minAuthEpoch: Long = SosDeviceAuthorization.AUTH_EPOCH_INITIAL,
        spentExportSessions: Set<String> = emptySet(),
    ): String {
        return try {
            val auth = SosDeviceAuthorization.Authorization.fromJson(JSONObject(authJson))
            val peers =
                when (val p = parsePeers(peersJson)) {
                    is PeerParse.Err -> return JSONObject().put("ok", false).put("code", p.code).toString()
                    is PeerParse.Ok -> p.peers
                }
            when (
                val r =
                    exportSealedIndex(
                        phoneIdentity = phoneIdentity,
                        auth = auth,
                        peerPubs = peers,
                        nowMs = nowMs,
                        minAuthEpoch = minAuthEpoch,
                        spentExportSessions = spentExportSessions,
                    )
            ) {
                is Result.Ok -> r.value.toPublicJson().toString()
                is Result.Err -> JSONObject().put("ok", false).put("code", r.code).toString()
            }
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("code", "EXPORT_FAIL").put("error", e.message ?: "").toString()
        }
    }

    /** Leakage scan helper for tests — public JSON must never contain root/nsec/plaintext keys. */
    fun publicJsonLooksSafe(json: String): Boolean {
        if (Regex("""\bnsec1[a-z0-9]+\b""", RegexOption.IGNORE_CASE).containsMatchIn(json)) return false
        if (Regex(""""conversationKey"\s*:""").containsMatchIn(json)) return false
        if (Regex(""""privateKey"\s*:""").containsMatchIn(json)) return false
        if (Regex(""""rootK"\s*:""").containsMatchIn(json)) return false
        if (Regex(""""nsec"\s*:""").containsMatchIn(json)) return false
        return true
    }
}
