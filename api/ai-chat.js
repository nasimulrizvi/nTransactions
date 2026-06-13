// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · AI Chat API
// Endpoint  : POST /api/ai-chat
// Provider  : OpenRouter  (https://openrouter.ai/api/v1/chat/completions)
// Purpose   : Answer user finance questions based on their full transaction history
// ─────────────────────────────────────────────────────────────────────────────

const OR_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Same ordered fallback list as gemini-voice.js
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

// ─── Shared utilities (mirrors gemini-voice.js) ───────────────────────────────

const chatBuckets = new Map();

function envList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function allowedOrigins() {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...envList(process.env.VOICE_ALLOWED_ORIGINS)
  ]);
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
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = Number(process.env.AI_CHAT_RPM || 8);
  const current = chatBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= maxRequests) {
    chatBuckets.set(uid, recent);
    return false;
  }
  recent.push(now);
  chatBuckets.set(uid, recent);
  return true;
}

async function verifyFirebaseUser(idToken) {
  const firebaseKey = process.env.FIREBASE_WEB_API_KEY;
  if (!firebaseKey) throw new Error('missing_firebase_key');
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.users) || !data.users.length) return null;
  return data.users[0];
}

// ─── OpenRouter config ────────────────────────────────────────────────────────

function openRouterConfig() {
  const envModels = envList(process.env.OR_CHAT_MODELS || process.env.OR_VOICE_MODELS);
  const models = envModels.length ? envModels : [...DEFAULT_OR_MODELS];
  const timeoutMs = Math.max(8000, Math.min(
    Number(process.env.OR_CHAT_TIMEOUT_MS || 40000) || 40000, 90000
  ));
  return {
    models,
    timeoutMs,
    maxOutputTokens: Math.max(400, Math.min(
      Number(process.env.OR_CHAT_MAX_TOKENS || 1200) || 1200, 4000
    )),
    temperature: Number.isFinite(Number(process.env.OR_CHAT_TEMPERATURE))
      ? Number(process.env.OR_CHAT_TEMPERATURE) : 0.3
  };
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('timeout');
      err.reason = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Context sanitisation ─────────────────────────────────────────────────────

function safeChatContext(transactions, wallets, loans) {
  // Keep last 6 months, cap at 300 entries to stay within context window
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString().slice(0, 10);

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
      description: String(t.description || '').slice(0, 120),
      wallet: String(t.walletName || t.walletId || '').slice(0, 60)
    }));

  const safeWallets = (Array.isArray(wallets) ? wallets : [])
    .slice(0, 30)
    .map(w => ({
      name: String(w.name || '').slice(0, 60),
      balance: Number(w.balance) || 0
    }));

  const safeLoans = (Array.isArray(loans) ? loans : [])
    .slice(0, 60)
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

// ─── Prompt builder ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a personal finance assistant embedded inside nTransactions, a personal finance tracking app.
Your job is to help users understand their own financial data clearly and accurately.

STRICT RULES:
1. Always respond in English only, regardless of the language used in the question.
2. Base all answers strictly on the transaction data provided in each message — do not assume or invent figures.
3. If the data is insufficient or the time period is not covered, say so honestly.
4. Format amounts with 2 decimal places and include the currency code (e.g. BDT 1,200.00).
5. For time-based questions, use the transaction "date" fields carefully.
6. Keep responses concise but complete. Use bullet points or short paragraphs where appropriate.
7. You can answer questions about expenses, income, loans, debts, transfers, wallet balances, spending by category, monthly summaries, and spending trends.
8. For loan/debt questions, use the loans data provided, not transaction records.`;

function buildChatMessages(question, context, currency) {
  const userContent = `Currency in use: ${currency || 'BDT'}

--- Transaction History (last 6 months, most recent first) ---
${JSON.stringify(context.transactions, null, 0)}

--- Wallet Balances ---
${JSON.stringify(context.wallets, null, 0)}

--- Loans & Debts ---
${JSON.stringify(context.loans, null, 0)}

--- User Question ---
${question}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent }
  ];
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(orKey, messages, config) {
  const payload = {
    models: config.models,
    messages,
    max_tokens: config.maxOutputTokens,
    temperature: config.temperature
  };

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
      body: JSON.stringify(payload)
    }, config.timeoutMs);
  } catch (e) {
    if (e && e.reason === 'timeout') {
      return { ok: false, status: 504, reason: 'timeout' };
    }
    return { ok: false, status: 502, reason: 'network' };
  }

  const responseText = await response.text().catch(() => '');
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}

  if (response.ok) {
    const answer = String(data.choices?.[0]?.message?.content || '').trim();
    if (answer) return { ok: true, answer, model: data.model || config.models[0] };
    return { ok: false, status: 502, reason: 'empty' };
  }

  return { ok: false, status: response.status, reason: 'http' };
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

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    sendJson(res, 500, {
      error: 'openrouter_not_configured',
      message: 'AI Chat is not configured on the server yet.'
    });
    return;
  }

  const auth = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) {
    sendJson(res, 401, { error: 'sign_in_required', message: 'Sign in to use AI Chat.' });
    return;
  }

  let user;
  try {
    user = await verifyFirebaseUser(idToken);
  } catch (e) {
    if (e && e.message === 'missing_firebase_key') {
      sendJson(res, 500, {
        error: 'firebase_not_configured',
        message: 'AI Chat authentication is not configured on the server yet.'
      });
    } else {
      sendJson(res, 500, {
        error: 'auth_verification_unavailable',
        message: 'Could not verify your session. Please try again.'
      });
    }
    return;
  }
  if (!user || !user.localId) {
    sendJson(res, 401, { error: 'invalid_session', message: 'Session expired. Please sign in again.' });
    return;
  }
  if (!rateLimit(user.localId)) {
    sendJson(res, 429, {
      error: 'chat_rate_limited',
      message: 'You are sending too many questions. Please wait a moment and try again.'
    });
    return;
  }

  const body = requestBody(req);
  const question = String(body.question || '').trim();
  if (!question || question.length > 600) {
    sendJson(res, 400, {
      error: 'invalid_question',
      message: 'Please type a question (up to 600 characters).'
    });
    return;
  }

  const currency = String(body.currency || 'BDT').slice(0, 12);
  const context = safeChatContext(body.transactions, body.wallets, body.loans);
  const config = openRouterConfig();
  const messages = buildChatMessages(question, context, currency);

  const result = await callOpenRouter(orKey, messages, config);

  if (!result.ok) {
    const msgMap = {
      timeout: 'AI Chat took too long to respond. Please try again.',
      network: 'AI Chat could not be reached. Check your connection and try again.',
      empty:   'AI returned an empty response. Please try again.',
      http:    result.status === 429
               ? 'AI Chat is busy right now. Please wait a moment and try again.'
               : 'AI Chat is temporarily unavailable. Please try again.'
    };
    sendJson(res, result.status === 429 ? 429 : 502, {
      error: 'ai_chat_failed',
      message: msgMap[result.reason] || 'AI Chat is temporarily unavailable. Please try again.'
    });
    return;
  }

  sendJson(res, 200, {
    answer: result.answer,
    model: result.model
  });
}

module.exports = handler;