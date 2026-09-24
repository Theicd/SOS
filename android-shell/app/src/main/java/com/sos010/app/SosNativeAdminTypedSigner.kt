package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * F6E/F6G — Typed admin signer: policy + F6D session + secure identity + trusted confirmation.
 * Constructs admin events natively; never accepts arbitrary admin events.
 * High-risk (all) ops require F6G native confirmation Authorization before private-key use.
 * HYPER CORE TECH
 */
object SosNativeAdminTypedSigner {

    const val NATIVE_TYPED_SIGNER_ADMIN_POLICY_ENFORCED = true
    const val ADMIN_POLICY_CHECK_BEFORE_PRIVATE_KEY_USE = true
    const val ADMIN_POLICY_RECHECK_BEFORE_SIGN = true
    const val F6G_TRUSTED_CONFIRMATION_AVAILABLE = true
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION = true
    const val WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION = false
    const val GENERIC_NATIVE_ADMIN_SIGN_API = false
    const val ARBITRARY_ADMIN_EVENT_SIGNING_EXPOSED = false
    const val CALLER_SUPPLIED_COMPLETE_ADMIN_EVENT_ACCEPTED = false
    const val ADMIN_TYPED_OP_REQUIRES_NATIVE_SESSION = true
    const val ADMIN_REUSES_F6D_SESSION_AUTHORITY = true
    const val SECOND_ADMIN_SESSION_AUTHORITY_CREATED = false
    const val ADMIN_SIGNING_PUBKEY_DERIVED_FROM_SECURE_IDENTITY = true
    const val CALLER_CAN_SELECT_ADMIN_PRIVATE_KEY = false
    const val CALLER_CAN_SELECT_ADMIN_PUBKEY = false
    const val ADMIN_POLICY_RECHECK_AFTER_CONFIRM = true
    const val CONFIRMATION_BYPASSES_ADMIN_POLICY = false

    sealed class AdminSignResult {
        data class Ok(val event: JSONObject) : AdminSignResult()
        data class Err(val code: String) : AdminSignResult()
    }

