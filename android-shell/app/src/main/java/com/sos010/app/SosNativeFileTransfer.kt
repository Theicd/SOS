package com.sos010.app

import android.content.Context
import android.os.Environment
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import org.webrtc.DataChannel
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * קבלת קבצי P2P ב-Native כשהכרטיסייה סגורה (file-transfer DC).
 * תואם ל-chat-p2p-file.js: file-offer / file-ready / chunk-meta / binary AES-GCM / chunk-ack.
 */
object SosNativeFileTransfer {
    private const val TAG = "SosNativeFile"
    private const val LABEL = "file-transfer"

    private data class Rx(
        val fileId: String,
        val name: String,
        val size: Long,
        val mime: String,
        val key: ByteArray,
        val totalChunks: Int,
        var expected: Int = 0,
        val chunks: Array<ByteArray?> = arrayOfNulls(0)
    )

    private val byPeer = ConcurrentHashMap<String, Rx>()
    private val channels = ConcurrentHashMap<String, DataChannel>()

    fun label(): String = LABEL

    fun wire(context: Context, peer: String, dc: DataChannel) {
        channels[peer] = dc
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) {
                    Log.i(TAG, "file DC OPEN ${peer.take(8)}")
                } else if (dc.state() == DataChannel.State.CLOSED) {
                    Log.i(TAG, "file DC CLOSED ${peer.take(8)}")
                    channels.remove(peer, dc)
                    byPeer.remove(peer)
                    maybeIdle(context)
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer?) {
                if (buffer == null) return
                val bytes = ByteArray(buffer.data.remaining())
                buffer.data.get(bytes)
                if (buffer.binary) {
                    onBinary(context, peer, bytes, dc)
                } else {
                    onText(context, peer, String(bytes, Charset.forName("UTF-8")), dc)
                }
            }
        })
    }

    private fun onText(context: Context, peer: String, raw: String, dc: DataChannel) {
        try {
            val m = JSONObject(raw)
            when (m.optString("type")) {
                "file-offer" -> onOffer(context, peer, m, dc)
                "chunk-meta" -> {
                    val fileId = m.optString("fileId")
                    val idx = m.optInt("index", -1)
                    val rx = byPeer[peer]
                    if (rx != null && rx.fileId == fileId && idx >= 0) {
                        rx.expected = idx
                    }
                }
                "ping" -> sendText(dc, JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
            }
        } catch (err: Exception) {
            Log.w(TAG, "text handle fail: ${err.message}")
        }
    }

    private fun onOffer(context: Context, peer: String, m: JSONObject, dc: DataChannel) {
        val fileId = m.optString("fileId")
        val keyStr = m.optString("keyStr")
        val name = m.optString("name").ifBlank { "file.bin" }
        val size = m.optLong("size")
        val mime = m.optString("mimeType").ifBlank { "application/octet-stream" }
        val total = m.optInt("totalChunks")
        if (fileId.isBlank() || keyStr.isBlank() || total <= 0) return
        val key = try {
            Base64.decode(keyStr, Base64.DEFAULT)
        } catch (_: Exception) {
            return
        }
        if (key.size !in 16..32) return
        SosP2pTransferKeeper.setActive(context, true)
        byPeer[peer] = Rx(
            fileId = fileId,
            name = name,
            size = size,
            mime = mime,
            key = key,
            totalChunks = total,
            expected = 0,
            chunks = arrayOfNulls(total)
        )
        sendText(dc, JSONObject().put("type", "file-ready").put("fileId", fileId).toString())
        Log.i(TAG, "file-offer ${peer.take(8)} $name chunks=$total → file-ready")
    }

    private fun onBinary(context: Context, peer: String, encrypted: ByteArray, dc: DataChannel) {
        if (encrypted.size < 32) return
        val rx = byPeer[peer] ?: return
        val idx = rx.expected
        if (idx < 0 || idx >= rx.totalChunks) return
        if (rx.chunks[idx] != null) {
            sendText(dc, JSONObject().put("type", "chunk-ack").put("fileId", rx.fileId).put("index", idx).toString())
            return
        }
        val plain = decrypt(encrypted, rx.key) ?: return
        rx.chunks[idx] = plain
        var got = 0
        for (c in rx.chunks) if (c != null) got++
        sendText(dc, JSONObject().put("type", "chunk-ack").put("fileId", rx.fileId).put("index", idx).toString())
        rx.expected = idx + 1
        Log.i(TAG, "chunk $idx/${rx.totalChunks} ← ${peer.take(8)}")
        if (got >= rx.totalChunks) {
            finalize(context, peer, rx, dc)
        }
    }

    private fun finalize(context: Context, peer: String, rx: Rx, dc: DataChannel) {
        try {
            val outDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: context.filesDir
            if (!outDir.exists()) outDir.mkdirs()
            val safeName = rx.name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120)
            val out = File(outDir, "sos-${System.currentTimeMillis()}-$safeName")
            FileOutputStream(out).use { fos ->
                for (i in 0 until rx.totalChunks) {
                    val part = rx.chunks[i] ?: throw IllegalStateException("missing chunk $i")
                    fos.write(part)
                }
            }
            sendText(
                dc,
                JSONObject()
                    .put("type", "file-complete-ack")
                    .put("fileId", rx.fileId)
                    .put("name", rx.name)
                    .put("size", rx.size)
                    .toString()
            )
            NotificationHelper.showMessage(
                context,
                "קובץ P2P",
                "התקבל: ${rx.name}",
                "https://sos010.com/videos.html",
                "p2p-file-$peer",
                eventId = rx.fileId,
                peerKey = peer,
                pictureUrl = null
            )
            Log.i(TAG, "saved ${out.absolutePath} (${out.length()} bytes)")
        } catch (err: Exception) {
            Log.e(TAG, "finalize failed: ${err.message}", err)
        } finally {
            byPeer.remove(peer)
            maybeIdle(context)
        }
    }

    private fun maybeIdle(context: Context) {
        if (byPeer.isEmpty() && channels.values.none { it.state() == DataChannel.State.OPEN }) {
            SosP2pTransferKeeper.setActive(context, false)
        }
    }

    private fun decrypt(data: ByteArray, key: ByteArray): ByteArray? {
        return try {
            val iv = data.copyOfRange(0, 12)
            val cipherBytes = data.copyOfRange(12, data.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.doFinal(cipherBytes)
        } catch (err: Exception) {
            Log.w(TAG, "decrypt fail: ${err.message}")
            null
        }
    }

    private fun sendText(dc: DataChannel, text: String) {
        if (dc.state() != DataChannel.State.OPEN) return
        val buf = ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8))
        dc.send(DataChannel.Buffer(buf, false))
    }
}
