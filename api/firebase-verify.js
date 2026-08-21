// ─────────────────────────────────────────────────────────────────────────────
// firebase-verify.js  –  Firebase ID Token verification using Node.js crypto
//
// Why this instead of accounts:lookup?
//   The REST accounts:lookup endpoint requires FIREBASE_WEB_API_KEY to match
//   the exact Firebase project that issued the token. Any mismatch silently
//   returns an empty users[] → 401 for every signed-in user.
//
//   This module verifies the JWT signature directly using Google's public
//   certificates, which is how firebase-admin does it internally — no API key
//   needed, just the project ID (FIREBASE_PROJECT_ID env var, already in Vercel).
// ─────────────────────────────────────────────────────────────────────────────

const { createVerify } = require('crypto');

// Google rotates these certs every few hours. Cache for up to 30 minutes.
let _certsCache = null;
let _certsCacheAt = 0;
const CERTS_TTL_MS = 30 * 60 * 1000;

async function getGooglePublicCerts() {
  if (_certsCache && Date.now() - _certsCacheAt < CERTS_TTL_MS) {
    return _certsCache;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
  );
  if (!resp.ok) throw new Error('Could not fetch Google public certs');
  const certs = await resp.json();
  _certsCache = certs;
  _certsCacheAt = Date.now();
  return certs;
}

function b64urlDecode(str) {
  // Convert base64url → base64 → Buffer
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

/**
 * Verify a Firebase ID token.
 * Returns { localId, email, emailVerified, displayName, photoURL } on success.
 * Returns null if the token is invalid, expired, or for the wrong project.
 * Throws on network failure (caller can decide whether to retry or return 500).
 */
async function verifyFirebaseToken(idToken) {
  const projectId = (process.env.FIREBASE_PROJECT_ID || 'ntransactions').trim();

  // ── 1. Structural check ────────────────────────────────────────────────────
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  // ── 2. Decode header and payload ──────────────────────────────────────────
  let header, payload;
  try {
    header  = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    return null; // malformed JWT
  }

  if (header.alg !== 'RS256') return null;
  const kid = header.kid;
  if (!kid) return null;

  // ── 3. Fetch Google's public certs and find the matching key ───────────────
  const certs = await getGooglePublicCerts();
  const cert = certs[kid];
  if (!cert) return null; // key rotated; ask client to refresh token

  // ── 4. Verify RSA-SHA256 signature ────────────────────────────────────────
  try {
    const signedContent = `${parts[0]}.${parts[1]}`;
    const signature     = b64urlDecode(parts[2]);
    const verifier      = createVerify('RSA-SHA256');
    verifier.update(signedContent);
    const valid = verifier.verify(cert, signature);
    if (!valid) return null;
  } catch (e) {
    console.error('[firebase-verify] signature check failed:', e.message);
    return null;
  }

  // ── 5. Validate standard JWT claims ───────────────────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec)          return null; // expired
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300)    return null; // future (clock skew)
  if (payload.aud  !== projectId)                                        return null; // wrong project
  if (payload.iss  !== `https://securetoken.google.com/${projectId}`)   return null; // wrong issuer
  if (!payload.sub || typeof payload.sub !== 'string')                  return null; // missing UID

  // ── 6. Return a user-info object that mirrors the old accounts:lookup shape ─
  return {
    localId:       payload.sub,
    email:         payload.email         || '',
    emailVerified: !!payload.email_verified,
    displayName:   payload.name          || '',
    photoURL:      payload.picture       || ''
  };
}

module.exports = { verifyFirebaseToken };