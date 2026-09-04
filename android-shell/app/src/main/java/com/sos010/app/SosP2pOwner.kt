package com.sos010.app

import android.util.Log

/**
 * בעלים יחיד לכל peer: WEBVIEW או NATIVE, לא שני PeerConnection. | HYPER CORE TECH
 */
enum class SosP2pOwnerKind {
    NONE,
    WEBVIEW,
    NATIVE,
    HANDOFF
}

object SosP2pOwner {
    private const val TAG = "SosP2pOwner"

    @Volatile var kind: SosP2pOwnerKind = SosP2pOwnerKind.NONE
        private set
    @Volatile var webViewReady: Boolean = false
        private set

    private val nativePeers = HashSet<String>()
    private val webViewPeers = HashSet<String>()

    fun amInitiator(selfPubkey: String, peerPubkey: String): Boolean {
        val a = selfPubkey.trim().lowercase()
        val b = peerPubkey.trim().lowercase()
        if (a.isBlank() || b.isBlank() || a == b) return false
        return a < b
    }

    fun onUiForeground() {
        if (webViewReady) setOwner(SosP2pOwnerKind.WEBVIEW)
        else setOwner(SosP2pOwnerKind.HANDOFF)
    }

    fun markWebViewReady() {
        webViewReady = true
        nativePeers.clear()
        setOwner(SosP2pOwnerKind.WEBVIEW)
    }

    fun onActivityGone(standbyEnabled: Boolean) {
        webViewReady = false
        webViewPeers.clear()
        if (standbyEnabled) setOwner(SosP2pOwnerKind.NATIVE)
        else {
            nativePeers.clear()
            setOwner(SosP2pOwnerKind.NONE)
        }
    }

    fun nativeMayHandle(): Boolean {
        return kind == SosP2pOwnerKind.NATIVE ||
            (kind == SosP2pOwnerKind.HANDOFF && !webViewReady)
    }

    fun claim(peerPubkey: String, who: SosP2pOwnerKind): Boolean {
        val peer = peerPubkey.trim().lowercase()
        if (peer.isBlank()) return false
        return when (who) {
            SosP2pOwnerKind.WEBVIEW -> {
                nativePeers.remove(peer)
                webViewPeers.add(peer)
                true
            }
            SosP2pOwnerKind.NATIVE -> {
                if (kind == SosP2pOwnerKind.WEBVIEW || webViewReady) return false
                if (webViewPeers.contains(peer)) return false
                webViewPeers.remove(peer)
                nativePeers.add(peer)
                true
            }
            else -> false
        }
    }

    fun hasExclusiveOwner(peerPubkey: String): Boolean {
        val peer = peerPubkey.trim().lowercase()
        val n = nativePeers.contains(peer)
        val w = webViewPeers.contains(peer)
        return (n xor w) || (!n && !w)
    }

    fun resetForTest() {
        kind = SosP2pOwnerKind.NONE
        webViewReady = false
        nativePeers.clear()
        webViewPeers.clear()
    }

    private fun setOwner(next: SosP2pOwnerKind) {
        kind = next
        try {
            Log.i(TAG, "[P2P-OWNER] peer=* owner=$next")
            SosDebugLog.i("p2p", "[P2P-OWNER] peer=* owner=$next")
        } catch (_: Exception) {
        }
    }
}
