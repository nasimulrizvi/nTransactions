// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · Voice Transaction API
// Provider : OpenRouter  (https://openrouter.ai/api/v1/chat/completions)
// Fallback  : native OpenRouter `models` array — single HTTP call, no manual loop
// ─────────────────────────────────────────────────────────────────────────────

const OR_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Ordered fallback list.  Primary → secondary Gemini → free LLMs.
// Override at runtime via OR_VOICE_MODELS (comma-separated OpenRouter model ids).
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

// ─── Shared utilities ─────────────────────────────────────────────────────────

const requestBuckets = new Map();

function envList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
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
  const maxRequests = Number(process.env.VOICE_PARSE_RPM || 12);
  const current = requestBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= maxRequests) {
    requestBuckets.set(uid, recent);
    return false;
  }
  recent.push(now);
  requestBuckets.set(uid, recent);
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
  const envModels = envList(process.env.OR_VOICE_MODELS);
  const models = envModels.length ? envModels : [...DEFAULT_OR_MODELS];
  const timeoutMs = Math.max(5000, Math.min(
    Number(process.env.OR_TIMEOUT_MS || 30000) || 30000, 60000
  ));
  return {
    models,
    timeoutMs,
    maxOutputTokens: Math.max(300, Math.min(
      Number(process.env.OR_MAX_OUTPUT_TOKENS || 700) || 700, 2000
    )),
    temperature: Number.isFinite(Number(process.env.OR_TEMPERATURE))
      ? Number(process.env.OR_TEMPERATURE) : 0.1
  };
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(transcript, context) {
  return `You parse one spoken personal-finance command for nTransactions.
Understand Bangla, English, and mixed Bangla-English informal speech.
Return every final field value, category explanation, description, and note in English only.
Infer real-world financial meaning. Do not translate word by word, and do not rely only on exact keywords.
Use the provided category and subcategory ids. Pick the closest main category by meaning. If a matching subcategory exists, choose it; otherwise leave subcategoryId empty and keep the main category.
Use type "income" for Cash In. Use type "transfer" only when money moves between wallets/accounts such as bKash to Nagad.
Use type "loan_given" when the user lent money to another person. Use type "loan_recv" when the user borrowed money from another person. Use type "deposit" when another person left money with the user for safekeeping. Use type "deposit_given" only when the user left a deposit with someone else.
Set loanAction to "new" for a new loan/deposit, "add_more" when the same person adds/borrows more under an existing loan/deposit, and "payment" for Loan Collected, Loan Repayment, Deposit Return, or Deposit Withdrawn.
Resolve person or organization names when mentioned. For family terms, write clear English such as Mother, Father, Brother, Uncle, or Friend.
Use dateTime "${context.now}" when no date or time is mentioned. Resolve relative dates such as today, tomorrow, day after tomorrow, next week, and next month against "${context.now}". Put expected return/repay/collect dates in dueDate.
Write description as a clean, natural passive-voice English sentence when possible.
Do not mention the amount, currency, taka, BDT, Tk, or numeric price in description. The amount belongs only in the amount field.
Semantic references:
- mosque donation -> expense, Donation, "A donation was made to the mosque."
- coaching/monthly fee -> expense, Education, "Monthly coaching centre fee was paid."
- restaurant meal with friends -> expense, Food & Drinks.
- doctor visit or medicine -> expense, Health & Care, matching Doctor Visit or Medicine subcategory if present.
- cinema ticket -> expense, Entertainment.
- Uber/ride-sharing/commute -> expense, Transportation.
- mess/house rent paid -> expense, Accommodation.
- mobile recharge on Grameenphone/Robi/Banglalink/Airtel/Teletalk -> expense, Mobile Recharge, operator subcategory if present.
- shirt/clothes/shoes -> expense, Clothing & Accessories.
- earphone/laptop/phone/accessories -> expense, Technology & Electronics.
- small household items -> expense, Miscellaneous Expenses.
- money from mother/father/family -> income, Parents & Family.
- cashback/bonus/reward -> income, Bonus & Cash Back.
- uncle/aunt/relative gift -> income, Relatives.
- salary, commission, scholarship/allowance, freelance/Fiverr, business/shop income, tuition fees, investment profit, dividends, rental income, cash gifts, refunds, remittance, sale proceeds, prizes -> choose the closest matching income category.
- bKash to Nagad or one wallet to another -> transfer, fill walletName and toWalletName when matched.
- lent to Sakib -> loan_given/new; Sakib borrowed more -> loan_given/add_more; Sakib returned money -> loan_given/payment.
- borrowed from Karim -> loan_recv/new; borrowed more from Karim -> loan_recv/add_more; repaid Karim -> loan_recv/payment.
- Tamim left a deposit with me -> deposit/new; Tamim deposited more -> deposit/add_more; Tamim collected it back -> deposit/payment.
Return only JSON with this schema:
{"type":"expense|income|transfer|loan_given|loan_recv|deposit|deposit_given","loanAction":"new|add_more|payment|","categoryId":"","categoryLabel":"","subcategoryId":"","subcategoryLabel":"","person":"","organization":"","amount":0,"walletId":"","walletName":"","toWalletId":"","toWalletName":"","dateTime":"YYYY-MM-DDTHH:mm","dueDate":"YYYY-MM-DD or empty","description":"","confidence":0}
App context JSON:
${JSON.stringify(context)}
Spoken sentence:
${JSON.stringify(transcript)}`;
}

