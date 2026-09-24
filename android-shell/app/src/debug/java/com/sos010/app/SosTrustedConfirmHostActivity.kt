package com.sos010.app

import android.os.Bundle
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

/**
 * F6G.1 — Minimal host Activity for trusted confirmation instrumentation.
 * Isolated from MainActivity / R2 call UI WIP.
 */
class SosTrustedConfirmHostActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this).apply { id = android.R.id.content })
        SosNativeAdminConfirmationOrchestrator.attachActivity(this)
        if (savedInstanceState != null) {
            SosNativeAdminConfirmationOrchestrator.onActivityRecreation()
        }
    }

    override fun onPause() {
        super.onPause()
        try {
            SosNativeAdminConfirmationOrchestrator.onPause()
        } catch (_: Exception) {
        }
    }
}
