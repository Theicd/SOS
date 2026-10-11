package com.sos010.app

import android.content.Context
import android.util.Log
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * On-device CameraX + ML Kit QR scanner for Linked Devices.
 * Does not upload frames. Releases camera on [stop].
 */
class SosLinkedDeviceQrCamera(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val previewView: PreviewView,
    private val onPayload: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
    private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val consumed = AtomicBoolean(false)
    private var provider: ProcessCameraProvider? = null
    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build(),
    )
    private var started = false

    fun start() {
        if (started) return
        started = true
        consumed.set(false)
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                try {
                    val cameraProvider = future.get()
                    provider = cameraProvider
                    bind(cameraProvider)
                } catch (e: Exception) {
                    Log.w(TAG, "camera provider failed: ${e.message}")
                    started = false
                    onError("CAMERA_UNAVAILABLE")
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    private fun bind(cameraProvider: ProcessCameraProvider) {
        cameraProvider.unbindAll()
        val preview = Preview.Builder().build()
        preview.setSurfaceProvider(previewView.surfaceProvider)

        // Dense SOSPAIR1 symbols need enough analysis pixels; keep-only-latest avoids stale backlog.
        val analysis = ImageAnalysis.Builder()
            .setTargetResolution(Size(1280, 720))
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()

        analysis.setAnalyzer(analysisExecutor) { imageProxy ->
            if (consumed.get()) {
                imageProxy.close()
                return@setAnalyzer
            }
            val media = imageProxy.image
            if (media == null) {
                imageProxy.close()
                return@setAnalyzer
            }
            val image = InputImage.fromMediaImage(media, imageProxy.imageInfo.rotationDegrees)
            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    if (consumed.get()) return@addOnSuccessListener
                    val raw = barcodes.firstOrNull { !it.rawValue.isNullOrBlank() }?.rawValue
                    if (raw != null && consumed.compareAndSet(false, true)) {
                        ContextCompat.getMainExecutor(context).execute {
                            onPayload(raw)
                        }
                    }
                }
                .addOnFailureListener { e ->
                    Log.w(TAG, "barcode process: ${e.message}")
                }
                .addOnCompleteListener {
                    imageProxy.close()
                }
        }

        try {
            cameraProvider.bindToLifecycle(
                lifecycleOwner,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis,
            )
        } catch (e: Exception) {
            Log.w(TAG, "bind failed: ${e.message}")
            started = false
            onError("CAMERA_BIND_FAIL")
        }
    }

    fun stop() {
        consumed.set(true)
        started = false
        try {
            provider?.unbindAll()
        } catch (_: Exception) {
        }
        provider = null
    }

    fun release() {
        stop()
        analysisExecutor.shutdown()
        try {
            scanner.close()
        } catch (_: Exception) {
        }
    }

    /** Test / instrumentation: inject a decoded payload once (same dedupe as camera). */
    fun injectDecodedForTests(raw: String): Boolean {
        if (!consumed.compareAndSet(false, true)) return false
        onPayload(raw)
        return true
    }

    fun resetConsumeForTests() {
        consumed.set(false)
    }

    companion object {
        private const val TAG = "SosLinkedQrCam"
    }
}
