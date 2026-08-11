package com.sos010.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
/**
 * מסך לוג רקע – העתק / שמירת TXT / שיתוף.
 */
class SosDebugLogActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var debugText: TextView
    private lateinit var debugMeta: TextView
    private lateinit var debugScroll: ScrollView
    private var autoScroll = true

    private val refreshRunnable = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1500L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_debug_log)
        debugText = findViewById(R.id.debugText)
        debugMeta = findViewById(R.id.debugMeta)
        debugScroll = findViewById(R.id.debugScroll)

        findViewById<Button>(R.id.btnCopy).setOnClickListener { copyLog() }
        findViewById<Button>(R.id.btnSaveTxt).setOnClickListener { saveTxt(shareAfter = false) }
        findViewById<Button>(R.id.btnShare).setOnClickListener { saveTxt(shareAfter = true) }
        findViewById<Button>(R.id.btnClear).setOnClickListener {
            SosDebugLog.clear()
            Toast.makeText(this, R.string.debug_log_reset_done, Toast.LENGTH_SHORT).show()
            render()
        }
        findViewById<Button>(R.id.btnClose).setOnClickListener { finish() }

        SosDebugLog.reloadFromDisk()
        SosDebugLog.i("ui", "debug log screen opened (loaded history)")
        render()
    }

    override fun onResume() {
        super.onResume()
        SosDebugLog.reloadFromDisk()
        handler.post(refreshRunnable)
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRunnable)
        super.onPause()
    }

    private fun render() {
        debugMeta.text = getString(
            R.string.debug_log_meta,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
            MainActivity.isHostAlive.toString(),
            MainActivity.isActivityAlive.toString(),
            BuildConfig.HAS_FCM.toString()
        )
        val text = SosDebugLog.getText()
        debugText.text = text
        if (autoScroll) {
            debugScroll.post { debugScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    private fun copyLog() {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("SOS debug log", SosDebugLog.getText()))
        Toast.makeText(this, R.string.debug_log_copied, Toast.LENGTH_SHORT).show()
        SosDebugLog.i("ui", "log copied to clipboard")
    }

    private fun saveTxt(shareAfter: Boolean) {
        try {
            val saved = SosDebugLog.saveTxt(this)
            Toast.makeText(
                this,
                getString(R.string.debug_log_saved, saved.publicPathHint),
                Toast.LENGTH_LONG
            ).show()
            if (!shareAfter) return
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_SUBJECT, "SOS background log ${BuildConfig.VERSION_NAME}")
                putExtra(Intent.EXTRA_TEXT, "SOS debug log: ${saved.displayName}")
                putExtra(Intent.EXTRA_STREAM, saved.shareUri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, getString(R.string.debug_log_share)))
        } catch (err: Exception) {
            SosDebugLog.e("ui", "save/share failed: ${err.message}")
            Toast.makeText(this, err.message ?: "save failed", Toast.LENGTH_LONG).show()
        }
    }
}
