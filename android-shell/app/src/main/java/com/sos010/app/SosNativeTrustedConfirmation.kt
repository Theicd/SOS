package com.sos010.app

import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference

/**
 * F6G — Trusted Android-native confirmation boundary.
 * WebView may request; only native UI may approve. No approval secret to JS.
 * HYPER CORE TECH
 */
object SosNativeTrustedConfirmation {

    const val DEFAULT_EXPIRY_MS = 60_000L
    const val MAX_ACTIVE = 1
    const val CREATE_COOLDOWN_MS = 400L
    const val MAX_CREATES_PER_MINUTE = 12
    const val CHALLENGE_BYTES = 32

    // Design / QA invariants
    const val TRUSTED_NATIVE_CONFIRMATION_PRESENT = true
    const val TRUSTED_CONFIRMATION_IS_WEBVIEW_HTML = false
    const val TRUSTED_CONFIRMATION_IS_JAVASCRIPT_DIALOG = false
    const val WEBVIEW_CAN_RENDER_TRUSTED_CONFIRMATION = false
    const val WEBVIEW_CAN_SIMULATE_APPROVAL_UI = false
    const val PROGRAMMATIC_AUTO_CONFIRM_SUPPORTED = false
    const val WEBVIEW_CAN_SEND_APPROVAL_BOOLEAN = false
    const val WEBVIEW_CAN_CALL_APPROVE_METHOD = false
    const val CONFIRMATION_CHALLENGE_ONE_TIME = true
    const val CONFIRMATION_CHALLENGE_BINDS_OPERATION = true
    const val CONFIRMATION_CHALLENGE_BINDS_PAYLOAD = true
    const val CONFIRMATION_CHALLENGE_BINDS_SESSION = true
    const val CONFIRMATION_CHALLENGE_BINDS_ACCOUNT = true
    const val CONFIRMATION_BINDS_EXPLICIT_COMMUNITY = true
    const val CONFIRMATION_EXPIRY_PRESENT = true
    const val CONFIRMATION_REPLAY_ACCEPTED = false
    const val DOUBLE_CONSUME_ACCEPTED = false
    const val POST_CONFIRM_PAYLOAD_MUTATION_ACCEPTED = false
    const val APPROVED_PAYLOAD_HASH_REVALIDATED = true
    const val APPROVAL_SECRET_EXPOSED_TO_WEBVIEW = false
    const val WEBVIEW_RECEIVES_REUSABLE_APPROVAL_TOKEN = false
    const val SENSITIVE_PAYLOAD_RESUBMISSION_AFTER_CONFIRM_REQUIRED = false
    const val BACKGROUND_CONFIRMATION_AUTO_APPROVED = false
    const val BACKGROUND_RESUME_REQUIRES_REVALIDATION = true
    const val ACTIVITY_RECREATION_AUTO_APPROVES = false
    const val PROCESS_RESTART_RESTORES_APPROVED_CONFIRMATION = false
    const val CROSS_REQUEST_CONFIRMATION_CONFUSION = false
    const val CONFIRMATION_FOR_A_AUTHORIZES_B = false
    const val CONFIRMATION_PROMPT_SPAM_BOUNDED = true
    const val RATE_LIMIT_BYPASS_GRANTS_AUTHORITY = false
    const val F6G_CLAIMS_XSS_ELIMINATED = false
    const val XSS_CAN_AUTO_APPROVE_HIGH_RISK_OPERATION = false
    const val XSS_CAN_READ_APPROVAL_SECRET = false
    const val ADMIN_POLICY_RECHECK_AFTER_CONFIRM = true
    const val CONFIRMATION_BYPASSES_ADMIN_POLICY = false
    const val CONFIRMATION_DOES_NOT_OVERRIDE_ROOT_REQUIREMENT = true
    const val DELEGATED_ADMIN_CAN_CONFIRM_ROOT_ONLY_OPERATION = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_WITHOUT_CONFIRMATION = false
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_AFTER_VALID_NATIVE_CONFIRMATION = true
    const val WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION = false
    const val WEBVIEW_CONTROLS_CONFIRMATION_SECURITY_TEXT = false
    const val NATIVE_BUILDS_CONFIRMATION_SUMMARY = true
    const val HIGH_IMPACT_CONFIRMATION_SUMMARY_HUMAN_READABLE = true
    const val TRUSTED_UI_READY_FOR_FUTURE_IDENTITY_INTENTS = true
    const val F5B5_EXPORT_IMPLEMENTED = false
    const val F5B6_MIGRATION_IMPLEMENTED = false
    const val ACCESS_CONTROL_V2_ACTIVATION_READY = false
    const val ROUTINE_CHAT_REQUIRES_NATIVE_CONFIRM = false
    const val P2P_FILE_CHUNK_REQUIRES_NATIVE_CONFIRM = false
    const val CALL_SIGNAL_PACKET_REQUIRES_NATIVE_CONFIRM = false
    const val CALL_PROTOCOL_CHANGED = false
    const val TRUSTED_UI_SCREEN_CAPTURE_POLICY = "FLAG_SECURE_ON_HIGH_IMPACT_DIALOGS_ONLY"
    const val ALL_F6E_ADMIN_OPS_HAVE_TRUSTED_CONFIRMATION = true

