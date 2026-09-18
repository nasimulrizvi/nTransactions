// ─────────────────────────────────────────────────────────────────────────────
// nTransactions · SMTP Email Notification Service
// Endpoints: POST /api/send-email
// Handlers :
//   - 'monthly_digest' : Monthly Financial Digest / Statement
//   - 'loan_reminder'  : Approaching or Due Date Loan Reminder
//   - 'test'           : Test SMTP Configuration
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require('nodemailer');
const crypto = require('crypto');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://appassets.androidplatform.net'
];

const emailBuckets = new Map();

function setCors(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
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
  const now = Date.now(), windowMs = 60000, max = Number(process.env.EMAIL_NOTIF_RPM || 10);
  const current = emailBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= max) { emailBuckets.set(uid, recent); return false; }
  recent.push(now); emailBuckets.set(uid, recent); return true;
}

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
  const firebaseKey = process.env.FIREBASE_WEB_API_KEY;
  if (firebaseKey) {
    try {
      const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseKey)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
      );
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && Array.isArray(data.users) && data.users.length) {
        return { localId: data.users[0].localId, email: data.users[0].email || '' };
      }
    } catch (_) {}
  }

  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now || payload.iat > now + 300) return null;

  const projectId = process.env.FIREBASE_PROJECT_ID || payload.aud || 'ntransactions';
  if (payload.aud !== projectId && payload.aud !== payload.iss?.split('/').pop()) return null;
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

