package com.sos010.app

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith

/**
 * S7A2 physical optical helper — launches Linked Devices UI (not exported to shell)
 * without paste/auto-start so the operator can use the real camera scanner.
 * Does not bypass confirmation or PhoneIssuer.
 */
@RunWith(AndroidJUnit4::class)
class SosLinkedDevicesCameraLaunchInstrumentedTest {
    @Test
    fun launchLinkedDevicesForOpticalScan() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(ctx, SosLinkedDevicesActivity::class.java)
        ActivityScenario.launch<SosLinkedDevicesActivity>(intent).use {
            // Keep activity alive for manual optical scan (~3 minutes).
            Thread.sleep(180_000L)
        }
    }
}
