package com.sos010.app

import android.content.Context
import android.util.Log
import fr.acinq.secp256k1.Hex
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * Authenticates kind-1059 call Gift Wraps inside the native process.
 * Ring does not wait for SecureCallWakeActivity.
 * Plaintext SDP is never stored.
 */
object SosNativeCallVerifier {
    private const val TAG = "NativeCallVerifier"
    private const val GIFT_KIND = 1059
    private const val SEAL_KIND = 13
    private const val RUMOR_KIND = 25050
    private const val FAMILY = "sos-call-signal"
    private const val VERSION = 1
    private const val MAX_OUTER_CONTENT = 100_000
    private const val MAX_DATA_CHARS = 64 * 1024
    private const val TWO_DAYS_SEC = 2 * 24 * 60 * 60
    private const val PREFS = "sos_native_ring_meta"
    private val rnd = SecureRandom()

    private val freshnessSec = mapOf(
        "offer" to 60,
        "answer" to 60,
        "candidate" to 120,
        "candidates" to 120,
        "disconnect" to 120
    )

    fun processPending(context: Context) {
        val app = context.applicationContext
        val priv = SosSessionStore.getPrivkey(app)
        val self = SosSessionStore.getPubkey(app).ifBlank {
            if (SosNostrCrypto.isHex64(priv)) SosNostrCrypto.pubkeyFromPriv(priv) else ""
        }
        if (!SosNostrCrypto.isHex64(priv) || !SosNostrCrypto.isHex64(self)) {
            Log.i(TAG, "NATIVE_GIFTWRAP_KEY_UNAVAILABLE")
            SosDebugLog.i("call", "NATIVE_GIFTWRAP_KEY_UNAVAILABLE")
            return
        }
        val queue = SosPendingCallStore.peekSecureWraps(app)
        for (i in 0 until queue.length()) {
            val item = queue.optJSONObject(i) ?: continue
            val raw = item.optString("event")
            val event = try {
                JSONObject(raw)
            } catch (_: Exception) {
                ackDrop(app, item.optString("id"), "bad-json")
                continue
            }
            when (val result = unwrap(event, priv, self)) {
                is Unwrap.Keep -> Unit
                is Unwrap.Drop -> ackDrop(app, event.optString("id"), result.reason)
                is Unwrap.Ok -> onAuthenticated(app, event, result.payload, raw)
            }
        }
    }

    fun testDisposition(wrap: JSONObject, privHex: String, self: String): String {
        return when (val result = unwrap(wrap, privHex, self)) {
            is Unwrap.Ok -> "ok:" + result.payload.optString("action")
            is Unwrap.Keep -> "keep"
            is Unwrap.Drop -> "drop:" + result.reason
        }
    }

    fun ringDisposition(action: String): String = when (action) {
        "offer" -> "ring"
        "candidate", "candidates" -> "silent"
        "disconnect" -> "disconnect"
        else -> "ignore"
    }

    fun testUnwrap(wrap: JSONObject, privHex: String, self: String): JSONObject? {
        return when (val result = unwrap(wrap, privHex, self)) {
            is Unwrap.Ok -> result.payload
            else -> null
        }
    }

    fun noteAnswered(context: Context, peer: String?) {
        val app = context.applicationContext
        val meta = loadMeta(app) ?: return
        val pk = peer?.trim()?.lowercase().orEmpty()
        if (pk.isNotEmpty() && pk != meta.peer) return
        SosSecureCallSessionStore.mark(app, meta.sessionId, SosSecureCallSessionStore.STATE_ANSWERED)
    }

    fun sendDecline(context: Context, peer: String, callType: String): Boolean {
        val app = context.applicationContext
        val meta = loadMeta(app)
        val pk = peer.trim().lowercase()
        val media = when (callType.trim().lowercase()) {
            "video", "v", "v-offer" -> "video"
            else -> "voice"
        }
        val sessionId = if (meta != null && (pk.isEmpty() || meta.peer == pk)) meta.sessionId else meta?.sessionId
        val recipient = if (meta != null && meta.peer.isNotEmpty()) meta.peer else pk
        if (sessionId.isNullOrBlank() || !SosNostrCrypto.isHex64(recipient)) {
            Log.i(TAG, "NATIVE_DECLINE_NO_SESSION")
            SosDebugLog.i("call", "NATIVE_DECLINE_NO_SESSION")
            return false
        }
        val sent = publishDisconnect(app, recipient, media, sessionId)
        SosSecureCallSessionStore.mark(app, sessionId, SosSecureCallSessionStore.STATE_DECLINED)
        clearSessionWraps(app, sessionId)
        clearMeta(app)
        return sent
    }

