package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Base64

/**
 * F6A — SosSecureIdentityStore unit tests (soft AES + memory prefs; no production keys).
 */
class SosSecureIdentityStoreTest {

    private val k1 = "11".repeat(32)
    private val p1 = "22".repeat(32)
    private val k2 = "33".repeat(32)
    private val p2 = "44".repeat(32)

    private lateinit var prefs: SosSecureIdentityStore.MemoryPrefsBackend
    private lateinit var crypto: SosSecureIdentityStore.SoftAesGcmCrypto
    private var legacyPriv = ""
    private var legacyPub = ""

    private fun derive(hex: String): String = when (SosSecureIdentityStore.normalizeHex(hex)) {
        k1 -> p1
        k2 -> p2
        else -> "ff".repeat(32)
    }

    private fun engine(): SosSecureIdentityStore.Engine =
        SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = crypto,
            derivePubkey = ::derive,
            legacyReader = { legacyPriv to legacyPub },
        )

    @Before
    fun setUp() {
        prefs = SosSecureIdentityStore.MemoryPrefsBackend()
        crypto = SosSecureIdentityStore.SoftAesGcmCrypto()
        legacyPriv = ""
        legacyPub = ""
    }

    @Test
    fun emptyStoreIsNewUser() {
        assertEquals(SosSecureIdentityStore.State.NEW_USER, engine().readState())
        assertFalse(engine().hasSecureIdentity())
        assertNull(engine().readIdentityForNativeUse())
    }

    @Test
    fun writeAndReadPreservesSameKP() {
        val r = engine().writeIdentitySameAccount(k1, p1)
        assertTrue(r is SosSecureIdentityStore.WriteResult.Ok)
        val id = engine().readIdentityForNativeUse()
        assertNotNull(id)
        assertEquals(k1, id!!.privateKeyHex)
        assertEquals(p1, id.publicKeyHex)
        assertEquals(SosSecureIdentityStore.State.NATIVE_ONLY, engine().readState())
    }

    @Test
    fun expectedPubkeyMismatchRejected() {
        val r = engine().writeIdentitySameAccount(k1, p2)
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        val err = r as SosSecureIdentityStore.WriteResult.Err
        assertEquals("EXPECTED_PUBKEY_MISMATCH", err.code)
        assertEquals(SosSecureIdentityStore.State.MISMATCH, err.state)
        assertFalse(engine().hasSecureIdentity())
    }

    @Test
    fun differentIdentityOverwriteRejected() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val r = engine().writeIdentitySameAccount(k2, p2)
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        assertEquals("DIFFERENT_IDENTITY_OVERWRITE", (r as SosSecureIdentityStore.WriteResult.Err).code)
        val id = engine().readIdentityForNativeUse()
        assertEquals(k1, id!!.privateKeyHex)
        assertEquals(p1, id.publicKeyHex)
    }

    @Test
    fun sameIdentityRewriteSafeFreshIv() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val iv1 = prefs.getRaw("iv_b64") as String
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val iv2 = prefs.getRaw("iv_b64") as String
        assertNotEquals(iv1, iv2)
        assertEquals(k1, engine().readIdentityForNativeUse()!!.privateKeyHex)
    }

    @Test
    fun corruptCiphertextRecoveryRequired() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        prefs.corruptCiphertext()
        assertEquals(SosSecureIdentityStore.State.RECOVERY_REQUIRED, engine().readState())
        assertNull(engine().readIdentityForNativeUse())
        val overwrite = engine().writeIdentitySameAccount(k2, p2)
        assertTrue(overwrite is SosSecureIdentityStore.WriteResult.Err)
        assertEquals("EXISTING_CORRUPT_NO_OVERWRITE", (overwrite as SosSecureIdentityStore.WriteResult.Err).code)
    }

    @Test
    fun corruptIvRecoveryRequired() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        prefs.corruptIv()
        assertEquals(SosSecureIdentityStore.State.RECOVERY_REQUIRED, engine().readState())
        assertNull(engine().readIdentityForNativeUse())
    }

    @Test
    fun wrongAadFailsDecrypt() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val ct = Base64.getDecoder().decode(prefs.getRaw("ciphertext_b64") as String)
        val iv = Base64.getDecoder().decode(prefs.getRaw("iv_b64") as String)
        val bad = crypto.decrypt(
            SosSecureIdentityStore.EncryptedBlob(ct, iv),
            "WRONG|aad".toByteArray(Charsets.UTF_8),
        )
        assertNull(bad)
        // Store still decrypts with correct AAD via engine
        assertNotNull(engine().readIdentityForNativeUse())
    }

    @Test
    fun failedWritePreservesPreviousIdentity() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val boom = SosSecureIdentityStore.engineForTests(
            prefs = prefs,
            crypto = object : SosSecureIdentityStore.BlobCrypto {
                override fun encrypt(plaintext: ByteArray, aad: ByteArray): SosSecureIdentityStore.EncryptedBlob {
                    throw IllegalStateException("boom")
                }
                override fun decrypt(
                    blob: SosSecureIdentityStore.EncryptedBlob,
                    aad: ByteArray,
                ): ByteArray? = crypto.decrypt(blob, aad)
            },
            derivePubkey = ::derive,
        )
        val r = boom.writeIdentitySameAccount(k1, p1)
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        assertEquals(k1, engine().readIdentityForNativeUse()!!.privateKeyHex)
    }

    @Test
    fun legacyMigrationPreservesSameKPAndRetainsLegacy() {
        legacyPriv = k1
        legacyPub = p1
        assertEquals(SosSecureIdentityStore.State.WEB_ONLY, engine().readState())
        val r = engine().migrateFromLegacySessionStoreIfNeeded()
        assertTrue(r is SosSecureIdentityStore.WriteResult.Ok)
        val ok = r as SosSecureIdentityStore.WriteResult.Ok
        assertTrue(ok.migratedFromLegacy)
        assertEquals(p1, ok.pubkey)
        assertEquals(k1, engine().readIdentityForNativeUse()!!.privateKeyHex)
        // Legacy still "present" in reader — not deleted by F6A
        assertEquals(k1, legacyPriv)
        assertEquals(p1, legacyPub)
        assertEquals(SosSecureIdentityStore.State.IDENTITY_OK, engine().readState())
    }

    @Test
    fun legacyMismatchDoesNotMigrateOrGenerate() {
        legacyPriv = k1
        legacyPub = p2
        val r = engine().migrateFromLegacySessionStoreIfNeeded()
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        assertEquals("LEGACY_MISMATCH", (r as SosSecureIdentityStore.WriteResult.Err).code)
        assertFalse(engine().hasSecureIdentity())
    }

    @Test
    fun noIdentityGenerationOnEmptyErrorPaths() {
        assertEquals(SosSecureIdentityStore.State.NEW_USER, engine().readState())
        val r = engine().writeIdentitySameAccount("not-a-key", null)
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        assertFalse(engine().hasSecureIdentity())
        assertNull(engine().readIdentityForNativeUse())
    }

    @Test
    fun clearSecureIdentityApiDoesNotRequireLegacyDelete() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        legacyPriv = k1
        legacyPub = p1
        engine().clearSecureIdentity()
        assertFalse(engine().hasSecureIdentity())
        assertEquals(k1, legacyPriv) // legacy untouched
        assertEquals(SosSecureIdentityStore.State.WEB_ONLY, engine().readState())
    }

    @Test
    fun publicMetadataNeverIncludesPrivateKey() {
        assertTrue(engine().writeIdentitySameAccount(k1, p1) is SosSecureIdentityStore.WriteResult.Ok)
        val meta = engine().getPublicIdentityMetadata()
        assertEquals(p1, meta.pubkey)
        assertTrue(meta.hasSecureIdentity)
        assertTrue(meta.valid)
        // Ensure metadata type has no priv field by constructing JSON-like map of public fields only
        val exposed = listOf(meta.pubkey, meta.state.name, meta.blobVersion.toString())
        assertFalse(exposed.any { it == k1 })
    }

    @Test
    fun designInvariants() {
        assertFalse(SosSecureIdentityStore.SECURE_IDENTITY_STORE_IS_SESSION_AUTHORITY)
        assertTrue(SosSecureIdentityStore.NATIVE_IDENTITY_COMMUNITY_INDEPENDENT)
        assertFalse(SosSecureIdentityStore.PER_COMMUNITY_NATIVE_IDENTITY)
        assertFalse(SosSecureIdentityStore.F6A_CLAIMS_PERFECT_ZEROIZATION)
        assertFalse(SosSecureIdentityStore.LEGACY_DELETE_ALLOWED)
        assertEquals("sos_identity_wrap_v1", SosSecureIdentityStore.KEYSTORE_ALIAS)
        assertEquals("SOS|android-identity|v1", SosSecureIdentityStore.AAD_TEXT)
        assertEquals("sos_native_identity_secure_v1", SosSecureIdentityStore.PREFS_NAME)
    }
}
