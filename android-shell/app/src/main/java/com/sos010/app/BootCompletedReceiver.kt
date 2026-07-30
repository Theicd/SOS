package com.sos010.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * מפעיל מחדש את שירות הרקע אחרי בוט / עדכון אפליקציה.
 */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val allowed = action == Intent.ACTION_BOOT_COMPLETED ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
            action == Intent.ACTION_MY_PACKAGE_REPLACED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON"
        if (!allowed) return
        try {
            SosForegroundService.start(context.applicationContext)
        } catch (_: Exception) {
            SosForegroundService.scheduleRestart(context.applicationContext, 2000L)
        }
    }
}