    enum class RiskTier {
        NORMAL_NATIVE_CONFIRM,
        STRONG_DEVICE_CONFIRM,
        NOT_IMPLEMENTED_YET,
    }

    enum class FutureIntent {
        IDENTITY_REPLACEMENT,
        IDENTITY_CLEAR,
        TRUSTED_EXPORT,
        RECOVERY,
        SEALED_MIGRATION,
        LINKED_DEVICE_AUTHORIZATION,
    }

    fun riskTierForAdmin(op: SosNativeAdminPolicy.AdminOp): RiskTier = when (op) {
        SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
        SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
        SosNativeAdminPolicy.AdminOp.BOOTSTRAP_MEMBER_ACTIVE,
        SosNativeAdminPolicy.AdminOp.RESOLVE_MEMBERSHIP_CONFLICT,
        SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
        SosNativeAdminPolicy.AdminOp.REVOKE_CAPABILITY,
        -> RiskTier.NORMAL_NATIVE_CONFIRM // strong device confirm reserved for F5B5/F5B6 identity intents
        else -> RiskTier.NORMAL_NATIVE_CONFIRM
    }

    fun riskTierForFuture(intent: FutureIntent): RiskTier = when (intent) {
        FutureIntent.TRUSTED_EXPORT,
        FutureIntent.IDENTITY_REPLACEMENT,
        FutureIntent.RECOVERY,
        FutureIntent.SEALED_MIGRATION,
        -> RiskTier.STRONG_DEVICE_CONFIRM // NOT implemented — must not silently downgrade
        else -> RiskTier.NORMAL_NATIVE_CONFIRM
    }

    data class IntentSpec(
        val requestId: String,
        val operation: SosNativeAdminPolicy.AdminOp,
        val communityId: String,
        val accountPubkey: String,
        val sessionCapability: String,
        val params: Map<String, Any?> = emptyMap(),
        val targetPubkey: String = "",
        val verifiedSnapshot: SosNativeAdminPolicy.VerifiedControlSnapshot? = null,
    ) {
        fun payloadHash(): String = canonicalPayloadHash(
            operation = operation.name,
            communityId = communityId,
            accountPubkey = accountPubkey,
            params = params,
            targetPubkey = targetPubkey,
        )
    }

    /**
     * One-time native authorization — never serialize to WebView.
     * Constructible only via Engine.approveFromNativeUi.
     */
    class Authorization internal constructor(
        val challengeId: String,
        val requestId: String,
        val operation: SosNativeAdminPolicy.AdminOp,
        val communityId: String,
        val accountPubkey: String,
        val sessionCapability: String,
        val payloadHash: String,
        val expiresAtMs: Long,
        private val consumeNonce: String,
    ) {
        internal fun matches(intent: IntentSpec, nowMs: Long): Boolean {
            if (nowMs > expiresAtMs) return false
            if (operation != intent.operation) return false
            if (communityId != intent.communityId) return false
            if (accountPubkey != SosSecureIdentityStore.normalizeHex(intent.accountPubkey)) return false
            if (sessionCapability != intent.sessionCapability) return false
            if (payloadHash != intent.payloadHash()) return false
            if (consumeNonce.isEmpty()) return false
            return true
        }
    }

