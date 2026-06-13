// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · AI Chat API  –  /api/ai-chat
// Auth: Firebase ID token verified via built-in crypto (zero external deps)
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

// ─── Zero-dependency Firebase JWT verifier ───────────────────────────────────
// Validates Firebase Auth ID tokens using Node.js built-in crypto.
// No firebase-admin, no npm install, no package.json changes needed.
// Works by fetching Google's public signing certs and verifying RS256 signature.

const crypto = require('crypto');
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// In-memory cert cache - respects Google's Cache-Control max-age header
let _certCache = null;
let _certCacheExp = 0;

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
  if (payload.exp <= now)        return null;  // expired
  if (payload.iat > now + 300)   return null;  // issued in future
  if (payload.aud !== projectId) throw new Error('firebase_api_key_invalid');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('firebase_api_key_invalid');
  if (!payload.sub || header.alg !== 'RS256' || !header.kid) return null;

  const certs = await _getCerts();
  const pem = certs[header.kid];
  if (!pem) return null; // unknown key ID - cert may have rotated

  try {
    const v = crypto.createVerify('RSA-SHA256');
    v.update(parts[0] + '.' + parts[1], 'utf8');
    if (!v.verify(pem, Buffer.from(parts[2], 'base64url'))) return null;
  } catch (_) { return null; }

  return { localId: String(payload.sub), email: String(payload.email || '') };
}

// ─────────────────────────────────────────────────────────────────────────────

const chatBuckets = new Map();

function envList(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }

function allowedOrigins() {
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...envList(process.env.VOICE_ALLOWED_ORIGINS)]);
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
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
  const now = Date.now(), windowMs = 60_000, max = Number(process.env.AI_CHAT_RPM || 8);
  const recent = (chatBuckets.get(uid) || []).filter(t => now - t < windowMs);
  if (recent.length >= max) { chatBuckets.set(uid, recent); return false; }
  chatBuckets.set(uid, [...recent, now]);
  return true;
}

function openRouterConfig() {
  const envModels = envList(process.env.OR_CHAT_MODELS || process.env.OR_VOICE_MODELS);
  return {
    models: envModels.length ? envModels : [...DEFAULT_OR_MODELS],
    timeoutMs: Math.max(8000, Math.min(Number(process.env.OR_CHAT_TIMEOUT_MS || 40000) || 40000, 90000)),
    maxOutputTokens: Math.max(400, Math.min(Number(process.env.OR_CHAT_MAX_TOKENS || 1200) || 1200, 4000)),
    temperature: Number.isFinite(Number(process.env.OR_CHAT_TEMPERATURE))
      ? Number(process.env.OR_CHAT_TEMPERATURE) : 0.3
  };
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); }
  catch (e) {
    if (e?.name === 'AbortError') { const err = new Error('timeout'); err.reason = 'timeout'; throw err; }
    throw e;
  } finally { clearTimeout(t); }
}

function safeChatContext(transactions, wallets, loans) {
  const cutoff = new Date(Date.now() - 182 * 86_400_000).toISOString().slice(0, 10);
  const safeTx = (Array.isArray(transactions) ? transactions : [])
    .filter(t => t && String(t.date || '') >= cutoff)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 300)
    .map(t => ({
      date: String(t.date || '').slice(0, 16),
      type: String(t.type || ''),
      amount: Number(t.amount) || 0,
      category: String(t.categoryLabel || t.category || '').slice(0, 60),
      subcategory: String(t.subcategoryLabel || '').slice(0, 60),
      description: String(t.description || t.note || '').slice(0, 120),
      wallet: String(t.walletName || t.walletId || '').slice(0, 60)
    }));
  const safeWallets = (Array.isArray(wallets) ? wallets : []).slice(0, 30)
    .map(w => ({ name: String(w.name || '').slice(0, 60), balance: Number(w.balance) || 0 }));
  const safeLoans = (Array.isArray(loans) ? loans : []).slice(0, 60)
    .map(l => ({
      person: String(l.person || l.organization || '').slice(0, 80),
      type: String(l.type || ''),
      amount: Number(l.amount) || 0,
      remaining: Number(l.remaining || l.amount) || 0,
      description: String(l.description || '').slice(0, 100),
      dueDate: String(l.dueDate || '').slice(0, 10)
    }));
  return { transactions: safeTx, wallets: safeWallets, loans: safeLoans };
}

