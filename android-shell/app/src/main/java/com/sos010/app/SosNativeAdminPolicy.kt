package com.sos010.app

import org.json.JSONArray
import org.json.JSONObject

/**
 * F6E — Native typed administrative policy (AC9 mirror).
 * No private-key custody. No generic admin signing.
 * High-risk ops require F6G trusted confirmation before sign.
 * HYPER CORE TECH
 */
object SosNativeAdminPolicy {

    const val PROTOCOL_VERSION = 1
    const val GROUP_CONTROL_KIND = 39001
    const val MEMBERSHIP_KIND = 39003
    const val SCHEMA_CONTROL = "sos-group-control"
    const val SCHEMA_MEMBER = "sos-group-member"
    const val DISPLAY_NAME_MAX = 80
    const val REASON_MAX = 200
    const val MAX_CANDIDATES = 32
    const val MAX_CAPS_PER_TARGET = 32
    const val MAX_BLOCKLIST = 5000
    const val COMMUNITY_ID_MAX = 128

    val INVITE_POLICIES = setOf("EVERYONE", "AUTHORIZED_USERS_ONLY", "ADMINS_ONLY")

    val MAP_CAPABILITIES = listOf(
        "MANAGE_ADMINS",
        "MANAGE_PERMISSIONS",
        "MANAGE_GROUP_SETTINGS",
        "MODERATE_CONTENT",
        "INVITE_USERS",
        "MANAGE_MEMBERS",
        "MANAGE_INVITES",
        "MANAGE_BLOCKLIST",
        "VIEW_AUDIT_LOG",
    )

    val DELEGABLE_BY_PERMISSION_MANAGER = setOf(
        "MANAGE_GROUP_SETTINGS",
        "MODERATE_CONTENT",
        "INVITE_USERS",
        "MANAGE_INVITES",
        "MANAGE_MEMBERS",
        "MANAGE_BLOCKLIST",
        "VIEW_AUDIT_LOG",
    )

    /** Canonical AC9 operation names — no aliases. */
    enum class AdminOp {
        SET_GROUP_DISPLAY_NAME,
        SET_INVITE_POLICY,
        GRANT_CAPABILITY,
        REVOKE_CAPABILITY,
        ADD_MEMBER_TO_BLOCKLIST,
        REMOVE_MEMBER_FROM_BLOCKLIST,
        CLEAN_REMOVED_MEMBER_CAPABILITIES,
        RESOLVE_CONTROL_CONFLICT,
        BOOTSTRAP_GROUP_CONTROL,
        GRANT_MEMBER_ACTIVE,
        BLOCK_MEMBER,
        UNBLOCK_MEMBER,
        REMOVE_MEMBER,
        RESOLVE_MEMBERSHIP_CONFLICT,
        BOOTSTRAP_MEMBER_ACTIVE,
    }

    enum class ConfirmClass {
        NO_CONFIRM_REQUIRED,
        POLICY_DEPENDENT,
        NATIVE_CONFIRM_REQUIRED,
    }

    enum class OpFamily { CONTROL, MEMBERSHIP }