    data class PendingPublic(
        val requestId: String,
        val operation: String,
        val communityId: String,
        val summaryTitle: String,
        val summaryBody: String,
        val expiresAtMs: Long,
        val riskTier: String,
    )

    private data class Challenge(
        val challengeId: String,
        val intent: IntentSpec,
        val payloadHash: String,
        val createdAtMs: Long,
        val expiresAtMs: Long,
        val summaryTitle: String,
        val summaryBody: String,
        val riskTier: RiskTier,
        val requireSecureFlag: Boolean,
        var state: State = State.PENDING_UI,
        var authorization: Authorization? = null,
    )

    enum class State {
        PENDING_UI,
        APPROVED_READY,
        CONSUMED,
        CANCELLED,
        EXPIRED,
        INVALIDATED,
    }

    sealed class CreateResult {
        data class Ok(val pending: PendingPublic, val challengeId: String) : CreateResult()
        data class Err(val code: String) : CreateResult()
    }

    sealed class ApproveResult {
        data class Ok(val authorization: Authorization) : ApproveResult()
        data class Err(val code: String) : ApproveResult()
    }

    /** Native UI only — never invoked from WebView. */
    fun interface NativeUiPresenter {
        fun present(
            pending: PendingPublic,
            challengeId: String,
            requireSecureFlag: Boolean,
            onApprove: () -> Unit,
            onCancel: () -> Unit,
        )
    }

    /** Test double: auto-invokes callbacks without claiming PROGRAMMATIC_AUTO_CONFIRM in production. */
    class TestUiPresenter(
        private val autoApprove: Boolean = false,
    ) : NativeUiPresenter {
        var lastPending: PendingPublic? = null
        var presentCount = 0
        override fun present(
            pending: PendingPublic,
            challengeId: String,
            requireSecureFlag: Boolean,
            onApprove: () -> Unit,
            onCancel: () -> Unit,
        ) {
            presentCount++
            lastPending = pending
            if (autoApprove) onApprove() else { /* wait for explicit test call */ }
            // Store callbacks for tests
            this.onApprove = onApprove
            this.onCancel = onCancel
        }
        var onApprove: (() -> Unit)? = null
        var onCancel: (() -> Unit)? = null
        fun clickApprove() { onApprove?.invoke() }
        fun clickCancel() { onCancel?.invoke() }
    }

