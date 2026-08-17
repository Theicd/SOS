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
 * מסך לוג רקע – העתק / שמירת TXT / שיתוף + מתג ON/OFF שנשמר.
 */
class SosDebugLogActivity : AppCompatActivity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var debugText: TextView
    private lateinit var debugMeta: TextView
    private lateinit var debugScroll: ScrollView
    private lateinit var btnToggle: Button
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
        btnToggle = findViewById(R.id.btnToggleLog)

        btnToggle.setOnClickListener {
            val next = !SosDebugLog.isEnabled()
            SosDebugLog.setEnabled(next)
            syncToggleUi()
            Toast.makeText(
                this,
                if (next) R.string.debug_log_enabled_toast else R.string.debug_log_disabled_toast,
                Toast.LENGTH_SHORT
            ).show()
            render()
        }
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
        syncToggleUi()
        render()
    }

    override fun onResume() {
        super.onResume()
        SosDebugLog.reloadFromDisk()
        syncToggleUi()
        handler.post(refreshRunnable)
    }

    override fun onPause() {
        handler.removeCallbacks(refreshRunnable)
        super.onPause()
    }

    private fun syncToggleUi() {
        val on = SosDebugLog.isEnabled()
        btnToggle.text = getString(if (on) R.string.debug_log_toggle_on else R.string.debug_log_toggle_off)
    }

    private fun render() {
        debugMeta.text = getString(
            R.string.debug_log_meta,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE,
            MainActivity.isHostAlive.toString(),
            MainActivity.isActivityAlive.toString(),
            BuildConfig.HAS_FCM.toString(),
            if (SosDebugLog.isEnabled()) "ON" else "OFF"
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
            Toast.makeText(this, err.message ?: "save failed", Toast.LENGTH_LONG).show()
        }
    }
}
