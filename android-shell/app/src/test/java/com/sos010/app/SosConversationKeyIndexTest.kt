package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.security.SecureRandom

/**
 * MD4 S2 — ConversationKeyIndex build/seal/open + security negatives.
 */
class SosConversationKeyIndexTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    private val rootPriv = "22".repeat(32)
    private lateinit var rootPub: String
    private lateinit var phoneIdentity: SosSecureIdentityStore.Engine
    private lateinit var desktopDevice: SosDeviceIdentityStore.Engine
    private lateinit var registry: SosDeviceAuthorizationRegistry

    @Before
    fun setUp() {
        rootPub = SosNostrCrypto.pubkeyFromPriv(rootPriv)
        phoneIdentity = SosSecureIdentityStore.engineForTests(
            prefs = SosSecureIdentityStore.MemoryPrefsBackend(),
            crypto = SosSecureIdentityStore.SoftAesGcmCrypto(),
            derivePubkey = { SosNostrCrypto.pubkeyFromPriv(it) },
        )
        assertTrue(
            phoneIdentity.writeIdentitySameAccount(rootPriv, rootPub)
                is SosSecureIdentityStore.WriteResult.Ok,
        )
        desktopDevice = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
        )
        registry = SosDeviceAuthorizationRegistry()
    }

    private fun session() = SosDeviceAuthorizationCeremony.SessionCtx(
        accountPubkey = rootPub,
        sessionValid = true,
        loggedIn = true,
    )

    private fun authorize(): SosDeviceAuthorization.Authorization {
        val ch = SosPairingSession.runLocalPairingWithChannel(desktopDevice, SosPairingSpentStore())
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(
            bound = ch.bound,
            session = session(),
            offerRecoveryDefault = false,
            deviceLabel = "DeskS2",
            sessionKey = ch.sessionKey,
            transcript = ch.transcript,
        ) as SosDeviceAuthorizationCeremony.Result.Ok
        assertTrue(issuer.confirmation().approveFromNativeUi(begin.challengeId!!))
        val signed = issuer.signAfterConfirm(session()) as SosDeviceAuthorizationCeremony.Result.Ok
        val dest = SosDeviceAuthorizationCeremony.DestinationAcceptor(desktopDevice)
        val accepted = dest.acceptAead(
            aeadJson = signed.outboundAeadJson!!,
            sessionKey = ch.sessionKey,
            transcript = ch.transcript,
            expectedAccountP = rootPub,
        ) as SosDeviceAuthorizationCeremony.Result.Ok
        val done = issuer.onDestinationAck(accepted.outboundAeadJson!!) as SosDeviceAuthorizationCeremony.Result.Ok
        return done.authorization!!
    }

    private fun peerPub(seedByte: Int): String {
        val priv = "%064x".format(seedByte.coerceAtLeast(1))
        return SosNostrCrypto.pubkeyFromPriv(priv)
    }

    private fun deskEncPriv(): ByteArray =
        desktopDevice.copyEncPrivateKeyForTests() ?: error("missing D_enc")

    @Test
    fun emptyIndexSealOpen() {
        val auth = authorize()
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity = phoneIdentity,
            auth = auth,
            peerPubs = emptyList(),
        ) as SosHistorySyncExporter.Result.Ok
        assertEquals(1, export.value.pages.size)
        assertEquals(0, export.value.pages[0].entryCount)
        assertTrue(SosHistorySyncExporter.publicJsonLooksSafe(export.value.toPublicJson().toString()))

        val opened = SosConversationKeyIndex.openSealed(
            pkg = export.value.pages[0].seal,
            dEncPriv = deskEncPriv(),
            expectAccountP = auth.accountP,
            expectDeviceId = auth.deviceId,
            expectDEncPub = auth.dEncPub,
            spentExportSessions = emptySet(),
            authExpiresAt = auth.expiresAt,
        )
        assertTrue(opened.isSuccess)
        assertEquals(0, opened.getOrThrow().entries.size)
    }

    @Test
    fun singleAndMultiPeerDeterministic() {
        val auth = authorize()
        val p1 = peerPub(0xaa)
        val p2 = peerPub(0xbb)
        val p3 = peerPub(0xcc)
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity = phoneIdentity,
            auth = auth,
            peerPubs = listOf(p2, p1, p3),
        ) as SosHistorySyncExporter.Result.Ok
        val opened = SosConversationKeyIndex.openSealed(
            pkg = export.value.pages[0].seal,
            dEncPriv = deskEncPriv(),
            expectAccountP = auth.accountP,
            expectDeviceId = auth.deviceId,
            expectDEncPub = auth.dEncPub,
            spentExportSessions = emptySet(),
            authExpiresAt = auth.expiresAt,
        ).getOrThrow()
        assertEquals(3, opened.entries.size)
        assertEquals(listOf(p1, p2, p3).sorted(), opened.entries.map { it.peerP })
        val expectCk = SosNostrCrypto.nip44ConversationKey(rootPriv, p1)!!
        assertEquals(Hex.encode(expectCk), opened.entries.first { it.peerP == p1 }.conversationKeyHex)
        expectCk.fill(0)
    }

    @Test
    fun nip44ReferenceVectorEntry() {
        val text = javaClass.classLoader.getResourceAsStream("nip44.vectors.json")!!
            .bufferedReader().readText()
        val row = JSONObject(text).getJSONObject("v2").getJSONObject("valid")
            .getJSONArray("get_conversation_key").getJSONObject(0)
        val sec1 = row.getString("sec1")
        val pub2 = row.getString("pub2")
        val expect = row.getString("conversation_key")
        val accountP = SosNostrCrypto.pubkeyFromPriv(sec1)
        val built = SosConversationKeyIndex.buildEntries(sec1, accountP, listOf(pub2)).getOrThrow()
        assertEquals(1, built.size)
        assertEquals(expect, built[0].conversationKeyHex)
    }

    @Test
    fun paginationBoundedDeterministic() {
        val peers = (1..20).map { peerPub(it) }
        val entries = SosConversationKeyIndex.buildEntries(rootPriv, rootPub, peers).getOrThrow()
        val pages = SosConversationKeyIndex.paginate(entries, pageSize = 7)
        assertEquals(3, pages.size)
        assertEquals(7, pages[0].size)
        assertEquals(7, pages[1].size)
        assertEquals(6, pages[2].size)
        assertEquals(entries.map { it.peerP }, pages.flatten().map { it.peerP })
    }

    @Test
    fun wrongDencFails() {
        val auth = authorize()
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity = phoneIdentity,
            auth = auth,
            peerPubs = listOf(peerPub(0xdd)),
        ) as SosHistorySyncExporter.Result.Ok
        val other = SosX25519.generateKeyPair()
        val opened = SosConversationKeyIndex.openSealed(
            pkg = export.value.pages[0].seal,
            dEncPriv = other.first,
            expectAccountP = auth.accountP,
            expectDeviceId = auth.deviceId,
            expectDEncPub = auth.dEncPub,
            spentExportSessions = emptySet(),
        )
        assertTrue(opened.isFailure)
    }

    @Test
    fun wrongAccountDeviceEpochExpiryReplayAead() {
        val auth = authorize()
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity = phoneIdentity,
            auth = auth,
            peerPubs = listOf(peerPub(0xee)),
        ) as SosHistorySyncExporter.Result.Ok
        val seal = export.value.pages[0].seal
        val dEnc = deskEncPriv()

        assertTrue(
            SosConversationKeyIndex.openSealed(
                seal, dEnc, "11".repeat(32), auth.deviceId, auth.dEncPub, emptySet(),
            ).isFailure,
        )
        assertTrue(
            SosConversationKeyIndex.openSealed(
                seal, dEnc, auth.accountP, "11".repeat(32), auth.dEncPub, emptySet(),
            ).isFailure,
        )
        assertTrue(
            SosConversationKeyIndex.openSealed(
                seal, dEnc, auth.accountP, auth.deviceId, auth.dEncPub, emptySet(),
                minAuthEpoch = auth.authEpoch + 1,
            ).isFailure,
        )
        assertTrue(
            SosConversationKeyIndex.openSealed(
                seal, dEnc, auth.accountP, auth.deviceId, auth.dEncPub, emptySet(),
                authExpiresAt = System.currentTimeMillis() - 1000,
            ).isFailure,
        )
        val ok1 = SosConversationKeyIndex.openSealed(
            seal, dEnc, auth.accountP, auth.deviceId, auth.dEncPub, emptySet(),
            authExpiresAt = auth.expiresAt,
        )
        assertTrue(ok1.isSuccess)
        val replay = SosConversationKeyIndex.openSealed(
            seal, dEnc, auth.accountP, auth.deviceId, auth.dEncPub,
            setOf(seal.exportSessionId),
            authExpiresAt = auth.expiresAt,
        )
        assertEquals("REPLAY_EXPORT_SESSION", replay.exceptionOrNull()?.message)

        val bad = seal.copy(ctB64 = seal.ctB64.dropLast(4) + "AAAA")
        assertTrue(
            SosConversationKeyIndex.openSealed(
                bad, dEnc, auth.accountP, auth.deviceId, auth.dEncPub, emptySet(),
                authExpiresAt = auth.expiresAt,
            ).isFailure,
        )
    }

    @Test
    fun duplicatePeerAndOversizedRejected() {
        val p = peerPub(0xff)
        val dup = SosConversationKeyIndex.buildEntries(rootPriv, rootPub, listOf(p, p))
        assertTrue(dup.isFailure)
        assertEquals("DUPLICATE_PEER", dup.exceptionOrNull()?.message)

        val distinct = (1..SosConversationKeyIndex.MAX_ENTRIES_HARD + 1).map { peerPub(it) }
        val big = SosConversationKeyIndex.buildEntries(rootPriv, rootPub, distinct)
        assertTrue(big.isFailure)
        assertEquals("INDEX_TOO_LARGE", big.exceptionOrNull()?.message)
    }

    @Test
    fun malformedSchemaRejected() {
        val bad = """{"schema":"evil","entries":[]}""".toByteArray()
        assertTrue(SosConversationKeyIndex.parseIndex(bad).isFailure)
    }

    @Test
    fun exporterAuthNegatives() {
        val auth = authorize()
        val noHist = SosDeviceAuthorization.signUnderRoot(
            rootPriv,
            auth.copy(
                capabilities = auth.capabilities - SosDeviceAuthorization.Capability.DEVICE_HISTORY_SYNC,
                rootSignatureHex = "",
            ),
        )
        val r1 = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, noHist, listOf(peerPub(0x11)))
        assertTrue(r1 is SosHistorySyncExporter.Result.Err)
        assertEquals("MISSING_DEVICE_HISTORY_SYNC", (r1 as SosHistorySyncExporter.Result.Err).code)

        val forged = auth.copy(rootSignatureHex = "ab".repeat(64))
        val r2 = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, forged, emptyList())
        assertTrue(r2 is SosHistorySyncExporter.Result.Err)

        val now = System.currentTimeMillis()
        val expired = SosDeviceAuthorization.signUnderRoot(
            rootPriv,
            auth.copy(
                createdAt = now - 86_400_000L,
                expiresAt = now - 1000L,
                rootSignatureHex = "",
            ),
        )
        val r3 = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, expired, emptyList())
        assertTrue(r3 is SosHistorySyncExporter.Result.Err)
        assertEquals("EXPIRED", (r3 as SosHistorySyncExporter.Result.Err).code)

        val r4 = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity, auth, emptyList(),
            expectPairingTranscriptHash = "11".repeat(32),
        )
        assertTrue(r4 is SosHistorySyncExporter.Result.Err)
        assertEquals("PAIRING_TRANSCRIPT_MISMATCH", (r4 as SosHistorySyncExporter.Result.Err).code)

        val r5 = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity, auth, emptyList(), revoked = true,
        )
        assertTrue(r5 is SosHistorySyncExporter.Result.Err)
        assertEquals("REVOKED", (r5 as SosHistorySyncExporter.Result.Err).code)

        val r6 = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity, auth, emptyList(), minAuthEpoch = auth.authEpoch + 5,
        )
        assertTrue(r6 is SosHistorySyncExporter.Result.Err)
        assertEquals("AUTH_EPOCH_MISMATCH", (r6 as SosHistorySyncExporter.Result.Err).code)
    }

    @Test
    fun dEncSubstitutionWrongDesktopCannotOpen() {
        val auth = authorize()
        val swapped = SosDeviceAuthorization.signUnderRoot(
            rootPriv,
            auth.copy(dEncPub = "33".repeat(32), rootSignatureHex = ""),
        )
        val export = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, swapped, emptyList())
        assertTrue(export is SosHistorySyncExporter.Result.Ok)
        val opened = SosConversationKeyIndex.openSealed(
            (export as SosHistorySyncExporter.Result.Ok).value.pages[0].seal,
            deskEncPriv(),
            auth.accountP,
            auth.deviceId,
            auth.dEncPub,
            emptySet(),
        )
        assertTrue(opened.isFailure)
    }

    @Test
    fun writeCrossRuntimeFixture() {
        val auth = authorize()
        val peer = peerPub(0xa1)
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity = phoneIdentity,
            auth = auth,
            peerPubs = listOf(peer),
        ) as SosHistorySyncExporter.Result.Ok
        val dEncPriv = deskEncPriv()
        val fixtureDir = File("../../qa/.md4-s2-fixtures").canonicalFile
        fixtureDir.mkdirs()
        val ck = SosNostrCrypto.nip44ConversationKey(rootPriv, peer)!!
        val o = JSONObject()
            .put("accountP", auth.accountP)
            .put("deviceId", auth.deviceId)
            .put("D_enc_pub", auth.dEncPub)
            .put("D_sign_pub", auth.dSignPub)
            .put("dEncPrivHex", Hex.encode(dEncPriv))
            .put("authorization", auth.toPublicJson())
            .put("seal", export.value.pages[0].seal.toPublicJson())
            .put("expectPeer", peer)
            .put("expectCk", Hex.encode(ck))
            .put("ROOT_K", JSONObject.NULL)
            .put("note", "controlled S2 fixture; dEncPrivHex not for production storage")
        File(fixtureDir, "android-sealed-cki.json").writeText(o.toString(2))
        assertTrue(File(fixtureDir, "android-sealed-cki.json").isFile)
        assertTrue(SosHistorySyncExporter.publicJsonLooksSafe(export.value.toPublicJson().toString()))
        assertFalse(export.value.toPublicJson().toString().contains(rootPriv))
        ck.fill(0)
    }

    @Test
    fun publicExportNeverContainsRootOrPlainKeys() {
        val auth = authorize()
        val export = SosHistorySyncExporter.exportSealedIndex(
            phoneIdentity, auth, listOf(peerPub(0xb2), peerPub(0xc3)),
        ) as SosHistorySyncExporter.Result.Ok
        val json = export.value.toPublicJson().toString()
        assertTrue(SosHistorySyncExporter.publicJsonLooksSafe(json))
        assertFalse(json.contains(rootPriv))
        assertFalse(json.contains("conversationKey"))
    }

    @Test
    fun reusedNonceDifferentSessionsStillDistinctPackages() {
        // Nonce uniqueness: two exports must not share exportSessionId; same IV reuse across seals is random.
        val auth = authorize()
        val a = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, auth, listOf(peerPub(1)))
            as SosHistorySyncExporter.Result.Ok
        val b = SosHistorySyncExporter.exportSealedIndex(phoneIdentity, auth, listOf(peerPub(1)))
            as SosHistorySyncExporter.Result.Ok
        assertTrue(a.value.exportSessionId != b.value.exportSessionId)
        assertTrue(a.value.pages[0].seal.indexNonce != b.value.pages[0].seal.indexNonce)
        assertTrue(a.value.pages[0].seal.ivB64 != b.value.pages[0].seal.ivB64)
    }
}
