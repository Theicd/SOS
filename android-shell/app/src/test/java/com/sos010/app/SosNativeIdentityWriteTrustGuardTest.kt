package com.sos010.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F6 write-path — trusted WebView URL guard for identity secret writes.
 * Disposable test URLs only; no real private keys.
 */
class SosNativeIdentityWriteTrustGuardTest {

    @Test
    fun trustedProductionHttpsAllowedForIdentityWrite() {
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com/"))
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com/videos.html"))
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://app.sos010.com/x"))
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://www.sos010.com/path?q=1"))
    }

    @Test
    fun untrustedHttpsOriginRejected() {
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://evil.example/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://attacker.com/sos010.com"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://github.com/"))
    }

    @Test
    fun lookalikeTrustedHostAttacksRejected() {
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com.evil.example/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://evil-sos010.com/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://notsos010.com/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com@evil.com/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://user:pass@sos010.com/"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com.evil.com/"))
    }

    @Test
    fun dangerousSchemesRejectedForIdentityWrite() {
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("data:text/html,hi"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("javascript:alert(1)"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("file:///android_asset/index.html"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("file:///sdcard/x.html"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("content://com.evil/x"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("intent://x#Intent;end"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("blob:https://sos010.com/uuid"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("about:blank"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("http://sos010.com/"))
    }

    @Test
    fun malformedAndEmptyRejected() {
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl(null))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl(""))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("   "))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("sos010.com"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("://sos010.com"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https:///path"))
    }

    @Test
    fun debugLocalhostAllowedOnlyWhenExplicitlyEnabled() {
        assertTrue(
            SosNativeTypedBridge.isTrustedWebViewUrl(
                "https://localhost:5173/",
                allowAndroidAsset = false,
                allowDebugLocalhost = true,
            ),
        )
        assertTrue(
            SosNativeTypedBridge.isTrustedWebViewUrl(
                "https://127.0.0.1/",
                allowAndroidAsset = false,
                allowDebugLocalhost = true,
            ),
        )
        // Release-policy: debug origins must not be trusted
        assertFalse(
            SosNativeTypedBridge.isTrustedWebViewUrl(
                "https://localhost/",
                allowAndroidAsset = false,
                allowDebugLocalhost = false,
            ),
        )
        assertFalse(
            SosNativeTypedBridge.isTrustedWebViewUrl(
                "https://127.0.0.1/",
                allowAndroidAsset = false,
                allowDebugLocalhost = false,
            ),
        )
        assertFalse(SosNativeTypedBridge.DEBUG_ORIGIN_ALLOWED_IN_RELEASE)
    }

    @Test
    fun cryptoBridgeMayTrustAssetButIdentityWriteMustNot() {
        assertTrue(SosNativeTypedBridge.isTrustedWebViewUrl("file:///android_asset/secure-call-verifier/index.html"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("file:///android_asset/secure-call-verifier/index.html"))
        assertFalse(SosNativeTypedBridge.FILE_URL_CAN_WRITE_IDENTITY)
    }

    @Test
    fun navigationChangeFailClosedDocumentedAsFreshUrlCheck() {
        // Authority boundary: each write re-reads URL. Prior trusted URL does not stick.
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com/app"))
        assertFalse(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://evil.example/after-nav"))
        assertTrue(SosNativeTypedBridge.WRITE_PATH_USES_CANONICAL_TRUSTED_CONTEXT)
        assertTrue(SosNativeTypedBridge.TRUSTED_URL_MATCH_USES_PARSED_ORIGIN)
        assertFalse(SosNativeTypedBridge.TRUSTED_URL_SUBSTRING_MATCH)
        assertFalse(SosNativeTypedBridge.WRITE_URL_GUARD_CLAIMS_XSS_ELIMINATED)
    }

    @Test
    fun sessionNotGrantedByUrlTrustAlone() {
        assertFalse(SosNativeSessionAuthority.SET_USER_PRIVKEY_AUTO_GRANTS_NATIVE_SESSION)
        // URL trust is orthogonal to session bind — simulated: trusted URL does not activate session.
        assertTrue(SosNativeTypedBridge.isTrustedIdentityWriteWebViewUrl("https://sos010.com/"))
        val auth = SosNativeSessionAuthority.engineForTests(identityPubkey = "aa".repeat(32))
        assertFalse(auth.isActive())
    }

    @Test
    fun identityValidationStillRequiredInvariant() {
        // Guard does not replace same-account / derive-P checks in secure store.
        assertFalse(SosNativeTypedBridge.WRITE_URL_GUARD_CLAIMS_XSS_ELIMINATED)
        val k = "11".repeat(32)
        val p = "22".repeat(32)
        val eng = SosSecureIdentityStore.engineForTests(
            prefs = SosSecureIdentityStore.MemoryPrefsBackend(),
            crypto = SosSecureIdentityStore.SoftAesGcmCrypto(),
            derivePubkey = { if (SosSecureIdentityStore.normalizeHex(it) == k) p else "ff".repeat(32) },
        )
        // Wrong expected P for disposable K must fail closed.
        val r = eng.writeIdentitySameAccount(k, "aa".repeat(32))
        assertTrue(r is SosSecureIdentityStore.WriteResult.Err)
        assertEquals("EXPECTED_PUBKEY_MISMATCH", (r as SosSecureIdentityStore.WriteResult.Err).code)
    }

    @Test
    fun invariantFlags() {
        assertTrue(SosNativeTypedBridge.WRITE_PATH_USES_CANONICAL_TRUSTED_CONTEXT)
        assertTrue(SosNativeTypedBridge.TRUSTED_URL_MATCH_USES_PARSED_ORIGIN)
        assertFalse(SosNativeTypedBridge.TRUSTED_URL_SUBSTRING_MATCH)
        assertFalse(SosNativeTypedBridge.FILE_URL_CAN_WRITE_IDENTITY)
        assertFalse(SosNativeTypedBridge.DEBUG_ORIGIN_ALLOWED_IN_RELEASE)
    }
}
