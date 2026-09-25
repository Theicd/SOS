package com.sos010.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * F6J-R2-FIX1 physical-friendly gates — no debug-only host Activity.
 * Disposable keys only. Never logs K/nsec.
 */
@RunWith(AndroidJUnit4::class)
class SosF6jR2Fix1ExistingKeyImportInstrumentedTest {

    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
    private val disposableA = "11".repeat(32)
    private val disposableB = "22".repeat(32)

    @Before
    fun clearIdentity() {
        SosSecureIdentityStore.clearSecureIdentity(ctx)
        SosNativeSessionAuthority.production(ctx).revoke("test_reset")
        SosSessionStore.clear(ctx)
    }

    @Test
    fun existingKeyImportBindsSessionAndPreservesP() {
        val expectedP = SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(disposableA))
        val r = SosExistingKeyImport.importExisting(
            context = ctx,
            privRaw = disposableA,
            trustedCaller = true,
        )
        assertTrue("import failed code=${r.code}", r.ok)
        assertEquals(SosExistingKeyImport.CODE_IMPORT_OK, r.code)
        assertEquals(expectedP, r.pubkey)
        assertTrue(SosNativeSessionAuthority.production(ctx).isActive())
        assertEquals(
            expectedP,
            SosNativeSessionAuthority.production(ctx).snapshotPublic().accountPubkey,
        )
        val meta = SosSecureIdentityStore.getPublicIdentityMetadata(ctx)
        assertEquals(expectedP, SosSecureIdentityStore.normalizeHex(meta.pubkey))
        val json = r.toJson().lowercase()
        assertFalse(json.contains("nsec"))
        assertFalse(json.contains(disposableA))
    }

    @Test
    fun untrustedRejected() {
        val r = SosExistingKeyImport.importExisting(
            context = ctx,
            privRaw = disposableA,
            trustedCaller = false,
        )
        assertFalse(r.ok)
        assertEquals(SosExistingKeyImport.CODE_UNTRUSTED_ORIGIN, r.code)
        assertFalse(SosSecureIdentityStore.getPublicIdentityMetadata(ctx).hasSecureIdentity)
    }

    @Test
    fun invalidKeyRejected() {
        val r = SosExistingKeyImport.importExisting(
            context = ctx,
            privRaw = "0".repeat(64),
            trustedCaller = true,
        )
        assertFalse(r.ok)
        assertEquals(SosExistingKeyImport.CODE_INVALID_KEY, r.code)
    }

    @Test
    fun accountSwitchAtoBNoAuthorityBleed() {
        assertTrue(
            SosExistingKeyImport.importExisting(ctx, disposableA, trustedCaller = true).ok,
        )
        val pA = SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(disposableA))
        val pB = SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(disposableB))
        val rB = SosExistingKeyImport.importExisting(ctx, disposableB, trustedCaller = true)
        assertTrue(rB.ok)
        assertEquals(pB, rB.pubkey)
        assertEquals(pB, SosNativeSessionAuthority.production(ctx).snapshotPublic().accountPubkey)
        assertFalse(SosNativeSessionAuthority.production(ctx).snapshotPublic().accountPubkey == pA)
    }

    @Test
    fun importSurvivesProcessRestartAuthorityRebind() {
        val expectedP = SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(disposableA))
        assertTrue(SosExistingKeyImport.importExisting(ctx, disposableA, trustedCaller = true).ok)
        // Simulate process death: capability is memory-only; secure identity remains.
        SosNativeSessionAuthority.production(ctx).revoke("simulate_process_death")
        assertFalse(SosNativeSessionAuthority.production(ctx).isActive())
        val meta = SosSecureIdentityStore.getPublicIdentityMetadata(ctx)
        assertEquals(expectedP, SosSecureIdentityStore.normalizeHex(meta.pubkey))
        // Rebind as inject/boot repair would.
        val auth = SosNativeSessionAuthority.production(ctx)
        val gen = auth.recommendedBindGeneration()
        val bind = auth.bind(gen, expectedP, null)
        assertTrue(bind is SosNativeSessionAuthority.BindResult.Ok)
        assertEquals(expectedP, (bind as SosNativeSessionAuthority.BindResult.Ok).accountPubkey)
    }
}
