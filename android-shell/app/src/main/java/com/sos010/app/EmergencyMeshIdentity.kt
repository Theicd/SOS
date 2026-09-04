package com.sos010.app

import java.util.UUID

/**
 * זהות לוגית: pubkey מלא, אחרת UUID התקנה. bootId לא נשמר. | HYPER CORE TECH
 */
object EmergencyMeshIdentity {
    private val PUBKEY = Regex("^[0-9a-f]{64}$")

    fun isValidPubkey(pubkey: String): Boolean {
        return pubkey.trim().lowercase().matches(PUBKEY)
    }

    fun nodeIdFrom(pubkey: String, installId: String): String {
        val pk = pubkey.trim().lowercase()
        if (isValidPubkey(pk)) return pk
        val install = installId.trim()
        require(install.isNotBlank()) { "installId required when pubkey missing" }
        return install
    }

    fun newBootId(): String = UUID.randomUUID().toString()

    fun newInstallId(): String = UUID.randomUUID().toString()

    fun upgrade(current: EmergencyNodeIdentity, newPubkey: String): EmergencyNodeIdentity {
        val pk = newPubkey.trim().lowercase()
        if (!isValidPubkey(pk)) return current
        if (current.pubkey == pk && current.nodeId == pk) return current
        return current.copy(nodeId = pk, pubkey = pk)
    }
}