    private fun onAuthenticated(app: Context, wrap: JSONObject, payload: JSONObject, rawEvent: String) {
        val action = payload.optString("action")
        val sessionId = payload.optString("sessionId")
        val wrapId = wrap.optString("id")
        if (SosSecureCallSessionStore.isTombstoned(app, sessionId)) {
            ackDrop(app, wrapId, "tombstone")
            return
        }
        when (ringDisposition(action)) {
            "ring" -> authorizeOffer(app, wrap, payload, rawEvent)
            "disconnect" -> onRemoteDisconnect(app, payload, wrapId)
            else -> Unit
        }
    }

    private fun authorizeOffer(app: Context, wrap: JSONObject, payload: JSONObject, rawEvent: String) {
        val sessionId = payload.optString("sessionId")
        val peer = payload.optString("sender")
        val media = payload.optString("media")
        if (!SosSecureCallSessionStore.markRinged(app, sessionId)) return
        SosSecureCallSessionStore.rememberActiveSession(app, sessionId)
        SosSecureCallSessionStore.mark(app, sessionId, SosSecureCallSessionStore.STATE_VERIFIED_RINGING)
        saveMeta(app, sessionId, peer, media)
        SosPendingCallStore.updateSecureWrapPeer(app, peer, media, rawEvent)
        val name = SosContactCache.displayName(app, peer, app.getString(R.string.call_someone))
        Log.i(TAG, "NATIVE_1059_OFFER_AUTH_OK")
        SosDebugLog.i("call", "NATIVE_1059_OFFER_AUTH_OK")
        NotificationHelper.showIncomingCall(
            app,
            name,
            name,
            SosCallUrls.acceptPage(media),
            media,
            peer,
            name
        )
        CallSoundHelper.startRingtone(app)
        Log.i(TAG, "NATIVE_CALL_RING_AUTHORIZED")
        SosDebugLog.i("call", "NATIVE_CALL_RING_AUTHORIZED")
    }

    private fun onRemoteDisconnect(app: Context, payload: JSONObject, wrapId: String) {
        val sessionId = payload.optString("sessionId")
        val state = SosSecureCallSessionStore.stateOf(app, sessionId)
        if (state != SosSecureCallSessionStore.STATE_VERIFIED_RINGING &&
            !SosSecureCallSessionStore.hasRingedSession(app, sessionId)
        ) {
            ackDrop(app, wrapId, "disconnect-idle")
            return
        }
        if (state == SosSecureCallSessionStore.STATE_ANSWERED) {
            return
        }
        CallSoundHelper.stopRingtone()
        NotificationHelper.cancelIncomingCall(app, stopSound = true, dismissUi = true)
        SosSecureCallSessionStore.mark(app, sessionId, SosSecureCallSessionStore.STATE_ENDED)
        clearSessionWraps(app, sessionId)
        ackDrop(app, wrapId, "remote-disconnect")
        clearMeta(app)
        Log.i(TAG, "NATIVE_CALL_REMOTE_DISCONNECT")
        SosDebugLog.i("call", "NATIVE_CALL_REMOTE_DISCONNECT")
    }

    private fun publishDisconnect(app: Context, recipient: String, media: String, sessionId: String): Boolean {
        val priv = SosSessionStore.getPrivkey(app)
        if (!SosNostrCrypto.isHex64(priv)) return false
        return try {
            val wrap = buildGiftWrap(
                privHex = priv,
                recipientPub = recipient,
                media = media,
                action = "disconnect",
                sessionId = sessionId,
                data = null
            ) ?: return false
            if (wrap.optInt("kind") != GIFT_KIND) return false
            SosRelayWatcher.publishEvent(app, wrap)
            Log.i(TAG, "NATIVE_DECLINE_1059_SENT")
            SosDebugLog.i("call", "NATIVE_DECLINE_1059_SENT")
            true
        } catch (_: Exception) {
            Log.i(TAG, "NATIVE_DECLINE_1059_FAIL")
            SosDebugLog.i("call", "NATIVE_DECLINE_1059_FAIL")
            false
        }
    }

