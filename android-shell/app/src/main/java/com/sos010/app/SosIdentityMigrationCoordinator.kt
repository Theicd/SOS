package com.sos010.app

import fr.acinq.secp256k1.Hex
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference

/**
 * F6H — Orchestration + safe UI state for sealed same-identity migration / recovery.
 *
 * Calls existing MD3 registry, F6G.3, and F5B6. Does NOT invent crypto.
 * Does NOT sync history. Does NOT implement Recovery Capsule / MD7 desktop recovery.
 * HYPER CORE TECH
 */
object SosIdentityMigrationCoordinator {

    const val F6H_ORCHESTRATOR_PRESENT = true
    const val F6H_USES_F5B6 = true
    const val F6H_USES_F6G3 = true
    const val F6H_PARALLEL_WEAKER_MIGRATION_CRYPTO = false
    const val F6H_PRESERVES_SAME_K = true
    const val F6H_PRESERVES_SAME_P = true
    const val F6H_SILENT_IDENTITY_ROTATION = false
    const val F6H_MIGRATION_REQUIRES_EXPLICIT_USER_ACTION = true
    const val F6H_REQUIRES_FRESH_STRONG_CONFIRM = true
    const val F6H_STRONG_CONFIRM_REUSE_WINDOW_SECONDS = 0
    const val F6H_STORES_REUSABLE_STRONG_CONFIRM_TOKEN = false
    const val F6H_HISTORY_SYNC_IMPLEMENTED = false
    const val F6H_RECOVERY_CAPSULE_IMPLEMENTED = false
    const val FULL_DESKTOP_TO_NEW_PHONE_RECOVERY_IMPLEMENTED = false
    const val WINDOWS_F6H_RUNTIME_IMPLEMENTED = false
    const val F6H_ANDROID_FLOW_IMPLEMENTED = true
    const val F6H_CHANGES_MAX_LINKED_DEVICES = false
    const val F6H_SILENTLY_GRANTS_DEVICE_RECOVERY = false
    const val F6H_REIMPLEMENTS_MD2_PAIRING = false
    const val F6H_GENERIC_SECRET_BRIDGE_ADDED = false
    const val F6H_NSEC_CREATED = false
    const val F6H_NSEC_DISPLAYED = false
    const val F5B5_EMERGENCY_RECOVERY_PATH_UNCHANGED = true
    const val F6H_PERSISTED_MIGRATION_METADATA =
        "NONE_DURABLE; ceremony state is in-memory only (uiId, public device summary, phase)"
    const val F6H_PRODUCT_MODES = "MIGRATE_TO_LINKED_DEVICE|RESTORE_ON_AUTHORIZED_DEVICE"

    /** Hebrew / product copy — no crypto jargon. */
    object Copy {
        const val ACTION_MIGRATE = "העבר/שחזר את החשבון במכשיר זה"
        const val TITLE_CONFIRM = "אישור העברת החשבון"
        const val BODY_SAME_ACCOUNT =
            "החשבון הנוכחי יועבר בצורה מאובטחת למכשיר המקושר שנבחר. זהו אותו חשבון — לא נוצר חשבון חדש."
        const val SUCCESS_SOURCE = "החשבון הועבר בהצלחה"
        const val SUCCESS_DEST = "החשבון שוחזר בהצלחה"
        const val HISTORY_NOTE = "זהות החשבון שוחזרה. סנכרון השיחות יתבצע בשלב הסנכרון."
        const val ERR_NOT_AUTHORIZED = "המכשיר כבר לא מורשה"
        const val ERR_AUTH_CANCELLED = "האימות בוטל"
        const val ERR_CONNECTION = "החיבור הופרע"
        const val ERR_ACCOUNT_MISMATCH = "אי-התאמה בחשבון"
        const val ERR_EXPIRED = "פג תוקף ההעברה"
        const val ERR_GENERIC = "ההעברה נכשלה"
        const val RECOVERY_STATUS_YES = "מכשיר לשחזור"
    }

    enum class ProductMode {
        MIGRATE_TO_LINKED_DEVICE,
        RESTORE_ON_AUTHORIZED_DEVICE,
    }

    enum class SourcePhase {
        IDLE,
        SELECT_DESTINATION,
        VALIDATING_DESTINATION,
        READY_FOR_CONFIRMATION,
        STRONG_CONFIRM_ACTIVE,
        SEALING,
        DELIVERING,
        WAITING_DESTINATION_ACK,
        COMPLETE,
        CANCELLED,
        EXPIRED,
        FAILED,
    }

