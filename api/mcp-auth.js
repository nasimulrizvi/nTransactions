// ─────────────────────────────────────────────────────────────────────────────
// api/mcp-auth.js  –  OAuth 2.0 Token Endpoint for Remote MCP Server
//
// Endpoint : POST /api/mcp/oauth/token
// Handles grant_type=authorization_code and returns Bearer access tokens.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntransactions.ai.studio',
  'https://ntransaction.vercel.app',
  'https://ntransactions.vercel.app',
  'https://claude.ai',
  'https://chatgpt.com'
];

// Sliding window rate limiter: 10 requests per minute per IP
const ipRateBuckets = new Map();

function rateLimitIp(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;
  const current = ipRateBuckets.get(ip) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= maxRequests) {
    ipRateBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  ipRateBuckets.set(ip, recent);
  return true;
}

function getSecretKey() {
  return process.env.MCP_OAUTH_SECRET || 'ntransactions_mcp_secret_default_key_2026';
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/**
 * Verify HMAC signature on auth code or token
 */
function verifySignature(payloadStr, signature) {
  const secret = getSecretKey();
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signature));
}

/**
 * Issue a signed OAuth access token valid for 30 days
 */
function issueAccessToken(uid) {
  const secret = getSecretKey();
  const iat = Math.floor(Date.now() / 1000);
  const expires_in = 30 * 24 * 60 * 60; // 30 days in seconds
  const exp = iat + expires_in;

  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify({ sub: uid, iat, exp, iss: 'ntransactions-mcp' })).toString('base64url');

  const signedContent = `${headerB64}.${payloadB64}`;
  const signature = crypto.createHmac('sha256', secret).update(signedContent).digest('base64url');

  return {
    access_token: `${signedContent}.${signature}`,
    token_type: 'Bearer',
    expires_in
  };
}

/**
 * Verify a signed OAuth access token
 */
function verifyAccessToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split('.');
  if (parts.length !== 3) return null;

  try {
    const signedContent = `${parts[0]}.${parts[1]}`;
    const secret = getSecretKey();
    const expectedSig = crypto.createHmac('sha256', secret).update(signedContent).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(parts[2]))) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return null; // expired

    return payload; // { sub, iat, exp, iss }
  } catch (e) {
    return null;
  }
}

/**
 * Generate a short-lived authorization code containing UID
 */
function generateAuthCode(uid) {
  const secret = getSecretKey();
  const exp = Date.now() + 10 * 60 * 1000; // 10 minutes expiry
  const payloadObj = { uid, exp, nonce: crypto.randomBytes(8).toString('hex') };
  const payloadStr = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
  return `${payloadStr}.${sig}`;
}

/**
 * Verify an authorization code
 */
function verifyAuthCode(codeStr) {
  if (!codeStr || typeof codeStr !== 'string') return null;
  const parts = codeStr.split('.');
  if (parts.length !== 2) return null;

  try {
    if (!verifySignature(parts[0], parts[1])) return null;
    const payloadObj = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payloadObj.uid || !payloadObj.exp || payloadObj.exp < Date.now()) return null;
    return payloadObj.uid;
  } catch (e) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const clientIp = (req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '127.0.0.1';
  if (!rateLimitIp(clientIp)) {
    return sendJson(res, 429, {
      error: 'rate_limit_exceeded',
      error_description: 'Rate limit exceeded for OAuth endpoint. Please wait a minute.'
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'invalid_request', error_description: 'Method not allowed' });
  }

  // Parse body (Form URL encoded or JSON)
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = Object.fromEntries(new URLSearchParams(req.body));
    }
  }

  const { grant_type, code } = body || {};

  if (grant_type !== 'authorization_code') {
    return sendJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Only grant_type=authorization_code is supported.'
    });
  }

  const uid = verifyAuthCode(code);
  if (!uid) {
    return sendJson(res, 400, {
      error: 'invalid_grant',
      error_description: 'Authorization code is invalid or expired.'
    });
  }

  const tokenResp = issueAccessToken(uid);
  return sendJson(res, 200, tokenResp);
};

module.exports.generateAuthCode = generateAuthCode;
module.exports.verifyAuthCode = verifyAuthCode;
module.exports.verifyAccessToken = verifyAccessToken;
module.exports.issueAccessToken = issueAccessToken;