    fun buildGiftWrap(
        privHex: String,
        recipientPub: String,
        media: String,
        action: String,
        sessionId: String,
        data: Any?
    ): JSONObject? {
        val sender = SosNostrCrypto.pubkeyFromPriv(privHex)
        val recipient = recipientPub.trim().lowercase()
        if (!SosNostrCrypto.isHex64(recipient) || sender == recipient) return null
        val signalId = randomHex(16)
        val sentAt = System.currentTimeMillis() / 1000L
        val payload = JSONObject()
            .put("family", FAMILY)
            .put("v", VERSION)
            .put("media", media)
            .put("action", action)
            .put("sessionId", sessionId)
            .put("signalId", signalId)
            .put("sender", sender)
            .put("recipient", recipient)
            .put("sentAt", sentAt)
            .put("data", data ?: JSONObject.NULL)
        val rumor = JSONObject()
            .put("kind", RUMOR_KIND)
            .put("pubkey", sender)
            .put("created_at", sentAt)
            .put("tags", JSONArray())
            .put("content", payload.toString())
        rumor.put("id", eventHash(rumor))
        val sealContent = encryptTo(privHex, recipient, rumor.toString()) ?: return null
        val seal = SosNostrCrypto.signEvent(
            privHex,
            SEAL_KIND,
            JSONArray(),
            sealContent,
            randomizedPast()
        )
        if (!SosNostrCrypto.verifyEvent(seal)) return null
        val eph = randomScalar()
        val wrapContent = encryptTo(eph, recipient, seal.toString()) ?: return null
        val wrap = SosNostrCrypto.signEvent(
            eph,
            GIFT_KIND,
            JSONArray().put(JSONArray().put("p").put(recipient)),
            wrapContent,
            randomizedPast()
        )
        if (!SosNostrCrypto.verifyEvent(wrap)) return null
        if (wrap.optString("pubkey").equals(sender, ignoreCase = true)) return null
        return wrap
    }

