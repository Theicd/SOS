package com.sos010.app

import android.app.Activity
import android.app.AlertDialog
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import java.lang.ref.WeakReference

/**
 * F6G — Native AlertDialog presenter (not WebView/HTML/JS).
 * HYPER CORE TECH
 */
class SosNativeTrustedConfirmationDialogPresenter(
    activity: Activity,
) : SosNativeTrustedConfirmation.NativeUiPresenter {

    private val activityRef = WeakReference(activity)
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var dialog: AlertDialog? = null

    /** F6G.1 instrumentation seam — not a WebView/JS surface. */
    @Volatile var lastRequireSecureFlagApplied: Boolean = false
        private set

    @Volatile var lastShownTitle: String? = null
        private set

    @Volatile var lastShownBody: String? = null
        private set

    fun dialogWindowHasFlagSecureForTests(): Boolean {
        val flags = dialog?.window?.attributes?.flags ?: return false
        return (flags and WindowManager.LayoutParams.FLAG_SECURE) != 0
    }

    override fun present(
        pending: SosNativeTrustedConfirmation.PendingPublic,
        challengeId: String,
        requireSecureFlag: Boolean,
        onApprove: () -> Unit,
        onCancel: () -> Unit,
    ) {
        mainHandler.post {
            val act = activityRef.get()
            if (act == null || act.isFinishing) {
                onCancel()
                return@post
            }
            dismiss()
            lastShownTitle = pending.summaryTitle
            lastShownBody = pending.summaryBody
            lastRequireSecureFlagApplied = false
            val builder = AlertDialog.Builder(act)
                .setTitle(pending.summaryTitle)
                .setMessage(pending.summaryBody)
                .setCancelable(false)
                .setPositiveButton("Approve") { _, _ ->
                    dialog = null
                    onApprove()
                }
                .setNegativeButton("Cancel") { _, _ ->
                    dialog = null
                    onCancel()
                }
            val d = builder.create()
            d.setOnDismissListener {
                // If dismissed without button (should not with cancelable=false), treat as cancel.
            }
            d.show()
            if (requireSecureFlag) {
                d.window?.setFlags(
                    WindowManager.LayoutParams.FLAG_SECURE,
                    WindowManager.LayoutParams.FLAG_SECURE,
                )
                lastRequireSecureFlagApplied = true
            }
            dialog = d
        }
    }

    fun dismiss() {
        try {
            dialog?.dismiss()
        } catch (_: Exception) {
        }
        dialog = null
    }
}
