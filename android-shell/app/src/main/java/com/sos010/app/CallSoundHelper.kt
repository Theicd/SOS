package com.sos010.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.util.Log

/**
 * ניגון צלצול/חיוג מקבצים שנארזו ב-APK (כמו WhatsApp).
 */
object CallSoundHelper {
    private const val TAG = "CallSoundHelper"
    @Volatile private var ringtonePlayer: MediaPlayer? = null
    @Volatile private var dialtonePlayer: MediaPlayer? = null

    fun ringtoneUri(context: Context): Uri =
        Uri.parse("android.resource://${context.packageName}/${R.raw.sos_ringtone}")

    fun dialtoneUri(context: Context): Uri =
        Uri.parse("android.resource://${context.packageName}/${R.raw.sos_dialtone}")

    @Synchronized
    fun startRingtone(context: Context) {
        stopDialtone()
        if (ringtonePlayer?.isPlaying == true) return
        stopRingtone()
        try {
            val app = context.applicationContext
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
    }
}
