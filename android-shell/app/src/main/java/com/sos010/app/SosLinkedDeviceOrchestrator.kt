package com.sos010.app

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import fr.acinq.secp256k1.Hex
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Phone-side MD2→MD3 product orchestrator.
 *
 * Call chain:
 * QR text
 * → SosPairingCrypto.parseQr / SosPairingSession.Responder.acceptQr
 * → Nostr rendezvous exchange (hello → PoP AEAD → ack)
 * → BoundDestination
 * → SosGlobalAccountStatusGate.assertIssuanceAllowed (fresh)
 * → SosDeviceAuthorizationCeremony.PhoneIssuer.beginFromBound
 * → native UI approve ConfirmationGate
 * → PhoneIssuer.signAfterConfirm (root Schnorr under P)
 * → deliver AEAD device_authorization
 * → onDestinationAck → registry ACTIVE
 *
 * ROOT K / nsec never leave PhoneIssuer / SecureIdentityStore.
 */
class SosLinkedDeviceOrchestrator(
    private val context: Context,
    private val identity: SosSecureIdentityStore.Engine,
    private val registry: SosDeviceAuthorizationRegistry = SosDeviceAuthorizationRegistry(),
    private val admissionBaseUrlProvider: () -> String? = { readAdmissionUrl(context) },
) {
    enum class UiPhase {
        IDLE,
        PARSING,
        HANDSHAKING,
        STATUS_CHECK,
        PENDING_APPROVAL,
        SIGNING,
        WAITING_ACK,
        LINKED,
        FAILED,
        CANCELLED,
    }

    data class Snapshot(
        val phase: UiPhase,
        val code: String? = null,
        val sas: String? = null,
        val fingerprint: String? = null,
        val deviceLabel: String? = null,
        val accountP: String? = null,
        val challengeId: String? = null,
        val authorizationId: String? = null,
        val ROOT_K_SENT_TO_DESKTOP: Boolean = false,
        val NSEC_SENT_TO_DESKTOP: Boolean = false,
    )

    interface Listener {
        fun onUpdate(snap: Snapshot)
    }

    private val io = Executors.newSingleThreadExecutor()
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val responder = SosPairingSession.Responder()
    private val issuer = SosDeviceAuthorizationCeremony.PhoneIssuer(identity, registry)
    private var transport: SosPairingNostrTransport? = null
    private var listener: Listener? = null
    private val snap = AtomicReference(Snapshot(UiPhase.IDLE))
    private var sessionKey: ByteArray? = null
    private var transcript: ByteArray? = null
    private var bound: SosPairingSession.BoundDestination? = null
    private var accountP: String = ""
    private val handshakeGen = AtomicLong(0)
    private val handshakeTimedOut = AtomicBoolean(false)

    fun setListener(l: Listener?) {
        listener = l
    }

    fun snapshot(): Snapshot = snap.get()

    fun confirmationGate(): SosDeviceAuthorizationCeremony.ConfirmationGate = issuer.confirmation()

    fun startFromQr(qrText: String, accountPubkey: String, sessionValid: Boolean) {
        io.execute {
            cancelInternal(notify = false)
            accountP = SosDeviceKeyCrypto.normalizeHex(accountPubkey)
            emit(UiPhase.PARSING)
            val parsed = SosPairingCrypto.parseQr(qrText).getOrNull()
            if (parsed == null) {
                emit(UiPhase.FAILED, "QR_FAIL")
                return@execute
            }
            val accepted = responder.acceptQr(qrText)
            if (accepted !is SosPairingSession.StepResult.Ok) {
                emit(UiPhase.FAILED, (accepted as SosPairingSession.StepResult.Err).code)
                return@execute
            }
            val relays = resolveRelays(parsed.rendezvous)
            Log.i(
                LOG_TAG,
                "start pairFp=${parsed.pairingId.take(12)} relays=${relays.map { safeHost(it) }}",
            )
            val t = SosPairingNostrTransport(relayUrls = relays)
            transport = t
            emit(UiPhase.HANDSHAKING)
            val gen = handshakeGen.incrementAndGet()
            handshakeTimedOut.set(false)
            scheduleHandshakeDeadline(gen, parsed.expiresAt)
            t.start(parsed.pairingId, role = "phone") { inbound ->
                io.execute { onTransportMessage(inbound, sessionValid) }
            }
            val hello = accepted.outboundMessage
            if (hello != null) {
                val published = t.publish(hello)
                Log.i(LOG_TAG, "hello_publish ok=$published pairFp=${parsed.pairingId.take(12)}")
                if (!published) {
                    emit(UiPhase.FAILED, "RELAY_UNREACHABLE")
                    transport?.stop()
                    transport = null
                }
            }
        }
    }

    fun approve() {
        io.execute {
            val s = snap.get()
            if (s.phase != UiPhase.PENDING_APPROVAL || s.challengeId.isNullOrBlank()) {
                emit(UiPhase.FAILED, "BAD_PHASE")
                return@execute
            }
            if (!issuer.confirmation().approveFromNativeUi(s.challengeId!!)) {
                emit(UiPhase.FAILED, "APPROVE_FAIL")
                return@execute
            }
            emit(UiPhase.SIGNING)
            val session = SosDeviceAuthorizationCeremony.SessionCtx(
                accountPubkey = accountP,
                sessionValid = true,
                loggedIn = true,
            )
            when (val signed = issuer.signAfterConfirm(session)) {
                is SosDeviceAuthorizationCeremony.Result.Err -> {
                    emit(UiPhase.FAILED, signed.code)
                }
                is SosDeviceAuthorizationCeremony.Result.Ok -> {
                    val outbound = signed.outboundAeadJson
                    if (outbound != null) {
                        transport?.publish(outbound)
                        emit(
                            UiPhase.WAITING_ACK,
                            authorizationId = signed.authorization?.authorizationId,
                        )
                    } else {
                        // No session key — cannot deliver; fail closed (no ACTIVE)
                        emit(UiPhase.FAILED, "NO_DELIVERY_CHANNEL")
                    }
                }
            }
        }
    }

    fun cancel() {
        io.execute { cancelInternal(notify = true) }
    }

    private fun scheduleHandshakeDeadline(gen: Long, qrExpiresAt: Long) {
        val now = System.currentTimeMillis()
        val untilQr = (qrExpiresAt - now).coerceAtLeast(5_000L)
        val waitMs = minOf(untilQr, HANDSHAKE_TIMEOUT_MS)
        scheduler.schedule({
            io.execute {
                if (handshakeGen.get() != gen) return@execute
                val phase = snap.get().phase
                if (phase == UiPhase.HANDSHAKING || phase == UiPhase.STATUS_CHECK) {
                    handshakeTimedOut.set(true)
                    Log.w(LOG_TAG, "handshake_timeout phase=$phase")
                    emit(UiPhase.FAILED, "HANDSHAKE_TIMEOUT")
                    transport?.stop()
                    transport = null
                }
            }
        }, waitMs, TimeUnit.MILLISECONDS)
    }

    private fun onTransportMessage(raw: String, sessionValid: Boolean) {
        if (handshakeTimedOut.get()) return
        val cur = snap.get().phase
        if (cur == UiPhase.WAITING_ACK) {
            when (val ack = issuer.onDestinationAck(raw)) {
                is SosDeviceAuthorizationCeremony.Result.Err -> emit(UiPhase.FAILED, ack.code)
                is SosDeviceAuthorizationCeremony.Result.Ok -> {
                    emit(
                        UiPhase.LINKED,
                        authorizationId = ack.authorization?.authorizationId,
                    )
                    transport?.stop()
                }
            }
            return
        }
        if (cur != UiPhase.HANDSHAKING) return
        when (val step = responder.onMessage(raw)) {
            is SosPairingSession.StepResult.Err -> {
                Log.w(LOG_TAG, "md2_step_err code=${step.code}")
                emit(UiPhase.FAILED, step.code)
            }
            is SosPairingSession.StepResult.Ok -> {
                step.outboundMessage?.let { transport?.publish(it) }
                if (step.state == SosPairingSession.State.CHANNEL_READY && step.bound != null) {
                    Log.i(LOG_TAG, "channel_ready pairFp=${step.bound.pairingId.take(12)}")
                    bound = step.bound
                    val secrets = responder.exportChannelSecrets()
                    if (secrets == null) {
                        emit(UiPhase.FAILED, "NO_CHANNEL_SECRETS")
                        return
                    }
                    sessionKey = secrets.first
                    transcript = secrets.second
                    runStatusThenBegin(sessionValid)
                }
            }
        }
    }

    private fun runStatusThenBegin(sessionValid: Boolean) {
        emit(UiPhase.STATUS_CHECK)
        val gate = SosGlobalAccountStatusGate.assertIssuanceAllowed(accountP, admissionBaseUrlProvider())
        if (!gate.ok) {
            emit(
                UiPhase.FAILED,
                if (gate.accountDisabled) "ACCOUNT_DISABLED" else gate.code,
            )
            return
        }
        val b = bound ?: run {
            emit(UiPhase.FAILED, "NO_BOUND")
            return
        }
        val session = SosDeviceAuthorizationCeremony.SessionCtx(
            accountPubkey = accountP,
            sessionValid = sessionValid,
            loggedIn = true,
        )
        when (
            val begun = issuer.beginFromBound(
                bound = b,
                session = session,
                offerRecoveryDefault = false,
                deviceLabel = "Computer",
                deviceType = "DESKTOP",
                sessionKey = sessionKey,
                transcript = transcript,
            )
        ) {
            is SosDeviceAuthorizationCeremony.Result.Err -> emit(UiPhase.FAILED, begun.code)
            is SosDeviceAuthorizationCeremony.Result.Ok -> {
                emit(
                    UiPhase.PENDING_APPROVAL,
                    sas = b.sas,
                    fingerprint = b.fingerprint,
                    challengeId = begun.challengeId,
                    accountP = accountP,
                )
            }
        }
    }

    private fun cancelInternal(notify: Boolean) {
        handshakeGen.incrementAndGet()
        handshakeTimedOut.set(false)
        try {
            issuer.cancel()
        } catch (_: Exception) {
        }
        transport?.stop()
        transport = null
        SosDeviceKeyCrypto.zeroize(sessionKey)
        sessionKey = null
        transcript = null
        bound = null
        if (notify) emit(UiPhase.CANCELLED)
    }

    private fun emit(
        phase: UiPhase,
        code: String? = null,
        sas: String? = null,
        fingerprint: String? = null,
        challengeId: String? = null,
        accountP: String? = null,
        authorizationId: String? = null,
    ) {
        val s = Snapshot(
            phase = phase,
            code = code,
            sas = sas ?: snap.get().sas,
            fingerprint = fingerprint ?: snap.get().fingerprint,
            deviceLabel = "Computer",
            accountP = accountP ?: this.accountP,
            challengeId = challengeId,
            authorizationId = authorizationId,
            ROOT_K_SENT_TO_DESKTOP = false,
            NSEC_SENT_TO_DESKTOP = false,
        )
        snap.set(s)
        listener?.onUpdate(s)
    }

    companion object {
        private const val LOG_TAG = "SosPairMd2"
        private const val PREFS = "sos_linked_devices_product_v1"
        private const val KEY_ADMISSION = "admission_base_url"
        /** Bounded MD2 handshake wait (also capped by QR expiry). */
        const val HANDSHAKE_TIMEOUT_MS = 45_000L

        fun readAdmissionUrl(ctx: Context): String? {
            val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return p.getString(KEY_ADMISSION, null)?.trim()?.takeIf { it.isNotEmpty() }
        }

        fun writeAdmissionUrl(ctx: Context, url: String?) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_ADMISSION, url?.trim().orEmpty())
                .apply()
        }

        /** QR rendezvous first (transcript-bound hint), then default relays — never single-relay black hole. */
        fun resolveRelays(rendezvous: String?): List<String> {
            val out = linkedSetOf<String>()
            val rv = rendezvous?.trim().orEmpty()
            if (rv.startsWith("wss://") || rv.startsWith("ws://")) {
                out.add(rv)
            }
            for (r in SosPairingNostrTransport.DEFAULT_RELAYS) out.add(r)
            return out.toList()
        }

        private fun safeHost(url: String): String = try {
            android.net.Uri.parse(url).host ?: "?"
        } catch (_: Exception) {
            "?"
        }
    }
}
