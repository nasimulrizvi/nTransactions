// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · AI SMS Parse API
// Endpoint  : POST /api/sms-parse
// Purpose   : Extract structured transaction data from raw Bangladeshi bank/MFS SMS
// Provider  : OpenRouter (native models-array fallback, max 3 models)
// Fallback  : Client handles offline regex fallback if this endpoint fails
// ─────────────────────────────────────────────────────────────────────────────

const { verifyFirebaseToken } = require('./firebase-verify');

const OR_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_OR_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
  'openrouter/free'
];

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntx.nasimulrizvi.com',
  'https://www.ntx.nasimulrizvi.com',
  'https://ntransactions.ai.studio',
  'https://www.ntransactions.ai.studio',
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

async function verifyFirebaseUser(idToken) {
  return verifyFirebaseToken(idToken);
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

Supported sources: bKash, Nagad, Rocket, CellFin, Dutch-Bangla Bank (DBBL), Bank Asia, BRAC Bank, City Bank, Islami Bank, Eastern Bank, Standard Chartered Bangladesh, HSBC Bangladesh, Mutual Trust Bank, Prime Bank, Southeast Bank, UCB, IFIC Bank, Trust Bank, generic Bangladeshi bank debit/credit alerts, ATM withdrawals, POS purchases, mobile banking payments, fund transfers, cash-out transactions, merchant payments.

RULES:
1. transactionType: "Expense" for debit/payment/cashout/withdrawal/purchase/sent; "Cash In" for credit/received/cashin/deposit/incoming; "Transfer" for send/transfer between accounts.
2. wallet: match the user wallet list by name (provided in the prompt). If no match, use the service name inferred from the SMS (e.g. "bKash", "Nagad", "BRAC Bank").
3. dateTime: normalize to "YYYY-MM-DD HH:MM" (24h) when date/time is present; otherwise return empty string "".
4. amount: extract numeric value only; remove commas/spaces; return as a number (not a string).
5. currency: always "BDT".
6. category: infer intelligently from context (e.g. "Food & Drinks", "Transportation", "Mobile Recharge", "Online Shopping", "Cash Withdrawal", "Utilities", "Health & Care", "Education", "Money Transfer", "Other").
7. referenceNumber: extract TxnID / Ref / Txn No / Reference / Transaction ID if present; otherwise return empty string "".
8. description: CRITICAL RULE — You MUST write a SHORT (5–12 words), natural English sentence that summarises the financial action FROM THE USER'S PERSPECTIVE. STRICTLY FORBIDDEN: do NOT copy, paraphrase, or echo any part of the raw SMS text. NEVER include phone numbers, OTPs, account balance, reference numbers, or raw transaction IDs in the description. Write as if the user is adding a quick diary note about what they spent or received money for.

DESCRIPTION GOOD EXAMPLES (right column = correct output):
SMS → Description
"Cash Out Tk 500.00 from Agent 01XXXXXXXX" → "Cash withdrawn from mobile banking agent."
"Payment Tk 1200.00 to Daraz" → "Online shopping payment completed."
"Send Money Tk 3000 to 01XXXXXXXXX" → "Money sent to a contact."
"You have received Tk 5000 from 01XXXXXXXXX" → "Payment received from a contact."
"ATM withdrawal Tk 10000 from DBBL" → "Cash withdrawn from ATM."
"Bill payment Tk 800 for DESCO" → "Electricity bill paid."
"Mobile Recharge Tk 50 to Grameenphone" → "Mobile airtime recharged."
"POS Purchase Tk 2500 at ShopUp" → "Card payment at retail store."
"bKash cashout TK 200.00 from Agent Point Your Balance is TK 1234.56 TxnID ABC123" → "Cash withdrawn via mobile banking agent."
"Nagad: You have received TK 36.55. Your Balance is TK 100.00" → "Payment received via mobile wallet."
"Salary Tk 45000 credited to your account" → "Monthly salary deposited."
"Loan EMI Tk 5000 debited" → "Loan instalment payment processed."

BAD DESCRIPTION EXAMPLES (NEVER output these):
"bKash cashout TK 200.00 from Agent Point Your Balance is TK 1234.56" (raw SMS copy)
"You have received TK 36.55" (raw SMS paraphrase)
"Nagad: TK 36.55 received. Your Balance is TK 100.00" (contains balance)

OUTPUT FORMAT: Return ONLY valid JSON. No markdown. No code fences. No explanations. No additional text before or after the JSON.

Required JSON schema (all fields mandatory):
{"transactionType":"Expense","wallet":"bKash","dateTime":"2026-06-09 16:30","amount":500,"currency":"BDT","category":"Mobile Recharge","referenceNumber":"","description":"Mobile airtime recharged."}`;

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

  const message = (data.error && data.error.message)
    ? String(data.error.message) : `HTTP ${resp.status}`;
  console.error('[OpenRouter Error]', resp.status, message);
  return { ok: false, reason: 'http', status: resp.status, message };
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
    if (e && e.message === 'missing_firebase_key') { sendJson(res, 500, { error: 'firebase_not_configured' }); return; }
    sendJson(res, 500, { error: 'auth_unavailable', message: 'Could not verify session.' }); return;
  }
  if (!user || !user.localId) { sendJson(res, 401, { error: 'invalid_session' }); return; }
  if (!rateLimit(user.localId)) { sendJson(res, 429, { error: 'rate_limited', message: 'Too many requests. Please wait.' }); return; }

  const body = requestBody(req);
  const sms = String(body.sms || '').trim();
  if (!sms || sms.length > 2000) { sendJson(res, 400, { error: 'invalid_sms', message: 'Provide a valid SMS text.' }); return; }

  const wallets = Array.isArray(body.wallets) ? body.wallets.slice(0, 50) : [];
  const currency = String(body.currency || 'BDT').slice(0, 10);

  const result = await callOpenRouter(orKey, sms, wallets, currency);
  if (!result.ok) {
    sendJson(res, result.status === 429 ? 429 : 502, {
      error: 'ai_parse_failed',
      message: result.message || 'AI parser unavailable — use offline fallback.',
      reason: result.reason
    });
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