    // Design / QA invariants
    const val NATIVE_ADMIN_POLICY_PRESENT = true
    const val NATIVE_ADMIN_POLICY_CONTAINS_PRIVATE_K = false
    const val NATIVE_ADMIN_POLICY_CONTAINS_NSEC = false
    const val NATIVE_ADMIN_TYPED_ALLOWLIST_PRESENT = true
    const val GENERIC_NATIVE_ADMIN_SIGN_API = false
    const val ARBITRARY_ADMIN_EVENT_SIGNING_EXPOSED = false
    const val CALLER_SUPPLIED_COMPLETE_ADMIN_EVENT_ACCEPTED = false
    const val NATIVE_CONSTRUCTS_ADMIN_EVENT = true
    const val CALLER_CAN_OVERRIDE_ADMIN_EVENT_KIND = false
    const val CALLER_CAN_OVERRIDE_ADMIN_SIGNING_PUBKEY = false
    const val ADMIN_TYPED_OP_REQUIRES_NATIVE_SESSION = true
    const val ADMIN_OPERATION_REQUIRES_EXPLICIT_COMMUNITY_SCOPE = true
    const val ACTIVE_COMMUNITY_IS_ADMIN_AUTHORITY_SOURCE = false
    const val CROSS_COMMUNITY_ADMIN_AUTHORITY_LEAK = false
    const val ADMIN_CAPABILITY_MAPPING_EXPLICIT = true
    const val MISSING_REQUIRED_CAPABILITY_ACCEPTED = false
    const val ROOT_ONLY_OPERATION_ACCEPTS_DELEGATED_ADMIN = false
    const val CALLER_SUPPLIED_CONTROL_STATE_IS_AUTHORITY = false
    const val CALLER_SUPPLIED_CAPABILITY_SET_IS_AUTHORITY = false
    const val STALE_ADMIN_BASE_AUTO_ACCEPTED = false
    const val ADMIN_TOCTOU_POLICY_DOCUMENTED = true
    const val HIGH_RISK_ADMIN_OP_CAN_SIGN_BEFORE_F6G = false
    const val WEBVIEW_CAN_BYPASS_NATIVE_CONFIRMATION = false
    const val PRE_F6G_ADMIN_SIGNING_SURFACE_MINIMIZED = true
    const val F6E_CLAIMS_XSS_ELIMINATED = false
    const val F6E_CLAIMS_INVITE_DOUBLE_REDEEM_SOLVED = false
    const val F6E_CLAIMS_HISTORICAL_AUTH_PROOF_SOLVED = false
    const val ACCESS_CONTROL_V2_ACTIVATION_READY = false
    const val ADMIN_REUSES_F6D_SESSION_AUTHORITY = true
    const val SECOND_ADMIN_SESSION_AUTHORITY_CREATED = false
    const val ADMIN_SIGNING_PUBKEY_DERIVED_FROM_SECURE_IDENTITY = true
    const val CALLER_CAN_SELECT_ADMIN_PRIVATE_KEY = false
    const val CALLER_CAN_SELECT_ADMIN_PUBKEY = false
    const val MEMBERSHIP_BLOCKLIST_SEMANTICS_UNCHANGED = true
    const val INVITE_POLICY_SECURITY_REGRESSION = false
    const val ROOT_MEMBER_PROTECTION_PRESERVED = true
    const val ARBITRARY_MEMBERSHIP_STATE_ACCEPTED = false
    const val NATIVE_ADMIN_POLICY_REQUIRES_REMOTE_API = false
    const val NATIVE_ADMIN_POLICY_REQUIRES_CLOUDFLARE = false
    const val NATIVE_ADMIN_POLICY_REQUIRES_SIGNER_HOST = false

    data class CapabilityRequirement(
        val anyOf: Set<String> = emptySet(),
        val rootOnly: Boolean = false,
        /** Root always satisfies; when true root-only and delegated never. */
        val allowRootBypass: Boolean = true,
    )

