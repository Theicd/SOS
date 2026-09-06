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
        
        // קבלת WebRTC signal — אותו handler כמו DataChannel, בלי כפילות offer/answer | HYPER CORE TECH
        window.SOSBridge.onWebRTCSignal = function(from, signal, fromPubkey) {
            console.log('[P2P-SIG] RX peer=' + String(fromPubkey || from || '').slice(0, 8) + ' transport=MESH');
            try {
                if (window.NostrApp && window.NostrApp.dataChannel && typeof window.NostrApp.dataChannel.ingestSignal === 'function') {
                    window.NostrApp.dataChannel.ingestSignal(from, signal, fromPubkey);
                }
            } catch (e) {
                console.warn('SOSEmergency: ingestSignal failed', e);
            }
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
        openSettings: openSettings,
        drainNow: function() {}
    };
})();

// פריטי תפריט צד לפיד – מצב חירום + לוג מעטפת; רק ב־APK | HYPER CORE TECH
(function wireEmergencyFeedUi() {
    function isNativeShell() {
        try {
            if (window.NostrApp && typeof window.NostrApp.isRunningInNativeShell === 'function') {
                return !!window.NostrApp.isRunningInNativeShell();
            }
            if (window.SosNativeShell && typeof window.SosNativeShell.isNativeShell === 'function') {
                var v = window.SosNativeShell.isNativeShell();
                return v === true || v === 'true';
            }
            if (/SOSNativeShell\//i.test(navigator.userAgent || '')) return true;
            // גשר נייטיב אמיתי בלבד (לא App.AndroidBridge מה־JS) | HYPER CORE TECH
            if (typeof window.AndroidBridge !== 'undefined' &&
                typeof window.AndroidBridge.openEmergencySettings === 'function' &&
                typeof window.AndroidBridge.isRelayNetworkActive === 'function') {
                return true;
            }
        } catch (e) {}
        return false;
    }

    function closeProfileMenu() {
        var menu = document.getElementById('topBarProfileMenu');
        if (menu && !menu.hidden) {
            menu.hidden = true;
            var avatarBtn = document.getElementById('topBarProfileButton');
            if (avatarBtn) avatarBtn.setAttribute('aria-expanded', 'false');
        }
    }

    function openEmergency() {
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
            console.warn('openEmergency failed', err);
        }
    }

    function openShellDebugLog() {
        try {
            if (window.SosNativeShell && typeof window.SosNativeShell.openDebugLog === 'function') {
                window.SosNativeShell.openDebugLog();
            }
        } catch (err) {
            console.warn('openShellDebugLog failed', err);
        }
    }

    function removeHeaderEmergencyIcon() {
        // הסרה דפנסיבית – גרסאות ישנות במטמון עדיין מזריקות כפתור בהדר | HYPER CORE TECH
        var stale = document.getElementById('emergencyToggleTop');
        if (stale && stale.parentNode) {
            stale.parentNode.removeChild(stale);
        }
        document.querySelectorAll('.top-bar__actions > .top-bar__emergency-btn').forEach(function(el) {
            if (el && el.parentNode) el.parentNode.removeChild(el);
        });
    }

    function wireApkMenuButton(id, onClick) {
        var btn = document.getElementById(id);
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
            onClick();
            closeProfileMenu();
        });
    }

    function setup() {
        removeHeaderEmergencyIcon();
        wireApkMenuButton('topBarShellDebugLog', openShellDebugLog);
        wireApkMenuButton('topBarEmergencyMode', openEmergency);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setup);
    } else {
        setup();
    }
    setTimeout(setup, 400);
    setTimeout(setup, 1200);
})();