    class Engine(
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        private val random: SecureRandom = SecureRandom(),
        private val sessionValidator: (capability: String, accountPubkey: String) -> String? = { _, _ -> null },
        private var uiPresenter: NativeUiPresenter? = null,
    ) {
        private val active = AtomicReference<Challenge?>(null)
        private val consumedIds = LinkedHashSet<String>()
        private var lastCreateMs = 0L
        private val createTimestamps = ArrayDeque<Long>()

        fun setUiPresenter(presenter: NativeUiPresenter?) {
            uiPresenter = presenter
        }

        fun hasActivePending(): Boolean {
            val c = active.get() ?: return false
            return c.state == State.PENDING_UI || c.state == State.APPROVED_READY
        }

        /**
         * Create challenge after session validation. Does not expose approval secret.
         */
        fun create(intent: IntentSpec, sessionOk: Boolean = true): CreateResult {
            if (!sessionOk) return CreateResult.Err("SESSION_REQUIRED")
            val account = SosSecureIdentityStore.normalizeHex(intent.accountPubkey)
            if (!SosSecureIdentityStore.isHex64(account)) return CreateResult.Err("BAD_ACCOUNT")
            val community = intent.communityId.trim()
            if (community.isEmpty()) return CreateResult.Err("EXPLICIT_COMMUNITY_SCOPE_REQUIRED")
            if (intent.requestId.isBlank() || intent.requestId.length > 128) {
                return CreateResult.Err("REQUEST_ID_REQUIRED")
            }
            if (intent.sessionCapability.isBlank()) return CreateResult.Err("SESSION_REQUIRED")

            val sessionErr = sessionValidator(intent.sessionCapability, account)
            if (sessionErr != null) return CreateResult.Err(sessionErr)

            val t = nowMs()
            // Rate limit / anti-spam
            while (createTimestamps.isNotEmpty() && t - createTimestamps.first() > 60_000L) {
                createTimestamps.removeFirst()
            }
            if (createTimestamps.size >= MAX_CREATES_PER_MINUTE) {
                return CreateResult.Err("CONFIRMATION_RATE_LIMITED")
            }
            if (t - lastCreateMs < CREATE_COOLDOWN_MS) {
                return CreateResult.Err("CONFIRMATION_COOLDOWN")
            }
            val existing = active.get()
            if (existing != null &&
                (existing.state == State.PENDING_UI || existing.state == State.APPROVED_READY) &&
                existing.expiresAtMs > t
            ) {
                return CreateResult.Err("CONFIRMATION_ALREADY_ACTIVE")
            }

            val hash = intent.payloadHash()
            val challengeId = randomHex(CHALLENGE_BYTES)
            val risk = riskTierForAdmin(intent.operation)
            if (risk == RiskTier.STRONG_DEVICE_CONFIRM || risk == RiskTier.NOT_IMPLEMENTED_YET) {
                // Must not silently downgrade strong intents — none of current admin ops use STRONG yet.
                return CreateResult.Err("STRONG_CONFIRMATION_UNAVAILABLE")
            }
            val (title, body) = buildHumanSummary(intent)
            val requireSecure = intent.operation in setOf(
                SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY,
                SosNativeAdminPolicy.AdminOp.REVOKE_CAPABILITY,
                SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL,
                SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT,
                SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER,
                SosNativeAdminPolicy.AdminOp.BLOCK_MEMBER,
            )
            val challenge = Challenge(
                challengeId = challengeId,
                intent = intent.copy(accountPubkey = account),
                payloadHash = hash,
                createdAtMs = t,
                expiresAtMs = t + DEFAULT_EXPIRY_MS,
                summaryTitle = title,
                summaryBody = body,
                riskTier = risk,
                requireSecureFlag = requireSecure,
            )
            active.set(challenge)
            lastCreateMs = t
            createTimestamps.addLast(t)

            val pending = PendingPublic(
                requestId = intent.requestId,
                operation = intent.operation.name,
                communityId = community,
                summaryTitle = title,
                summaryBody = body,
                expiresAtMs = challenge.expiresAtMs,
                riskTier = risk.name,
            )
            return CreateResult.Ok(pending, challengeId)
        }

        fun presentUi(challengeId: String): String? {
            val c = active.get() ?: return "NO_PENDING"
            if (c.challengeId != challengeId) return "CHALLENGE_MISMATCH"
            if (c.state != State.PENDING_UI) return "BAD_STATE"
            if (nowMs() > c.expiresAtMs) {
                c.state = State.EXPIRED
                return "EXPIRED"
            }
            val presenter = uiPresenter ?: return "NO_UI_PRESENTER"
            val pending = PendingPublic(
                requestId = c.intent.requestId,
                operation = c.intent.operation.name,
                communityId = c.intent.communityId,
                summaryTitle = c.summaryTitle,
                summaryBody = c.summaryBody,
                expiresAtMs = c.expiresAtMs,
                riskTier = c.riskTier.name,
            )
            presenter.present(
                pending = pending,
                challengeId = challengeId,
                requireSecureFlag = c.requireSecureFlag,
                onApprove = { approveFromNativeUi(challengeId) },
                onCancel = { cancel(challengeId, "user_cancel") },
            )
            return null
        }

        /**
         * ONLY native UI path. Not exposed on JavascriptInterface.
         */
        fun approveFromNativeUi(challengeId: String): ApproveResult {
            val c = active.get() ?: return ApproveResult.Err("NO_PENDING")
            if (c.challengeId != challengeId) return ApproveResult.Err("CHALLENGE_MISMATCH")
            if (c.state != State.PENDING_UI) return ApproveResult.Err("BAD_STATE")
            val t = nowMs()
            if (t > c.expiresAtMs) {
                c.state = State.EXPIRED
                return ApproveResult.Err("EXPIRED")
            }
            // Revalidate session at approve time
            val sessionErr = sessionValidator(c.intent.sessionCapability, c.intent.accountPubkey)
            if (sessionErr != null) {
                c.state = State.INVALIDATED
                return ApproveResult.Err(sessionErr)
            }
            val nonce = randomHex(16)
            val auth = Authorization(
                challengeId = c.challengeId,
                requestId = c.intent.requestId,
                operation = c.intent.operation,
                communityId = c.intent.communityId,
                accountPubkey = c.intent.accountPubkey,
                sessionCapability = c.intent.sessionCapability,
                payloadHash = c.payloadHash,
                expiresAtMs = c.expiresAtMs,
                consumeNonce = nonce,
            )
            c.authorization = auth
            c.state = State.APPROVED_READY
            return ApproveResult.Ok(auth)
        }

        /**
         * Single-use consume for signing. Re-checks payload hash vs intent.
         */
        fun consumeForSign(authorization: Authorization, intent: IntentSpec): String? {
            val c = active.get() ?: return "NO_PENDING"
            if (c.challengeId != authorization.challengeId) return "CHALLENGE_MISMATCH"
            if (c.state != State.APPROVED_READY) {
                if (c.state == State.CONSUMED) return "DOUBLE_CONSUME"
                return "NOT_APPROVED"
            }
            if (consumedIds.contains(authorization.challengeId)) return "REPLAY"
            val t = nowMs()
            if (!authorization.matches(intent, t)) {
                if (t > authorization.expiresAtMs) return "EXPIRED"
                if (authorization.payloadHash != intent.payloadHash()) return "PAYLOAD_MUTATION"
                return "AUTHORIZATION_MISMATCH"
            }
            val sessionErr = sessionValidator(intent.sessionCapability, intent.accountPubkey)
            if (sessionErr != null) {
                c.state = State.INVALIDATED
                return sessionErr
            }
            c.state = State.CONSUMED
            consumedIds.add(authorization.challengeId)
            while (consumedIds.size > 64) {
                val it = consumedIds.iterator()
                if (it.hasNext()) {
                    it.next()
                    it.remove()
                } else break
            }
            active.compareAndSet(c, null)
            return null
        }

        fun cancel(challengeId: String, reason: String = "cancel"): Boolean {
            val c = active.get() ?: return false
            if (c.challengeId != challengeId) return false
            if (c.state == State.CONSUMED) return false
            c.state = State.CANCELLED
            c.authorization = null
            active.compareAndSet(c, null)
            return true
        }

        fun invalidateAll(reason: String) {
            val c = active.getAndSet(null) ?: return
            c.state = State.INVALIDATED
            c.authorization = null
        }

        fun onBackground() {
            // Pending UI must not auto-approve; cancel or require revalidation.
            val c = active.get() ?: return
            if (c.state == State.PENDING_UI || c.state == State.APPROVED_READY) {
                c.state = State.INVALIDATED
                c.authorization = null
                active.compareAndSet(c, null)
            }
        }

        fun onActivityRecreation() {
            // Must not auto-approve; drop pending.
            invalidateAll("activity_recreation")
        }

        fun peekPendingPublic(): PendingPublic? {
            val c = active.get() ?: return null
            if (c.state != State.PENDING_UI && c.state != State.APPROVED_READY) return null
            if (nowMs() > c.expiresAtMs) {
                c.state = State.EXPIRED
                return null
            }
            return PendingPublic(
                requestId = c.intent.requestId,
                operation = c.intent.operation.name,
                communityId = c.intent.communityId,
                summaryTitle = c.summaryTitle,
                summaryBody = c.summaryBody,
                expiresAtMs = c.expiresAtMs,
                riskTier = c.riskTier.name,
            )
        }

        fun activeChallengeId(): String? = active.get()?.challengeId

        fun takeApprovedAuthorization(): Authorization? {
            val c = active.get() ?: return null
            if (c.state != State.APPROVED_READY) return null
            return c.authorization
        }
    }