    /** Verified authority snapshot — NOT caller-supplied control state. */
    data class VerifiedControlSnapshot(
        val groupId: String,
        val controlEpoch: Int,
        val rootAdminPubkey: String,
        val capabilities: Map<String, List<String>>,
        val invitePolicy: String,
        val blockedPubkeys: List<String>,
        val membershipEpoch: Int,
        val displayName: String,
        val networkTag: String,
        val baseProvenLatest: Boolean = false,
    ) {
        companion object {
            /**
             * Build from a signature-verified base event content.
             * Caller must prove event signature before invoking.
             */
            fun fromVerifiedControlBody(body: JSONObject, baseProvenLatest: Boolean = false): VerifiedControlSnapshot {
                if (body.optString("schema") != SCHEMA_CONTROL) error("BAD_BASE_SCHEMA")
                val groupId = body.optString("groupId").trim()
                if (groupId.isEmpty() || groupId.length > COMMUNITY_ID_MAX) error("BAD_BASE_GROUP")
                val root = SosSecureIdentityStore.normalizeHex(body.optString("rootAdminPubkey"))
                if (!SosSecureIdentityStore.isHex64(root)) error("BAD_BASE_ROOT")
                val epoch = body.optInt("controlEpoch", -1)
                if (epoch < 1) error("BAD_BASE_EPOCH")
                val capsObj = body.optJSONObject("capabilities") ?: JSONObject()
                val caps = LinkedHashMap<String, List<String>>()
                val keys = capsObj.keys()
                while (keys.hasNext()) {
                    val pk = SosSecureIdentityStore.normalizeHex(keys.next())
                    val arr = capsObj.optJSONArray(pk) ?: JSONArray()
                    val list = ArrayList<String>()
                    for (i in 0 until arr.length()) list.add(arr.optString(i))
                    caps[pk] = list
                }
                val settings = body.optJSONObject("groupSettings") ?: JSONObject()
                val blocked = ArrayList<String>()
                val ba = body.optJSONArray("blockedPubkeys") ?: JSONArray()
                for (i in 0 until ba.length()) {
                    val p = SosSecureIdentityStore.normalizeHex(ba.optString(i))
                    if (SosSecureIdentityStore.isHex64(p)) blocked.add(p)
                }
                return VerifiedControlSnapshot(
                    groupId = groupId,
                    controlEpoch = epoch,
                    rootAdminPubkey = root,
                    capabilities = caps,
                    invitePolicy = body.optString("invitePolicy", "EVERYONE"),
                    blockedPubkeys = blocked,
                    membershipEpoch = body.optInt("membershipEpoch", 1),
                    displayName = settings.optString("displayName", ""),
                    networkTag = settings.optString("networkTag", groupId),
                    baseProvenLatest = baseProvenLatest,
                )
            }
        }
    }

    data class TypedAdminRequest(
        val operation: AdminOp,
        val communityId: String,
        val params: Map<String, Any?> = emptyMap(),
        /** Claims only — never authority. */
        val claimControlEpoch: Int? = null,
        val claimCapabilities: Map<String, List<String>>? = null,
        val claimRootPubkey: String? = null,
        val kindOverride: Int? = null,
        val pubkeyOverride: String? = null,
        val completeEvent: JSONObject? = null,
        val actorMembershipStatus: String? = null,
        val controlConflict: Boolean = false,
        val memberConflict: Boolean = false,
    )

    sealed class PolicyResult {
        data class Allowed(
            val op: AdminOp,
            val family: OpFamily,
            val communityId: String,
            val confirmation: ConfirmClass,
            val requiredCapabilities: Set<String>,
            val constructedKind: Int,
            val nextControl: JSONObject? = null,
            val nextMembership: JSONObject? = null,
            val note: String = "",
        ) : PolicyResult()

        data class Denied(val code: String) : PolicyResult()
    }

    fun familyOf(op: AdminOp): OpFamily = when (op) {
        AdminOp.GRANT_MEMBER_ACTIVE,
        AdminOp.BLOCK_MEMBER,
        AdminOp.UNBLOCK_MEMBER,
        AdminOp.REMOVE_MEMBER,
        AdminOp.RESOLVE_MEMBERSHIP_CONFLICT,
        AdminOp.BOOTSTRAP_MEMBER_ACTIVE,
        -> OpFamily.MEMBERSHIP
        else -> OpFamily.CONTROL
    }

    fun confirmationFor(op: AdminOp): ConfirmClass {
        // Conservative F6E: all admin ops require F6G trusted UI before sign.
        return when (op) {
            AdminOp.SET_GROUP_DISPLAY_NAME,
            AdminOp.SET_INVITE_POLICY,
            AdminOp.GRANT_CAPABILITY,
            AdminOp.REVOKE_CAPABILITY,
            AdminOp.ADD_MEMBER_TO_BLOCKLIST,
            AdminOp.REMOVE_MEMBER_FROM_BLOCKLIST,
            AdminOp.CLEAN_REMOVED_MEMBER_CAPABILITIES,
            AdminOp.RESOLVE_CONTROL_CONFLICT,
            AdminOp.BOOTSTRAP_GROUP_CONTROL,
            AdminOp.GRANT_MEMBER_ACTIVE,
            AdminOp.BLOCK_MEMBER,
            AdminOp.UNBLOCK_MEMBER,
            AdminOp.REMOVE_MEMBER,
            AdminOp.RESOLVE_MEMBERSHIP_CONFLICT,
            AdminOp.BOOTSTRAP_MEMBER_ACTIVE,
            -> ConfirmClass.NATIVE_CONFIRM_REQUIRED
        }
    }