    enum class DestPhase {
        IDLE,
        WAITING_FOR_MIGRATION,
        ENVELOPE_RECEIVED,
        VERIFYING_SOURCE,
        DECRYPTING,
        VERIFYING_IDENTITY,
        IMPORTING,
        ACKNOWLEDGING,
        COMPLETE,
        FAILED,
    }

    data class SafeDeviceSummary(
        val deviceId: String,
        val authorizationId: String,
        val deviceLabel: String,
        val deviceType: String,
        val fingerprint: String,
        val linkedAtMs: Long,
        val recoveryEligible: Boolean,
        val authEpoch: Long,
    ) {
        fun toPublicJson(): JSONObject = JSONObject()
            .put("deviceId", deviceId)
            .put("authorizationId", authorizationId)
            .put("deviceLabel", deviceLabel)
            .put("deviceType", deviceType)
            .put("fingerprint", fingerprint)
            .put("linkedAtMs", linkedAtMs)
            .put("recoveryEligible", recoveryEligible)
            .put("authEpoch", authEpoch)
            .put("recoveryStatusLabel", if (recoveryEligible) Copy.RECOVERY_STATUS_YES else "")
    }

    data class UiState(
        val uiId: String,
        val mode: ProductMode,
        val sourcePhase: SourcePhase,
        val destPhase: DestPhase,
        val title: String,
        val body: String,
        val errorSafe: String,
        val selectedDevice: SafeDeviceSummary?,
        val accountFingerprint: String,
        val historyNote: String,
        val canCancel: Boolean,
        val isSuccess: Boolean,
    ) {
        fun toPublicJson(): JSONObject = JSONObject()
            .put("uiId", uiId)
            .put("mode", mode.name)
            .put("sourcePhase", sourcePhase.name)
            .put("destPhase", destPhase.name)
            .put("title", title)
            .put("body", body)
            .put("errorSafe", errorSafe)
            .put("selectedDevice", selectedDevice?.toPublicJson())
            .put("accountFingerprint", accountFingerprint)
            .put("historyNote", historyNote)
            .put("canCancel", canCancel)
            .put("isSuccess", isSuccess)
            .put("historySyncClaimed", false)
    }

    sealed class Outcome {
        data class Ok(val ui: UiState, val value: Any? = null) : Outcome()
        data class Err(val code: String, val ui: UiState) : Outcome()
    }

    fun interface SessionGate {
        fun validate(sessionCapability: String, accountP: String, sessionGeneration: Long): String?
    }

    fun interface IdentityReader {
        fun readRootIdentity(): Pair<ByteArray, String>?
    }

    fun interface IdentityWriter {
        fun importSameAccount(kBytes: ByteArray, expectedP: String): String?
    }

    fun interface ExistingAccountProbe {
        fun existingAccountP(): String?
    }

    fun interface DeliveryChannel {
        /** Deliver sealed envelope JSON. Return null on success, else error code. */
        fun deliver(envelopeJson: String): String?
    }

    interface DestDeviceOps : SosSealedIdentityMigration.DestinationDeviceOps

    private data class ActiveCeremony(
        val uiId: String,
        val mode: ProductMode,
        var accountP: String,
        val sessionCapability: String,
        val sessionGeneration: Long,
        val selected: SafeDeviceSummary,
        var sourcePhase: SourcePhase,
        var destPhase: DestPhase = DestPhase.IDLE,
        var errorSafe: String = "",
        var sourceEngine: SosSealedIdentityMigration.SourceEngine? = null,
        var lastEnvelopeJson: String? = null,
        var lastAck: SosSealedIdentityMigration.Ack? = null,
        var rootKReadsObserved: Int = 0,
    )

