package com.sos010.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * לוג זמן-אמת של שירות ממסר החירום | HYPER CORE TECH
 */
class SosEmergencyLogActivity : AppCompatActivity() {

    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView
    private val buffer = StringBuilder()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent == null) return
            val level = intent.getStringExtra("level") ?: "INFO"
            val message = intent.getStringExtra("message") ?: return
            runOnUiThread { append("[$level] $message") }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        scroll = ScrollView(this).apply {
            setBackgroundColor(0xFF0D1117.toInt())
            setPadding(24, 24, 24, 24)
        }
        logView = TextView(this).apply {
            setTextColor(0xFF58A6FF.toInt())
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            text = "📡 לוג שירות ממסר חירום\n"
        }
        scroll.addView(logView)
        setContentView(scroll)
        title = "לוג ממסר חירום"
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(SosEmergencyState.ACTION_LOG)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    override fun onStop() {
        try { unregisterReceiver(receiver) } catch (_: Exception) {}
        super.onStop()
    }

    private fun append(line: String) {
        buffer.append(line).append('\n')
        if (buffer.length > 20000) buffer.delete(0, buffer.length - 12000)
        logView.text = buffer.toString()
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
