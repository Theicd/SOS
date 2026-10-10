package com.sos010.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import fr.acinq.secp256k1.Hex
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Isolated kind-25060 transport probe — no MD3 issuance.
 * Handoff (host pushes via adb): /data/local/tmp/sos-k25060-probe-handoff.json
 * Result (app filesDir): files/sos-k25060-probe-result.json — pull via run-as.
 */
@RunWith(AndroidJUnit4::class)
class SosKind25060TransportProbeInstrumentedTest {

    @Test
    fun publishSyntheticKind25060ToLocalRelay() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val handoffPath =
            InstrumentationRegistry.getArguments().getString("handoff")
                ?: "/data/local/tmp/sos-k25060-probe-handoff.json"
        val handoff = JSONObject(File(handoffPath).readText())
        val relayUrl = handoff.optString("relayUrl", "ws://10.0.2.2:7797")
        val pairingId = handoff.optString("pairingId", "ab".repeat(32)).lowercase()

        val opened = AtomicBoolean(false)
        val failure = AtomicReference<String?>(null)
        val sentOk = AtomicBoolean(false)
        val openLatch = CountDownLatch(1)
        val trace = JSONArray()

        fun note(phase: String, extra: JSONObject = JSONObject()) {
            trace.put(
                JSONObject()
                    .put("ts", System.currentTimeMillis())
                    .put("phase", phase)
                    .put("relayCategory", categorize(relayUrl))
                    .put("extra", extra),
            )
        }

        val client =
            OkHttpClient.Builder()
                .connectTimeout(12, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build()

        note(
            "CONNECT_START",
            JSONObject().put("urlHost", relayUrl.substringAfter("://").substringBefore("/")),
        )
        val ws =
            client.newWebSocket(
                Request.Builder().url(relayUrl).header("User-Agent", "SosK25060Probe/1.0").build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        opened.set(true)
                        note("OPEN", JSONObject().put("code", response.code))
                        openLatch.countDown()
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        failure.set((t.javaClass.simpleName + ":" + (t.message ?: "")).take(160))
                        note(
                            "FAILURE",
                            JSONObject()
                                .put("err", failure.get())
                                .put("http", response?.code ?: -1),
                        )
                        openLatch.countDown()
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        note("CLOSING", JSONObject().put("code", code).put("reason", reason.take(80)))
                    }
                },
            )

        val openedInTime = openLatch.await(20, TimeUnit.SECONDS)
        note("OPEN_WAIT_DONE", JSONObject().put("opened", opened.get()).put("awaitOk", openedInTime))

        var eventIdFp = ""
        var serialized = false
        var sendInvoked = false
        var transportPubOk = false
        if (opened.get()) {
            val sk =
                run {
                    val b = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
                    val hex = Hex.encode(b)
                    SosNostrCrypto.pubkeyFromPriv(hex)
                    hex
                }
            val tags =
                JSONArray()
                    .put(JSONArray().put("t").put("sos-pair-v1"))
                    .put(JSONArray().put("d").put(pairingId))
                    .put(JSONArray().put("role").put("phone"))
            val content =
                JSONObject()
                    .put("type", "hello")
                    .put("pairingId", pairingId)
                    .put("probe", true)
                    .toString()
            val ev = SosNostrCrypto.signEvent(sk, 25060, tags, content)
            serialized = true
            eventIdFp = ev.optString("id").take(16)
            val valid = SosNostrCrypto.verifyEvent(ev)
            note(
                "EVENT_SIGNED",
                JSONObject()
                    .put("idFp", eventIdFp)
                    .put("kind", ev.optInt("kind"))
                    .put("verify", valid),
            )
            val frame = JSONArray().put("EVENT").put(ev).toString()
            sendInvoked = true
            val ok = ws.send(frame)
            sentOk.set(ok)
            note("SEND", JSONObject().put("ok", ok).put("frameLen", frame.length))

            val transport = SosPairingNostrTransport(relayUrls = listOf(relayUrl))
            transport.start(pairingId, "phone") { }
            Thread.sleep(800)
            transportPubOk = transport.publish(content)
            note("TRANSPORT_PUBLISH", JSONObject().put("ok", transportPubOk))
            Thread.sleep(1000)
            transport.stop()
        }

        try {
            ws.close(1000, "probe-done")
        } catch (_: Exception) {
        }

        val result =
            JSONObject()
                .put("runId", handoff.optString("runId", ""))
                .put("ok", opened.get() && sentOk.get() && serialized)
                .put("ANDROID_SOCKET_OPEN", opened.get())
                .put("ANDROID_EVENT_SERIALIZED", serialized)
                .put("ANDROID_EVENT_SEND_INVOKED", sendInvoked)
                .put("ANDROID_SEND_SOCKET_OPEN", opened.get() && sendInvoked)
                .put("ANDROID_OUTBOUND_WS_FRAME_OBSERVED", sentOk.get())
                .put("KIND_25060_EVENT_VALID", serialized && eventIdFp.isNotEmpty())
                .put("TRANSPORT_PUBLISH_OK", transportPubOk)
                .put("failure", failure.get())
                .put("relayCategory", categorize(relayUrl))
                .put("eventIdFp", eventIdFp)
                .put("trace", trace)

        // App-private only (API 33+ blocks app write to /data/local/tmp).
        ctx.openFileOutput("sos-k25060-probe-result.json", 0).use {
            it.write(result.toString().toByteArray(Charsets.UTF_8))
        }
        // Also mirror under cache for easier run-as path discovery.
        File(ctx.cacheDir, "sos-k25060-probe-result.json").writeText(result.toString())

        assertTrue("socket open failed: ${failure.get()}", opened.get())
        assertTrue("send failed", sentOk.get())
    }

    private fun categorize(url: String): String =
        when {
            url.contains("10.0.2.2") -> "EMULATOR_HOST_ALIAS"
            url.contains("127.0.0.1") || url.contains("localhost") -> "LOOPBACK"
            url.startsWith("wss://") -> "PUBLIC_WSS"
            else -> "OTHER"
        }
}
