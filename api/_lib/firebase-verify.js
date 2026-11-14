'use strict';

const { createVerify } = require('crypto');

let certsCache = null;
let certsCacheAt = 0;
const CERTS_TTL_MS = 30 * 60 * 1000;

async function getGooglePublicCerts() {
  if (certsCache && Date.now() - certsCacheAt < CERTS_TTL_MS) return certsCache;
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined }
  );
  if (!resp.ok) throw new Error('Could not fetch Google public certs');
  certsCache = await resp.json();
  certsCacheAt = Date.now();
  return certsCache;
}

function b64urlDecode(value) {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function verifyFirebaseToken(idToken) {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || 'ntransactions').trim();
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (e) {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const certs = await getGooglePublicCerts();
  const cert = certs[header.kid];
  if (!cert) return null;
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(cert, b64urlDecode(parts[2]))) return null;
  } catch (e) {
    return null;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;

  return {
    localId: payload.sub,
    email: payload.email || '',
    emailVerified: !!payload.email_verified,
    displayName: payload.name || '',
    photoURL: payload.picture || ''
  };
}

module.exports = { verifyFirebaseToken };