    class Engine(
        private val registry: SosDeviceAuthorizationRegistry,
        private val identity: IdentityReader,
        private val sessionGate: SessionGate,
        private val strongAuthDriver: SosNativeStrongConfirmation.StrongAuthDriver,
        private val wrapCrypto: SosNativeStrongConfirmation.ConfirmWrapCrypto,
        private val delivery: DeliveryChannel,
        private val destOps: DestDeviceOps? = null,
        private val destWriter: IdentityWriter? = null,
        private val destExisting: ExistingAccountProbe? = null,
        private val nowMs: () -> Long = { System.currentTimeMillis() },
        private val random: SecureRandom = SecureRandom(),
    ) {
        private val active = AtomicReference<ActiveCeremony?>(null)
        private val destSpent = java.util.concurrent.ConcurrentHashMap<String, Pair<String, SosSealedIdentityMigration.Ack>>()
        private var lastSuccessfulRootReads = 0

        fun sourcePhase(): SourcePhase = active.get()?.sourcePhase ?: SourcePhase.IDLE
        fun destPhase(): DestPhase = active.get()?.destPhase ?: DestPhase.IDLE
        fun preauthRootKReadCount(): Int = 0 // F6H never reads K itself
        fun successfulRootKReadCount(): Int = lastSuccessfulRootReads
        fun uiState(): UiState = buildUi(active.get())

        /** Recovery-capable ACTIVE devices only — public metadata. */
        fun listRecoveryEligibleLinkedDevices(accountP: String, nowMs: Long = this.nowMs()): List<SafeDeviceSummary> {
            val account = SosDeviceKeyCrypto.normalizeHex(accountP)
            registry.refreshExpired(account, nowMs)
            return registry.entries(account).mapNotNull { e ->
                if (e.status != SosDeviceAuthorization.Status.ACTIVE) return@mapNotNull null
                if (nowMs > e.expiresAt) return@mapNotNull null
                if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in e.capabilities) return@mapNotNull null
                val auth = try {
                    SosDeviceAuthorization.Authorization.fromJson(JSONObject(e.signedAuthorizationJson))
                } catch (_: Exception) {
                    return@mapNotNull null
                }
                when (SosDeviceAuthorization.verifyStrict(auth, nowMs)) {
                    is SosDeviceAuthorization.VerifyResult.Err -> return@mapNotNull null
                    SosDeviceAuthorization.VerifyResult.Ok -> Unit
                }
                SafeDeviceSummary(
                    deviceId = e.deviceId,
                    authorizationId = e.authorizationId,
                    deviceLabel = e.deviceLabel.ifBlank { "מכשיר מקושר" },
                    deviceType = e.deviceType.ifBlank { "OTHER" },
                    fingerprint = SosPairingCrypto.deviceFingerprint(e.dSignPub, e.dEncPub),
                    linkedAtMs = e.createdAt,
                    recoveryEligible = true,
                    authEpoch = e.authEpoch,
                )
            }
        }

        fun listRecoveryEligiblePublicJson(accountP: String): String {
            val arr = JSONArray()
            for (d in listRecoveryEligibleLinkedDevices(accountP)) arr.put(d.toPublicJson())
            return JSONObject().put("ok", true).put("devices", arr).toString()
        }

        /**
         * Explicit user action: begin migration to an already-authorized recovery device.
         * deviceId selects from registry — caller cannot supply D_enc.
         */
        fun beginMigration(
            accountP: String,
            deviceId: String,
            sessionCapability: String,
            sessionGeneration: Long,
            mode: ProductMode = ProductMode.MIGRATE_TO_LINKED_DEVICE,
        ): Outcome {
            val existing = active.get()
            if (existing != null &&
                existing.sourcePhase != SourcePhase.COMPLETE &&
                existing.sourcePhase != SourcePhase.CANCELLED &&
                existing.sourcePhase != SourcePhase.FAILED &&
                existing.sourcePhase != SourcePhase.EXPIRED &&
                existing.sourcePhase != SourcePhase.IDLE
            ) {
                return Outcome.Err("MIGRATION_ALREADY_ACTIVE", buildUi(existing))
            }

            val account = SosDeviceKeyCrypto.normalizeHex(accountP)
            val sessErr = sessionGate.validate(sessionCapability, account, sessionGeneration)
            if (sessErr != null) {
                return Outcome.Err(sessErr, idleUi(account, SourcePhase.FAILED, mapError(sessErr)))
            }

            val targets = listRecoveryEligibleLinkedDevices(account)
            val selected = targets.firstOrNull {
                SosDeviceKeyCrypto.normalizeHex(it.deviceId) == SosDeviceKeyCrypto.normalizeHex(deviceId)
            } ?: return Outcome.Err(
                "DEVICE_NOT_ELIGIBLE",
                idleUi(account, SourcePhase.FAILED, Copy.ERR_NOT_AUTHORIZED),
            )

            val uiId = Hex.encode(ByteArray(16).also { random.nextBytes(it) })
            val ceremony = ActiveCeremony(
                uiId = uiId,
                mode = mode,
                accountP = account,
                sessionCapability = sessionCapability,
                sessionGeneration = sessionGeneration,
                selected = selected,
                sourcePhase = SourcePhase.VALIDATING_DESTINATION,
            )
            active.set(ceremony)

            // Re-validate destination authority from registry / signed auth
            val auth = lookupAuth(account, selected.authorizationId) ?: run {
                ceremony.sourcePhase = SourcePhase.FAILED
                ceremony.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("NO_ACTIVE_DEVICE_AUTH", buildUi(ceremony))
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                ceremony.sourcePhase = SourcePhase.FAILED
                ceremony.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("MISSING_DEVICE_RECOVERY", buildUi(ceremony))
            }
            if (auth.authEpoch != selected.authEpoch) {
                ceremony.sourcePhase = SourcePhase.FAILED
                ceremony.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("AUTH_EPOCH_MISMATCH", buildUi(ceremony))
            }

            ceremony.sourcePhase = SourcePhase.READY_FOR_CONFIRMATION
            return Outcome.Ok(buildUi(ceremony))
        }

