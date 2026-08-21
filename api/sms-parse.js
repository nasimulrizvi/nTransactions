// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · AI SMS Parse API
// Endpoint  : POST /api/sms-parse
// Purpose   : Extract structured transaction data from raw Bangladeshi bank/MFS SMS
// Provider  : OpenRouter (native models-array fallback, max 3 models)
// Fallback  : Client handles offline regex fallback if this endpoint fails
// ─────────────────────────────────────────────────────────────────────────────

const OR_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_OR_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-120b:free',
  'qwen/qwen-2.5-72b-instruct:free'
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntransaction.vercel.app',
  'https://ntransactions.vercel.app',
  'https://appassets.androidplatform.net'
];

// ─── Utilities (mirrors gemini-voice.js) ─────────────────────────────────────

const smsBuckets = new Map();

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
  const now = Date.now(), windowMs = 60000, max = Number(process.env.SMS_PARSE_RPM || 20);
  const current = smsBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= max) { smsBuckets.set(uid, recent); return false; }
  recent.push(now); smsBuckets.set(uid, recent); return true;
}

// ─── Zero-dependency Firebase JWT verifier ───────────────────────────────────

const crypto = require('crypto');
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let _certCache = null, _certCacheExp = 0;

async function _getCerts() {
  const now = Date.now();
  if (_certCache && now < _certCacheExp) return _certCache;
  let resp;
  try { resp = await fetch(CERTS_URL, { signal: AbortSignal.timeout(6000) }); }
  catch (_) { throw new Error('firebase_network_error'); }
  if (!resp.ok) throw new Error('firebase_network_error');
  const match = (resp.headers.get('cache-control') || '').match(/max-age=(\d+)/);
  _certCache = await resp.json();
  _certCacheExp = now + (match ? parseInt(match[1]) * 1000 : 3_600_000);
  return _certCache;
}

async function verifyFirebaseUser(idToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'ntransactions';
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now)        return null;
  if (payload.iat > now + 300)   return null;
  if (payload.aud !== projectId) throw new Error('firebase_api_key_invalid');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('firebase_api_key_invalid');
  if (!payload.sub || header.alg !== 'RS256' || !header.kid) return null;
  const certs = await _getCerts();
  const pem = certs[header.kid];
  if (!pem) return null;
  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(parts[0] + '.' + parts[1], 'utf8');
    if (!v.verify(pem, Buffer.from(parts[2], 'base64url'))) return null;
  } catch (_) { return null; }
  return { localId: String(payload.sub), email: String(payload.email || '') };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (e) { if (e && e.name === 'AbortError') { const err = new Error('timeout'); err.reason = 'timeout'; throw err; } throw e; }
  finally { clearTimeout(timer); }
}

// ─── SMS Parse prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert SMS transaction parser for a Bangladeshi personal finance app.

Extract structured transaction data from the provided bank or mobile banking SMS.

Supported sources include: bKash, Nagad, Rocket, CellFin, DBBL, Bank Asia, BRAC Bank, City Bank, Islami Bank, Eastern Bank, Standard Chartered Bangladesh, HSBC Bangladesh, Mutual Trust Bank, Prime Bank, Southeast Bank, UCB, IFIC Bank, Trust Bank, and any generic Bangladeshi debit/credit alert.

RULES:
1. transactionType: "Expense" for debit/payment/cashout/withdrawal/purchase/sent; "Cash In" for credit/received/cashin/deposit/incoming; "Transfer" for send/transfer between accounts
2. wallet: match against the provided user wallet list by name; if none match, use the service name from the SMS (e.g. "bKash", "Nagad", "BRAC Bank")
3. dateTime: normalize to "YYYY-MM-DD HH:MM" when date/time is present; otherwise return empty string
4. amount: extract numeric value only; remove commas; return as number
5. currency: always "BDT"
6. category: infer intelligently (e.g. "Food & Drinks", "Transportation", "Mobile Recharge", "Online Shopping", "Cash Withdrawal", "Utilities", "Health & Care", "Education", "Money Transfer", "Other")
7. referenceNumber: extract TxnID/Ref/Txn No/Reference/ID if present; otherwise empty string
8. description: generate a SHORT, intelligent, user-friendly English description of the financial action. Do NOT copy SMS text. Make it feel natural and useful in a transaction history.

