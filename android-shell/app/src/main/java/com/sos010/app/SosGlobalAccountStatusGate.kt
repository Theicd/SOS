package com.sos010.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Fresh global account-security gate for sensitive MD3 DeviceAuthorization issuance.
 *
 * Legacy login may allow STALE_UNKNOWN offline — NEW device auth must NOT.
 * UNKNOWN / unreachable → reject issuance (not silently ACTIVE).
 * ACCOUNT_DISABLED → reject.
 * Authoritative Worker tip with status ACTIVE (including legacy no-row) → allow.
 */
object SosGlobalAccountStatusGate {

    const val UNKNOWN_STATUS_NEW_DEVICE_AUTH_ACCEPTED = false
    const val DISABLED_ACCOUNT_NEW_DEVICE_AUTH_ACCEPTED = false

    data class Decision(
        val ok: Boolean,
        val code: String,
        val status: String? = null,
        val reachable: Boolean = false,
        val accountDisabled: Boolean = false,
    )

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()

    /**
     * @param admissionBaseUrl e.g. http://10.0.2.2:8799 (no trailing slash required)
     */
    fun assertIssuanceAllowed(accountP: String, admissionBaseUrl: String?): Decision {
        val pk = SosDeviceKeyCrypto.normalizeHex(accountP)
        if (!SosDeviceKeyCrypto.isHex64(pk)) {
            return Decision(ok = false, code = "BAD_PUBKEY")
        }
        val base = (admissionBaseUrl ?: "").trim().trimEnd('/')
        if (base.isEmpty()) {
            return Decision(
                ok = false,
                code = "STATUS_AUTHORITY_UNAVAILABLE",
                reachable = false,
            )
        }
        return try {
            val body = JSONObject().put("pubkey", pk).toString()
            val req = Request.Builder()
                .url("$base/v1/global/account/status/get")
                .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
                .header("Content-Type", "application/json")
                .build()
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                val json = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    return Decision(ok = false, code = "STATUS_BAD_RESPONSE", reachable = true)
                }
                if (json.optString("result") != "OK") {
                    return Decision(
                        ok = false,
                        code = json.optString("code", "STATUS_ERROR"),
                        reachable = true,
                    )
                }
                val status = json.optString("status", "ACTIVE").uppercase()
                val disabled = json.optBoolean("ACCOUNT_DISABLED", false) || status == "ACCOUNT_DISABLED"
                if (disabled) {
                    return Decision(
                        ok = false,
                        code = "ACCOUNT_DISABLED",
                        status = status,
                        reachable = true,
                        accountDisabled = true,
                    )
                }
                Decision(
                    ok = true,
                    code = "OK",
                    status = status,
                    reachable = true,
                    accountDisabled = false,
                )
            }
        } catch (_: Exception) {
            Decision(ok = false, code = "STATUS_UNAVAILABLE", reachable = false)
        }
    }
}
