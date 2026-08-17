/**
 * SOS Emergency Network Bridge
 * גשר בין ממשק SOS לרשת החירום המקומית
 * 
 * שימוש:
 * 1. טען את הקובץ הזה בממשק SOS
 * 2. קרא ל-SOSEmergency.init() בטעינת האפליקציה
 * 3. השתמש ב-SOSEmergency.getPeers() במקום חיפוש peers באינטרנט
 */

window.SOSEmergency = (function() {
    'use strict';
    
    // מצב פנימי
    let isInitialized = false;
    let networkStatus = {
        isActive: false,
        peerCount: 0,
        peers: [],
        parentIp: '',
        myIp: ''
    };
    
    // Callbacks
    let onPeersUpdated = null;
    let onMessageReceived = null;
    let onNetworkStatusChanged = null;
    
    /**
     * בדיקה האם אנחנו באפליקציית Android עם תמיכה ברשת חירום
     */
    function isAndroidApp() {
        return typeof window.AndroidBridge !== 'undefined';
    }
    
    /**
     * בדיקה האם רשת החירום פעילה
     */
    function isEmergencyNetworkActive() {
        if (!isAndroidApp()) return false;
        
        try {
            return window.AndroidBridge.isRelayNetworkActive();
        } catch (e) {
            console.warn('SOSEmergency: isRelayNetworkActive failed', e);
            return false;
        }
    }
    
    /**
     * קבלת מצב הרשת המלא
     */
    function getNetworkStatus() {
        if (!isAndroidApp()) {
            return { isActive: false, peerCount: 0, peers: [], parentIp: '', myIp: '' };
        }
        
        try {
            const statusJson = window.AndroidBridge.getEmergencyNetworkStatus();
            return JSON.parse(statusJson);
        } catch (e) {
            console.warn('SOSEmergency: getEmergencyNetworkStatus failed', e);
            return networkStatus;
        }
    }
    
    /**
     * קבלת רשימת peers מהרשת המקומית
     * זה מה שצריך לקרוא במקום לחפש peers באינטרנט
     */
    function getPeers() {
        if (!isAndroidApp()) return [];
        
        try {
            const peersJson = window.AndroidBridge.getRelayPeers();
            const peers = JSON.parse(peersJson);
            console.log('SOSEmergency: Got', peers.length, 'peers from relay network');
            return peers;
        } catch (e) {
            console.warn('SOSEmergency: getRelayPeers failed', e);
            return [];
        }
    }
    
    /**
     * שליחת הודעה P2P לכל ה-peers
     */
    function broadcast(message) {
        if (!isAndroidApp()) {
            console.warn('SOSEmergency: Not in Android app, cannot broadcast');
            return false;
        }
        
        try {
            const messageJson = typeof message === 'string' ? message : JSON.stringify(message);
            return window.AndroidBridge.sendP2PMessage(messageJson);
        } catch (e) {
            console.error('SOSEmergency: broadcast failed', e);
            return false;
        }
    }
    
    /**
     * שליחת הודעה ל-peer ספציפי
     */
    function sendToPeer(peerIp, message) {
        if (!isAndroidApp()) return false;
        
        try {
            const messageJson = typeof message === 'string' ? message : JSON.stringify(message);
            return window.AndroidBridge.sendToPeer(peerIp, messageJson);
        } catch (e) {
            console.error('SOSEmergency: sendToPeer failed', e);
            return false;
        }
    }
    
    /**
     * פרסום אירוע Nostr לרשת המקומית
     */
    function publishNostrEvent(event) {
        if (!isAndroidApp()) return false;
        
        try {
            const eventJson = typeof event === 'string' ? event : JSON.stringify(event);
            return window.AndroidBridge.publishNostrEvent(eventJson);
        } catch (e) {
            console.error('SOSEmergency: publishNostrEvent failed', e);
            return false;
        }
    }
    
    /**
     * שליחת WebRTC signal
     */
    function sendWebRTCSignal(targetPubkey, signal) {
        if (!isAndroidApp()) return false;
        
        try {
            const signalJson = typeof signal === 'string' ? signal : JSON.stringify(signal);
            return window.AndroidBridge.sendWebRTCSignal(targetPubkey, signalJson);
        } catch (e) {
            console.error('SOSEmergency: sendWebRTCSignal failed', e);
            return false;
        }
    }
    
    /**
     * אתחול הגשר - קרא לזה בטעינת האפליקציה
     */
    function init(options = {}) {
        if (isInitialized) {
            console.log('SOSEmergency: Already initialized');
            return;
        }
        
        console.log('SOSEmergency: Initializing...');
        
        // שמור callbacks
        onPeersUpdated = options.onPeersUpdated || null;
        onMessageReceived = options.onMessageReceived || null;
        onNetworkStatusChanged = options.onNetworkStatusChanged || null;
        
        // הגדר את window.SOSBridge לקבלת עדכונים מ-Android
        window.SOSBridge = window.SOSBridge || {};
        
        // עדכון רשת
        window.SOSBridge.onNetworkUpdate = function(status) {
            console.log('SOSEmergency: Network update received', status);
            networkStatus = status;
            
            if (onNetworkStatusChanged) {
                onNetworkStatusChanged(status);
            }
            
            if (onPeersUpdated && status.peers) {
                onPeersUpdated(status.peers);
            }
        };
        
        // קבלת הודעה
        window.SOSBridge.onMessage = function(fromIp, message) {
            console.log('SOSEmergency: Message from', fromIp);
            if (onMessageReceived) {
                onMessageReceived(fromIp, message);
            }
        };
        
        // קבלת אירוע Nostr
        window.SOSBridge.onNostrEvent = function(event) {
            console.log('SOSEmergency: Nostr event received');
            if (onMessageReceived) {
                onMessageReceived('nostr', { type: 'nostr_event', event: event });
            }
        };
        
        // קבלת WebRTC signal
        window.SOSBridge.onWebRTCSignal = function(from, signal) {
            console.log('SOSEmergency: WebRTC signal from', from);
            if (onMessageReceived) {
                onMessageReceived(from, { type: 'webrtc_signal', signal: signal });
            }
        };
        
        // קבלת הודעת צ'אט
        window.SOSBridge.onChatMessage = function(fromIp, message) {
            console.log('SOSEmergency: Chat from', fromIp);
            if (onMessageReceived) {
                onMessageReceived(fromIp, message);
            }
        };
        
        // peer התחבר
        window.SOSBridge.onPeerConnected = function(ip) {
            console.log('SOSEmergency: Peer connected:', ip);
            // עדכן את הרשימה
            networkStatus = getNetworkStatus();
            if (onPeersUpdated) {
                onPeersUpdated(getPeers());
            }
        };
        
        // קבל מצב ראשוני
        if (isAndroidApp()) {
            networkStatus = getNetworkStatus();
            console.log('SOSEmergency: Initial status -', 
                networkStatus.isActive ? 'ACTIVE' : 'INACTIVE',
                'with', networkStatus.peerCount, 'peers');
            
            // בקש עדכון peers
            try {
                window.AndroidBridge.requestPeerUpdate();
            } catch (e) {}
        }
        
        isInitialized = true;
        console.log('SOSEmergency: Initialized successfully');
    }
    
    /**
     * בדיקה האם צריך להשתמש ברשת החירום
     * קרא לזה לפני כל פעולת P2P
     */
    function shouldUseEmergencyNetwork() {
        if (!isAndroidApp()) return false;
        
        // בדוק אם הרשת פעילה ויש peers
        const status = getNetworkStatus();
        return status.isActive && status.peerCount > 0;
    }
    
    /**
     * קבלת מספר peers מחוברים
     */
    function getPeerCount() {
        if (!isAndroidApp()) return 0;
        return getNetworkStatus().peerCount;
    }
    
    /**
     * פתיחת הגדרות מצב חירום
     */
    function openSettings() {
        if (isAndroidApp()) {
            try {
                window.AndroidBridge.openEmergencySettings();
            } catch (e) {}
        }
    }
    
    // API ציבורי
    return {
        init: init,
        isAndroidApp: isAndroidApp,
        isActive: isEmergencyNetworkActive,
        shouldUse: shouldUseEmergencyNetwork,
        getStatus: getNetworkStatus,
        getPeers: getPeers,
        getPeerCount: getPeerCount,
        broadcast: broadcast,
        sendToPeer: sendToPeer,
        publishNostrEvent: publishNostrEvent,
        sendWebRTCSignal: sendWebRTCSignal,
        openSettings: openSettings
    };
})();

