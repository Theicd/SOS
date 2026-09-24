package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * MD3 — Account-scoped authorized-device registry (public metadata + signed auth object).
 * Signed DeviceAuthorization is cryptographic authority; registry indexes it.
 * HYPER CORE TECH
 */
class SosDeviceAuthorizationRegistry {

    data class Entry(
        val accountP: String,
        val authorizationId: String,
        val deviceId: String,
        val dSignPub: String,
        val dEncPub: String,
        val capabilities: Set<SosDeviceAuthorization.Capability>,
        val authEpoch: Long,
        val createdAt: Long,
        val expiresAt: Long,
        val status: SosDeviceAuthorization.Status,
        val deviceLabel: String,
        val deviceType: String,
        val signedAuthorizationJson: String,
    )

    private val byAccount = ConcurrentHashMap<String, MutableMap<String, Entry>>()

    fun clearAll() {
        byAccount.clear()
    }

    fun activeCount(accountP: String, nowMs: Long = System.currentTimeMillis()): Int {
        refreshExpired(accountP, nowMs)
        return entries(accountP).count {
            it.status == SosDeviceAuthorization.Status.ACTIVE && nowMs <= it.expiresAt
        }
    }

    fun entries(accountP: String): List<Entry> {
        val key = SosDeviceKeyCrypto.normalizeHex(accountP)
        return byAccount[key]?.values?.toList() ?: emptyList()
    }

    fun get(accountP: String, authorizationId: String): Entry? {
        val a = SosDeviceKeyCrypto.normalizeHex(accountP)
        val id = SosDeviceKeyCrypto.normalizeHex(authorizationId)
        return byAccount[a]?.get(id)
    }

    fun findActiveByDeviceId(accountP: String, deviceId: String, nowMs: Long = System.currentTimeMillis()): Entry? {
        refreshExpired(accountP, nowMs)
        val d = SosDeviceKeyCrypto.normalizeHex(deviceId)
        return entries(accountP).firstOrNull {
            it.deviceId == d &&
                it.status == SosDeviceAuthorization.Status.ACTIVE &&
                nowMs <= it.expiresAt
        }
    }

    sealed class PutResult {
        data class Ok(val entry: Entry) : PutResult()
        data class Err(val code: String) : PutResult()
    }

    /**
     * Commit ACTIVE only after full ceremony. Validates signed object matches entry fields.
     */
    fun putActive(auth: SosDeviceAuthorization.Authorization, nowMs: Long = System.currentTimeMillis()): PutResult {
        when (val v = SosDeviceAuthorization.verifyStrict(auth, nowMs)) {
            is SosDeviceAuthorization.VerifyResult.Err -> return PutResult.Err(v.code)
            SosDeviceAuthorization.VerifyResult.Ok -> Unit
        }
        val account = SosDeviceKeyCrypto.normalizeHex(auth.accountP)
        refreshExpired(account, nowMs)

        // Collision: same deviceId with different keys
        val sameId = entries(account).filter {
            it.deviceId == auth.deviceId && it.status == SosDeviceAuthorization.Status.ACTIVE
        }
        for (e in sameId) {
            if (e.dSignPub != auth.dSignPub || e.dEncPub != auth.dEncPub) {
                return PutResult.Err("DEVICE_ID_KEY_MISMATCH")
            }
        }

        // Collision: same keys under different deviceId
        val sameKeys = entries(account).filter {
            it.status == SosDeviceAuthorization.Status.ACTIVE &&
                it.dSignPub == auth.dSignPub &&
                it.dEncPub == auth.dEncPub
        }
        for (e in sameKeys) {
            if (e.deviceId != auth.deviceId) {
                return PutResult.Err("DEVICE_KEY_REUSE")
            }
        }

        // Same device reauthorization: replace slot (no duplicate)
        val existing = findActiveByDeviceId(account, auth.deviceId, nowMs)
        if (existing != null) {
            if (existing.dSignPub == auth.dSignPub && existing.dEncPub == auth.dEncPub) {
                remove(account, existing.authorizationId)
            } else {
                return PutResult.Err("DEVICE_ID_KEY_MISMATCH")
            }
        } else if (activeCount(account, nowMs) >= SosDeviceAuthorization.MAX_LINKED_DEVICES) {
            return PutResult.Err("MAX_LINKED_DEVICES")
        }

        val entry = Entry(
            accountP = account,
            authorizationId = auth.authorizationId,
            deviceId = auth.deviceId,
            dSignPub = auth.dSignPub,
            dEncPub = auth.dEncPub,
            capabilities = auth.capabilities,
            authEpoch = auth.authEpoch,
            createdAt = auth.createdAt,
            expiresAt = auth.expiresAt,
            status = SosDeviceAuthorization.Status.ACTIVE,
            deviceLabel = SosDeviceAuthorization.sanitizeLabel(auth.deviceLabel),
            deviceType = SosDeviceAuthorization.sanitizeLabel(auth.deviceType),
            signedAuthorizationJson = auth.toPublicJson().toString(),
        )
        // Authority check: re-parse signed object must match
        val parsed = SosDeviceAuthorization.Authorization.fromJson(JSONObject(entry.signedAuthorizationJson))
        if (parsed.authorizationId != entry.authorizationId ||
            parsed.deviceId != entry.deviceId ||
            parsed.dSignPub != entry.dSignPub ||
            parsed.capabilities != entry.capabilities
        ) {
            return PutResult.Err("REGISTRY_AUTH_MISMATCH")
        }
        val map = byAccount.getOrPut(account) { ConcurrentHashMap() }
        map[entry.authorizationId] = entry
        return PutResult.Ok(entry)
    }

