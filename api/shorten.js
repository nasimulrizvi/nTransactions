// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · Link Shortening API
// Endpoint  : POST /api/shorten
// Provider  : Short.io  (https://api.short.io/links)
// Domain    : rizvi.nav.bd  (branded short domain)
// Fallback  : on any failure, the client keeps using the original long URL —
//             sharing never breaks because of this endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const SHORTIO_API_URL = 'https://api.short.io/links';
const SHORTIO_DOMAIN  = 'rizvi.nav.bd';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntransaction.vercel.app',
  'https://ntransactions.vercel.app',
  'https://appassets.androidplatform.net'
];

const shortenBuckets = new Map();

function envList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = new Set([...DEFAULT_ALLOWED_ORIGINS, ...envList(process.env.VOICE_ALLOWED_ORIGINS)]);
  if (allowed.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function rateLimit(uid) {
  const now = Date.now(), windowMs = 60000, max = Number(process.env.SHORTEN_RPM || 20);
  const current = shortenBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= max) { shortenBuckets.set(uid, recent); return false; }
  recent.push(now); shortenBuckets.set(uid, recent); return true;
}

async function verifyFirebaseUser(idToken) {
  const firebaseKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseKey) throw new Error('missing_firebase_key');
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseKey)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !Array.isArray(data.users) || !data.users.length) return null;
  return data.users[0];
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function requestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body)); } catch (_) { return {}; }
}

// Only allow shortening of our own share/referral URLs — never an open redirector
function isShortenable(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return /(^|\.)ntransactions\.pro\.bd$/i.test(u.hostname);
  } catch (_) { return false; }
}

async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }

  const body = requestBody(req);
  const longUrl = String(body.url || '').trim();
  if (!longUrl || !isShortenable(longUrl)) {
    sendJson(res, 400, { error: 'invalid_url', message: 'Only nTransactions links can be shortened.' });
    return;
  }

  // Auth (same pattern as other endpoints) — prevents the endpoint being used
  // as an open shortener by anonymous callers.
  const auth = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) { sendJson(res, 401, { error: 'sign_in_required' }); return; }

  let user;
  try { user = await verifyFirebaseUser(idToken); }
  catch (e) {
    if (e && e.message === 'missing_firebase_key') { sendJson(res, 500, { error: 'firebase_not_configured' }); return; }
    sendJson(res, 500, { error: 'auth_unavailable' }); return;
  }
  if (!user || !user.localId) { sendJson(res, 401, { error: 'invalid_session' }); return; }
  if (!rateLimit(user.localId)) { sendJson(res, 429, { error: 'rate_limited' }); return; }

  const shortioKey = process.env.SHORTIO_API_KEY;
  if (!shortioKey) {
    // Not configured yet — caller falls back to the original long URL.
    sendJson(res, 200, { shortUrl: longUrl, shortened: false });
    return;
  }

  try {
    const resp = await fetchWithTimeout(SHORTIO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': shortioKey
      },
      body: JSON.stringify({ domain: SHORTIO_DOMAIN, originalURL: longUrl })
    }, 8000);

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.shortURL) {
      sendJson(res, 200, { shortUrl: data.shortURL, shortened: true });
    } else {
      // Short.io rejected the request (e.g. invalid/secret-vs-public key mismatch)
      // — fall back to the long URL so sharing never breaks.
      sendJson(res, 200, { shortUrl: longUrl, shortened: false });
    }
  } catch (e) {
    sendJson(res, 200, { shortUrl: longUrl, shortened: false });
  }
}

module.exports = handler;