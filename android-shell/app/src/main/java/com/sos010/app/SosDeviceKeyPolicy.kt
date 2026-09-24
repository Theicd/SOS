package com.sos010.app

/**
 * MD1 — Linked-device key policy constants (no pairing / no authorization).
 * Owner decisions frozen: MAX_LINKED_DEVICES=4, RECOVERY_CAPABLE_DEFAULT=true (eligibility only;
 * capability grant requires future explicit user approval in MD2/MD3).
 * HYPER CORE TECH
 */
object SosDeviceKeyPolicy {

    const val KEY_FORMAT_VERSION = "sos-device-keys-v1"
    const val MAX_LINKED_DEVICES = 4

    /** Owner: default preference for recovery-capable linking once security class allows. */
    const val RECOVERY_CAPABLE_DEFAULT = true

    const val STANDARD_NOSTR_P_AUTHORSHIP_FROM_DESKTOP = "PHONE_COSIGN_FIRST"
    const val RECOVERY_STRONG_CONFIRMATION_EVERY_CEREMONY = true
    const val NO_REMEMBER_ME_FOR_RECOVERY = true
    const val ROOT_K_REQUIRED_ON_EVERY_DEVICE = false

    const val DEVICE_ID_BITS = 256
    const val D_SIGN_PUBLIC_ENCODING = "secp256k1-xonly-hex-v1"
    const val D_ENC_PUBLIC_ENCODING = "x25519-u-hex-v1"
    const val DEVICE_SIGNING_ALGORITHM = "secp256k1"
    const val DEVICE_ENCRYPTION_ALGORITHM = "X25519"

    /** Installation-global D; future DeviceAuthorization is account-specific (MD3). */
    const val DEVICE_IDENTITY_SCOPE = "installation"

    const val BROWSER_ONLY_LINKED_DEVICE_ALLOWED = true
    const val BROWSER_ONLY_RECOVERY_CAPABLE_ALLOWED = false

    const val MD1_CLAIMS_PERFECT_ZEROIZATION = false
    const val LOCAL_DEVICE_KEY_DELETE_DOES_NOT_CLAIM_REMOTE_REVOCATION = true
    const val RECOVERY_CAPABILITY_GRANTED_IN_MD1 = false
    const val INSECURE_SOFT_KEY_RECOVERY_ELIGIBLE = false

    enum class StorageClass {
        /** Platform API holds the exact wire private key non-exportably (not available for secp256k1/X25519 on Android). */
        HARDWARE_NONEXPORTABLE,
        /** Wire private key is software; wrapped by non-exportable platform AES (Android Keystore). */
        PLATFORM_WRAPPED,
        /** Software wrap only (tests / degraded). Never recovery-eligible. */
        SOFTWARE_ONLY,
        /** Platform cannot meet minimum storage requirements. */
        UNSUPPORTED,
    }

    /**
     * recoveryEligible means "may be offered RECOVERY_CAPABLE in future pairing after explicit user approval".
     * Does NOT grant recovery capability in MD1.
     */
    fun recoveryEligibleFor(storageClass: StorageClass, hardwareBackedWrap: Boolean): Boolean {
        return when (storageClass) {
            StorageClass.HARDWARE_NONEXPORTABLE -> true
            StorageClass.PLATFORM_WRAPPED -> true // platform-bound wrap key (AES Keystore)
            StorageClass.SOFTWARE_ONLY -> false
            StorageClass.UNSUPPORTED -> false
        }.also {
            // hardwareBackedWrap is informational; PLATFORM_WRAPPED is eligible even if TEE flag is false
            // (emulator / devices without StrongBox still bind to AndroidKeyStore).
            @Suppress("UNUSED_EXPRESSION")
            hardwareBackedWrap
        }
    }

    fun accountSwitchDeviceKeyPolicy(): String =
        "installation_device_identity_persists; DeviceAuthorization (future) is account-scoped; " +
            "account switch must not transfer another account's authorization to this D"
}
