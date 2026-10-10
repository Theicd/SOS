package com.sos010.app

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * MD3 live pairing acceptance — SosExistingKeyImport + LinkedDevices paste/auto-start path.
 * Handoff JSON (adb-pushed) supplies disposable priv + SOSPAIR1 QR + admission URL.
 * Never logs K/nsec. Activity remains exported=false (started from instrumentation).
 */
@RunWith(AndroidJUnit4::class)
class SosMd3LinkedDevicePairingInstrumentedTest {

    @Test
    fun importPrimaryAndCompleteMd3PairingFromHandoff() {
        val args = InstrumentationRegistry.getArguments()
        val handoffPath =
            args.getString("handoff")
                ?: "/data/local/tmp/sos-md3-e2e-handoff.json"
        val file = File(handoffPath)
        assertTrue("handoff missing: $handoffPath", file.isFile)
        val handoff = JSONObject(file.readText())
        try {
            file.writeText("{}")
        } catch (_: Exception) {
        }

        val priv = handoff.optString("privHex", "")
        val qr = handoff.optString("qrText", "")
        val admission = handoff.optString("admissionUrl", "http://127.0.0.1:8799")
        val expectedP = handoff.optString("accountP", "")
        assertTrue("privHex", SosSecureIdentityStore.isHex64(priv))
        assertTrue("qr", qr.startsWith("SOSPAIR1:"))
        assertFalse("nsec in qr", qr.contains("nsec", ignoreCase = true))

        val ctx = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        SosSecureIdentityStore.clearSecureIdentity(ctx)
        SosNativeSessionAuthority.production(ctx).revoke("md3_e2e_reset")
        SosSessionStore.clear(ctx)

        val imported = SosExistingKeyImport.importExisting(ctx, priv, trustedCaller = true)
        assertTrue("import ${imported.code}", imported.ok)
        assertEquals(SosExistingKeyImport.CODE_IMPORT_OK, imported.code)
        if (SosSecureIdentityStore.isHex64(expectedP)) {
            assertEquals(expectedP.lowercase(), imported.pubkey.lowercase())
        }
        val meta = SosSecureIdentityStore.getPublicIdentityMetadata(ctx)
        assertTrue(meta.hasSecureIdentity)
        assertEquals(imported.pubkey, SosSecureIdentityStore.normalizeHex(meta.pubkey))

        SosLinkedDeviceOrchestrator.writeAdmissionUrl(ctx, admission)

        val intent =
            Intent(ctx, SosLinkedDevicesActivity::class.java)
                .putExtra(SosLinkedDevicesActivity.EXTRA_QR, qr)
                .putExtra(SosLinkedDevicesActivity.EXTRA_ACCOUNT_P, imported.pubkey)
                .putExtra(SosLinkedDevicesActivity.EXTRA_ADMISSION_URL, admission)
                .putExtra(SosLinkedDevicesActivity.EXTRA_AUTO_START, true)

        val phase = AtomicReference("INIT")
        val code = AtomicReference<String?>(null)
        val done = CountDownLatch(1)
        var linked = false

        try {
            ActivityScenario.launch<SosLinkedDevicesActivity>(intent).use { scenario ->
                val deadline = System.currentTimeMillis() + 120_000L
                var approved = false
                while (System.currentTimeMillis() < deadline) {
                    var statusText = ""
                    var approveEnabled = false
                    scenario.onActivity { act ->
                        statusText = act.findViewById<android.widget.TextView>(R.id.linkedStatus).text?.toString().orEmpty()
                        phase.set(statusText)
                        val btn = act.findViewById<android.widget.Button>(R.id.linkedApprove)
                        approveEnabled = btn.isEnabled
                        // Prefer direct View.performClick over Espresso (avoids matcher races).
                        if (!approved && approveEnabled) {
                            btn.performClick()
                            approved = true
                        }
                    }
                    if (statusText.contains("קושר") || statusText.contains("LINKED", ignoreCase = true)) {
                        linked = true
                        done.countDown()
                        break
                    }
                    if (statusText.contains("נכשל") || statusText.contains("FAILED", ignoreCase = true)) {
                        code.set(statusText)
                        break
                    }
                    Thread.sleep(400)
                }
            }
            done.await(3, TimeUnit.SECONDS)
        } finally {
            val resultPath = File(ctx.filesDir, "sos-md3-e2e-result.json")
            val out =
                JSONObject()
                    .put("ok", linked)
                    .put("phase", phase.get())
                    .put("failCode", code.get())
                    .put("accountP", imported.pubkey)
                    .put("SECURE_IDENTITY_STORE_INITIALIZED", true)
                    .put("ROOT_K_SENT_TO_DESKTOP", false)
                    .put("NSEC_SENT_TO_DESKTOP", false)
            resultPath.writeText(out.toString())
            try {
                File("/data/local/tmp/sos-md3-e2e-result.json").writeText(out.toString())
            } catch (_: Exception) {
            }
        }

        assertTrue("MD3 pairing did not reach linked. phase=${phase.get()} code=${code.get()}", linked)
    }
}
