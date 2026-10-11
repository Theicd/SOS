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
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat

/**
 * Settings → מכשירים מקושרים → קישור מכשיר חדש.
 * Camera QR (product) + paste fallback (QA). MD3 issuance only via PhoneIssuer
 * after fresh global status gate + explicit approve — never from QR recognition alone.
 */
class SosLinkedDevicesActivity : AppCompatActivity(), SosLinkedDeviceOrchestrator.Listener {

    private lateinit var qrInput: EditText
    private lateinit var statusView: TextView
    private lateinit var detailView: TextView
    private lateinit var continueBtn: Button
    private lateinit var approveBtn: Button
    private lateinit var cancelBtn: Button
    private lateinit var scanCameraBtn: Button
    private lateinit var stopCameraBtn: Button
    private lateinit var previewView: PreviewView

    private var orchestrator: SosLinkedDeviceOrchestrator? = null
    private var identity: SosSecureIdentityStore.Engine? = null
    private var qrCamera: SosLinkedDeviceQrCamera? = null
    private var pairingStartedFromScan = false
    private var cameraSessionActive = false

    private val requestCameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            startCameraScanner()
        } else {
            val permanentlyDenied = !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
            statusView.text = if (permanentlyDenied) {
                "הרשאת מצלמה נחסמה. אפשר להפעיל בהגדרות האפליקציה, או להדביק QR לבדיקות."
            } else {
                "נדרשת הרשאת מצלמה לסריקת QR. ניתן לנסות שוב או להדביק QR."
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
        qrInput = findViewById(R.id.linkedQrInput)
        statusView = findViewById(R.id.linkedStatus)
        detailView = findViewById(R.id.linkedDetail)
        continueBtn = findViewById(R.id.linkedScanContinue)
        approveBtn = findViewById(R.id.linkedApprove)
        cancelBtn = findViewById(R.id.linkedCancel)
        scanCameraBtn = findViewById(R.id.linkedScanCamera)
        stopCameraBtn = findViewById(R.id.linkedStopCamera)
        previewView = findViewById(R.id.linkedCameraPreview)

        intent.getStringExtra(EXTRA_QR)?.takeIf { it.isNotBlank() }?.let { qrInput.setText(it) }
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
            beginPairingFromUi(eng, fromCameraScan = false)
        }
        approveBtn.setOnClickListener { orchestrator?.approve() }
        cancelBtn.setOnClickListener {
            stopCameraScanner(userCancelled = true)
            orchestrator?.cancel()
            finish()
        }

        // Instrumentation / deep-link: QR + account extras auto-start (paste path; not hardware).
        if (intent.getBooleanExtra(EXTRA_AUTO_START, false) &&
            !intent.getStringExtra(EXTRA_QR).isNullOrBlank()
        ) {
            qrInput.post {
                pairingStartedFromScan = false
                beginPairingFromUi(eng, fromCameraScan = false)
            }
        }
    }

    private fun onScanCameraClicked() {
        detailView.setOnClickListener(null)
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
            statusView.text = "אין מצלמה במכשיר. ניתן להדביק QR לבדיקות."
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
                    "זה קוד הזמנה לקבוצה — לא קישור מחשב. סרקו QR‏ SOSPAIR1 מהמחשב.\nלחצו שוב על סריקת QR."
                "EXPIRED" ->
                    "קוד QR פג תוקף. בקשו מהמחשב להציג קוד חדש וסרקו שוב."
                "BAD_PREFIX", "UNKNOWN_PROTOCOL_VERSION" ->
                    "קוד QR אינו נתמך לקישור מכשיר.\nלחצו שוב על סריקת QR."
                "SECRET_IN_QR" -> "קוד QR נדחה מסיבות אבטחה."
                else -> "QR נדחה: $code"
            }
            return
        }
        stopCameraScanner(userCancelled = false)
        qrInput.setText(accepted.qrText)
        statusView.text = "QR זוהה — מאמתים פרוטוקול ומתחברים…"
        detailView.text = "מזהה צימוד: ${accepted.pairingId.take(12)}…"
        pairingStartedFromScan = true
        val eng = identity ?: return
        beginPairingFromUi(eng, fromCameraScan = true)
    }

    private fun beginPairingFromUi(
        identity: SosSecureIdentityStore.Engine,
        fromCameraScan: Boolean,
    ) {
        val qr = qrInput.text?.toString()?.trim().orEmpty()
        if (qr.isEmpty()) {
            statusView.text = if (fromCameraScan) {
                "סריקה ריקה"
            } else {
                "יש להדביק QR‏ SOSPAIR1 או לסרוק במצלמה"
            }
            return
        }
        // Defense in depth: same intake for paste and camera.
        val intake = SosLinkedDeviceQrIntake.acceptScannedPayload(qr)
        if (intake.isFailure) {
            val code = intake.exceptionOrNull()?.message ?: "QR_FAIL"
            statusView.text = when (code) {
                "GROUP_INVITE_QR" -> "זה קוד הזמנה לקבוצה — לא קישור מחשב."
                "EXPIRED" -> "קוד QR פג תוקף. הציגו קוד חדש במחשב."
                else -> "QR נדחה: $code"
            }
            return
        }
        val account = intent.getStringExtra(EXTRA_ACCOUNT_P)
            ?: identity.readIdentityForNativeUse()?.publicKeyHex
        if (account.isNullOrBlank()) {
            statusView.text = "אין חשבון מחובר בטלפון"
            return
        }
        approveBtn.isEnabled = false
        if (!fromCameraScan) {
            detailView.text = "נתיב הדבקה (לא סריקת מצלמה חומרתית)"
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
        orchestrator?.setListener(null)
        orchestrator?.cancel()
        super.onDestroy()
    }

    override fun onUpdate(snap: SosLinkedDeviceOrchestrator.Snapshot) {
        runOnUiThread {
            statusView.text = when (snap.phase) {
                SosLinkedDeviceOrchestrator.UiPhase.IDLE -> "מוכן"
                SosLinkedDeviceOrchestrator.UiPhase.PARSING -> "קורא QR…"
                SosLinkedDeviceOrchestrator.UiPhase.HANDSHAKING -> "מחבר למחשב…"
                SosLinkedDeviceOrchestrator.UiPhase.STATUS_CHECK -> "בודק סטטוס חשבון גלובלי…"
                SosLinkedDeviceOrchestrator.UiPhase.PENDING_APPROVAL -> "אשר קישור למחשב זה"
                SosLinkedDeviceOrchestrator.UiPhase.SIGNING -> "חותם הרשאת מכשיר…"
                SosLinkedDeviceOrchestrator.UiPhase.WAITING_ACK -> "ממתין לאישור במחשב…"
                SosLinkedDeviceOrchestrator.UiPhase.LINKED -> "המכשיר קושר בהצלחה"
                SosLinkedDeviceOrchestrator.UiPhase.FAILED -> {
                    val code = snap.code ?: "?"
                    when (code) {
                        "EXPIRED" -> "קוד QR פג תוקף — הציגו קוד חדש במחשב וסרקו שוב"
                        else -> "נכשל: $code"
                    }
                }
                SosLinkedDeviceOrchestrator.UiPhase.CANCELLED -> "בוטל"
            }
            val parts = mutableListOf<String>()
            snap.fingerprint?.let { parts.add("טביעת מכשיר: ${it.take(16)}…") }
            snap.sas?.let { parts.add("SAS: $it") }
            snap.accountP?.let { parts.add("P: ${it.take(12)}…") }
            parts.add("K לא נשלח לדפדפן")
            if (pairingStartedFromScan) {
                parts.add("מקור: סריקת מצלמה")
            } else if (snap.phase != SosLinkedDeviceOrchestrator.UiPhase.IDLE) {
                parts.add("מקור: הדבקה/QA")
            }
            detailView.text = parts.joinToString("\n")
            approveBtn.isEnabled = snap.phase == SosLinkedDeviceOrchestrator.UiPhase.PENDING_APPROVAL
            val idleish = snap.phase == SosLinkedDeviceOrchestrator.UiPhase.IDLE ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.FAILED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.CANCELLED ||
                snap.phase == SosLinkedDeviceOrchestrator.UiPhase.LINKED
            continueBtn.isEnabled = idleish
            scanCameraBtn.isEnabled = idleish && !cameraSessionActive
        }
    }

    companion object {
        const val EXTRA_QR = "qr"
        const val EXTRA_ACCOUNT_P = "account_p"
        const val EXTRA_ADMISSION_URL = "admission_url"
        /** When true with EXTRA_QR, start pairing without requiring the Continue tap. */
        const val EXTRA_AUTO_START = "auto_start"
    }
}