DESCRIPTION EXAMPLES:
- "Cash Out Tk 500 from Agent" → "Cash withdrawn from an agent point."
- "Payment Tk 1200 to Daraz" → "Online shopping payment completed."
- "Send Money Tk 3000 to 01XXXXXXXXX" → "Peer-to-peer mobile transfer sent."
- "You have received Tk 5000 from 01XXXXXXXXX" → "Mobile transfer received from sender."
- "ATM withdrawal Tk 10000" → "Cash withdrawn from ATM."
- "Bill payment Tk 800 for DESCO" → "Electricity bill payment processed."
- "Mobile recharge Tk 50 to Grameenphone" → "Mobile airtime recharge completed."
- "POS purchase Tk 2500 at ShopUp" → "In-store card payment made."

OUTPUT: Return ONLY valid JSON. No markdown. No code fences. No explanations. No additional text.

JSON schema:
{"transactionType":"Expense","wallet":"","dateTime":"","amount":0,"currency":"BDT","category":"","referenceNumber":"","description":""}`;

function buildSmsPrompt(sms, wallets, currency) {
  return `User wallets: ${JSON.stringify(wallets.map(w => ({ id: w.id, name: w.name })))}\nCurrency: ${currency || 'BDT'}\nSMS:\n${sms}`;
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(orKey, smsText, wallets, currency) {
  const envModels = envList(process.env.OR_SMS_MODELS);
  const models = envModels.length ? envModels : [...DEFAULT_OR_MODELS];
  const timeoutMs = Math.max(10000, Math.min(Number(process.env.OR_TIMEOUT_MS || 30000) || 30000, 60000));

  const payload = {
    models,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildSmsPrompt(smsText, wallets, currency) }
    ],
    max_tokens: 400,
    temperature: 0.1
  };

  let resp;
  try {
    resp = await fetchWithTimeout(OR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + orKey, 'HTTP-Referer': 'https://ntransactions.pro.bd', 'X-Title': 'nTransactions SMS' },
      body: JSON.stringify(payload)
    }, timeoutMs);
  } catch (e) {
    if (e && e.reason === 'timeout') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network' };
  }

  const responseText = await resp.text().catch(() => '');
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}

  if (resp.ok) {
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    if (text) return { ok: true, text, model: data.model || models[0] };
    return { ok: false, reason: 'empty' };
  }
  return { ok: false, reason: 'http', status: resp.status };
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function parseAiJson(text) {
  const raw = String(text || '').trim()
    .replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(raw.slice(s, e + 1));
  throw new Error('Invalid JSON from AI');
}

// ─── Request body helper ──────────────────────────────────────────────────────

function requestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body)); } catch (_) { return {}; }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) { sendJson(res, 500, { error: 'openrouter_not_configured', message: 'SMS AI parser is not configured on the server.' }); return; }

  // Firebase auth
  const auth = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) { sendJson(res, 401, { error: 'sign_in_required' }); return; }

  let user;
  try { user = await verifyFirebaseUser(idToken); }
  catch (e) {
    if (e && e.message === 'firebase_api_key_invalid') { sendJson(res, 500, { error: 'firebase_misconfigured', message: 'Firebase project ID mismatch. Check FIREBASE_PROJECT_ID env var.' }); return; }
    if (e && e.message === 'firebase_network_error') { sendJson(res, 503, { error: 'auth_unavailable', message: 'Authentication temporarily unreachable. Please try again.' }); return; }
    sendJson(res, 500, { error: 'auth_error', message: 'Could not verify session. Please try again.' }); return;
  }
  if (!user || !user.localId) { sendJson(res, 401, { error: 'invalid_session', message: 'Your session has expired. Please sign in again.' }); return; }
  if (!rateLimit(user.localId)) { sendJson(res, 429, { error: 'rate_limited', message: 'Too many requests. Please wait.' }); return; }

  const body = requestBody(req);
  const sms = String(body.sms || '').trim();
  if (!sms || sms.length > 2000) { sendJson(res, 400, { error: 'invalid_sms', message: 'Provide a valid SMS text.' }); return; }

  const wallets = Array.isArray(body.wallets) ? body.wallets.slice(0, 50) : [];
  const currency = String(body.currency || 'BDT').slice(0, 10);

  const result = await callOpenRouter(orKey, sms, wallets, currency);
  if (!result.ok) {
    sendJson(res, 502, { error: 'ai_parse_failed', message: 'AI parser unavailable — use offline fallback.', reason: result.reason });
    return;
  }

  try {
    const parsed = parseAiJson(result.text);
    if (!parsed.amount || Number(parsed.amount) <= 0) {
      sendJson(res, 422, { error: 'no_amount', message: 'Could not extract amount from SMS.' });
      return;
    }
    sendJson(res, 200, { ...parsed, _model: result.model });
  } catch (_) {
    sendJson(res, 502, { error: 'bad_json', message: 'AI returned unreadable response — use offline fallback.' });
  }
}

module.exports = handler;