    fun requiredCapabilities(op: AdminOp): CapabilityRequirement = when (op) {
        AdminOp.SET_GROUP_DISPLAY_NAME -> CapabilityRequirement(anyOf = setOf("MANAGE_GROUP_SETTINGS"))
        AdminOp.SET_INVITE_POLICY -> CapabilityRequirement(anyOf = setOf("MANAGE_INVITES"))
        AdminOp.GRANT_CAPABILITY, AdminOp.REVOKE_CAPABILITY ->
            CapabilityRequirement(anyOf = setOf("MANAGE_PERMISSIONS", "MANAGE_ADMINS"))
        AdminOp.ADD_MEMBER_TO_BLOCKLIST, AdminOp.REMOVE_MEMBER_FROM_BLOCKLIST ->
            CapabilityRequirement(anyOf = setOf("MANAGE_BLOCKLIST", "MANAGE_MEMBERS"))
        AdminOp.CLEAN_REMOVED_MEMBER_CAPABILITIES ->
            CapabilityRequirement(anyOf = setOf("MANAGE_MEMBERS"))
        AdminOp.RESOLVE_CONTROL_CONFLICT -> CapabilityRequirement(rootOnly = true)
        AdminOp.BOOTSTRAP_GROUP_CONTROL -> CapabilityRequirement(rootOnly = true)
        AdminOp.GRANT_MEMBER_ACTIVE -> CapabilityRequirement(anyOf = setOf("MANAGE_MEMBERS"))
        AdminOp.BLOCK_MEMBER ->
            CapabilityRequirement(anyOf = setOf("MANAGE_BLOCKLIST", "MANAGE_MEMBERS"))
        AdminOp.UNBLOCK_MEMBER ->
            CapabilityRequirement(anyOf = setOf("MANAGE_BLOCKLIST", "MANAGE_MEMBERS"))
        AdminOp.REMOVE_MEMBER -> CapabilityRequirement(anyOf = setOf("MANAGE_MEMBERS"))
        AdminOp.RESOLVE_MEMBERSHIP_CONFLICT -> CapabilityRequirement(rootOnly = true)
        AdminOp.BOOTSTRAP_MEMBER_ACTIVE -> CapabilityRequirement(rootOnly = true)
    }

    fun isRootOnly(op: AdminOp): Boolean = requiredCapabilities(op).rootOnly