    private fun unwrap(wrap: JSONObject, privHex: String, self: String): Unwrap {
        if (wrap.optInt("kind") != GIFT_KIND) return Unwrap.Drop("kind")
        val content = wrap.optString("content")
        if (content.length > MAX_OUTER_CONTENT) return Unwrap.Drop("outer-bound")
        when (val verified = SosNostrCrypto.verifyEventDetailed(wrap)) {
            SosNostrCrypto.EventVerifyResult.VALID -> {
                trace("NATIVE_EVENT_VERIFY_ID_OK")
                trace("NATIVE_EVENT_VERIFY_SCHNORR_OK")
                trace("NATIVE_1059_OUTER_OK")
            }
            SosNostrCrypto.EventVerifyResult.EVENT_ID_MISMATCH -> {
                trace("NATIVE_EVENT_VERIFY_ID_MISMATCH")
                return Unwrap.Keep
            }
            SosNostrCrypto.EventVerifyResult.SCHNORR_EXCEPTION -> {
                trace("NATIVE_EVENT_VERIFY_EXCEPTION")
                return Unwrap.Keep
            }
            SosNostrCrypto.EventVerifyResult.SCHNORR_INVALID -> {
                trace("NATIVE_EVENT_VERIFY_SCHNORR_INVALID")
                return Unwrap.Drop("outer-sig")
            }
            SosNostrCrypto.EventVerifyResult.BAD_FORMAT -> return Unwrap.Drop("outer-sig")
        }
        if (pTag(wrap) != self) return Unwrap.Drop("recipient")
        val sealJson = decryptFrom(privHex, wrap.optString("pubkey"), content)
            ?: return Unwrap.Drop("outer-mac")
        val seal = try {
            JSONObject(sealJson)
        } catch (_: Exception) {
            return Unwrap.Drop("seal-json")
        }
        if (seal.optInt("kind") != SEAL_KIND) return Unwrap.Drop("seal-kind")
        val sealTags = seal.optJSONArray("tags") ?: return Unwrap.Drop("seal-tags")
        if (sealTags.length() != 0) return Unwrap.Drop("seal-tags")
        val sealContent = seal.optString("content")
        if (sealContent.length > MAX_OUTER_CONTENT) return Unwrap.Drop("seal-bound")
        when (val verified = SosNostrCrypto.verifyEventDetailed(seal)) {
            SosNostrCrypto.EventVerifyResult.VALID -> {
                trace("NATIVE_EVENT_VERIFY_ID_OK")
                trace("NATIVE_EVENT_VERIFY_SCHNORR_OK")
                trace("NATIVE_1059_SEAL_OK")
            }
            SosNostrCrypto.EventVerifyResult.EVENT_ID_MISMATCH -> {
                trace("NATIVE_EVENT_VERIFY_ID_MISMATCH")
                return Unwrap.Keep
            }
            SosNostrCrypto.EventVerifyResult.SCHNORR_EXCEPTION -> {
                trace("NATIVE_EVENT_VERIFY_EXCEPTION")
                return Unwrap.Keep
            }
            SosNostrCrypto.EventVerifyResult.SCHNORR_INVALID -> {
                trace("NATIVE_EVENT_VERIFY_SCHNORR_INVALID")
                return Unwrap.Drop("seal-sig")
            }
            SosNostrCrypto.EventVerifyResult.BAD_FORMAT -> return Unwrap.Drop("seal-sig")
        }
        val rumorJson = decryptFrom(privHex, seal.optString("pubkey"), sealContent)
            ?: return Unwrap.Drop("seal-mac")
        val rumor = try {
            JSONObject(rumorJson)
        } catch (_: Exception) {
            return Unwrap.Drop("rumor-json")
        }
        if (rumor.optInt("kind") != RUMOR_KIND) return Unwrap.Drop("rumor-kind")
        if (!rumor.optString("pubkey").equals(seal.optString("pubkey"), ignoreCase = true)) {
            Log.i(TAG, "NATIVE_GIFTWRAP_AUTHOR_MISMATCH")
            SosDebugLog.i("call", "NATIVE_GIFTWRAP_AUTHOR_MISMATCH")
            return Unwrap.Drop("author")
        }
        val expectId = eventHash(rumor)
        if (!rumor.optString("id").equals(expectId, ignoreCase = true)) {
            trace("NATIVE_EVENT_VERIFY_ID_MISMATCH")
            return Unwrap.Keep
        }
        val payload = try {
            JSONObject(rumor.optString("content"))
        } catch (_: Exception) {
            return Unwrap.Drop("payload")
        }
        val valid = validatePayload(payload, self) ?: return Unwrap.Drop("schema")
        if (!valid.optString("sender").equals(seal.optString("pubkey"), ignoreCase = true)) {
            Log.i(TAG, "NATIVE_GIFTWRAP_AUTHOR_MISMATCH")
            SosDebugLog.i("call", "NATIVE_GIFTWRAP_AUTHOR_MISMATCH")
            return Unwrap.Drop("author")
        }
        return Unwrap.Ok(valid)
    }

    private fun validatePayload(payload: JSONObject, self: String): JSONObject? {
        if (payload.optString("family") != FAMILY || payload.optInt("v") != VERSION) return null
        val media = payload.optString("media")
        if (media != "voice" && media != "video") return null
        val action = payload.optString("action")
        val maxAge = freshnessSec[action] ?: return null
        val sessionId = payload.optString("sessionId")
        val signalId = payload.optString("signalId")
        if (sessionId.length < 32 || signalId.length < 32) return null
        val sender = payload.optString("sender").trim().lowercase()
        val recipient = payload.optString("recipient").trim().lowercase()
        if (!SosNostrCrypto.isHex64(sender) || !SosNostrCrypto.isHex64(recipient)) return null
        if (recipient != self.trim().lowercase()) return null
        val sentAt = payload.optLong("sentAt", 0L)
        if (sentAt <= 0L) return null
        val age = (System.currentTimeMillis() / 1000L) - sentAt
        if (age > maxAge || age < -30) return null
        if (payload.has("data") && !payload.isNull("data")) {
            val data = payload.opt("data")
            val size = when (data) {
                is String -> data.length
                else -> data?.toString()?.length ?: 0
            }
            if (size > MAX_DATA_CHARS) return null
        }
        payload.put("sender", sender)
        payload.put("recipient", recipient)
        return payload
    }

    private fun decryptFrom(privHex: String, peerPub: String, payload: String): String? {
        val key = SosNostrCrypto.nip44ConversationKey(privHex, peerPub) ?: return null
        return SosNostrCrypto.nip44Decrypt(key, payload)
    }

