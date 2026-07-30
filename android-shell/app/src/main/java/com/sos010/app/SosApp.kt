package com.sos010.app

import android.app.Application

class SosApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // כל עליית תהליך – מוודאים ששירות הרקע רץ | HYPER CORE TECH
        try {
            SosForegroundService.start(this)
        } catch (_: Exception) {
            SosForegroundService.scheduleRestart(this, 1500L)
        }
    }
}
