const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const mcpHandler = require('../api/mcp');
const mcpAuthHandler = require('../api/mcp-auth');
const oauthDiscoveryHandler = require('../api/oauth-discovery');

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  req.query = parsedUrl.query;

  // Read body if POST/PUT
  if (req.method === 'POST' || req.method === 'PUT') {
    let bodyData = '';
    for await (const chunk of req) {
      bodyData += chunk;
    }
    req.body = bodyData;
  }

  console.log(`[HTTP] ${req.method} ${pathname}`);

  if (pathname === '/.well-known/oauth-authorization-server') {
    req.query.type = 'server';
    return oauthDiscoveryHandler(req, res);
  }
  if (pathname === '/.well-known/oauth-protected-resource') {
    req.query.type = 'resource';
    return oauthDiscoveryHandler(req, res);
  }
  if (pathname === '/api/mcp-auth' || pathname === '/api/mcp/oauth/token') {
    return mcpAuthHandler(req, res);
  }
  if (pathname === '/api/mcp') {
    return mcpHandler(req, res);
  }
  if (pathname === '/mcp-auth.html' || pathname === '/') {
    const filePath = path.join(__dirname, '..', 'mcp-auth.html');
    const content = fs.readFileSync(filePath, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(content);
  }

  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`nTransactions Remote MCP Server running on http://localhost:${PORT}`);
});
