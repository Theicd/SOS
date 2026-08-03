package com.sos010.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.PowerManager
import android.util.Log

/**
 * ניגון צלצול/חיוג מקבצים שנארזו ב-APK (כמו WhatsApp).
 */
object CallSoundHelper {
    private const val TAG = "CallSoundHelper"
    @Volatile private var ringtonePlayer: MediaPlayer? = null
    @Volatile private var dialtonePlayer: MediaPlayer? = null
    @Volatile private var ringtoneWakeLock: PowerManager.WakeLock? = null
    @Volatile private var screenWakeLock: PowerManager.WakeLock? = null

    fun ringtoneUri(context: Context): Uri =
        Uri.parse("android.resource://${context.packageName}/${R.raw.sos_ringtone}")

    fun dialtoneUri(context: Context): Uri =
        Uri.parse("android.resource://${context.packageName}/${R.raw.sos_dialtone}")

    /** ניסיון להעיר מסך כשיש שיחה נכנסת (בנוסף ל-FullScreenIntent/CallStyle) | HYPER CORE TECH */
    @Suppress("DEPRECATION")
    fun wakeScreenBriefly(context: Context) {
        try {
            val app = context.applicationContext
            val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
            screenWakeLock?.let { lock ->
                try { if (lock.isHeld) lock.release() } catch (_: Exception) {}
            }
            val lock = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
                "sos:incoming_call_screen"
            )
            lock.setReferenceCounted(false)
            lock.acquire(8_000L)
            screenWakeLock = lock
        } catch (err: Exception) {
            Log.w(TAG, "wake screen failed: ${err.message}")
        }
    }

    @Synchronized
    fun startRingtone(context: Context) {
        stopDialtone()
        if (ringtonePlayer?.isPlaying == true) return
        stopRingtone()
        try {
            val app = context.applicationContext
            acquireRingtoneWakeLock(app)
            val player = MediaPlayer()
            player.isLooping = true
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setLegacyStreamType(AudioManager.STREAM_RING)
                    .build()
            )
            player.setDataSource(app, ringtoneUri(app))
            player.prepare()
            player.start()
            ringtonePlayer = player
            Log.i(TAG, "ringtone started")
        } catch (err: Exception) {
            Log.w(TAG, "ringtone fail: ${err.message}")
            stopRingtone()
        }
    }

    @Synchronized
    fun stopRingtone() {
        try {
            ringtonePlayer?.stop()
        } catch (_: Exception) {
        }
        try {
            ringtonePlayer?.release()
        } catch (_: Exception) {
        }
        ringtonePlayer = null
        releaseRingtoneWakeLock()
    }

    @Synchronized
    fun startDialtone(context: Context) {
        stopRingtone()
        if (dialtonePlayer?.isPlaying == true) return
        stopDialtone()
        try {
            val app = context.applicationContext
            val player = MediaPlayer()
            player.isLooping = true
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setLegacyStreamType(AudioManager.STREAM_VOICE_CALL)
                    .build()
            )
            player.setDataSource(app, dialtoneUri(app))
            player.prepare()
            player.start()
            dialtonePlayer = player
        } catch (err: Exception) {
            Log.w(TAG, "dialtone fail: ${err.message}")
            stopDialtone()
        }
    }

    @Synchronized
    fun stopDialtone() {
        try {
            dialtonePlayer?.stop()
        } catch (_: Exception) {
        }
        try {
            dialtonePlayer?.release()
        } catch (_: Exception) {
        }
        dialtonePlayer = null
    }

    @Synchronized
    fun stopAll() {
        stopRingtone()
        stopDialtone()
        try {
            screenWakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        screenWakeLock = null
    }

    private fun acquireRingtoneWakeLock(context: Context) {
        try {
            releaseRingtoneWakeLock()
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            val lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sos:ringtone")
            lock.setReferenceCounted(false)
            lock.acquire(65_000L)
            ringtoneWakeLock = lock
        } catch (_: Exception) {
        }
    }

    private fun releaseRingtoneWakeLock() {
        try {
            ringtoneWakeLock?.let { if (it.isHeld) it.release() }
        } catch (_: Exception) {
        }
        ringtoneWakeLock = null
    }
}