        /** After user reads warning — launch F6G.3 → F5B6 seal → deliver → ACK. */
        fun confirmAndSeal(uiId: String): Outcome {
            val c = active.get() ?: return Outcome.Err("NO_ACTIVE", idleUi("", SourcePhase.FAILED, Copy.ERR_GENERIC))
            if (c.uiId != uiId) return Outcome.Err("UI_MISMATCH", buildUi(c))
            if (c.sourcePhase != SourcePhase.READY_FOR_CONFIRMATION) {
                return Outcome.Err("BAD_PHASE_${c.sourcePhase}", buildUi(c))
            }

            // Revalidate session + auth before confirm
            val sessErr = sessionGate.validate(c.sessionCapability, c.accountP, c.sessionGeneration)
            if (sessErr != null) {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = mapError(sessErr)
                return Outcome.Err(sessErr, buildUi(c))
            }
            val auth = lookupAuth(c.accountP, c.selected.authorizationId) ?: run {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("NO_ACTIVE_DEVICE_AUTH", buildUi(c))
            }
            if (SosDeviceAuthorization.Capability.DEVICE_RECOVERY !in auth.capabilities) {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("MISSING_DEVICE_RECOVERY", buildUi(c))
            }
            if (auth.authEpoch != c.selected.authEpoch ||
                SosDeviceKeyCrypto.normalizeHex(auth.deviceId) !=
                SosDeviceKeyCrypto.normalizeHex(c.selected.deviceId)
            ) {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_NOT_AUTHORIZED
                return Outcome.Err("DEVICE_AUTH_CHANGED", buildUi(c))
            }

            var identityReads = 0
            val src = SosSealedIdentityMigration.SourceEngine(
                identity = {
                    identityReads++
                    identity.readRootIdentity()
                },
                deviceAuth = { acc, id, now -> lookupAuth(acc, id, now) },
                sessionGate = { cap, acc, gen -> sessionGate.validate(cap, acc, gen) },
                strongAuthDriver = strongAuthDriver,
                wrapCrypto = wrapCrypto,
                nowMs = nowMs,
                random = random,
            )
            c.sourceEngine = src
            c.sourcePhase = SourcePhase.STRONG_CONFIRM_ACTIVE

            when (val prep = src.prepare(c.selected.authorizationId, c.sessionCapability, c.sessionGeneration, c.accountP)) {
                is SosSealedIdentityMigration.Result.Err -> {
                    c.sourcePhase = SourcePhase.FAILED
                    c.errorSafe = mapError(prep.code)
                    return Outcome.Err(prep.code, buildUi(c))
                }
                is SosSealedIdentityMigration.Result.Ok -> Unit
            }

            when (val conf = src.startStrongConfirm()) {
                is SosSealedIdentityMigration.Result.Err -> {
                    c.sourcePhase = when (conf.code) {
                        "USER_CANCEL", "CANCELLED" -> SourcePhase.CANCELLED
                        else -> SourcePhase.FAILED
                    }
                    c.errorSafe = mapError(conf.code)
                    return Outcome.Err(conf.code, buildUi(c))
                }
                is SosSealedIdentityMigration.Result.Ok -> Unit
            }

            if (src.state() != SosSealedIdentityMigration.State.SEALED) {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_GENERIC
                return Outcome.Err("SEAL_INCOMPLETE", buildUi(c))
            }
            c.rootKReadsObserved = identityReads
            lastSuccessfulRootReads = src.successfulRootKReadCount()
            c.sourcePhase = SourcePhase.SEALING

            val env = src.lastEnvelope() ?: run {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_GENERIC
                return Outcome.Err("NO_ENVELOPE", buildUi(c))
            }
            // Ensure no secret in UI-facing package
            val envJson = env.toJson().toString()
            if (envJsonContainsSecret(envJson)) {
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_GENERIC
                return Outcome.Err("SECRET_IN_ENVELOPE_SERIALIZATION", buildUi(c))
            }
            c.lastEnvelopeJson = envJson
            c.sourcePhase = SourcePhase.DELIVERING

            val deliverErr = delivery.deliver(envJson)
            if (deliverErr != null) {
                // Seal succeeded; transport failed — not COMPLETE; allow identical retransmit later
                c.sourcePhase = SourcePhase.WAITING_DESTINATION_ACK
                c.errorSafe = Copy.ERR_CONNECTION
                return Outcome.Err(deliverErr, buildUi(c))
            }
            src.markDelivered()
            c.sourcePhase = SourcePhase.WAITING_DESTINATION_ACK
            return Outcome.Ok(buildUi(c), envJson)
        }

