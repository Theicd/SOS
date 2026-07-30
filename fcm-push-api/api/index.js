import admin from 'firebase-admin';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const STORE = '/tmp/sos-fcm-tokens.json';

function initFirebase() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('missing_FIREBASE_SERVICE_ACCOUNT_JSON');
  const cred = JSON.parse(raw);
  return admin.initializeApp({
    credential: admin.credential.cert(cred),
  });
}

function loadStore() {
  try {
    if (!existsSync(STORE)) return {};
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(data) {
  try {
    writeFileSync(STORE, JSON.stringify(data));
  } catch {}
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isRegister(req) {
  const url = String(req.url || '');
  if (url.includes('register')) return true;
  if (req.query?.action === 'register') return true;
  if (req.body?.action === 'register') return true;
  return false;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'sos-fcm-push-api' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  try {
    initFirebase();
  } catch (err) {
    return res.status(503).json({ ok: false, error: String(err.message || err) });
  }

  if (isRegister(req)) {
    const { pubkey, token } = req.body || {};
    if (!pubkey || !token) {
      return res.status(400).json({ ok: false, error: 'pubkey_and_token_required' });
    }
    const store = loadStore();
    store[String(pubkey).toLowerCase()] = { token: String(token), updatedAt: Date.now() };
    saveStore(store);
    return res.status(200).json({ ok: true });
  }

  const { pubkey, title, body, url, tag, data } = req.body || {};
  if (!pubkey) return res.status(400).json({ ok: false, error: 'pubkey_required' });

  const store = loadStore();
  const entry = store[String(pubkey).toLowerCase()];
  if (!entry?.token) return res.status(404).json({ ok: false, error: 'no_fcm_token' });

  try {
    const messageId = await admin.messaging().send({
      token: entry.token,
      notification: {
        title: title || 'SOS',
        body: body || 'יש לך עדכון חדש',
      },
      data: Object.fromEntries(
        Object.entries({
          title: title || 'SOS',
          body: body || 'יש לך עדכון חדש',
          url: url || 'https://sos010.com/videos.html',
          tag: tag || 'sos',
          ...(data || {}),
        }).map(([k, v]) => [k, String(v ?? '')])
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'sos_messages',
          priority: 'high',
        },
      },
    });
    return res.status(200).json({ ok: true, messageId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