function getMailTransporter() {
  let user = (process.env.SMTP_USER || 'resend').trim();
  const pass = process.env.SMTP_PASS ? process.env.SMTP_PASS.trim() : '';
  let host = (process.env.SMTP_HOST || 'smtp.resend.com').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  // Auto-switch to Resend if legacy Gmail or Zoho values are present
  if (!host || host === 'smtp.gmail.com' || host === 'smtp.zoho.com') {
    host = 'smtp.resend.com';
  }
  if (!user || user === 'contact.nasimulrizvi@gmail.com' || user === 'hello@nasimulrizvi.com') {
    user = 'resend';
  }

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: {
      rejectUnauthorized: false
    }
  });
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtAmt(amt, curr) {
  const c = curr || '৳';
  const val = Number(amt) || 0;
  const isPrefix = ['৳', '$', '€', '£', '¥', '₹'].includes(c);
  const formatted = val.toLocaleString('en-US', {
    minimumFractionDigits: val % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
  return isPrefix ? `${c}${formatted}` : `${formatted} ${c}`;
}

// ── Plain Text Generators (Essential for anti-spam multipart/alternative delivery) ──

function buildMonthlyDigestText({
  monthLabel,
  income = 0,
  expense = 0,
  net = 0,
  savings = 0,
  currency = '৳',
  topExpenseCategory = null,
  categoryExpenses = [],
  categoryIncomes = [],
  loansSummary = null
}) {
  const lines = [];
  lines.push(`MONTHLY FINANCIAL STATEMENT - ${monthLabel}`);
  lines.push(`nTransactions • Monthly Financial Summary`);
  lines.push('========================================');
  lines.push(`Total Income  : ${fmtAmt(income, currency)}`);
  lines.push(`Total Expense : ${fmtAmt(expense, currency)}`);
  lines.push(`Net Balance   : ${(net > 0 ? '+' : '')}${fmtAmt(net, currency)}`);
  if (savings > 0) lines.push(`Saved Target  : ${fmtAmt(savings, currency)}`);
  lines.push('');

  if (categoryExpenses && categoryExpenses.length > 0) {
    lines.push('Top Expense Categories:');
    categoryExpenses.slice(0, 8).forEach(cat => {
      const name = cat.name || cat.label || 'Other';
      const pct = cat.percentage ? ` (${Math.round(cat.percentage)}%)` : '';
      lines.push(`- ${name}: ${fmtAmt(cat.amount, currency)}${pct}`);
    });
    lines.push('');
  }

  const topName = topExpenseCategory ? (topExpenseCategory.name || topExpenseCategory.label || '') : '';
  if (topExpenseCategory && topName && topExpenseCategory.amount > 0) {
    lines.push(`Highest Expense Category: ${topName} - ${fmtAmt(topExpenseCategory.amount, currency)}`);
    lines.push('');
  }

  if (categoryIncomes && categoryIncomes.length > 0) {
    lines.push('Income Breakdown:');
    categoryIncomes.slice(0, 6).forEach(cat => {
      const name = cat.name || cat.label || 'Income';
      lines.push(`- ${name}: +${fmtAmt(cat.amount, currency)}`);
    });
    lines.push('');
  }

  if (loansSummary) {
    lines.push('Loans & Deposits Overview:');
    lines.push(`- You Owe (I Owe): ${fmtAmt(loansSummary.iOwe, currency)}`);
    lines.push(`- You are Owed (Owe Me): ${fmtAmt(loansSummary.owesMe, currency)}`);
    if (loansSummary.depositTaken > 0) lines.push(`- Deposit Received: ${fmtAmt(loansSummary.depositTaken, currency)}`);
    if (loansSummary.depositGiven > 0) lines.push(`- Deposit Given: ${fmtAmt(loansSummary.depositGiven, currency)}`);
    lines.push('');
  }

  lines.push('========================================');
  lines.push('This statement was automatically generated for your nTransactions account.');
  return lines.join('\n');
}

function buildLoanReminderText({
  person,
  loanTypeLabel,
  amount = 0,
  remaining = 0,
  dueDate,
  diffDays,
  currency = '৳'
}) {
  const diff = Number(diffDays);
  const dueStatus = diff === 0 ? 'DUE TODAY' : (diff > 0 ? `Due in ${diff} day(s)` : 'OVERDUE');
  return [
    `nTransactions: Loan Due Date Reminder (${dueStatus})`,
    '========================================',
    `Person: ${person || 'Loan'}`,
    `Type: ${loanTypeLabel || 'Loan'}`,
    `Due Date: ${dueDate || 'N/A'}`,
    `Total Amount: ${fmtAmt(amount, currency)}`,
    `Remaining Balance: ${fmtAmt(remaining, currency)}`,
    '========================================',
    'Please record any new payments or settlements in your nTransactions app.'
  ].join('\n');
}

// ── Email HTML Templates ──────────────────────────────────────────────────

function buildMonthlyDigestHtml({
  monthLabel,
  income = 0,
  expense = 0,
  net = 0,
  savings = 0,
  currency = '৳',
  topExpenseCategory = null,
  categoryExpenses = [],
  categoryIncomes = [],
  loansSummary = null,
  appName = 'nTransactions'
}) {
  const netColor = net >= 0 ? '#10b981' : '#ef4444';
  const netSign = net > 0 ? '+' : '';

  const catRows = (categoryExpenses || []).slice(0, 8).map(cat => {
    const catName = cat.name || cat.label || 'Other';
    const pct = cat.percentage ? `${Math.round(cat.percentage)}%` : '';
    return `
      <tr>
        <td style="padding: 10px 12px; font-size: 14px; color: #334155; border-bottom: 1px solid #f1f5f9;">
          ${esc(catName)}
        </td>
        <td style="padding: 10px 12px; font-size: 14px; font-weight: 600; text-align: right; color: #0f172a; border-bottom: 1px solid #f1f5f9;">
          ${fmtAmt(cat.amount, currency)} ${pct ? `<span style="font-size: 12px; font-weight: 400; color: #64748b; margin-left: 6px;">(${pct})</span>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  const incRows = (categoryIncomes || []).slice(0, 6).map(cat => {
    const catName = cat.name || cat.label || 'Income';
    return `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; color: #334155; border-bottom: 1px solid #f1f5f9;">
          ${esc(catName)}
        </td>
        <td style="padding: 8px 12px; font-size: 13px; font-weight: 600; text-align: right; color: #10b981; border-bottom: 1px solid #f1f5f9;">
          +${fmtAmt(cat.amount, currency)}
        </td>
      </tr>
    `;
  }).join('');

  let loanHtml = '';
  if (loansSummary) {
    const { iOwe = 0, owesMe = 0, depositTaken = 0, depositGiven = 0 } = loansSummary;
    loanHtml = `
      <div style="margin-top: 24px; padding: 18px 20px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h3 style="margin: 0 0 12px; font-size: 15px; font-weight: 700; color: #1e293b;">
          Loans &amp; Deposits Overview (ঋণ ও আমানত)
        </h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 6px 0; color: #64748b;">You Owe (দেওয়া বাকি):</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #ef4444;">${fmtAmt(iOwe, currency)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #64748b;">You are Owed (পাওয়া বাকি):</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #10b981;">${fmtAmt(owesMe, currency)}</td>
          </tr>
          ${depositTaken > 0 ? `
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Deposit Received (আমানত গ্রহণ):</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #3b82f6;">${fmtAmt(depositTaken, currency)}</td>
          </tr>` : ''}
          ${depositGiven > 0 ? `
          <tr>
            <td style="padding: 6px 0; color: #64748b;">Deposit Given (আমানত প্রদান):</td>
            <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #8b5cf6;">${fmtAmt(depositGiven, currency)}</td>
          </tr>` : ''}
        </table>
      </div>
    `;
  }

  let topExpBadge = '';
  const topCatName = topExpenseCategory ? (topExpenseCategory.name || topExpenseCategory.label || '') : '';
  if (topExpenseCategory && topCatName && topExpenseCategory.amount > 0) {
    topExpBadge = `
      <div style="margin: 20px 0 16px; padding: 12px 16px; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 10px; display: flex; align-items: center;">
        <div style="font-size: 13px; color: #9f1239;">
          <strong>সর্বোচ্চ ব্যয়ের খাত:</strong> ${esc(topCatName)} &mdash; <strong>${fmtAmt(topExpenseCategory.amount, currency)}</strong>
          ${topExpenseCategory.percentage ? `(${Math.round(topExpenseCategory.percentage)}% of expenses)` : ''}
        </div>
      </div>
    `;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monthly Financial Statement - ${esc(monthLabel)}</title>
</head>
<body style="margin: 0; padding: 24px 12px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    <!-- Header -->
    <div style="padding: 28px 24px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff;">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; color: #94a3b8; margin-bottom: 6px;">
        Monthly Financial Statement
      </div>
      <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; color: #ffffff;">
        ${esc(monthLabel)}
      </h1>
      <div style="margin-top: 8px; font-size: 13px; color: #cbd5e1;">
        ${esc(appName)} &bull; স্বয়ংক্রিয় মাসিক আয়ের-ব্যয়ের সারসংক্ষেপ
      </div>
    </div>

    <!-- Body -->
    <div style="padding: 24px;">
      <!-- Key Figures Grid -->
      <table style="width: 100%; border-collapse: separate; border-spacing: 8px 0; margin-bottom: 20px;">
        <tr>
          <td style="width: 50%; padding: 16px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #166534; letter-spacing: 0.5px;">মোট আয় (Income)</div>
            <div style="font-size: 20px; font-weight: 700; color: #15803d; margin-top: 6px;">${fmtAmt(income, currency)}</div>
          </td>
          <td style="width: 50%; padding: 16px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 12px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #991b1b; letter-spacing: 0.5px;">মোট ব্যয় (Expense)</div>
            <div style="font-size: 20px; font-weight: 700; color: #b91c1c; margin-top: 6px;">${fmtAmt(expense, currency)}</div>
          </td>
        </tr>
      </table>

      <table style="width: 100%; border-collapse: separate; border-spacing: 8px 0; margin-bottom: 20px;">
        <tr>
          <td style="width: 50%; padding: 14px 16px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #64748b; letter-spacing: 0.5px;">নীট সঞ্চয় / ব্যালেন্স (Net)</div>
            <div style="font-size: 18px; font-weight: 700; color: ${netColor}; margin-top: 4px;">${netSign}${fmtAmt(net, currency)}</div>
          </td>
          <td style="width: 50%; padding: 14px 16px; background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px;">
            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #1e40af; letter-spacing: 0.5px;">জমা বা সেভিংস (Saved)</div>
            <div style="font-size: 18px; font-weight: 700; color: #2563eb; margin-top: 4px;">${fmtAmt(savings, currency)}</div>
          </td>
        </tr>
      </table>

      ${topExpBadge}

      <!-- Expenses Breakdown -->
      ${catRows ? `
      <div style="margin-top: 24px;">
        <h3 style="margin: 0 0 10px; font-size: 15px; font-weight: 700; color: #1e293b;">
          খরচের প্রধান খাতসমূহ (Top Expense Categories)
        </h3>
        <table style="width: 100%; border-collapse: collapse;">
          ${catRows}
        </table>
      </div>` : ''}

      <!-- Income Sources -->
      ${incRows ? `
      <div style="margin-top: 20px;">
        <h3 style="margin: 0 0 10px; font-size: 15px; font-weight: 700; color: #1e293b;">
          আয়ের প্রধান উৎসসমূহ (Income Breakdown)
        </h3>
        <table style="width: 100%; border-collapse: collapse;">
          ${incRows}
        </table>
      </div>` : ''}

      <!-- Loans & Deposits -->
      ${loanHtml}

      <!-- Footer CTA -->
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center;">
        <a href="https://ntransactions.pro.bd" style="display: inline-block; padding: 12px 28px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: 600;">
          Open nTransactions
        </a>
        <div style="margin-top: 16px; font-size: 12px; color: #94a3b8; line-height: 1.5;">
          This statement was automatically generated for your nTransactions account.<br>
          Sent via verified SMTP (${esc(process.env.SMTP_FROM || 'support@app.nasimulrizvi.com')}).
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

function buildLoanReminderHtml({
  person = '',
  loanType = 'loan_recv',
  loanTypeLabel = '',
  amount = 0,
  remaining = 0,
  dueDate = '',
  diffDays = 0,
  currency = 'BDT',
  appName = 'nTransactions'
}) {
  const isDueToday = diffDays === 0;
  const isOverdue = diffDays < 0;
  const badgeColor = isOverdue ? '#dc2626' : (isDueToday ? '#ea580c' : '#2563eb');
  const badgeBg = isOverdue ? '#fef2f2' : (isDueToday ? '#fff7ed' : '#eff6ff');
  const badgeBorder = isOverdue ? '#fecaca' : (isDueToday ? '#fed7aa' : '#bfdbfe');

  const statusText = isOverdue
    ? `সময়সীমা পার হয়ে গেছে (${Math.abs(diffDays)} দিন আগে)`
    : (isDueToday ? 'আজকে মেয়াদ শেষ (Due Today)' : `${diffDays} দিনের মধ্যে পরিশোধের তারিখ (Due in ${diffDays} days)`);

  const typeDesc = loanType === 'loan_recv'
    ? 'আপনার গ্রহণ করা ধারের পরিশোধের তারিখ ঘনিয়ে এসেছে।'
    : (loanType === 'loan_given'
      ? 'আপনার প্রদান করা ধারের ফেরতের তারিখ ঘনিয়ে এসেছে।'
      : 'আমানত বা ডিপোজিটের তারিখ ঘনিয়ে এসেছে।');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loan Reminder - ${esc(person)}</title>
</head>
<body style="margin: 0; padding: 24px 12px; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <div style="max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
    <!-- Header -->
    <div style="padding: 24px; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #94a3b8; margin-bottom: 4px;">
        Loan &amp; Debt Due Reminder
      </div>
      <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #ffffff;">
        লোন ও দেনা-পাওনার সতর্কবার্তা
      </h1>
      <div style="margin-top: 6px; font-size: 13px; color: #cbd5e1;">
        ${esc(typeDesc)}
      </div>
    </div>

    <!-- Content -->
    <div style="padding: 24px;">
      <!-- Status Badge -->
      <div style="margin-bottom: 20px; padding: 12px 16px; background-color: ${badgeBg}; border: 1px solid ${badgeBorder}; border-radius: 10px; text-align: center;">
        <span style="font-size: 14px; font-weight: 700; color: ${badgeColor};">
          ${esc(statusText)}
        </span>
      </div>

      <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px;">
        <tr>
          <td style="padding: 10px 0; color: #64748b; border-bottom: 1px solid #f1f5f9;">ব্যক্তি / প্রতিষ্ঠান:</td>
          <td style="padding: 10px 0; font-weight: 700; color: #0f172a; text-align: right; border-bottom: 1px solid #f1f5f9;">
            ${esc(person || 'Unknown')}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #64748b; border-bottom: 1px solid #f1f5f9;">লেনদেনের ধরন:</td>
          <td style="padding: 10px 0; font-weight: 600; color: #334155; text-align: right; border-bottom: 1px solid #f1f5f9;">
            ${esc(loanTypeLabel || loanType)}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #64748b; border-bottom: 1px solid #f1f5f9;">মোট পরিমাণ:</td>
          <td style="padding: 10px 0; font-weight: 600; color: #334155; text-align: right; border-bottom: 1px solid #f1f5f9;">
            ${fmtAmt(amount, currency)}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #64748b; border-bottom: 1px solid #f1f5f9;">অবশিষ্ট বকেয়া (Remaining):</td>
          <td style="padding: 10px 0; font-size: 16px; font-weight: 700; color: #ea580c; text-align: right; border-bottom: 1px solid #f1f5f9;">
            ${fmtAmt(remaining, currency)}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #64748b; border-bottom: 1px solid #f1f5f9;">মেয়াদ বা ডিউ ডেট:</td>
          <td style="padding: 10px 0; font-weight: 700; color: #0f172a; text-align: right; border-bottom: 1px solid #f1f5f9;">
            ${esc(dueDate)}
          </td>
        </tr>
      </table>

      <div style="text-align: center; margin-top: 24px; padding-top: 18px; border-top: 1px solid #e2e8f0;">
        <a href="https://ntransactions.pro.bd" style="display: inline-block; padding: 12px 28px; background: #0f172a; color: #ffffff; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: 600;">
          অ্যাপে বিস্তারিত দেখুন (View in App)
        </a>
        <div style="margin-top: 16px; font-size: 12px; color: #94a3b8;">
          ${esc(appName)} &bull; স্বয়ংক্রিয় লোন সতর্কবার্তা
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

function requestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body)); } catch (_) { return {}; }
}

async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }

  const auth = String(req.headers.authorization || '');
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) { sendJson(res, 401, { error: 'sign_in_required', message: 'Authentication required' }); return; }

  let user;
  try { user = await verifyFirebaseUser(idToken); }
  catch (e) {
    if (e && e.message === 'missing_firebase_key') { sendJson(res, 500, { error: 'firebase_not_configured' }); return; }
    sendJson(res, 500, { error: 'auth_unavailable' }); return;
  }
  if (!user || !user.localId) { sendJson(res, 401, { error: 'invalid_session' }); return; }

  const recipientEmail = String(user.email || '').trim();
  if (!recipientEmail || !recipientEmail.includes('@')) {
    sendJson(res, 400, { error: 'no_user_email', message: 'User account has no valid email address associated.' });
    return;
  }

  if (!rateLimit(user.localId)) {
    sendJson(res, 429, { error: 'rate_limited', message: 'Too many email requests. Please wait a minute.' });
    return;
  }

  const transporter = getMailTransporter();
  if (!transporter) {
    sendJson(res, 503, {
      error: 'smtp_not_configured',
      configured: false,
      message: 'SMTP credentials (SMTP_USER / SMTP_PASS) not configured on server environment.'
    });
    return;
  }

  const body = requestBody(req);
  const type = String(body.type || '').trim();
  const rawFrom = String(process.env.SMTP_FROM || 'support@app.nasimulrizvi.com').trim();
  const fromAddress = rawFrom.includes('<') ? rawFrom : `"nTransactions" <${rawFrom}>`;
  const replyToAddress = String(process.env.SMTP_REPLY_TO || 'hello@nasimulrizvi.com').trim();

  try {
    if (type === 'monthly_digest') {
      const {
        month,
        monthLabel,
        income,
        expense,
        net,
        savings,
        currency,
        topExpenseCategory,
        categoryExpenses,
        categoryIncomes,
        loansSummary
      } = body;

      const curr = currency || '৳';
      const parsedInc = Number(income) || 0;
      const parsedExp = Number(expense) || 0;
      const parsedNet = Number(net) || 0;
      const parsedSav = Number(savings) || 0;

      const html = buildMonthlyDigestHtml({
        monthLabel: monthLabel || 'Monthly Statement',
        income: parsedInc,
        expense: parsedExp,
        net: parsedNet,
        savings: parsedSav,
        currency: curr,
        topExpenseCategory,
        categoryExpenses,
        categoryIncomes,
        loansSummary
      });

      const textBody = buildMonthlyDigestText({
        monthLabel: monthLabel || 'Monthly Statement',
        income: parsedInc,
        expense: parsedExp,
        net: parsedNet,
        savings: parsedSav,
        currency: curr,
        topExpenseCategory,
        categoryExpenses,
        categoryIncomes,
        loansSummary
      });

      const info = await transporter.sendMail({
        from: fromAddress,
        replyTo: replyToAddress,
        to: recipientEmail,
        subject: `📊 nTransactions: ${monthLabel || 'Monthly'} Financial Statement`,
        text: textBody,
        html,
        headers: {
          'X-Mailer': 'nTransactions Financial Tracker',
          'X-Entity-Ref-ID': `ntx-digest-${month || Date.now()}`,
          'Auto-Submitted': 'auto-generated'
        }
      });

      sendJson(res, 200, {
        success: true,
        type: 'monthly_digest',
        messageId: info.messageId,
        recipient: recipientEmail
      });
      return;
    }

    if (type === 'loan_reminder') {
      const {
        person,
        loanType,
        loanTypeLabel,
        amount,
        remaining,
        dueDate,
        diffDays,
        currency
      } = body;

      const curr = currency || '৳';
      const diff = Number(diffDays);
      const parsedRemaining = Number(remaining) || 0;
      const dueSubject = diff === 0
        ? '⚠️ [Today] Due Date Reminder'
        : (diff > 0 ? `⏰ [${diff} days left] Due Date Reminder` : '🚨 Overdue Loan Reminder');

      const html = buildLoanReminderHtml({
        person,
        loanType,
        loanTypeLabel,
        amount: Number(amount) || 0,
        remaining: parsedRemaining,
        dueDate,
        diffDays: diff,
        currency: curr
      });

      const textBody = buildLoanReminderText({
        person,
        loanTypeLabel,
        amount: Number(amount) || 0,
        remaining: parsedRemaining,
        dueDate,
        diffDays: diff,
        currency: curr
      });

      const info = await transporter.sendMail({
        from: fromAddress,
        replyTo: replyToAddress,
        to: recipientEmail,
        subject: `${dueSubject}: ${person || 'Loan'} (${fmtAmt(parsedRemaining, curr)})`,
        text: textBody,
        html,
        headers: {
          'X-Mailer': 'nTransactions Financial Tracker',
          'Auto-Submitted': 'auto-generated'
        }
      });

      sendJson(res, 200, {
        success: true,
        type: 'loan_reminder',
        messageId: info.messageId,
        recipient: recipientEmail
      });
      return;
    }

    if (type === 'test') {
      const plainText = [
        'nTransactions: SMTP Connection Verified',
        '========================================',
        'Your nTransactions email notification integration is successfully connected and ready to deliver:',
        '- Monthly Financial Statements',
        '- Loan Due Date Reminders',
        '',
        `Sender: ${fromAddress}`,
        `Recipient: ${recipientEmail}`
      ].join('\n');

      const info = await transporter.sendMail({
        from: fromAddress,
        replyTo: replyToAddress,
        to: recipientEmail,
        subject: '✅ nTransactions: SMTP Connection Verified',
        text: plainText,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; color: #1e293b; max-width: 540px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
            <div style="display: inline-block; padding: 6px 12px; background: #ecfdf5; color: #047857; font-weight: 700; font-size: 12px; border-radius: 6px; margin-bottom: 12px;">
              SMTP VERIFIED
            </div>
            <h2 style="margin: 0 0 10px; font-size: 20px; color: #0f172a;">🎉 SMTP Configuration is Working!</h2>
            <p style="margin: 0 0 16px; font-size: 14px; color: #475569; line-height: 1.5;">
              Your nTransactions email integration is successfully connected and ready to deliver:
            </p>
            <ul style="margin: 0 0 20px; padding-left: 20px; font-size: 14px; color: #334155; line-height: 1.6;">
              <li><strong>Monthly Financial Statements</strong> (মাসিক আয়ের-ব্যয়ের সারসংক্ষেপ)</li>
              <li><strong>Loan Due Date Reminders</strong> (লোন ও ধারের সতর্কবার্তা)</li>
            </ul>
            <div style="padding: 12px 14px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b;">
              <strong>Sender:</strong> ${esc(fromAddress)} &bull; <strong>Recipient:</strong> ${esc(recipientEmail)}
            </div>
          </div>
        `,
        headers: {
          'X-Mailer': 'nTransactions Financial Tracker'
        }
      });

      sendJson(res, 200, {
        success: true,
        type: 'test',
        messageId: info.messageId,
        recipient: recipientEmail
      });
      return;
    }

    sendJson(res, 400, { error: 'invalid_type', message: 'Supported types: monthly_digest, loan_reminder, test' });
  } catch (err) {
    sendJson(res, 500, {
      error: 'send_failed',
      message: err.message || 'Failed to send email via SMTP transporter'
    });
  }
}

module.exports = handler;
