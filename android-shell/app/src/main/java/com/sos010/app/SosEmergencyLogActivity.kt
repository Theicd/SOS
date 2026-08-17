package com.sos010.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * לוג זמן-אמת של שירות ממסר החירום + מתג לוג מעטפת (אותו דגל כמו SosDebugLog).
 * הממסר עצמו לא מתחיל כאן – רק במסך החירום בלחיצה. | HYPER CORE TECH
 */
class SosEmergencyLogActivity : AppCompatActivity() {

    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView
    private lateinit var btnToggle: Button
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
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0D1117.toInt())
            setPadding(24, 24, 24, 24)
        }
        btnToggle = Button(this).apply {
            text = toggleLabel()
            setOnClickListener {
                val next = !SosDebugLog.isEnabled()
                SosDebugLog.setEnabled(next)
                text = toggleLabel()
                Toast.makeText(
                    this@SosEmergencyLogActivity,
                    if (next) R.string.debug_log_enabled_toast else R.string.debug_log_disabled_toast,
                    Toast.LENGTH_SHORT
                ).show()
            }
        }
        val hint = TextView(this).apply {
            setTextColor(0xFF8B949E.toInt())
            textSize = 12f
            text = "לוג מעטפת (דיסק/רקע) נפרד מהממסר. ממסר נדלק רק ממסך החירום."
            setPadding(0, 8, 0, 12)
        }
        scroll = ScrollView(this).apply {
            setBackgroundColor(0xFF0D1117.toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }
        logView = TextView(this).apply {
            setTextColor(0xFF58A6FF.toInt())
            textSize = 12f
            typeface = android.graphics.Typeface.MONOSPACE
            text = "📡 לוג שירות ממסר חירום\n"
            gravity = Gravity.START
        }
        scroll.addView(logView)
        root.addView(btnToggle)
        root.addView(hint)
        root.addView(scroll)
        setContentView(root)
        title = "לוג ממסר חירום"
    }

    override fun onStart() {
        super.onStart()
        btnToggle.text = toggleLabel()
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

    private fun toggleLabel(): String =
        getString(if (SosDebugLog.isEnabled()) R.string.debug_log_toggle_on else R.string.debug_log_toggle_off)

    private fun append(line: String) {
        buffer.append(line).append('\n')
        if (buffer.length > 20000) buffer.delete(0, buffer.length - 12000)
        logView.text = buffer.toString()
        scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
    }
}