    fun remove(accountP: String, authorizationId: String) {
        val a = SosDeviceKeyCrypto.normalizeHex(accountP)
        val id = SosDeviceKeyCrypto.normalizeHex(authorizationId)
        byAccount[a]?.remove(id)
    }

    fun refreshExpired(accountP: String, nowMs: Long = System.currentTimeMillis()) {
        val a = SosDeviceKeyCrypto.normalizeHex(accountP)
        val map = byAccount[a] ?: return
        for ((id, e) in map.toMap()) {
            if (e.status == SosDeviceAuthorization.Status.ACTIVE && nowMs > e.expiresAt) {
                map[id] = e.copy(status = SosDeviceAuthorization.Status.EXPIRED)
            }
        }
    }

    /** Fail closed on corrupt signed blob — does not auto-trust. */
    fun loadFromSignedJson(accountP: String, json: String, nowMs: Long = System.currentTimeMillis()): PutResult {
        return try {
            val auth = SosDeviceAuthorization.Authorization.fromJson(JSONObject(json))
            if (SosDeviceKeyCrypto.normalizeHex(auth.accountP) !=
                SosDeviceKeyCrypto.normalizeHex(accountP)
            ) {
                return PutResult.Err("ACCOUNT_MISMATCH")
            }
            putActive(auth, nowMs)
        } catch (_: Exception) {
            PutResult.Err("CORRUPT_AUTH_JSON")
        }
    }

    fun exportAccountPublic(accountP: String): JSONArray {
        val arr = JSONArray()
        for (e in entries(accountP)) {
            arr.put(
                JSONObject()
                    .put("authorizationId", e.authorizationId)
                    .put("deviceId", e.deviceId)
                    .put("D_sign_pub", e.dSignPub)
                    .put("D_enc_pub", e.dEncPub)
                    .put("authEpoch", e.authEpoch)
                    .put("createdAt", e.createdAt)
                    .put("expiresAt", e.expiresAt)
                    .put("status", e.status.name)
                    .put("deviceLabel", e.deviceLabel)
                    .put("deviceType", e.deviceType)
                    .put(
                        "capabilities",
                        JSONArray().also { a -> e.capabilities.map { it.name }.sorted().forEach { a.put(it) } },
                    ),
            )
        }
        return arr
    }
}