// צ'אט רשת חירום – אנשי קשר מחוברים + קבוצה, בלי התראות רגילות | HYPER CORE TECH
(function wireEmergencyMeshChat() {
    var GROUP_PK = 'e5e1111111111111111111111111111111111111111111111111111111111111';
    var meshOnly = new Set();
    var meshPeerSet = new Set();
    var seenIds = new Set();
    var pendingDelivery = {};
    var wasActive = false;
    var pendingMeshOut = [];
    var MESH_OUTBOX_MAX = 40;
    var MESH_OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
    try { console.log('[CHAT/PERSIST] MODULE emergency-bridge.js v=20260905p1'); } catch (e0) {}

    function app() {
        return window.NostrApp || {};
    }

    function isRelayOn() {
        try {
            return typeof window.AndroidBridge !== 'undefined' &&
                typeof window.AndroidBridge.isEmergencyMode === 'function' &&
                !!window.AndroidBridge.isEmergencyMode();
        } catch (e) {
            return false;
        }
    }

    function localProfile() {
        var A = app();
        var pk = String(A.publicKey || '').toLowerCase();
        var cached = (A.profileCache instanceof Map && (A.profileCache.get(pk) || A.profileCache.get('self'))) || {};
        var prof = A.profile || {};
        return {
            name: String(prof.name || cached.name || cached.display_name || '').trim(),
            picture: String(prof.picture || cached.picture || '').trim()
        };
    }

    function pushProfile() {
        if (typeof window.AndroidBridge === 'undefined' || typeof window.AndroidBridge.setEmergencyProfile !== 'function') return;
        var p = localProfile();
        try {
            window.AndroidBridge.setEmergencyProfile(p.name, p.picture);
        } catch (e) {}
    }

    function ensureGroup() {
        var A = app();
        if (typeof A.ensureChatContact !== 'function') return;
        var c = A.ensureChatContact(GROUP_PK, {
            name: 'רשת חירום',
            picture: '',
            initials: 'רח',
            emergencyMesh: true,
            meshReachable: true,
            meshRelation: 'GROUP'
        });
        if (c && !c.lastMessage) c.lastMessage = 'קבוצת רשת חירום';
        meshOnly.add(GROUP_PK);
        meshPeerSet.add(GROUP_PK);
    }

    function syncPeers() {
        var A = app();
        if (typeof A.ensureChatContact !== 'function') return;
        var peers = [];
        try {
            peers = JSON.parse(window.AndroidBridge.getRelayPeers() || '[]');
        } catch (e) {
            peers = [];
        }
        if (!Array.isArray(peers)) peers = [];
        var me = String(A.publicKey || '').toLowerCase();
        var seen = new Set();
        ensureGroup();
        seen.add(GROUP_PK);
        peers.forEach(function(p) {
            var pk = String(p && p.pubkey || '').toLowerCase();
            if (/^[0-9a-f]{64}$/.test(pk) === false || pk === me) return;
            var wasReachable = meshPeerSet.has(pk);
            seen.add(pk);
            meshPeerSet.add(pk);
            var existing = A.chatState && A.chatState.contacts && A.chatState.contacts.get(pk);
            var name = String(p.name || '').trim() || (existing && existing.name) || ('משתמש ' + pk.slice(0, 8));
            var picture = String(p.picture || '').trim() || (existing && existing.picture) || '';
            var initials = (typeof A.getInitials === 'function' && name) ? A.getInitials(name) : 'מש';
            var relation = String(p.relation || p.type || '');
            if (existing && !existing.emergencyMesh) {
                A.ensureChatContact(pk, { name: name, picture: picture, initials: initials, meshReachable: true, meshRelation: relation });
            } else {
                A.ensureChatContact(pk, { name: name, picture: picture, initials: initials, emergencyMesh: true, meshReachable: true, meshRelation: relation });
                meshOnly.add(pk);
            }
            if (!wasReachable) {
                try {
                    if (A.dataChannel && typeof A.dataChannel.connect === 'function') A.dataChannel.connect(pk);
                    if (typeof A.drainPendingReadReceipts === 'function') A.drainPendingReadReceipts(pk);
                } catch (e4) {}
            }
        });
        Array.from(meshOnly).forEach(function(pk) {
            if (pk === GROUP_PK) return;
            if (!seen.has(pk)) {
                meshOnly.delete(pk);
                meshPeerSet.delete(pk);
                markMeshGone(A, pk);
            }
        });
    }

    function hasChatHistory(A, pk) {
        if (!A || !pk) return false;
        var c = A.chatState && A.chatState.contacts && A.chatState.contacts.get(pk);
        if (c && c.lastMessage) return true;
        if (typeof A.getChatMessages === 'function') {
            var msgs = A.getChatMessages(pk) || [];
            return msgs.length > 0;
        }
        return false;
    }

    function markMeshGone(A, pk) {
        if (!A || typeof A.ensureChatContact !== 'function') return;
        var existing = A.chatState && A.chatState.contacts && A.chatState.contacts.get(pk);
        if (existing) {
            A.ensureChatContact(pk, { meshReachable: false, meshRelation: existing.meshRelation || '' });
        }
        if (existing && existing.emergencyMesh && !hasChatHistory(A, pk) && pk !== GROUP_PK) {
            return;
        }
    }

    function clearMeshContacts() {
        var A = app();
        Array.from(meshOnly).forEach(function(pk) {
            if (pk === GROUP_PK) {
                if (A && typeof A.ensureChatContact === 'function') {
                    A.ensureChatContact(pk, { meshReachable: false, meshRelation: 'GROUP' });
                }
                return;
            }
            markMeshGone(A, pk);
        });
        meshOnly.clear();
        meshPeerSet.clear();
    }

    function ingestChat(fromIp, payload) {
        var A = app();
        var msg = payload;
        if (typeof payload === 'string') {
            try { msg = JSON.parse(payload); } catch (e) { return; }
        }
        if (!msg || msg.type !== 'chat') return;
        var me = String(A.publicKey || '').toLowerCase();
        var from = String(msg.from || '').toLowerCase();
        var to = String(msg.to || '').toLowerCase();
        if (!from || from === me) return;
        var isGroup = to === GROUP_PK;
        var isDirect = to === me;
        if (!isGroup && !isDirect) return;
        var id = String(msg.id || ('em-' + fromIp + '-' + (msg.ts || Date.now())));
        if (seenIds.has(id)) return;
        seenIds.add(id);
        if (seenIds.size > 400) {
            seenIds = new Set(Array.from(seenIds).slice(-200));
        }
        var peer = isGroup ? GROUP_PK : from;
        var dest = isGroup ? GROUP_PK : me;
        if (typeof A.ensureChatContact === 'function') {
            var existing = A.chatState && A.chatState.contacts && A.chatState.contacts.get(peer);
            if (!existing) {
                A.ensureChatContact(peer, {
                    name: isGroup ? 'רשת חירום' : ('משתמש ' + from.slice(0, 8)),
                    initials: isGroup ? 'רח' : 'מש',
                    emergencyMesh: true
                });
                meshOnly.add(peer);
                meshPeerSet.add(peer);
            }
        }
        if (typeof A.appendChatMessage === 'function') {
            A.appendChatMessage({
                id: id,
                from: from,
                to: dest,
                content: String(msg.text || ''),
                createdAt: Math.floor(Number(msg.ts || Date.now()) / 1000),
                direction: 'incoming',
                emergency: true,
                source: 'MESH'
            });
        }
    }

    function ingestReadReceipt(payload) {
        var A = app();
        var msg = payload;
        if (typeof payload === 'string') {
            try { msg = JSON.parse(payload); } catch (e) { return; }
        }
        if (!msg || msg.type !== 'chat_read_receipt') return;
        if (typeof A.handleIncomingReadReceipt === 'function') {
            A.handleIncomingReadReceipt(msg);
        }
    }

    function drainInbox() {
        if (typeof window.AndroidBridge === 'undefined' || typeof window.AndroidBridge.drainEmergencyInbox !== 'function') return;
        var items = [];
        try {
            items = JSON.parse(window.AndroidBridge.drainEmergencyInbox() || '[]');
        } catch (e) {
            return;
        }
        if (!Array.isArray(items)) return;
        items.forEach(function(item) {
            var data = item && item.data;
            var parsed = data;
            if (typeof data === 'string') {
                try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
            }
            var cb = item && item.callback;
            var fromIp = item && item.fromIp;
            if (cb === 'onChatMessage' || (parsed && parsed.type === 'chat')) {
                ingestChat(fromIp, parsed);
            } else if (cb === 'onChatReadReceipt' || (parsed && parsed.type === 'chat_read_receipt')) {
                ingestReadReceipt(parsed);
            } else if (cb === 'onWebRTCSignal' || (parsed && parsed.type === 'webrtc_signal')) {
                var signal = parsed && parsed.signal ? parsed.signal : parsed;
                var fromPubkey = parsed && parsed.fromPubkey ? parsed.fromPubkey : '';
                if (window.SOSBridge && typeof window.SOSBridge.onWebRTCSignal === 'function') {
                    window.SOSBridge.onWebRTCSignal(fromIp, signal, fromPubkey);
                }
            } else if (cb === 'onNostrEvent' || (parsed && parsed.type === 'nostr_event')) {
                var ev = parsed && parsed.event ? parsed.event : parsed;
                if (window.SOSBridge && typeof window.SOSBridge.onNostrEvent === 'function') {
                    window.SOSBridge.onNostrEvent(ev);
                }
            }
        });
    }

    function drainNow() {
        drainInbox();
    }
    if (window.SOSEmergency) window.SOSEmergency.drainNow = drainNow;

    function rememberOutgoingMesh(payload, options) {
        pendingMeshOut = pendingMeshOut.filter(function(item) {
            return item && item.payload && item.payload.id !== payload.id && (Date.now() - (item.queuedAt || 0) < MESH_OUTBOX_TTL_MS);
        });
        pendingMeshOut.push({
            peer: payload.to,
            text: payload.text,
            options: options || {},
            payload: payload,
            queuedAt: Date.now()
        });
        if (pendingMeshOut.length > MESH_OUTBOX_MAX) {
            pendingMeshOut = pendingMeshOut.slice(-MESH_OUTBOX_MAX);
        }
    }

    function persistOutgoingMesh(A, payload, options, status) {
        var outgoing = {
            id: payload.id,
            from: payload.from,
            to: payload.to,
            content: payload.text,
            createdAt: Math.floor(Number(payload.ts || Date.now()) / 1000),
            direction: 'outgoing',
            status: status || 'sent',
            emergency: true,
            source: 'MESH'
        };
        var tempId = options && options.clientTempId;
        if (tempId && tempId === payload.id && typeof A.updateChatMessageStatus === 'function') {
            A.updateChatMessageStatus(payload.id, outgoing.status);
            return;
        }
        if (tempId && typeof A.replaceOutgoingTempMessage === 'function') {
            A.replaceOutgoingTempMessage(tempId, outgoing);
            return;
        }
        if (typeof A.appendChatMessage === 'function') {
            A.appendChatMessage(outgoing);
        }
    }

    function trySendMeshPayload(payload) {
        if (typeof window.AndroidBridge === 'undefined' || typeof window.AndroidBridge.sendMeshChat !== 'function') {
            return { ok: false, error: 'no-bridge' };
        }
        try {
            var raw = window.AndroidBridge.sendMeshChat(JSON.stringify(payload));
            var result = {};
            try { result = JSON.parse(raw || '{}'); } catch (e2) { result = {}; }
            return result && result.ok ? result : { ok: false, error: (result && result.error) || 'emergency-send-failed' };
        } catch (e) {
            return { ok: false, error: 'emergency-send-failed' };
        }
    }

    function drainMeshOutbox() {
        if (!isRelayOn() || !pendingMeshOut.length) return;
        var left = [];
        pendingMeshOut.forEach(function(item) {
            if (!item || !item.payload) return;
            if (Date.now() - (item.queuedAt || 0) > MESH_OUTBOX_TTL_MS) return;
            var result = trySendMeshPayload(item.payload);
            if (result && result.ok) {
                var A = app();
                var mid = result.messageId || item.payload.id;
                if (mid) pendingDelivery[mid] = item.payload.id;
                persistOutgoingMesh(A, item.payload, item.options, result.status === 'QUEUED' ? 'queued' : 'sent');
            } else {
                left.push(item);
            }
        });
        pendingMeshOut = left;
    }

    function wrapPublish() {
        var A = app();
        if (!A || typeof A.publishChatMessage !== 'function' || A.publishChatMessage._emergencyMesh) return false;
        var orig = A.publishChatMessage;
        var wrapped = function(peer, text, options) {
            var key = String(peer || '').toLowerCase();
            if (!isRelayOn() || !meshPeerSet.has(key)) {
                return orig.apply(this, arguments);
            }
            if (typeof A.hasChatFileAttachment === 'function' && A.hasChatFileAttachment(peer)) {
                return orig.apply(this, arguments);
            }
            var payload = {
                type: 'chat',
                id: (options && options.clientTempId) || ('em-' + Date.now()),
                from: String(A.publicKey || '').toLowerCase(),
                to: key,
                text: String(text || '').trim(),
                ts: Date.now()
            };
            if (!payload.text) return orig.apply(this, arguments);
            var result = trySendMeshPayload(payload);
            if (result && result.ok) {
                var mid = result.messageId || payload.id;
                if (mid) pendingDelivery[mid] = payload.id;
                if (payload.id && payload.id !== mid) pendingDelivery[payload.id] = payload.id;
                persistOutgoingMesh(A, payload, options, result.status === 'QUEUED' ? 'queued' : 'sent');
                return Promise.resolve({
                    ok: true,
                    messageId: payload.id || mid,
                    emergency: true,
                    status: result.status || 'SENT'
                });
            }
            rememberOutgoingMesh(payload, options);
            persistOutgoingMesh(A, payload, options, 'queued');
            return Promise.resolve({
                ok: true,
                messageId: payload.id,
                emergency: true,
                queued: true,
                status: 'QUEUED'
            });
        };
        wrapped._emergencyMesh = true;
        A.publishChatMessage = wrapped;
        return true;
    }

    function applyDeliveries() {
        var A = app();
        if (typeof A.updateChatMessageStatus !== 'function') return;
        if (typeof window.AndroidBridge === 'undefined' || typeof window.AndroidBridge.getMeshDeliveryStatus !== 'function') return;
        Object.keys(pendingDelivery).forEach(function(mid) {
            var st = '';
            try { st = String(window.AndroidBridge.getMeshDeliveryStatus(mid) || ''); } catch (e) { return; }
            var chatId = pendingDelivery[mid] || mid;
            if (st === 'DELIVERED') {
                A.updateChatMessageStatus(chatId, 'sent');
                delete pendingDelivery[mid];
            } else if (st === 'FAILED') {
                A.updateChatMessageStatus(chatId, 'failed');
                delete pendingDelivery[mid];
            }
        });
    }

    function sendMeshReadReceipt(receipt) {
        if (!receipt || !isRelayOn()) return false;
        var result = trySendMeshPayload(receipt);
        return !!(result && result.ok);
    }

    function tick() {
        var active = isRelayOn();
        wrapPublish();
        if (active) {
            if (!wasActive) pushProfile();
            pushProfile();
            syncPeers();
            drainInbox();
            drainMeshOutbox();
            applyDeliveries();
            if (typeof app().drainPendingReadReceipts === 'function') {
                try { app().drainPendingReadReceipts(); } catch (e3) {}
            }
        } else if (wasActive) {
            clearMeshContacts();
        }
        wasActive = active;
    }

    setInterval(tick, 3000);
    window.addEventListener('sos-native-resume', drainNow);
    if (window.SOSEmergency) {
        window.SOSEmergency.sendMeshReadReceipt = sendMeshReadReceipt;
        window.SOSEmergency.drainMeshOutbox = drainMeshOutbox;
        window.SOSEmergency.isMeshPeer = function(pk) {
            return meshPeerSet.has(String(pk || '').toLowerCase());
        };
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(tick, 800); });
    } else {
        setTimeout(tick, 800);
    }
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