    class Engine(
        private val nowSec: () -> Long = { System.currentTimeMillis() / 1000L },
    ) {
        /**
         * Evaluate typed admin intent against verified snapshot + actor pubkey.
         * Does not use private keys. Does not accept caller control state as authority.
         */
        fun evaluate(
            actorPubkey: String,
            request: TypedAdminRequest,
            verified: VerifiedControlSnapshot?,
        ): PolicyResult {
            val actor = SosSecureIdentityStore.normalizeHex(actorPubkey)
            if (!SosSecureIdentityStore.isHex64(actor)) return PolicyResult.Denied("NO_ACTOR")

            // Reject caller overrides / arbitrary event
            if (request.kindOverride != null) return PolicyResult.Denied("CALLER_KIND_OVERRIDE")
            if (request.pubkeyOverride != null) return PolicyResult.Denied("CALLER_PUBKEY_OVERRIDE")
            if (request.completeEvent != null) return PolicyResult.Denied("ARBITRARY_EVENT_FIELDS")
            if (request.claimControlEpoch != null) return PolicyResult.Denied("CALLER_EPOCH_OVERRIDE")
            if (request.claimCapabilities != null) return PolicyResult.Denied("CALLER_CAPABILITY_SET_AUTHORITY")
            if (request.claimRootPubkey != null) return PolicyResult.Denied("CALLER_ROOT_OVERRIDE")

            val communityId = request.communityId.trim()
            if (communityId.isEmpty() || communityId.length > COMMUNITY_ID_MAX) {
                return PolicyResult.Denied("EXPLICIT_COMMUNITY_SCOPE_REQUIRED")
            }
            // Never use ambient activeCommunity — only explicit communityId.

            val op = request.operation
            val confirm = confirmationFor(op)
            val capsReq = requiredCapabilities(op)

            if (op == AdminOp.BOOTSTRAP_GROUP_CONTROL) {
                // Bootstrap: no prior verified base; actor becomes root for new group.
                if (verified != null) return PolicyResult.Denied("BOOTSTRAP_WITH_EXISTING_BASE")
                val invite = request.params["invitePolicy"]?.toString() ?: "EVERYONE"
                if (invite !in INVITE_POLICIES) return PolicyResult.Denied("BAD_INVITE_POLICY")
                val name = sanitizeDisplayName(request.params["displayName"]?.toString() ?: "Community")
                if (name.isEmpty()) return PolicyResult.Denied("EMPTY_DISPLAY_NAME")
                val next = JSONObject()
                    .put("schema", SCHEMA_CONTROL)
                    .put("version", 1)
                    .put("groupId", communityId)
                    .put("controlEpoch", 1)
                    .put("rootAdminPubkey", actor)
                    .put("capabilities", JSONObject())
                    .put("invitePolicy", invite)
                    .put("blockedPubkeys", JSONArray())
                    .put("membershipEpoch", 1)
                    .put(
                        "groupSettings",
                        JSONObject().put("displayName", name).put("networkTag", communityId),
                    )
                    .put("createdAt", nowSec())
                return PolicyResult.Allowed(
                    op = op,
                    family = OpFamily.CONTROL,
                    communityId = communityId,
                    confirmation = confirm,
                    requiredCapabilities = emptySet(),
                    constructedKind = GROUP_CONTROL_KIND,
                    nextControl = next,
                    note = "ROOT_BOOTSTRAP",
                )
            }

            if (verified == null) return PolicyResult.Denied("NO_VERIFIED_BASE")
            if (verified.groupId != communityId) return PolicyResult.Denied("CROSS_COMMUNITY")
            if (!verified.baseProvenLatest) {
                // Do not auto-accept stale/unproven base as latest.
                return PolicyResult.Denied("LATEST_STATE_NOT_PROVEN")
            }

            if (request.controlConflict && op != AdminOp.RESOLVE_CONTROL_CONFLICT) {
                return PolicyResult.Denied("CONTROL_CONFLICT")
            }
            if (request.memberConflict && op != AdminOp.RESOLVE_MEMBERSHIP_CONFLICT) {
                return PolicyResult.Denied("MEMBER_CONFLICT")
            }

            val isRoot = actor == verified.rootAdminPubkey
            if (!isRoot) {
                val mstat = request.actorMembershipStatus
                if (mstat == "BLOCKED" || mstat == "REMOVED" || mstat == "CONFLICT") {
                    return PolicyResult.Denied("MEMBERSHIP_BLOCKS_ADMIN")
                }
            }

            if (capsReq.rootOnly && !isRoot) {
                return PolicyResult.Denied(
                    if (op == AdminOp.RESOLVE_CONTROL_CONFLICT) "ROOT_RESOLVE_REQUIRED" else "ROOT_ONLY",
                )
            }
            if (!capsReq.rootOnly && !isRoot) {
                val held = verified.capabilities[actor] ?: emptyList()
                if (capsReq.anyOf.none { held.contains(it) }) {
                    return PolicyResult.Denied("UNAUTHORIZED")
                }
            }

            return when (familyOf(op)) {
                OpFamily.CONTROL -> evaluateControl(actor, isRoot, op, communityId, confirm, capsReq, verified, request)
                OpFamily.MEMBERSHIP -> evaluateMembership(actor, isRoot, op, communityId, confirm, capsReq, verified, request)
            }
        }

        private fun evaluateControl(
            @Suppress("UNUSED_PARAMETER") actor: String,
            isRoot: Boolean,
            op: AdminOp,
            communityId: String,
            confirm: ConfirmClass,
            capsReq: CapabilityRequirement,
            verified: VerifiedControlSnapshot,
            request: TypedAdminRequest,
        ): PolicyResult {
            if (op == AdminOp.RESOLVE_CONTROL_CONFLICT) {
                val candidates = request.params["candidateEventIds"]
                if (candidates !is List<*> || candidates.isEmpty() || candidates.size > MAX_CANDIDATES) {
                    return PolicyResult.Denied("BAD_CANDIDATES")
                }
                for (c in candidates) {
                    val s = c?.toString().orEmpty()
                    if (s.length < 8 || s.length > 128) return PolicyResult.Denied("BAD_CANDIDATE_ID")
                }
            }

            if (op == AdminOp.GRANT_CAPABILITY || op == AdminOp.REVOKE_CAPABILITY) {
                val target = SosSecureIdentityStore.normalizeHex(request.params["targetPubkey"]?.toString())
                if (!SosSecureIdentityStore.isHex64(target)) return PolicyResult.Denied("INVALID_PUBKEY")
                if (target == verified.rootAdminPubkey) return PolicyResult.Denied("ROOT_TARGET_FORBIDDEN")
                val cap = request.params["capability"]?.toString().orEmpty()
                if (cap == "ROOT_ADMIN") return PolicyResult.Denied("ROOT_ADMIN_NOT_GRANTABLE")
                if (cap !in MAP_CAPABILITIES) return PolicyResult.Denied("UNKNOWN_CAPABILITY")
                if (!isRoot) {
                    if (cap !in DELEGABLE_BY_PERMISSION_MANAGER) return PolicyResult.Denied("DELEGATION_ESCALATION")
                    if (cap == "MANAGE_ADMINS" || cap == "MANAGE_PERMISSIONS") {
                        return PolicyResult.Denied("DELEGATION_ESCALATION")
                    }
                }
            }

            if (op == AdminOp.SET_GROUP_DISPLAY_NAME) {
                val name = sanitizeDisplayName(request.params["displayName"]?.toString())
                if (name.isEmpty()) return PolicyResult.Denied("EMPTY_DISPLAY_NAME")
            }
            if (op == AdminOp.SET_INVITE_POLICY) {
                val pol = request.params["invitePolicy"]?.toString().orEmpty()
                if (pol !in INVITE_POLICIES) return PolicyResult.Denied("BAD_INVITE_POLICY")
            }
            if (op == AdminOp.ADD_MEMBER_TO_BLOCKLIST || op == AdminOp.REMOVE_MEMBER_FROM_BLOCKLIST) {
                val target = SosSecureIdentityStore.normalizeHex(request.params["targetPubkey"]?.toString())
                if (!SosSecureIdentityStore.isHex64(target)) return PolicyResult.Denied("INVALID_PUBKEY")
                if (target == verified.rootAdminPubkey) return PolicyResult.Denied("ROOT_TARGET_FORBIDDEN")
            }

            val nextEpoch = if (op == AdminOp.RESOLVE_CONTROL_CONFLICT) {
                verified.controlEpoch + 2
            } else {
                verified.controlEpoch + 1
            }
            val next = JSONObject()
                .put("schema", SCHEMA_CONTROL)
                .put("version", 1)
                .put("groupId", verified.groupId)
                .put("controlEpoch", nextEpoch)
                .put("rootAdminPubkey", verified.rootAdminPubkey)
                .put("invitePolicy", verified.invitePolicy)
                .put("membershipEpoch", verified.membershipEpoch)
                .put("createdAt", nowSec())
                .put(
                    "groupSettings",
                    JSONObject()
                        .put("displayName", verified.displayName)
                        .put("networkTag", verified.networkTag),
                )
            // Caps / blocklist cloned shallowly for constructed next-state sketch
            val capsJson = JSONObject()
            verified.capabilities.forEach { (k, v) -> capsJson.put(k, JSONArray(v)) }
            next.put("capabilities", capsJson)
            next.put("blockedPubkeys", JSONArray(verified.blockedPubkeys))

            return PolicyResult.Allowed(
                op = op,
                family = OpFamily.CONTROL,
                communityId = communityId,
                confirmation = confirm,
                requiredCapabilities = capsReq.anyOf,
                constructedKind = GROUP_CONTROL_KIND,
                nextControl = next,
            )
        }

        private fun evaluateMembership(
            actor: String,
            @Suppress("UNUSED_PARAMETER") isRoot: Boolean,
            op: AdminOp,
            communityId: String,
            confirm: ConfirmClass,
            capsReq: CapabilityRequirement,
            verified: VerifiedControlSnapshot,
            request: TypedAdminRequest,
        ): PolicyResult {
            val member = SosSecureIdentityStore.normalizeHex(request.params["memberPubkey"]?.toString())
            if (!SosSecureIdentityStore.isHex64(member)) return PolicyResult.Denied("INVALID_PUBKEY")
            if (member == verified.rootAdminPubkey) {
                if (op == AdminOp.BLOCK_MEMBER || op == AdminOp.REMOVE_MEMBER) {
                    return PolicyResult.Denied("ROOT_PROTECTED")
                }
                if (op == AdminOp.RESOLVE_MEMBERSHIP_CONFLICT &&
                    request.params["status"]?.toString() != "ACTIVE"
                ) {
                    return PolicyResult.Denied("ROOT_PROTECTED")
                }
            }
            if (op == AdminOp.BLOCK_MEMBER && actor == member) return PolicyResult.Denied("SELF_BLOCK")
            if (op == AdminOp.UNBLOCK_MEMBER && actor == member) return PolicyResult.Denied("SELF_UNBLOCK")

            val status = when (op) {
                AdminOp.GRANT_MEMBER_ACTIVE, AdminOp.BOOTSTRAP_MEMBER_ACTIVE, AdminOp.UNBLOCK_MEMBER -> "ACTIVE"
                AdminOp.BLOCK_MEMBER -> "BLOCKED"
                AdminOp.REMOVE_MEMBER -> "REMOVED"
                AdminOp.RESOLVE_MEMBERSHIP_CONFLICT -> {
                    val s = request.params["status"]?.toString().orEmpty()
                    if (s !in setOf("ACTIVE", "BLOCKED", "REMOVED")) return PolicyResult.Denied("BAD_STATUS")
                    s
                }
                else -> return PolicyResult.Denied("UNKNOWN_OP")
            }

            val body = JSONObject()
                .put("schema", SCHEMA_MEMBER)
                .put("version", 1)
                .put("groupId", verified.groupId)
                .put("memberPubkey", member)
                .put("status", status)
                .put("memberRevision", 1)
                .put("controlEpochAtIssue", verified.controlEpoch)
                .put("membershipEpoch", verified.membershipEpoch)
                .put("issuerPubkey", actor)
                .put("createdAt", nowSec())

            return PolicyResult.Allowed(
                op = op,
                family = OpFamily.MEMBERSHIP,
                communityId = communityId,
                confirmation = confirm,
                requiredCapabilities = capsReq.anyOf,
                constructedKind = MEMBERSHIP_KIND,
                nextMembership = body,
            )
        }
    }

    fun sanitizeDisplayName(raw: String?): String {
        var s = (raw ?: "").replace(Regex("[<>]"), "").replace(Regex("[\\u0000-\\u001f\\u007f]"), "")
        s = s.replace(Regex("\\s+"), " ").trim()
        if (s.length > DISPLAY_NAME_MAX) s = s.take(DISPLAY_NAME_MAX)
        return s
    }

    fun engineForTests(nowSec: () -> Long = { System.currentTimeMillis() / 1000L }): Engine =
        Engine(nowSec)

    fun capabilityMappingJson(): JSONObject {
        val o = JSONObject()
        AdminOp.values().forEach { op ->
            val req = requiredCapabilities(op)
            o.put(
                op.name,
                JSONObject()
                    .put("anyOf", JSONArray(req.anyOf.toList()))
                    .put("rootOnly", req.rootOnly)
                    .put("confirmation", confirmationFor(op).name)
                    .put("family", familyOf(op).name)
                    .put("kind", if (familyOf(op) == OpFamily.CONTROL) GROUP_CONTROL_KIND else MEMBERSHIP_KIND),
            )
        }
        return o
    }
}