    private fun encryptTo(privHex: String, peerPub: String, plaintext: String): String? {
        val key = SosNostrCrypto.nip44ConversationKey(privHex, peerPub) ?: return null
        val nonce = ByteArray(32).also { rnd.nextBytes(it) }
        return try {
            SosNostrCrypto.nip44Encrypt(key, plaintext, nonce)
        } catch (_: Exception) {
            null
        }
    }

    private fun eventHash(event: JSONObject): String = SosNostrCrypto.nostrEventId(event)

    private fun trace(code: String) {
        try {
            Log.i(TAG, code)
        } catch (_: Throwable) {
        }
        try {
            SosDebugLog.i("call", code)
        } catch (_: Throwable) {
        }
    }

    private fun pTag(event: JSONObject): String {
        val tags = event.optJSONArray("tags") ?: return ""
        for (i in 0 until tags.length()) {
            val tag = tags.optJSONArray(i) ?: continue
            if (tag.optString(0) == "p") return tag.optString(1).lowercase()
        }
        return ""
    }

    private fun ackDrop(app: Context, eventId: String?, reason: String) {
        if (!eventId.isNullOrBlank()) {
            SosSecureWrapHandledStore.markHandled(app, eventId)
            SosPendingCallStore.removeSecureWrap(app, eventId)
        }
        Log.i(TAG, "NATIVE_GIFTWRAP_DROP")
        SosDebugLog.i("call", "NATIVE_GIFTWRAP_DROP $reason")
    }

    private fun clearSessionWraps(app: Context, sessionId: String) {
        val priv = SosSessionStore.getPrivkey(app)
        val self = SosSessionStore.getPubkey(app)
        if (!SosNostrCrypto.isHex64(priv) || !SosNostrCrypto.isHex64(self)) return
        val queue = SosPendingCallStore.peekSecureWraps(app)
        for (i in 0 until queue.length()) {
            val item = queue.optJSONObject(i) ?: continue
            val event = try {
                JSONObject(item.optString("event"))
            } catch (_: Exception) {
                continue
            }
            val result = unwrap(event, priv, self)
            if (result is Unwrap.Ok && result.payload.optString("sessionId") == sessionId) {
                val id = event.optString("id")
                SosSecureWrapHandledStore.markHandled(app, id)
                SosPendingCallStore.removeSecureWrap(app, id)
            }
        }
    }

    private fun saveMeta(app: Context, sessionId: String, peer: String, media: String) {
        val obj = JSONObject()
            .put("sessionId", sessionId)
            .put("peer", peer)
            .put("media", media)
            .put("at", System.currentTimeMillis())
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString("meta", obj.toString())
            .apply()
    }

    private fun loadMeta(app: Context): RingMeta? {
        val raw = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("meta", "").orEmpty()
        if (raw.isBlank()) return null
        return try {
            val obj = JSONObject(raw)
            val at = obj.optLong("at", 0L)
            if (at <= 0L || System.currentTimeMillis() - at > 180_000L) return null
            RingMeta(obj.optString("sessionId"), obj.optString("peer"), obj.optString("media"))
        } catch (_: Exception) {
            null
        }
    }

    private fun clearMeta(app: Context) {
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("meta").apply()
    }

    private fun randomizedPast(): Long {
        val now = System.currentTimeMillis() / 1000L
        val offset = (rnd.nextInt(TWO_DAYS_SEC).toLong()).coerceAtLeast(0L)
        return (now - offset).coerceAtLeast(0L)
    }

    private fun randomHex(bytes: Int): String {
        val buf = ByteArray(bytes)
        rnd.nextBytes(buf)
        return Hex.encode(buf)
    }

    private fun randomScalar(): String {
        repeat(8) {
            val buf = ByteArray(32)
            rnd.nextBytes(buf)
            val hex = Hex.encode(buf)
            try {
                SosNostrCrypto.pubkeyFromPriv(hex)
                return hex
            } catch (_: Exception) {
            }
        }
        throw IllegalStateException("ephemeral")
    }

    private data class RingMeta(val sessionId: String, val peer: String, val media: String)

    private sealed class Unwrap {
        data class Ok(val payload: JSONObject) : Unwrap()
        data class Drop(val reason: String) : Unwrap()
        data object Keep : Unwrap()
    }
}
