package com.sos010.app

import android.app.Application

class SosApp : Application() {
    override fun onCreate() {
        super.onCreate()
        SosDebugLog.init(this)
        SosDebugLog.i("app", "process start")
        // כל עליית תהליך – מוודאים ששירות הרקע רץ | HYPER CORE TECH
        try {
            SosForegroundService.start(this)
            SosDebugLog.i("app", "FGS start requested")
        } catch (err: Exception) {
            SosDebugLog.w("app", "FGS start failed: ${err.message}")
            SosForegroundService.scheduleRestart(this, 1500L)
        }
    }
}