    fun canonicalPayloadHash(
        operation: String,
        communityId: String,
        accountPubkey: String,
        params: Map<String, Any?>,
        targetPubkey: String,
    ): String {
        val sortedParams = params.entries.sortedBy { it.key }.joinToString("|") { (k, v) ->
            k + "=" + normalizeParam(v)
        }
        val raw = listOf(
            operation,
            communityId.trim(),
            SosSecureIdentityStore.normalizeHex(accountPubkey),
            SosSecureIdentityStore.normalizeHex(targetPubkey),
            sortedParams,
        ).joinToString("\n")
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { b -> "%02x".format(b) }
    }

    private fun normalizeParam(v: Any?): String = when (v) {
        null -> ""
        is String -> v
        is Number, is Boolean -> v.toString()
        is List<*> -> v.joinToString(",", transform = { normalizeParam(it) })
        is Map<*, *> -> v.entries.sortedBy { it.key.toString() }
            .joinToString(";") { it.key.toString() + "=" + normalizeParam(it.value) }
        else -> v.toString()
    }

    fun buildHumanSummary(intent: IntentSpec): Pair<String, String> {
        val op = intent.operation.name
        val community = intent.communityId
        val target = intent.targetPubkey.ifBlank {
            intent.params["targetPubkey"]?.toString()
                ?: intent.params["memberPubkey"]?.toString()
                ?: ""
        }
        val title = when (intent.operation) {
            SosNativeAdminPolicy.AdminOp.GRANT_CAPABILITY -> "Grant admin capability"
            SosNativeAdminPolicy.AdminOp.REVOKE_CAPABILITY -> "Revoke admin capability"
            SosNativeAdminPolicy.AdminOp.BLOCK_MEMBER -> "Block member"
            SosNativeAdminPolicy.AdminOp.UNBLOCK_MEMBER -> "Unblock member"
            SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER -> "Remove member"
            SosNativeAdminPolicy.AdminOp.SET_GROUP_DISPLAY_NAME -> "Change community name"
            SosNativeAdminPolicy.AdminOp.SET_INVITE_POLICY -> "Change invite policy"
            SosNativeAdminPolicy.AdminOp.BOOTSTRAP_GROUP_CONTROL -> "Bootstrap community control"
            SosNativeAdminPolicy.AdminOp.RESOLVE_CONTROL_CONFLICT -> "Resolve control conflict"
            SosNativeAdminPolicy.AdminOp.BOOTSTRAP_MEMBER_ACTIVE -> "Bootstrap member"
            SosNativeAdminPolicy.AdminOp.RESOLVE_MEMBERSHIP_CONFLICT -> "Resolve membership conflict"
            SosNativeAdminPolicy.AdminOp.ADD_MEMBER_TO_BLOCKLIST -> "Add to blocklist"
            SosNativeAdminPolicy.AdminOp.REMOVE_MEMBER_FROM_BLOCKLIST -> "Remove from blocklist"
            SosNativeAdminPolicy.AdminOp.CLEAN_REMOVED_MEMBER_CAPABILITIES -> "Clean removed member caps"
            SosNativeAdminPolicy.AdminOp.GRANT_MEMBER_ACTIVE -> "Grant member active"
        }
        val body = buildString {
            append("Operation: ").append(op).append('\n')
            append("Community: ").append(community)
            if (target.isNotBlank()) {
                append('\n').append("Target: ").append(target.take(16)).append('…')
            }
            val cap = intent.params["capability"]?.toString()
            if (!cap.isNullOrBlank()) {
                append('\n').append("Capability: ").append(cap)
            }
            val invite = intent.params["invitePolicy"]?.toString()
            if (!invite.isNullOrBlank()) {
                append('\n').append("Invite policy: ").append(invite)
            }
            val name = intent.params["displayName"]?.toString()
            if (!name.isNullOrBlank()) {
                append('\n').append("Display name: ").append(name.take(40))
            }
            append("\n\nApprove only if you initiated this action.")
        }
        return title to body
    }

    private fun randomHex(bytes: Int): String {
        val buf = ByteArray(bytes)
        SecureRandom().nextBytes(buf)
        return buf.joinToString("") { "%02x".format(it) }
    }

    fun engineForTests(
        nowMs: () -> Long = { System.currentTimeMillis() },
        sessionValidator: (String, String) -> String? = { _, _ -> null },
        uiPresenter: NativeUiPresenter? = null,
    ): Engine = Engine(nowMs = nowMs, sessionValidator = sessionValidator, uiPresenter = uiPresenter)
}
