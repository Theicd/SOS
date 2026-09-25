package com.sos010.app

import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * F6J-R2-FIX1 — production-safe F6H release entry (Linked Devices / sealed migration).
 * High-level UX only. No K/nsec/export/signer bridge exposure.
 */
class SosSealedMigrationActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = SosIdentityMigrationCoordinator.Copy.ACTION_MIGRATE

        val root = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }
        root.addView(col)

        col.addView(
            TextView(this).apply {
                text = SosIdentityMigrationCoordinator.Copy.ACTION_MIGRATE
                textSize = 20f
            },
        )
        col.addView(
            TextView(this).apply {
                text = SosIdentityMigrationCoordinator.Copy.BODY_SAME_ACCOUNT
                textSize = 15f
                setPadding(0, 24, 0, 24)
            },
        )

        val account = try {
            SosSecureIdentityStore.normalizeHex(
                SosSecureIdentityStore.getPublicIdentityMetadata(applicationContext).pubkey,
            )
        } catch (_: Exception) {
            ""
        }
        val status = TextView(this).apply {
            textSize = 14f
            setPadding(0, 8, 0, 24)
        }
        if (!SosSecureIdentityStore.isHex64(account)) {
            status.text = "יש להתחבר לחשבון לפני העברה למכשיר מקושר."
        } else {
            val fp = account.take(4) + "…" + account.takeLast(4)
            status.text =
                "חשבון: $fp\n\nמכשירים מקושרים הזכאים לשחזור יופיעו כאן אחרי קישור מכשיר. " +
                    "העברה דורשת אישור חזק (F6G.3) ואז חותם זהות (F5B6) — בלי חשיפת מפתח."
        }
        col.addView(status)

        col.addView(
            Button(this).apply {
                text = "המשך לאישור חזק"
                isEnabled = SosSecureIdentityStore.isHex64(account)
                setOnClickListener {
                    // Entry reachable; strong-confirm host is launched only with a live ceremony.
                    // Without an authorized destination this remains a safe no-op UI step.
                    status.append("\n\nאין יעד מורשה פעיל כרגע. קשרו מכשיר ואז נסו שוב.")
                }
            },
        )
        col.addView(
            Button(this).apply {
                text = "סגור"
                setOnClickListener { finish() }
            },
        )
        setContentView(root)
    }
}