    class Engine(
        private val identity: SosSecureIdentityStore.Engine,
        private val policy: SosNativeAdminPolicy.Engine = SosNativeAdminPolicy.Engine(),
        private var sessionGate: SosNativeTypedSigner.SessionAuthorityGate =
            SosNativeTypedSigner.DefaultSessionGate,
        private val nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        private val signWithPriv: (privHex: String, kind: Int, tags: JSONArray, content: String, createdAt: Long) -> JSONObject =
            { priv, kind, tags, content, createdAt ->
                SosNostrCrypto.signEvent(priv, kind, tags, content, createdAt)
            },
        private val verifyEvent: (JSONObject) -> Boolean = { SosNostrCrypto.verifyEvent(it) },
    ) {
        fun setSessionGate(gate: SosNativeTypedSigner.SessionAuthorityGate) {
            sessionGate = gate
        }

        fun evaluatePolicy(
            request: SosNativeAdminPolicy.TypedAdminRequest,
            verified: SosNativeAdminPolicy.VerifiedControlSnapshot?,
        ): SosNativeAdminPolicy.PolicyResult {
            val id = identity.readIdentityForNativeUse()
                ?: return SosNativeAdminPolicy.PolicyResult.Denied("NO_SECURE_IDENTITY")
            return policy.evaluate(id.publicKeyHex, request, verified)
        }

        /**
         * Requires SosNativeTrustedConfirmation.Authorization from native UI.
         * WebView cannot construct Authorization.
         */
        fun attemptTypedAdminSign(
            binding: SosNativeTypedSigner.SessionBinding,
            request: SosNativeAdminPolicy.TypedAdminRequest,
            verified: SosNativeAdminPolicy.VerifiedControlSnapshot?,
            authorization: SosNativeTrustedConfirmation.Authorization? = null,
        ): AdminSignResult {
            if (request.completeEvent != null) return AdminSignResult.Err("ARBITRARY_EVENT_FIELDS")
            if (request.kindOverride != null) return AdminSignResult.Err("CALLER_KIND_OVERRIDE")
            if (request.pubkeyOverride != null) return AdminSignResult.Err("CALLER_PUBKEY_OVERRIDE")

            val state = identity.readState()
            when (state) {
                SosSecureIdentityStore.State.MISMATCH ->
                    return AdminSignResult.Err("MISMATCH_SECURE_IDENTITY")
                SosSecureIdentityStore.State.INVALID ->
                    return AdminSignResult.Err("INVALID_SECURE_IDENTITY")
                SosSecureIdentityStore.State.RECOVERY_REQUIRED ->
                    return AdminSignResult.Err("RECOVERY_REQUIRED_IDENTITY")
                SosSecureIdentityStore.State.NEW_USER,
                SosSecureIdentityStore.State.WEB_ONLY,
                ->
                    return AdminSignResult.Err("NO_SECURE_IDENTITY")
                SosSecureIdentityStore.State.IDENTITY_OK,
                SosSecureIdentityStore.State.NATIVE_ONLY,
                -> { }
            }

            val id = identity.readIdentityForNativeUse()
                ?: return AdminSignResult.Err("NO_SECURE_IDENTITY")
            if (!SosSecureIdentityStore.isHex64(id.privateKeyHex) ||
                !SosSecureIdentityStore.isHex64(id.publicKeyHex)
            ) {
                return AdminSignResult.Err("INVALID_SECURE_IDENTITY")
            }

            when (val gate = sessionGate.check(SosNativeTypedSigner.Op.SIGN_CHAT_EVENT, binding, id.publicKeyHex)) {
                is SosNativeTypedSigner.CheckResult.Err -> return AdminSignResult.Err(gate.code)
                SosNativeTypedSigner.CheckResult.Ok -> { }
            }

            val eval = policy.evaluate(id.publicKeyHex, request, verified)
            when (eval) {
                is SosNativeAdminPolicy.PolicyResult.Denied -> return AdminSignResult.Err(eval.code)
                is SosNativeAdminPolicy.PolicyResult.Allowed -> {
                    if (eval.confirmation == SosNativeAdminPolicy.ConfirmClass.NATIVE_CONFIRM_REQUIRED) {
                        if (authorization == null) {
                            return AdminSignResult.Err("TRUSTED_CONFIRMATION_REQUIRED")
                        }
                        val intent = SosNativeTrustedConfirmation.IntentSpec(
                            requestId = authorization.requestId,
                            operation = request.operation,
                            communityId = request.communityId,
                            accountPubkey = id.publicKeyHex,
                            sessionCapability = binding.sessionCapability,
                            params = request.params,
                            targetPubkey = request.params["targetPubkey"]?.toString()
                                ?: request.params["memberPubkey"]?.toString()
                                ?: "",
                        )
                        if (!authorization.matches(intent, nowMs())) {
                            return AdminSignResult.Err("AUTHORIZATION_MISMATCH")
                        }
                        if (authorization.accountPubkey != id.publicKeyHex) {
                            return AdminSignResult.Err("ACCOUNT_SWITCH_DURING_CONFIRM")
                        }
                    }

                    val recheck = policy.evaluate(id.publicKeyHex, request, verified)
                    if (recheck !is SosNativeAdminPolicy.PolicyResult.Allowed) {
                        return AdminSignResult.Err(
                            (recheck as SosNativeAdminPolicy.PolicyResult.Denied).code,
                        )
                    }

                    when (val gate2 = sessionGate.check(SosNativeTypedSigner.Op.SIGN_CHAT_EVENT, binding, id.publicKeyHex)) {
                        is SosNativeTypedSigner.CheckResult.Err -> return AdminSignResult.Err(gate2.code)
                        SosNativeTypedSigner.CheckResult.Ok -> { }
                    }

                    val kind = recheck.constructedKind
                    val createdAt = nowSec()
                    val (content, tags) = when (recheck.family) {
                        SosNativeAdminPolicy.OpFamily.CONTROL -> {
                            val body = recheck.nextControl
                                ?: return AdminSignResult.Err("NO_CONTROL_BODY")
                            body.put("createdAt", createdAt)
                            val contentStr = body.toString()
                            val t = JSONArray()
                            t.put(JSONArray().put("d").put(recheck.communityId))
                            t.put(JSONArray().put("t").put(recheck.communityId))
                            t.put(JSONArray().put("t").put("sos-group-control"))
                            contentStr to t
                        }
                        SosNativeAdminPolicy.OpFamily.MEMBERSHIP -> {
                            val body = recheck.nextMembership
                                ?: return AdminSignResult.Err("NO_MEMBER_BODY")
                            body.put("createdAt", createdAt)
                            val member = body.optString("memberPubkey")
                            val contentStr = body.toString()
                            val t = JSONArray()
                            t.put(JSONArray().put("d").put(recheck.communityId + ":" + member))
                            t.put(JSONArray().put("p").put(member))
                            t.put(JSONArray().put("t").put(recheck.communityId))
                            t.put(JSONArray().put("t").put("sos-group-member"))
                            contentStr to t
                        }
                    }

                    return try {
                        val signed = signWithPriv(id.privateKeyHex, kind, tags, content, createdAt)
                        val pub = signed.optString("pubkey").lowercase()
                        if (pub != id.publicKeyHex) return AdminSignResult.Err("PUBKEY_DERIVE_MISMATCH")
                        if (signed.optInt("kind") != kind) return AdminSignResult.Err("KIND_MISMATCH")
                        if (!verifyEvent(signed)) return AdminSignResult.Err("SIGNATURE_VERIFY_FAILED")
                        signed.remove("privateKey")
                        signed.remove("privkey")
                        signed.remove("nsec")
                        signed.remove("k")
                        AdminSignResult.Ok(signed)
                    } catch (_: Exception) {
                        AdminSignResult.Err("SIGN_FAILED")
                    }
                }
            }
        }

        fun rejectSignAdminEvent(): AdminSignResult =
            AdminSignResult.Err("GENERIC_ADMIN_SIGN_UNAVAILABLE")

        fun rejectSignGroupControl(): AdminSignResult =
            AdminSignResult.Err("GENERIC_ADMIN_SIGN_UNAVAILABLE")

        fun rejectSignMembershipState(): AdminSignResult =
            AdminSignResult.Err("GENERIC_ADMIN_SIGN_UNAVAILABLE")

        fun rejectSignArbitraryAdmin(): AdminSignResult =
            AdminSignResult.Err("GENERIC_ADMIN_SIGN_UNAVAILABLE")
    }

    fun engineForTests(
        identity: SosSecureIdentityStore.Engine,
        sessionGate: SosNativeTypedSigner.SessionAuthorityGate = SosNativeTypedSigner.TestPermissiveSessionGate,
        nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
        nowMs: () -> Long = { System.currentTimeMillis() },
        verifyEvent: (JSONObject) -> Boolean = { SosNostrCrypto.verifyEvent(it) },
    ): Engine =
        Engine(
            identity = identity,
            sessionGate = sessionGate,
            nowSec = nowSec,
            nowMs = nowMs,
            verifyEvent = verifyEvent,
        )
}
