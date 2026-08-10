package com.sos010.app

import android.content.Context
import android.util.AttributeSet
import android.util.Log
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.webkit.WebView
import androidx.core.view.inputmethod.EditorInfoCompat
import androidx.core.view.inputmethod.InputConnectionCompat
import androidx.core.view.inputmethod.InputContentInfoCompat

/**
 * WebView שמצהיר תמיכה ב-GIF/תמונות מהמקלדת (Commit Content API).
 * בלי זה Gboard מציג "האפליקציה אינה תומכת ב-GIF כאן".
 */
class SosWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.webViewStyle
) : WebView(context, attrs, defStyleAttr) {

    fun interface RichContentListener {
        fun onRichContent(info: InputContentInfoCompat, mime: String)
    }

    var richContentListener: RichContentListener? = null

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        EditorInfoCompat.setContentMimeTypes(
            outAttrs,
            arrayOf(
                "image/gif",
                "image/png",
                "image/jpeg",
                "image/jpg",
                "image/webp",
                "image/*"
            )
        )
        return InputConnectionCompat.createWrapper(base, outAttrs) { contentInfo, flags, _ ->
            try {
                if (flags and InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION != 0) {
                    try {
                        contentInfo.requestPermission()
                    } catch (e: Exception) {
                        Log.w(TAG, "requestPermission failed", e)
                    }
                }
                val desc = contentInfo.description
                var mime = "image/gif"
                for (i in 0 until desc.mimeTypeCount) {
                    val candidate = desc.getMimeType(i) ?: continue
                    if (candidate.startsWith("image/")) {
                        mime = candidate
                        break
                    }
                }
                richContentListener?.onRichContent(contentInfo, mime)
                true
            } catch (e: Exception) {
                Log.e(TAG, "onCommitContent failed", e)
                false
            }
        }
    }

    companion object {
        private const val TAG = "SosWebView"
    }
}
