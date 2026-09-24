package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

/**
 * MD3 — DeviceAuthorization ceremony unit tests (disposable identities only).
 */
class SosDeviceAuthorizationTest {

    companion object {
        @JvmStatic
        @BeforeClass
        fun loadSecp() {
            val dll = java.io.File("build/native/secp256k1-jni.dll")
            if (dll.isFile) System.load(dll.absolutePath)
        }
    }

    private val rootPriv = "11".repeat(32)
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

    private fun pairChannel() =
        SosPairingSession.runLocalPairingWithChannel(desktopDevice, SosPairingSpentStore())

    private fun authorizeFull(
        offerRecovery: Boolean = true,
        label: String = "Desk",
    ): SosDeviceAuthorization.Authorization {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(
            bound = ch.bound,
            session = session(),
            offerRecoveryDefault = offerRecovery,
            deviceLabel = label,
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
        assertEquals(SosDeviceAuthorizationCeremony.Phase.LINKED_AUTHORIZED, done.phase)
        assertEquals(1, issuer.rootSignCount())
        return done.authorization!!
    }

    @Test
    fun happyPathLinkedAuthorized() {
        val auth = authorizeFull()
        assertEquals(SosDeviceAuthorization.VERSION, auth.version)
        assertTrue(SosDeviceAuthorization.Capability.DEVICE_CHAT in auth.capabilities)
        assertTrue(SosDeviceAuthorization.Capability.DEVICE_RECOVERY in auth.capabilities)
        assertFalse(SosDeviceAuthorization.Capability.DEVICE_ADMIN in auth.capabilities)
        assertEquals(1, registry.activeCount(rootPub))
        assertEquals(
            SosDeviceAuthorization.VerifyResult.Ok,
            SosDeviceAuthorization.verifyStrict(auth),
        )
    }

    @Test
    fun softwareOnlyCannotGetRecovery() {
        val softDesktop = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftAesGcmCrypto(), // SOFTWARE_ONLY
        )
        val ch = SosPairingSession.runLocalPairingWithChannel(softDesktop)
        assertFalse(ch.bound.recoveryEligible)
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session(), offerRecoveryDefault = true)
        // Without recovery in caps when not eligible — begin should succeed with normal profile only
        assertTrue(begin is SosDeviceAuthorizationCeremony.Result.Ok)
        val draft = (begin as SosDeviceAuthorizationCeremony.Result.Ok).authorization!!
        assertFalse(SosDeviceAuthorization.Capability.DEVICE_RECOVERY in draft.capabilities)
    }

    @Test
    fun fifthDeviceRejected() {
        repeat(4) {
            val d = SosDeviceIdentityStore.engineForTests(
                SosDeviceIdentityStore.MemoryPrefsBackend(),
                SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
            )
            desktopDevice = d
            authorizeFull(label = "D$it")
        }
        assertEquals(4, registry.activeCount(rootPub))
        val d5 = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
        )
        val ch = SosPairingSession.runLocalPairingWithChannel(d5)
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
            as SosDeviceAuthorizationCeremony.Result.Ok
        issuer.confirmation().approveFromNativeUi(begin.challengeId!!)
        val signed = issuer.signAfterConfirm(session()) as SosDeviceAuthorizationCeremony.Result.Ok
        val dest = SosDeviceAuthorizationCeremony.DestinationAcceptor(d5)
        val accepted = dest.acceptAead(signed.outboundAeadJson!!, ch.sessionKey, ch.transcript, rootPub)
            as SosDeviceAuthorizationCeremony.Result.Ok
        val done = issuer.onDestinationAck(accepted.outboundAeadJson!!)
        assertTrue(done is SosDeviceAuthorizationCeremony.Result.Err)
        assertEquals("MAX_LINKED_DEVICES", (done as SosDeviceAuthorizationCeremony.Result.Err).code)
    }

    @Test
    fun sameDeviceReauthReplacesSlot() {
        val auth1 = authorizeFull(label = "Desk")
        assertEquals(1, registry.activeCount(rootPub))
        // New pairing same desktop device identity
        val ch = SosPairingSession.runLocalPairingWithChannel(desktopDevice)
        assertEquals(auth1.deviceId, ch.bound.deviceId)
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
            as SosDeviceAuthorizationCeremony.Result.Ok
        issuer.confirmation().approveFromNativeUi(begin.challengeId!!)
        val signed = issuer.signAfterConfirm(session()) as SosDeviceAuthorizationCeremony.Result.Ok
        val dest = SosDeviceAuthorizationCeremony.DestinationAcceptor(desktopDevice)
        val accepted = dest.acceptAead(signed.outboundAeadJson!!, ch.sessionKey, ch.transcript, rootPub)
            as SosDeviceAuthorizationCeremony.Result.Ok
        val done = issuer.onDestinationAck(accepted.outboundAeadJson!!) as SosDeviceAuthorizationCeremony.Result.Ok
        assertEquals(1, registry.activeCount(rootPub))
        assertTrue(done.authorization!!.authorizationId != auth1.authorizationId)
    }

    @Test
    fun accountMismatchRejected() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val bad = issuer.beginFromBound(
            ch.bound,
            SosDeviceAuthorizationCeremony.SessionCtx("22".repeat(32), sessionValid = true),
        )
        assertTrue(bad is SosDeviceAuthorizationCeremony.Result.Err)
        assertEquals("ACCOUNT_MISMATCH", (bad as SosDeviceAuthorizationCeremony.Result.Err).code)
    }

    @Test
    fun cancelBeforeSignNoActive() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
        issuer.cancel()
        assertEquals(0, registry.activeCount(rootPub))
        assertEquals(SosDeviceAuthorizationCeremony.Phase.CANCELLED, issuer.phase())
    }

    @Test
    fun cancelAfterSignNoActive() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
            as SosDeviceAuthorizationCeremony.Result.Ok
        issuer.confirmation().approveFromNativeUi(begin.challengeId!!)
        issuer.signAfterConfirm(session())
        issuer.cancel()
        assertEquals(0, registry.activeCount(rootPub))
    }

    @Test
    fun tamperedCapabilitiesFailVerify() {
        val auth = authorizeFull()
        val o = auth.toPublicJson()
        val caps = o.getJSONArray("capabilities")
        caps.put(SosDeviceAuthorization.Capability.DEVICE_ADMIN.name)
        val tampered = SosDeviceAuthorization.Authorization.fromJson(o)
        val v = SosDeviceAuthorization.verifyStrict(tampered)
        assertTrue(v is SosDeviceAuthorization.VerifyResult.Err)
    }

    @Test
    fun tamperedEpochFailsSignature() {
        val auth = authorizeFull()
        val tampered = auth.copy(authEpoch = 99L)
        val v = SosDeviceAuthorization.verifyRootSignature(tampered)
        assertEquals(SosDeviceAuthorization.VerifyResult.Err("BAD_SIGNATURE"), v)
    }

    @Test
    fun expiredRejected() {
        val auth = authorizeFull()
        val v = SosDeviceAuthorization.verifyStrict(auth, nowMs = auth.expiresAt + 1)
        assertEquals(SosDeviceAuthorization.VerifyResult.Err("EXPIRED"), v)
    }

    @Test
    fun pairingConsumedOnce() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
            as SosDeviceAuthorizationCeremony.Result.Ok
        issuer.confirmation().approveFromNativeUi(begin.challengeId!!)
        val signed = issuer.signAfterConfirm(session()) as SosDeviceAuthorizationCeremony.Result.Ok
        val dest = SosDeviceAuthorizationCeremony.DestinationAcceptor(desktopDevice)
        val accepted = dest.acceptAead(signed.outboundAeadJson!!, ch.sessionKey, ch.transcript, rootPub)
            as SosDeviceAuthorizationCeremony.Result.Ok
        issuer.onDestinationAck(accepted.outboundAeadJson!!)
        val again = issuer.beginFromBound(ch.bound, session(), sessionKey = ch.sessionKey, transcript = ch.transcript)
        assertTrue(again is SosDeviceAuthorizationCeremony.Result.Err)
        assertEquals("PAIRING_ALREADY_CONSUMED", (again as SosDeviceAuthorizationCeremony.Result.Err).code)
    }

    @Test
    fun destinationRejectsOtherDeviceAuth() {
        val auth = authorizeFull()
        val other = SosDeviceIdentityStore.engineForTests(
            SosDeviceIdentityStore.MemoryPrefsBackend(),
            SosDeviceIdentityStore.SoftPlatformBoundAesGcmCrypto(),
        )
        other.createOrGet()
        val meta = other.getPublicMetadata()!!
        val v = SosDeviceAuthorization.verifyForDestination(
            auth, meta.deviceId, meta.dSignPub, meta.dEncPub, rootPub,
        )
        assertTrue(v is SosDeviceAuthorization.VerifyResult.Err)
    }

    @Test
    fun maliciousLabelSanitized() {
        val auth = authorizeFull(label = "<script>alert(1)</svg>\"evil\u202E")
        assertFalse(auth.deviceLabel.contains("<"))
        assertFalse(auth.deviceLabel.contains(">"))
        assertFalse(auth.deviceLabel.contains("\""))
    }

    @Test
    fun loggedOutCannotAuthorize() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val r = issuer.beginFromBound(
            ch.bound,
            SosDeviceAuthorizationCeremony.SessionCtx(rootPub, sessionValid = true, loggedIn = false),
        )
        assertEquals("SESSION_INVALID", (r as SosDeviceAuthorizationCeremony.Result.Err).code)
    }

    @Test
    fun confirmationReplayRejected() {
        val ch = pairChannel()
        val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(phoneIdentity, registry)
        val begin = issuer.beginFromBound(ch.bound, session()) as SosDeviceAuthorizationCeremony.Result.Ok
        val chId = begin.challengeId!!
        assertTrue(issuer.confirmation().approveFromNativeUi(chId))
        // mutate capabilities in a forged intent
        val forged = begin.confirmIntent!!.copy(
            capabilities = begin.confirmIntent!!.capabilities + SosDeviceAuthorization.Capability.DEVICE_ADMIN,
        )
        val err = issuer.confirmation().consume(chId, forged)
        assertEquals("PAYLOAD_MUTATION", err)
    }

    @Test
    fun noRootSecretInAuthObject() {
        val auth = authorizeFull()
        val json = auth.toPublicJson().toString().lowercase()
        assertFalse(json.contains("nsec"))
        assertFalse(json.contains(rootPriv))
        assertFalse(json.contains("\"priv"))
    }

    @Test
    fun accountIsolationRegistry() {
        authorizeFull()
        val otherAccount = "33".repeat(32)
        assertEquals(0, registry.activeCount(otherAccount))
        assertEquals(1, registry.activeCount(rootPub))
    }

    @Test
    fun unknownVersionFailsClosed() {
        val auth = authorizeFull().copy(version = "sos-device-authorization-v999")
        assertEquals(
            SosDeviceAuthorization.VerifyResult.Err("UNKNOWN_VERSION"),
            SosDeviceAuthorization.verifyStrict(auth),
        )
    }
}