        /** Source receives destination ACK (or retries identical delivery). */
        fun onDestinationAck(uiId: String, ackJson: String): Outcome {
            val c = active.get() ?: return Outcome.Err("NO_ACTIVE", idleUi("", SourcePhase.FAILED, Copy.ERR_GENERIC))
            if (c.uiId != uiId) return Outcome.Err("UI_MISMATCH", buildUi(c))
            if (c.sourcePhase == SourcePhase.COMPLETE && c.lastAck != null) {
                return Outcome.Ok(buildUi(c))
            }
            val src = c.sourceEngine ?: return Outcome.Err("NO_SOURCE", buildUi(c))
            val ack = SosSealedIdentityMigration.Ack.fromJson(JSONObject(ackJson))
                ?: return Outcome.Err("BAD_ACK", buildUi(c).also { c.errorSafe = Copy.ERR_GENERIC })
            return when (val v = src.verifyAck(ack)) {
                is SosSealedIdentityMigration.Result.Ok -> {
                    c.lastAck = ack
                    c.sourcePhase = SourcePhase.COMPLETE
                    c.errorSafe = ""
                    Outcome.Ok(buildUi(c))
                }
                is SosSealedIdentityMigration.Result.Err -> {
                    c.errorSafe = mapError(v.code)
                    Outcome.Err(v.code, buildUi(c))
                }
            }
        }

        /** Retransmit identical sealed envelope (F5B6 rules) — no new seal / no new biometric. */
        fun retransmitSealedEnvelope(uiId: String): Outcome {
            val c = active.get() ?: return Outcome.Err("NO_ACTIVE", idleUi("", SourcePhase.FAILED, Copy.ERR_GENERIC))
            if (c.uiId != uiId) return Outcome.Err("UI_MISMATCH", buildUi(c))
            val envJson = c.lastEnvelopeJson ?: return Outcome.Err("NO_ENVELOPE", buildUi(c))
            if (c.sourcePhase != SourcePhase.WAITING_DESTINATION_ACK &&
                c.sourcePhase != SourcePhase.DELIVERING
            ) {
                return Outcome.Err("BAD_PHASE", buildUi(c))
            }
            val err = delivery.deliver(envJson)
            if (err != null) {
                c.errorSafe = Copy.ERR_CONNECTION
                return Outcome.Err(err, buildUi(c))
            }
            return Outcome.Ok(buildUi(c), envJson)
        }

