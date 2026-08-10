package com.sos010.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

/**
 * שומר את ה-CPU/WebView ערים בזמן העברת קובץ P2P (רקע / מסך כבוי).
 * בלי זה Android מעכב JS ו-chunk-ack נתקע עד חזרה לפוקוס.
 */
object SosP2pTransferKeeper {
    private const val TAG = "SosP2pTransfer"
    private const val WAKE_MS = 10 * 60_000L
    private const val PUMP_MS = 1500L

    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeCount = AtomicInteger(0)
    @Volatile private var appRef: Context? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val pumpRunnable = object : Runnable {
        override fun run() {
            if (activeCount.get() <= 0) return
            try {
                MainActivity.pumpWebViewKeepAlive()
                acquireWake(appRef)
            } catch (err: Exception) {
                Log.w(TAG, "pump failed: ${err.message}")
            } finally {
                if (activeCount.get() > 0) {
                    mainHandler.postDelayed(this, PUMP_MS)
                }
            }
        }
    }

    fun setActive(context: Context, active: Boolean) {
        appRef = context.applicationContext
        if (active) {
            val prev = activeCount.getAndIncrement()
            Log.i(TAG, "transfer active count=${prev + 1}")
            acquireWake(context)
            SosForegroundService.start(context)
            if (prev == 0) {
                mainHandler.removeCallbacks(pumpRunnable)
                mainHandler.post(pumpRunnable)
            }
        } else {
            var next: Int
            while (true) {
                val cur = activeCount.get()
                if (cur <= 0) {
                    activeCount.set(0)
                    next = 0
                    break
                }
                if (activeCount.compareAndSet(cur, cur - 1)) {
                    next = cur - 1
                    break
                }
            }
            Log.i(TAG, "transfer idle count=$next")
            if (next <= 0) {
                mainHandler.removeCallbacks(pumpRunnable)
                releaseWake()
            }
        }
    }

    fun isActive(): Boolean = activeCount.get() > 0

    private fun acquireWake(context: Context?) {
        val ctx = context ?: appRef ?: return
        try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = wakeLock ?: pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "sos:p2p-file-transfer"
            ).also {
                it.setReferenceCounted(false)
                wakeLock = it
            }
            lock.acquire(WAKE_MS)
        } catch (err: Exception) {
            Log.w(TAG, "wake lock failed: ${err.message}")
        }
    }

    private fun releaseWake() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        wakeLock = null
    }
}