// ─── JSON parsing ─────────────────────────────────────────────────────────────

function parseResponseJson(text) {
  const raw = String(text || '').trim()
    .replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw e;
  }
}

// ─── Fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('openrouter_timeout');
      err.reason = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenRouter API call (single request, native models-array fallback) ───────

async function callOpenRouter(orKey, prompt, config) {
  // The `models` array is OpenRouter's native multi-model fallback:
  // it attempts each model in order and returns the first successful result.
  const payload = {
    models: config.models,
    messages: [{ role: 'user', content: prompt }],
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
        'X-Title': 'nTransactions Voice'
      },
      body: JSON.stringify(payload)
    }, config.timeoutMs);
  } catch (e) {
    if (e && e.reason === 'timeout') {
      return { ok: false, status: 504, message: 'Request timed out.', reason: 'timeout' };
    }
    return { ok: false, status: 502, message: 'OpenRouter could not be reached.', reason: 'network' };
  }

  const responseText = await response.text().catch(() => '');
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; } catch (_) {}

  if (response.ok) {
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    if (text) return { ok: true, text, model: data.model || config.models[0] };
    return { ok: false, status: 502, message: 'Empty response from AI.', reason: 'empty' };
  }

  const message = (data.error && data.error.message)
    ? String(data.error.message) : `HTTP ${response.status}`;
  return { ok: false, status: response.status, message, reason: 'http' };
}

// ─── User-facing error messages ───────────────────────────────────────────────

function orClientMessage(error) {
  if (!error) return 'Voice Transaction AI is temporarily unavailable. Please try again.';
  if (error.reason === 'timeout') return 'Voice Transaction AI took too long to respond. Please try again.';
  if (error.reason === 'network') return 'Voice Transaction AI could not be reached. Check the connection and try again.';
  if (error.reason === 'empty') return 'Voice Transaction AI returned an empty response. Please try again.';
  if (error.reason === 'bad_json') return 'Voice Transaction AI returned an unreadable response. Please try again.';
  if (error.status === 429) return 'Voice Transaction AI is busy right now. Please wait a moment and try again.';
  if ([500, 502, 503, 504].includes(error.status)) return 'Voice Transaction AI is temporarily unavailable. Please try again.';
  return 'Voice Transaction AI could not process this transaction. Please try again.';
}

// ─── Input sanitisation ───────────────────────────────────────────────────────

function safeContext(context) {
  const source = context && typeof context === 'object' ? context : {};
  return {
    now: String(source.now || '').slice(0, 32),
    today: String(source.today || '').slice(0, 16),
    currency: String(source.currency || 'BDT').slice(0, 12),
    wallets: Array.isArray(source.wallets)
      ? source.wallets.slice(0, 50).map(w => ({
          id: String(w.id || '').slice(0, 80),
          name: String(w.name || '').slice(0, 120)
        }))
      : [],
    expenseCategories: Array.isArray(source.expenseCategories)
      ? source.expenseCategories.slice(0, 80) : [],
    incomeCategories: Array.isArray(source.incomeCategories)
      ? source.incomeCategories.slice(0, 80) : [],
    transactionTypes: ['expense', 'income', 'transfer', 'loan_given', 'loan_recv', 'deposit', 'deposit_given'],
    loanActions: ['new', 'add_more', 'payment'],
    loanTypes: Array.isArray(source.loanTypes) ? source.loanTypes.slice(0, 12) : []
  };
}

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
      message: 'Voice Transaction AI is not configured on the server yet.'
    });
    return;
  }

  const auth = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) {
    sendJson(res, 401, { error: 'sign_in_required' });
    return;
  }

  let user;
  try {
    user = await verifyFirebaseUser(idToken);
  } catch (e) {
    if (e && e.message === 'missing_firebase_key') {
      sendJson(res, 500, {
        error: 'firebase_not_configured',
        message: 'Voice Transaction authentication is not configured on the server yet.'
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
    sendJson(res, 401, { error: 'invalid_session' });
    return;
  }
  if (!rateLimit(user.localId)) {
    sendJson(res, 429, { error: 'voice_rate_limited' });
    return;
  }

  const body = requestBody(req);
  const transcript = String(body.transcript || '').trim();
  if (!transcript || transcript.length > 1000) {
    sendJson(res, 400, {
      error: 'invalid_transcript',
      message: 'Speak or type a transaction sentence first.'
    });
    return;
  }

  const context = safeContext(body.context);
  const config = openRouterConfig();
  const prompt = buildPrompt(transcript, context);

  const result = await callOpenRouter(orKey, prompt, config);

  if (!result.ok) {
    const status = result.status === 429 ? 429 : 502;
    sendJson(res, status, {
      error: 'openrouter_request_failed',
      status: result.status,
      model: result.model || '',
      message: orClientMessage(result)
    });
    return;
  }

  try {
    const parsed = parseResponseJson(result.text);
    sendJson(res, 200, {
      parsed,
      model: result.model,
      fallbackUsed: !!(result.model && result.model !== config.models[0])
    });
  } catch (_) {
    sendJson(res, 502, {
      error: 'openrouter_bad_json',
      message: orClientMessage({ reason: 'bad_json' })
    });
  }
}

module.exports = handler;