        /**
         * Destination: receive sealed envelope and import via F5B6 DestinationEngine.
         * Requires destOps/writer/existing injected for this device.
         */
        fun destinationReceive(envelopeJson: String): Outcome {
            val ops = destOps ?: return Outcome.Err(
                "DEST_NOT_CONFIGURED",
                idleUi("", SourcePhase.IDLE, Copy.ERR_GENERIC).copy(destPhase = DestPhase.FAILED),
            )
            val writer = destWriter ?: return Outcome.Err("DEST_NOT_CONFIGURED", idleUi("", SourcePhase.IDLE, Copy.ERR_GENERIC))
            val existing = destExisting ?: return Outcome.Err("DEST_NOT_CONFIGURED", idleUi("", SourcePhase.IDLE, Copy.ERR_GENERIC))

            var c = active.get()
            if (c == null) {
                c = ActiveCeremony(
                    uiId = Hex.encode(ByteArray(16).also { random.nextBytes(it) }),
                    mode = ProductMode.RESTORE_ON_AUTHORIZED_DEVICE,
                    accountP = "",
                    sessionCapability = "",
                    sessionGeneration = 0L,
                    selected = SafeDeviceSummary(
                        deviceId = ops.localDeviceId(),
                        authorizationId = "",
                        deviceLabel = "",
                        deviceType = "",
                        fingerprint = "",
                        linkedAtMs = 0L,
                        recoveryEligible = true,
                        authEpoch = 0L,
                    ),
                    sourcePhase = SourcePhase.IDLE,
                    destPhase = DestPhase.WAITING_FOR_MIGRATION,
                )
                active.set(c)
            }
            c.destPhase = DestPhase.ENVELOPE_RECEIVED
            c.destPhase = DestPhase.VERIFYING_SOURCE

            val dest = SosSealedIdentityMigration.DestinationEngine(
                device = ops,
                writer = { k, p -> writer.importSameAccount(k, p) },
                existing = { existing.existingAccountP() },
                deviceAuthLookup = { acc, id, now -> lookupAuth(acc, id, now) },
                spent = destSpent,
                nowMs = nowMs,
            )
            c.destPhase = DestPhase.DECRYPTING
            c.destPhase = DestPhase.VERIFYING_IDENTITY
            c.destPhase = DestPhase.IMPORTING
            return when (val r = dest.receiveAndImport(JSONObject(envelopeJson))) {
                is SosSealedIdentityMigration.Result.Ok -> {
                    c.destPhase = DestPhase.ACKNOWLEDGING
                    val ack = r.value as SosSealedIdentityMigration.Ack
                    c.accountP = ack.accountP
                    c.lastAck = ack
                    c.destPhase = DestPhase.COMPLETE
                    // Caller (source) must verify ACK explicitly via onDestinationAck — no auto-complete.
                    Outcome.Ok(buildUi(c), ack.toJson().toString())
                }
                is SosSealedIdentityMigration.Result.Err -> {
                    c.destPhase = DestPhase.FAILED
                    c.errorSafe = mapError(r.code)
                    Outcome.Err(r.code, buildUi(c))
                }
            }
        }

        fun cancel(uiId: String): Outcome {
            val c = active.get() ?: return Outcome.Ok(idleUi("", SourcePhase.IDLE, ""))
            if (c.uiId != uiId) return Outcome.Err("UI_MISMATCH", buildUi(c))
            if (c.sourcePhase == SourcePhase.COMPLETE) {
                return Outcome.Err("ALREADY_COMPLETE", buildUi(c))
            }
            c.sourceEngine?.cancel()
            c.sourcePhase = SourcePhase.CANCELLED
            c.errorSafe = ""
            c.lastEnvelopeJson = null
            active.set(null)
            return Outcome.Ok(idleUi(c.accountP, SourcePhase.CANCELLED, ""))
        }

        fun onBackground() {
            val c = active.get() ?: return
            if (c.sourcePhase == SourcePhase.STRONG_CONFIRM_ACTIVE ||
                c.sourcePhase == SourcePhase.READY_FOR_CONFIRMATION
            ) {
                c.sourceEngine?.invalidateOnRestart()
                c.sourcePhase = SourcePhase.FAILED
                c.errorSafe = Copy.ERR_GENERIC
                c.lastEnvelopeJson = null
            }
        }

        fun onProcessRestart() {
            active.get()?.sourceEngine?.invalidateOnRestart()
            active.set(null)
            // No durable approval — fresh ceremony required
        }

        fun onLogoutOrAccountSwitch() {
            active.get()?.sourceEngine?.cancel()
            active.set(null)
        }

