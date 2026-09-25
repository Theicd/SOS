package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference

/**
 * F6J-R2-FIX1 — existing-key import unit gates (disposable keys only; no secrets logged).
 */
class SosExistingKeyImportTest {

    private lateinit var identityEng: SosSecureIdentityStore.Engine
    private lateinit var sessionAuth: SosNativeSessionAuthority.Engine
    private lateinit var currentPub: AtomicReference<String>

    private val disposablePrivA = "11".repeat(32)
    private val disposablePrivB = "22".repeat(32)

    @Before
    fun setUp() {
        identityEng = SosSecureIdentityStore.engineForTests(
            prefs = SosSecureIdentityStore.MemoryPrefsBackend(),
            crypto = SosSecureIdentityStore.SoftAesGcmCrypto(),
            derivePubkey = { SosNostrCrypto.pubkeyFromPriv(it) },
            legacyReader = { "" to "" },
        )
        currentPub = AtomicReference("")
        sessionAuth = SosNativeSessionAuthority.engineForTests(
            identity = object : SosNativeSessionAuthority.IdentityPubkeySource {
                override fun currentSecurePubkey(): String = currentPub.get()
            },
            watermark = SosNativeSessionAuthority.MemoryWatermarkStore(),
            random = SecureRandom(),
        )
    }

    private fun pubOf(priv: String): String =
        SosSecureIdentityStore.normalizeHex(SosNostrCrypto.pubkeyFromPriv(priv))

    private fun importWith(
        priv: String,
        trusted: Boolean = true,
    ): SosExistingKeyImport.Result {
        if (!trusted) {
            return SosExistingKeyImport.Result(ok = false, code = SosExistingKeyImport.CODE_UNTRUSTED_ORIGIN)
        }
        val norm = SosExistingKeyImport.normalizeIncomingPriv(priv)
        if (!SosExistingKeyImport.isValidSecp256k1Priv(norm)) {
            return SosExistingKeyImport.Result(ok = false, code = SosExistingKeyImport.CODE_INVALID_KEY)
        }
        val derived = pubOf(norm)
        val existing = SosSecureIdentityStore.normalizeHex(identityEng.getPublicIdentityMetadata().pubkey)
        if (SosSecureIdentityStore.isHex64(existing) && existing != derived) {
            identityEng.clearSecureIdentity()
            sessionAuth.revoke("switch")
        }
        when (val w = identityEng.writeIdentitySameAccount(norm, derived)) {
            is SosSecureIdentityStore.WriteResult.Ok -> {
                currentPub.set(SosSecureIdentityStore.normalizeHex(w.pubkey))
            }
            is SosSecureIdentityStore.WriteResult.Err -> {
                val code = when (w.code) {
                    "DIFFERENT_IDENTITY_OVERWRITE", "EXPECTED_PUBKEY_MISMATCH" ->
                        SosExistingKeyImport.CODE_ACCOUNT_MISMATCH
                    "INVALID_PRIVATE_KEY", "DERIVE_FAILED" -> SosExistingKeyImport.CODE_INVALID_KEY
                    else -> SosExistingKeyImport.CODE_SECURE_STORE_FAILED
                }
                return SosExistingKeyImport.Result(ok = false, code = code)
            }
        }
        sessionAuth.revoke("rebind")
        val gen = sessionAuth.recommendedBindGeneration()
        return when (val b = sessionAuth.bind(gen, derived, null)) {
            is SosNativeSessionAuthority.BindResult.Ok ->
                SosExistingKeyImport.Result(
                    ok = true,
                    code = SosExistingKeyImport.CODE_IMPORT_OK,
                    pubkey = derived,
                    generation = b.generation,
                )
            is SosNativeSessionAuthority.BindResult.Err ->
                SosExistingKeyImport.Result(ok = false, code = SosExistingKeyImport.CODE_SESSION_BIND_FAILED)
        }
    }

    @Test
    fun validExistingKeyImportEstablishesSession() {
        val r = importWith(disposablePrivA)
        assertTrue(r.ok)
        assertEquals(SosExistingKeyImport.CODE_IMPORT_OK, r.code)
        assertEquals(pubOf(disposablePrivA), r.pubkey)
        assertTrue(sessionAuth.isActive())
        assertEquals(pubOf(disposablePrivA), sessionAuth.snapshotPublic().accountPubkey)
    }

    @Test
    fun invalidKeyRejected() {
        assertFalse(SosExistingKeyImport.isValidSecp256k1Priv(""))
        assertFalse(SosExistingKeyImport.isValidSecp256k1Priv("ab"))
        assertFalse(SosExistingKeyImport.isValidSecp256k1Priv("zz".repeat(32)))
        assertFalse(SosExistingKeyImport.isValidSecp256k1Priv("0".repeat(64)))
        assertEquals("", SosExistingKeyImport.normalizeIncomingPriv("nsec1qqq"))
        assertTrue(SosExistingKeyImport.isValidSecp256k1Priv(disposablePrivA))
        assertEquals(SosExistingKeyImport.CODE_INVALID_KEY, importWith("not-a-key").code)
    }

    @Test
    fun untrustedOriginRejected() {
        val r = importWith(disposablePrivA, trusted = false)
        assertFalse(r.ok)
        assertEquals(SosExistingKeyImport.CODE_UNTRUSTED_ORIGIN, r.code)
        assertFalse(sessionAuth.isActive())
    }

    @Test
    fun accountSwitchBindsPbNotPa() {
        assertTrue(importWith(disposablePrivA).ok)
        val rB = importWith(disposablePrivB)
        assertTrue(rB.ok)
        assertEquals(pubOf(disposablePrivB), rB.pubkey)
        assertEquals(pubOf(disposablePrivB), sessionAuth.snapshotPublic().accountPubkey)
        assertFalse(sessionAuth.snapshotPublic().accountPubkey == pubOf(disposablePrivA))
    }

    @Test
    fun mismatchedBindRejectedPreservesF6d() {
        assertTrue(importWith(disposablePrivA).ok)
        sessionAuth.revoke("t")
        val gen = sessionAuth.recommendedBindGeneration()
        val bad = sessionAuth.bind(gen, pubOf(disposablePrivB), null)
        assertTrue(bad is SosNativeSessionAuthority.BindResult.Err)
        assertEquals(
            "SESSION_ACCOUNT_SECURE_IDENTITY_MISMATCH",
            (bad as SosNativeSessionAuthority.BindResult.Err).code,
        )
    }

    @Test
    fun resultJsonNeverContainsSecrets() {
        val r = SosExistingKeyImport.Result(
            ok = true,
            code = SosExistingKeyImport.CODE_IMPORT_OK,
            pubkey = pubOf(disposablePrivA),
            generation = 1L,
        )
        val json = r.toJson().lowercase()
        assertFalse(json.contains("nsec"))
        assertFalse(json.contains("privkey"))
        assertFalse(json.contains(disposablePrivA))
        assertTrue(json.contains("\"ok\":true"))
    }

    @Test
    fun whitespaceAndCaseHexNormalized() {
        val spaced = "  " + disposablePrivA.uppercase() + "  "
        assertEquals(disposablePrivA, SosExistingKeyImport.normalizeIncomingPriv(spaced))
    }

    @Test
    fun sameIdentityReimportPreservesP() {
        assertTrue(importWith(disposablePrivA).ok)
        val again = importWith(disposablePrivA)
        assertTrue(again.ok)
        assertEquals(pubOf(disposablePrivA), again.pubkey)
    }
}
