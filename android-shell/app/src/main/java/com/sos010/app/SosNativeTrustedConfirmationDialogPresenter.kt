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