        private fun lookupAuth(
            accountP: String,
            authorizationId: String,
            now: Long = nowMs(),
        ): SosDeviceAuthorization.Authorization? {
            registry.refreshExpired(accountP, now)
            val e = registry.get(accountP, authorizationId) ?: return null
            if (e.status != SosDeviceAuthorization.Status.ACTIVE) return null
            return try {
                SosDeviceAuthorization.Authorization.fromJson(JSONObject(e.signedAuthorizationJson))
            } catch (_: Exception) {
                null
            }
        }

        private fun buildUi(c: ActiveCeremony?): UiState {
            if (c == null) return idleUi("", SourcePhase.IDLE, "")
            val success = c.sourcePhase == SourcePhase.COMPLETE || c.destPhase == DestPhase.COMPLETE
            val title = when {
                success && c.mode == ProductMode.RESTORE_ON_AUTHORIZED_DEVICE -> Copy.SUCCESS_DEST
                success -> Copy.SUCCESS_SOURCE
                c.sourcePhase == SourcePhase.READY_FOR_CONFIRMATION ||
                    c.sourcePhase == SourcePhase.STRONG_CONFIRM_ACTIVE -> Copy.TITLE_CONFIRM
                else -> Copy.ACTION_MIGRATE
            }
            val body = when {
                success -> Copy.HISTORY_NOTE
                c.sourcePhase == SourcePhase.READY_FOR_CONFIRMATION ||
                    c.sourcePhase == SourcePhase.STRONG_CONFIRM_ACTIVE -> Copy.BODY_SAME_ACCOUNT
                else -> ""
            }
            return UiState(
                uiId = c.uiId,
                mode = c.mode,
                sourcePhase = c.sourcePhase,
                destPhase = c.destPhase,
                title = title,
                body = body,
                errorSafe = c.errorSafe,
                selectedDevice = c.selected.takeIf { it.authorizationId.isNotEmpty() },
                accountFingerprint = accountFingerprint(c.accountP),
                historyNote = if (success) Copy.HISTORY_NOTE else "",
                canCancel = c.sourcePhase != SourcePhase.COMPLETE &&
                    c.sourcePhase != SourcePhase.CANCELLED &&
                    c.destPhase != DestPhase.COMPLETE,
                isSuccess = success,
            )
        }

        private fun idleUi(accountP: String, phase: SourcePhase, err: String) = UiState(
            uiId = "",
            mode = ProductMode.MIGRATE_TO_LINKED_DEVICE,
            sourcePhase = phase,
            destPhase = DestPhase.IDLE,
            title = Copy.ACTION_MIGRATE,
            body = "",
            errorSafe = err,
            selectedDevice = null,
            accountFingerprint = accountFingerprint(accountP),
            historyNote = "",
            canCancel = false,
            isSuccess = false,
        )

        private fun accountFingerprint(accountP: String): String {
            val p = SosDeviceKeyCrypto.normalizeHex(accountP)
            if (!SosDeviceKeyCrypto.isHex64(p)) return ""
            return p.take(4) + "…" + p.takeLast(4)
        }

        private fun mapError(code: String): String = when (code) {
            "USER_CANCEL", "CANCELLED" -> Copy.ERR_AUTH_CANCELLED
            "NO_ACTIVE_DEVICE_AUTH", "MISSING_DEVICE_RECOVERY", "DEVICE_NOT_ELIGIBLE",
            "DEVICE_AUTH_CHANGED", "AUTH_EPOCH_MISMATCH", "EXPIRED",
            -> Copy.ERR_NOT_AUTHORIZED
            "ACCOUNT_MISMATCH", "ACCOUNT_SWITCH", "SESSION_ACCOUNT_MISMATCH" -> Copy.ERR_ACCOUNT_MISMATCH
            "CEREMONY_EXPIRED", "REQUEST_EXPIRED", "ENVELOPE_EXPIRED" -> Copy.ERR_EXPIRED
            "DELIVERY_FAILED", "CONNECTION", "CONFIRMATION_UNAVAILABLE" -> Copy.ERR_CONNECTION
            else -> if (code.contains("DELIVER") || code.contains("CONNECT")) Copy.ERR_CONNECTION else Copy.ERR_GENERIC
        }

        private fun envJsonContainsSecret(s: String): Boolean {
            val lower = s.lowercase()
            return lower.contains("nsec") || lower.contains("\"k\":") || lower.contains("privkey")
        }
    }
}