// כפתור מנורה בהדר הפיד – רק ב־APK ורק אם האלמנט קיים (videos.html) | HYPER CORE TECH
(function wireEmergencyTopBarButton() {
    function isNativeShell() {
        try {
            if (typeof window.AndroidBridge !== 'undefined') return true;
            if (window.SosNativeShell && typeof window.SosNativeShell.isNativeShell === 'function') {
                return !!window.SosNativeShell.isNativeShell();
            }
        } catch (e) {}
        return false;
    }

    function setup() {
        var btn = document.getElementById('emergencyToggleTop');
        if (!btn) return;
        if (!isNativeShell()) {
            btn.hidden = true;
            return;
        }
        btn.hidden = false;
        if (btn.dataset.wired === '1') return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            try {
                if (window.SOSEmergency && typeof window.SOSEmergency.openSettings === 'function') {
                    window.SOSEmergency.openSettings();
                    return;
                }
                if (window.NostrApp && window.NostrApp.AndroidBridge && typeof window.NostrApp.AndroidBridge.openEmergencySettings === 'function') {
                    window.NostrApp.AndroidBridge.openEmergencySettings();
                    return;
                }
                if (typeof window.AndroidBridge !== 'undefined' && typeof window.AndroidBridge.openEmergencySettings === 'function') {
                    window.AndroidBridge.openEmergencySettings();
                }
            } catch (err) {
                console.warn('emergencyToggleTop open failed', err);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
    // גשר נטען לעיתים אחרי DOM – ניסיון חוזר קצר | HYPER CORE TECH
    setTimeout(setup, 400);
    setTimeout(setup, 1200);
})();

// אתחול אוטומטי אם האפליקציה כבר טעונה
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(function() {
        if (!window.SOSEmergency._autoInitDone) {
            window.SOSEmergency._autoInitDone = true;
            console.log('SOSEmergency: Auto-init on ready');
        }
    }, 100);
}
