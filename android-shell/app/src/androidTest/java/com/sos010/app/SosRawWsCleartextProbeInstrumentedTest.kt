package com.sos010.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.Base64
import java.security.SecureRandom

/**
 * Raw TCP WebSocket upgrade probe (no OkHttp) for cleartext host-alias / loopback.
 */
@RunWith(AndroidJUnit4::class)
class SosRawWsCleartextProbeInstrumentedTest {
    @Test
    fun rawUpgradeToLocalRelay() {
        val handoff = JSONObject(
            java.io.File("/data/local/tmp/sos-k25060-probe-handoff.json").readText(),
        )
        val relayUrl = handoff.optString("relayUrl", "ws://10.0.2.2:7805")
        val host = relayUrl.substringAfter("://").substringBefore("/").substringBefore(":")
        val port = relayUrl.substringAfter("://").substringBefore("/").substringAfter(":", "80").toInt()

        val sock = Socket()
        sock.connect(InetSocketAddress(host, port), 8000)
        val out = BufferedOutputStream(sock.getOutputStream())
        val inp = BufferedInputStream(sock.getInputStream())
        val key = Base64.getEncoder().encodeToString(ByteArray(16).also { SecureRandom().nextBytes(it) })
        val req =
            "GET / HTTP/1.1\r\n" +
                "Host: $host:$port\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: $key\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "\r\n"
        out.write(req.toByteArray(Charsets.US_ASCII))
        out.flush()

        val buf = ByteArray(1024)
        sock.soTimeout = 8000
        val n = inp.read(buf)
        val resp = if (n > 0) String(buf, 0, n, Charsets.US_ASCII) else ""
        sock.close()

        val result =
            JSONObject()
                .put("host", host)
                .put("port", port)
                .put("respHead", resp.lineSequence().firstOrNull() ?: "")
                .put("ok", resp.contains("101"))
        InstrumentationRegistry.getInstrumentation().targetContext
            .openFileOutput("sos-raw-ws-probe-result.json", 0)
            .use { it.write(result.toString().toByteArray()) }

        assertTrue("upgrade failed: ${resp.take(200)}", resp.contains("101"))
    }
}