const SYSTEM_PROMPT = `You are a personal finance assistant embedded inside nTransactions, a personal finance tracking app.
Your job is to help users understand their own financial data clearly and accurately.

STRICT RULES:
1. Always respond in English only, regardless of the language used in the question.
2. Base all answers strictly on the transaction data provided in each message. Do not assume or invent figures.
3. If the data is insufficient or the time period is not covered, say so honestly.
4. Format amounts with 2 decimal places and include the currency code (e.g. BDT 1,200.00).
5. For time-based questions, use the transaction "date" fields carefully.
6. Keep responses concise but complete. Use bullet points or short paragraphs where appropriate.
7. You can answer questions about expenses, income, loans, debts, transfers, wallet balances, spending by category, monthly summaries, and spending trends.
8. For loan/debt questions, use the loans data provided, not transaction records.`;

function buildMessages(question, ctx, currency) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content:
        `Currency in use: ${currency || 'BDT'}\n\n` +
        `--- Transaction History (last 6 months, most recent first) ---\n${JSON.stringify(ctx.transactions)}\n\n` +
        `--- Wallet Balances ---\n${JSON.stringify(ctx.wallets)}\n\n` +
        `--- Loans & Debts ---\n${JSON.stringify(ctx.loans)}\n\n` +
        `--- User Question ---\n${question}`
    }
  ];
}

async function callOpenRouter(orKey, messages, cfg) {
  let response;
  try {
    response = await fetchWithTimeout(OR_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + orKey,
        'HTTP-Referer': 'https://ntransactions.pro.bd',
        'X-Title': 'nTransactions AI Chat'
      },
      body: JSON.stringify({ models: cfg.models, messages, max_tokens: cfg.maxOutputTokens, temperature: cfg.temperature })
    }, cfg.timeoutMs);
  } catch (e) {
    return { ok: false, status: 504, reason: e?.reason === 'timeout' ? 'timeout' : 'network' };
  }
  let data = {};
  try { data = JSON.parse(await response.text().catch(() => '')); } catch (_) {}
  if (response.ok) {
    const answer = String(data.choices?.[0]?.message?.content || '').trim();
    return answer ? { ok: true, answer, model: data.model || cfg.models[0] }
                  : { ok: false, status: 502, reason: 'empty' };
  }
  return { ok: false, status: response.status, reason: 'http' };
}

function requestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body)); } catch (_) { return {}; }
}

async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST')    { sendJson(res, 405, { error: 'method_not_allowed' }); return; }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    sendJson(res, 500, { error: 'openrouter_not_configured', message: 'AI Chat is not configured on the server yet.' });
    return;
  }

  const auth    = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) { sendJson(res, 401, { error: 'sign_in_required', message: 'Sign in to use AI Chat.' }); return; }

  let user;
  try { user = await verifyFirebaseUser(idToken); }
  catch (e) {
    if (e?.message === 'firebase_api_key_invalid') {
      sendJson(res, 500, { error: 'firebase_misconfigured',
        message: 'Firebase project ID mismatch. Set FIREBASE_PROJECT_ID env var in Vercel if your project is not "ntransactions".' });
    } else if (e?.message === 'firebase_network_error') {
      sendJson(res, 503, { error: 'auth_unavailable',
        message: 'Authentication temporarily unreachable. Please try again.' });
    } else {
      sendJson(res, 500, { error: 'auth_error', message: 'Could not verify your session. Please try again.' });
    }
    return;
  }

  if (!user?.localId) {
    sendJson(res, 401, { error: 'invalid_session', message: 'Your session has expired. Please sign in again.' });
    return;
  }

  if (!rateLimit(user.localId)) {
    sendJson(res, 429, { error: 'chat_rate_limited', message: 'Too many questions. Please wait a moment and try again.' });
    return;
  }

  const body     = requestBody(req);
  const question = String(body.question || '').trim();
  if (!question || question.length > 600) {
    sendJson(res, 400, { error: 'invalid_question', message: 'Please type a question (up to 600 characters).' });
    return;
  }

  const currency = String(body.currency || 'BDT').slice(0, 12);
  const ctx      = safeChatContext(body.transactions, body.wallets, body.loans);
  const cfg      = openRouterConfig();
  const result   = await callOpenRouter(orKey, buildMessages(question, ctx, currency), cfg);

  if (!result.ok) {
    const msgs = {
      timeout: 'AI Chat took too long to respond. Please try again.',
      network: 'AI Chat could not be reached. Check your connection.',
      empty:   'AI returned an empty response. Please try again.',
      http:    result.status === 429 ? 'AI Chat is busy right now. Please wait a moment.'
                                     : 'AI Chat is temporarily unavailable. Please try again.'
    };
    sendJson(res, result.status === 429 ? 429 : 502,
      { error: 'ai_chat_failed', message: msgs[result.reason] || msgs.http });
    return;
  }

  sendJson(res, 200, { answer: result.answer, model: result.model });
}

module.exports = handler;
