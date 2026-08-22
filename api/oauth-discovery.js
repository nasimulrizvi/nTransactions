// ─────────────────────────────────────────────────────────────────────────────
// api/oauth-discovery.js – OAuth 2.0 Discovery Metadata Endpoints (RFC 8414)
//
// Exposes /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource
// so Remote MCP clients (Claude, ChatGPT) can auto-discover auth endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntx.nasimulrizvi.com',
  'https://www.ntx.nasimulrizvi.com',
  'https://ntransactions.ai.studio',
  'https://ntransaction.vercel.app',
  'https://ntransactions.vercel.app',
  'https://claude.ai',
  'https://chatgpt.com'
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(JSON.stringify(body));
}

function getBaseUrl(req) {
  const host = req.headers.host || 'ntransactions.pro.bd';
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method_not_allowed' }));
  }

  const baseUrl = getBaseUrl(req);
  const type = req.query.type || (req.url.includes('protected-resource') ? 'resource' : 'server');

  if (type === 'resource') {
    return sendJson(res, 200, {
      resource: `${baseUrl}/api/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ['read', 'write']
    });
  }

  // Authorization Server Metadata (RFC 8414)
  return sendJson(res, 200, {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/mcp-auth.html`,
    token_endpoint: `${baseUrl}/api/mcp-auth`,
    registration_endpoint: `${baseUrl}/api/mcp-auth?action=register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['read', 'write']
  });
};
