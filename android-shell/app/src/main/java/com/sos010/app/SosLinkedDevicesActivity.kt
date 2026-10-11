package com.sos010.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat

/**
 * Settings → מכשירים מקושרים → קישור מכשיר חדש.
 * Product: CameraX scan only. QA paste gated by EXTRA_QA_DIAGNOSTICS.
 * MD3 issuance only via PhoneIssuer after CHANNEL_READY + explicit approve.
 */
class SosLinkedDevicesActivity : AppCompatActivity(), SosLinkedDeviceOrchestrator.Listener {

    private lateinit var qrInput: EditText
    private lateinit var qaPasteSection: LinearLayout
    private lateinit var statusView: TextView
    private lateinit var detailView: TextView
    private lateinit var continueBtn: Button
    private lateinit var approveBtn: Button
    private lateinit var cancelBtn: Button
    private lateinit var retryBtn: Button
    private lateinit var scanCameraBtn: Button
    private lateinit var stopCameraBtn: Button
    private lateinit var previewView: PreviewView

    private var orchestrator: SosLinkedDeviceOrchestrator? = null
    private var identity: SosSecureIdentityStore.Engine? = null
    private var qrCamera: SosLinkedDeviceQrCamera? = null
    private var pairingStartedFromScan = false
    private var cameraSessionActive = false
    private var qaDiagnostics = false
    /** Short-lived in-memory QR — never shown in product UI. */
    private var pendingQrText: String? = null

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            startCameraScanner()
        } else {
            val permanentlyDenied = !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
            statusView.text = if (permanentlyDenied) {
                "הרשאת מצלמה נחסמה. אפשר להפעיל בהגדרות האפליקציה."
            } else {
                "נדרשת הרשאת מצלמה לסריקת QR."
            }
            if (permanentlyDenied) {
                detailView.text = "הגדרות → הרשאות → מצלמה"
                detailView.setOnClickListener {
                    startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", packageName, null),
                        ),
                    )
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_linked_devices)
        qaDiagnostics = intent.getBooleanExtra(EXTRA_QA_DIAGNOSTICS, false)
        qrInput = findViewById(R.id.linkedQrInput)
        qaPasteSection = findViewById(R.id.linkedQaPasteSection)
        statusView = findViewById(R.id.linkedStatus)
        detailView = findViewById(R.id.linkedDetail)
        continueBtn = findViewById(R.id.linkedScanContinue)
        approveBtn = findViewById(R.id.linkedApprove)
        cancelBtn = findViewById(R.id.linkedCancel)
        retryBtn = findViewById(R.id.linkedRetry)
        scanCameraBtn = findViewById(R.id.linkedScanCamera)
        stopCameraBtn = findViewById(R.id.linkedStopCamera)
        previewView = findViewById(R.id.linkedCameraPreview)

        qaPasteSection.visibility = if (qaDiagnostics) View.VISIBLE else View.GONE

        intent.getStringExtra(EXTRA_QR)?.takeIf { it.isNotBlank() }?.let { qr ->
            pendingQrText = qr
            if (qaDiagnostics) qrInput.setText(qr)
        }
        intent.getStringExtra(EXTRA_ADMISSION_URL)?.let {
            SosLinkedDeviceOrchestrator.writeAdmissionUrl(this, it)
        }

        val eng = SosSecureIdentityStore.productionEngine(applicationContext)
        identity = eng
        orchestrator = SosLinkedDeviceOrchestrator(this, eng).also { it.setListener(this) }

        scanCameraBtn.setOnClickListener { onScanCameraClicked() }
        stopCameraBtn.setOnClickListener { stopCameraScanner(userCancelled = true) }
        continueBtn.setOnClickListener {
            pairingStartedFromScan = false
            pendingQrText = qrInput.text?.toString()?.trim()
            beginPairingFromPending(eng, fromCameraScan = false)
        }
        retryBtn.setOnClickListener {
            orchestrator?.cancel()
            pendingQrText = null
            if (qaDiagnostics) qrInput.setText("")
            retryBtn.visibility = View.GONE
            statusView.text = "מוכן — סרקו קוד QR חדש מהמחשב"
            detailView.text = "רעננו את הקוד במחשב לפני סריקה חוזרת."
            scanCameraBtn.isEnabled = true
        }
        approveBtn.setOnClickListener { orchestrator?.approve() }
        cancelBtn.setOnClickListener {
            stopCameraScanner(userCancelled = true)
            orchestrator?.cancel()
            finish()
        }

        // Instrumentation / bridge: QR extras auto-start without showing payload.
        if (intent.getBooleanExtra(EXTRA_AUTO_START, false) && !pendingQrText.isNullOrBlank()) {
            statusView.post {
                pairingStartedFromScan = false
                beginPairingFromPending(eng, fromCameraScan = false)
            }
        } else if (pendingQrText.isNullOrBlank()) {
            statusView.text = "מוכן לסריקה"
            detailView.text = "לחצו על סריקת QR וכוונו למסך המחשב."
        }
    }

    private fun onScanCameraClicked() {
        detailView.setOnClickListener(null)
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            statusView.text = "אין מצלמה במכשיר."
            return
        }
        when {
            ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED -> startCameraScanner()
            else -> {
                statusView.text = "מבקשים הרשאת מצלמה לסריקת QR…"
                requestCameraPermission.launch(Manifest.permission.CAMERA)
            }
        }
    }

    private fun startCameraScanner() {
        stopCameraScanner(userCancelled = false)
        pairingStartedFromScan = false
        cameraSessionActive = true
        previewView.visibility = View.VISIBLE
        stopCameraBtn.visibility = View.VISIBLE
        scanCameraBtn.isEnabled = false
        retryBtn.visibility = View.GONE
        statusView.text = "מכוונים את המצלמה לקוד ה־QR במסך המחשב…"
        detailView.text = "הסריקה מקומית במכשיר. אין שליחת תמונות לשרת."
        val cam = SosLinkedDeviceQrCamera(
            context = this,
            lifecycleOwner = this,
            previewView = previewView,
            onPayload = { raw -> onBarcodeDecoded(raw) },
            onError = { code ->
                runOnUiThread {
                    statusView.text = when (code) {
                        "CAMERA_UNAVAILABLE" -> "לא ניתן לפתוח את המצלמה"
                        "CAMERA_BIND_FAIL" -> "שגיאת אתחול מצלמה"
                        else -> "שגיאת מצלמה: $code"
                    }
                    stopCameraScanner(userCancelled = false)
                }
            },
        )
        qrCamera = cam
        cam.start()
    }

    private fun stopCameraScanner(userCancelled: Boolean) {
        qrCamera?.stop()
        qrCamera?.release()
        qrCamera = null
        cameraSessionActive = false
        previewView.visibility = View.GONE
        stopCameraBtn.visibility = View.GONE
        scanCameraBtn.isEnabled = true
        if (userCancelled && orchestrator?.snapshot()?.phase == SosLinkedDeviceOrchestrator.UiPhase.IDLE) {
            statusView.text = "סריקה בוטלה"
        }
    }

    private fun onBarcodeDecoded(raw: String) {
        val intake = SosLinkedDeviceQrIntake.acceptScannedPayload(raw)
        val accepted = intake.getOrElse { err ->
            val code = err.message ?: "QR_FAIL"
            stopCameraScanner(userCancelled = false)
            statusView.text = when (code) {
                "GROUP_INVITE_QR" ->
                    "זה קוד הזמנה לקבוצה — לא קישור מחשב. סרקו QR מהמחשב."
                "EXPIRED" ->
                    "קוד QR פג תוקף. בקשו מהמחשב להציג קוד חדש וסרקו שוב."
                "BAD_PREFIX", "UNKNOWN_PROTOCOL_VERSION" ->
                    "קוד QR אינו נתמך לקישור מכשיר."
                "SECRET_IN_QR" -> "קוד QR נדחה מסיבות אבטחה."
                else -> "QR נדחה: $code"
            }
            retryBtn.visibility = View.VISIBLE
            return
        }
        stopCameraScanner(userCancelled = false)
        pendingQrText = accepted.qrText
        // Product: never dump raw SOSPAIR1 into the visible field.
        if (qaDiagnostics) {
            qrInput.setText(accepted.qrText)
        } else {
            qrInput.setText("")
        }
        statusView.text = "QR זוהה — מתחברים למחשב…"
        detailView.text = "מזהה צימוד: ${accepted.pairingId.take(12)}…"
        pairingStartedFromScan = true
        val eng = identity ?: return
        beginPairingFromPending(eng, fromCameraScan = true)
    }

    private fun beginPairingFromPending(
        identity: SosSecureIdentityStore.Engine,
        fromCameraScan: Boolean,
    ) {
        val qr = pendingQrText?.trim().orEmpty().ifEmpty {
            if (qaDiagnostics) qrInput.text?.toString()?.trim().orEmpty() else ""
        }
        if (qr.isEmpty()) {
            statusView.text = if (fromCameraScan) {
                "סריקה ריקה"
            } else {
                "יש לסרוק QR מהמחשב"
            }
            return
        }
        pendingQrText = qr
        val intake = SosLinkedDeviceQrIntake.acceptScannedPayload(qr)
        if (intake.isFailure) {
            val code = intake.exceptionOrNull()?.message ?: "QR_FAIL"
            statusView.text = when (code) {
                "GROUP_INVITE_QR" -> "זה קוד הזמנה לקבוצה — לא קישור מחשב."
                "EXPIRED" -> "קוד QR פג תוקף. הציגו קוד חדש במחשב."
                else -> "QR נדחה: $code"
            }
            retryBtn.visibility = View.VISIBLE
            return
        }
        val account = intent.getStringExtra(EXTRA_ACCOUNT_P)
            ?: identity.readIdentityForNativeUse()?.publicKeyHex
        if (account.isNullOrBlank()) {
            statusView.text = "אין חשבון מחובר בטלפון"
            return
        }
        approveBtn.isEnabled = false
        retryBtn.visibility = View.GONE
        if (!fromCameraScan && qaDiagnostics) {
            detailView.text = "נתיב אבחון QA (הדבקה)"
        }
        orchestrator?.startFromQr(qr, account, sessionValid = true)
    }

    override fun onPause() {
        if (cameraSessionActive) {
            stopCameraScanner(userCancelled = false)
        }
        super.onPause()
    }

    override fun onDestroy() {
        stopCameraScanner(userCancelled = false)
        pendingQrText = null
        orchestrator?.setListener(null)
        orchestrator?.cancel()
        super.onDestroy()
    }

    override fun onUpdate(snap: SosLinkedDeviceOrchestrator.Snapshot) {
        runOnUiThread {
            statusView.text = when (snap.phase) {
                SosLinkedDeviceOrchestrator.UiPhase.IDLE -> "מוכן לסריקה"
                SosLinkedDeviceOrchestrator.UiPhase.PARSING -> "קורא QR…"
                SosLinkedDeviceOrchestrator.UiPhase.HANDSHAKING -> "מחבר למחשב…"
                SosLinkedDeviceOrchestrator.UiPhase.STATUS_CHECK -> "בודק סטטוס חשבון…"
                SosLinkedDeviceOrchestrator.UiPhase.PENDING_APPROVAL -> "אשר קישור למחשב זה"
                SosLinkedDeviceOrchestrator.UiPhase.SIGNING -> "חותם הרשאת מכשיר…"
                SosLinkedDeviceOrchestrator.UiPhase.WAITING_ACK -> "ממתין לאישור במחשב…"
                SosLinkedDeviceOrchestrator.UiPhase.LINKED -> "המכשיר קושר בהצלחה"
                SosLinkedDeviceOrchestrator.UiPhase.FAILED -> failedMessage(snap.code)
                SosLinkedDeviceOrchestrator.UiPhase.CANCELLED -> "בוטל"
            }
            val parts = mutableListOf<String>()
            if (snap.phase == SosLinkedDeviceOrchestrator.UiPhase.PENDING_APPROVAL ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.LINKED
            ) {
                snap.fingerprint?.let { parts.add("מחשב: ${it.take(16)}…") }
                snap.sas?.let { parts.add("קוד אימות: $it") }
            }
            if (pairingStartedFromScan && snap.phase != SosLinkedDeviceOrchestrator.UiPhase.IDLE) {
                parts.add("מקור: סריקת מצלמה")
            } else if (qaDiagnostics && snap.phase != SosLinkedDeviceOrchestrator.UiPhase.IDLE) {
                parts.add("מקור: אבחון QA")
            }
            when (snap.phase) {
                SosLinkedDeviceOrchestrator.UiPhase.HANDSHAKING ->
                    parts.add("ממתינים לתשובת המחשב. אם זה נמשך — רעננו QR במחשב.")
                SosLinkedDeviceOrchestrator.UiPhase.FAILED ->
                    parts.add("לחצו ׳נסה שוב׳ לאחר רענון הקוד במחשב.")
                else -> {}
            }
            detailView.text = parts.joinToString("\n")
            approveBtn.isEnabled = snap.phase == SosLinkedDeviceOrchestrator.UiPhase.PENDING_APPROVAL
            val idleish = snap.phase == SosLinkedDeviceOrchestrator.UiPhase.IDLE ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.FAILED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.CANCELLED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.LINKED
            continueBtn.isEnabled = idleish
            scanCameraBtn.isEnabled = idleish && !cameraSessionActive
            retryBtn.visibility =
                if (snap.phase == SosLinkedDeviceOrchestrator.UiPhase.FAILED) View.VISIBLE else View.GONE
            if (snap.phase == SosLinkedDeviceOrchestrator.UiPhase.LINKED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.FAILED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.CANCELLED
            ) {
                pendingQrText = null
            }
        }
    }

    private fun failedMessage(code: String?): String {
        return when (code) {
            "EXPIRED" -> "קוד QR פג תוקף — הציגו קוד חדש במחשב וסרקו שוב"
            "HANDSHAKE_TIMEOUT" -> "החיבור למחשב לא הושלם בזמן — רעננו QR במחשב ונסו שוב"
            "RELAY_UNREACHABLE" -> "אין חיבור לרשת הצימוד — בדקו אינטרנט ונסו שוב"
            "POP_FAIL" -> "אימות המחשב נכשל — רעננו QR ונסו שוב"
            "AEAD_FAIL" -> "שגיאת ערוץ מאובטח — רעננו QR ונסו שוב"
            "ACCOUNT_DISABLED" -> "החשבון אינו מורשה לקשר מכשירים"
            else -> "הקישור נכשל (${code ?: "?"}). רעננו QR במחשב ונסו שוב"
        }
    }

    companion object {
        const val EXTRA_QR = "qr"
        const val EXTRA_ACCOUNT_P = "account_p"
        const val EXTRA_ADMISSION_URL = "admission_url"
        /** When true with EXTRA_QR, start pairing without requiring the Continue tap. */
        const val EXTRA_AUTO_START = "auto_start"
        /** Explicit QA/diagnostics gate for manual paste UI (off in normal product). */
        const val EXTRA_QA_DIAGNOSTICS = "qa_diagnostics"
    }
}
