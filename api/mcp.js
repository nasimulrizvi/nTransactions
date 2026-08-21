// ─────────────────────────────────────────────────────────────────────────────
// api/mcp.js  –  Remote Model Context Protocol (MCP) Server Endpoint
//
// Standard JSON-RPC 2.0 over HTTP (Streamable HTTP / SSE transport)
// Integrates with nTransactions Firebase Realtime Database atomically.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyAccessToken } = require('./mcp-auth');
const mcpCore = require('./mcp-core');
const financeCore = require('../finance-core');

const {
  isLoanType,
  validateAddTransactionInput,
  resolveWalletId,
  resolveCategoryId,
  calculatePeriodSummary,
  calculateOutstandingLoansAndDeposits,
  calculateWalletBalances,
  calculateBudgetStatus,
  calculateSavingsStatus,
  calculateCategoryBreakdown
} = mcpCore;

const {
  roundMoney,
  recomputeAllWalletBalances,
  buildSyncPayload
} = financeCore;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ntransactions.pro.bd',
  'https://www.ntransactions.pro.bd',
  'https://ntransactions.ai.studio',
  'https://ntransaction.vercel.app',
  'https://ntransactions.vercel.app',
  'https://claude.ai',
  'https://chatgpt.com'
];

// Sliding window rate limiters
const uidRateBuckets = new Map();
const ipRateBuckets = new Map();

function rateLimitUid(uid) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 30; // 30 req/min per UID
  const current = uidRateBuckets.get(uid) || [];
  const recent = current.filter(ts => now - ts < windowMs);
  if (recent.length >= maxRequests) {
    uidRateBuckets.set(uid, recent);
    return false;
  }
  recent.push(now);
  uidRateBuckets.set(uid, recent);
  return true;
}

function rateLimitIp(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 60; // 60 req/min per IP
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

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJsonRpc(res, status, jsonRpcResponse) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(jsonRpcResponse));
}

// ─── Firebase Database Access Helper ─────────────────────────────────────────

const DB_BASE_URL = (process.env.FIREBASE_DATABASE_URL || 'https://ntransactions-default-rtdb.firebaseio.com').replace(/\/$/, '');

// Mock database storage for local testing when Firebase credentials are not set
const _localMockDb = new Map();

async function getFirebaseUserData(uid) {
  if (process.env.NODE_ENV === 'test' || process.env.USE_MOCK_DB === 'true') {
    return _localMockDb.get(uid) || null;
  }

  try {
    const url = `${DB_BASE_URL}/users/${uid}/data.json`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('[MCP Firebase Fetch Error]', e);
    return null;
  }
}

/**
 * Atomic write helper to users/{uid}/data
 */
async function atomicUpdateUserData(uid, mutatorFn) {
  if (process.env.NODE_ENV === 'test' || process.env.USE_MOCK_DB === 'true') {
    let current = _localMockDb.get(uid) || null;
    const updated = mutatorFn(current);
    _localMockDb.set(uid, updated);
    return updated;
  }

  // Firebase Realtime Database REST ETag optimistic concurrency or Admin SDK transaction
  const url = `${DB_BASE_URL}/users/${uid}/data.json`;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const getResp = await fetch(url);
      const etag = getResp.headers.get('etag');
      let currentData = getResp.ok ? await getResp.json() : null;

      const updatedData = mutatorFn(currentData);

      const headers = { 'Content-Type': 'application/json' };
      if (etag) headers['if-match'] = etag;

      const putResp = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(updatedData)
      });

      if (putResp.ok || putResp.status === 412) {
        if (putResp.ok) return updatedData;
        // Status 412 Precondition Failed means ETag mismatch (concurrent write). Retry!
        continue;
      }

      // If ETag header is not supported by public endpoint, fallback to plain PUT
      const directResp = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData)
      });
      if (directResp.ok) return updatedData;
    } catch (e) {
      console.error('[MCP Atomic Update Error Attempt]', attempt, e);
    }
  }
  throw new Error('Could not commit atomic database write after multiple attempts.');
}

// ─── Tool Definitions List ───────────────────────────────────────────────────

const TOOLS_SCHEMAS = [
  {
    name: 'add_transaction',
    description: 'Add a new financial transaction (expense, cash in/income, transfer, loan given, loan received, deposit taken, or deposit given) to nTransactions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['expense', 'income', 'transfer', 'loan_given', 'loan_recv', 'deposit', 'deposit_given'],
          description: 'Transaction type. expense = Expense, income = Cash In, transfer = Wallet Transfer, loan_given = Money lent out, loan_recv = Money borrowed, deposit = Deposit taken for safekeeping, deposit_given = Deposit given for safekeeping.'
        },
        amount: {
          type: 'number',
          description: 'Positive numeric amount (e.g. 50.00).'
        },
        category: {
          type: 'string',
          description: 'Category name or label (e.g., "Food & Dining", "Salary"). Ignored for transfers and loans.'
        },
        wallet: {
          type: 'string',
          description: 'Name or ID of source wallet (e.g., "Cash", "Bank Account"). Defaults to primary wallet.'
        },
        toWallet: {
          type: 'string',
          description: 'Name or ID of destination wallet. Required ONLY for "transfer" type.'
        },
        person: {
          type: 'string',
          description: 'Person or organization name. Required for loan_given, loan_recv, deposit, and deposit_given.'
        },
        date: {
          type: 'string',
          description: 'Date or ISO timestamp (e.g. "2026-08-20"). Defaults to current time.'
        },
        dueDate: {
          type: 'string',
          description: 'Due date for loan repayment or deposit return (YYYY-MM-DD).'
        },
        description: {
          type: 'string',
          description: 'Optional note or description for the transaction.'
        }
      },
      required: ['type', 'amount']
    }
  },
  {
    name: 'get_period_summary',
    description: 'Get financial summary (income, expense, transfer, net cashflow, and loan/deposit activity) for a given month (YYYY-MM), year (YYYY), date range (YYYY-MM-DD..YYYY-MM-DD), or all time.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Period filter, e.g. "2026-03" for March 2026, "2026" for full year 2026, "2026-01-01..2026-03-31" for custom range, or "all".'
        }
      }
    }
  },
  {
    name: 'get_outstanding_loans_and_deposits',
    description: 'Get list of active, unsettled loans and deposits (money owed to user or money user owes), including counterparty names, remaining balances, and due dates.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['loans', 'deposits', 'all'],
          description: 'Filter by "loans" (loans given/received), "deposits" (deposits taken/given), or "all". Defaults to "all".'
        }
      }
    }
  },
  {
    name: 'get_wallet_balances',
    description: 'Get total balance across all wallets and individual balance details for each named wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        walletName: {
          type: 'string',
          description: 'Optional filter by wallet name or ID.'
        }
      }
    }
  },
  {
    name: 'get_budget_status',
    description: 'Get monthly or yearly overall and category budget targets vs actual spending, including percentage used and remaining budget.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['monthly', 'yearly'],
          description: 'Budget period ("monthly" or "yearly"). Defaults to "monthly".'
        },
        month: {
          type: 'string',
          description: 'Month (YYYY-MM) or Year (YYYY). Defaults to current period.'
        }
      }
    }
  },
  {
    name: 'get_savings_status',
    description: 'Get monthly or yearly savings target vs actual saved income, including target percentage and achievement rate.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['monthly', 'yearly'],
          description: 'Savings period ("monthly" or "yearly"). Defaults to "monthly".'
        },
        key: {
          type: 'string',
          description: 'Month (YYYY-MM) or Year (YYYY). Defaults to current period.'
        }
      }
    }
  },
  {
    name: 'get_category_breakdown',
    description: 'Get category-wise breakdown of expenses or income with total amounts and percentage shares for any period.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: 'Period filter (e.g., "2026-08", "2026", or "all").'
        },
        type: {
          type: 'string',
          enum: ['expense', 'income'],
          description: 'Transaction type ("expense" or "income"). Defaults to "expense".'
        }
      }
    }
  }
];

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const clientIp = (req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '127.0.0.1';

  // Handle SSE handshake GET request
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write('event: endpoint\ndata: /api/mcp\n\n');
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJsonRpc(res, 405, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request method' }, id: null });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  // Validate JSON-RPC request body
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return sendJsonRpc(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
  }

  const { jsonrpc, method, params, id } = body || {};
  const reqId = id !== undefined ? id : null;

  if (jsonrpc !== '2.0' || !method) {
    return sendJsonRpc(res, 400, { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' }, id: reqId });
  }

  // 1. Handshake methods: initialize & notifications/initialized (Unauthenticated rate limit)
  if (method === 'initialize') {
    if (!rateLimitIp(clientIp)) {
      return sendJsonRpc(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded. Please wait a minute.' }, id: reqId });
    }
    return sendJsonRpc(res, 200, {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nTransactions Remote MCP', version: '1.0.0' }
      },
      id: reqId
    });
  }

  if (method === 'notifications/initialized') {
    return sendJsonRpc(res, 200, { jsonrpc: '2.0', result: {}, id: reqId });
  }

  // 2. Authenticated endpoints (tools/list & tools/call)
  const host = req.headers.host || 'ntransactions.pro.bd';
  const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  const baseUrl = `${proto}://${host}`;

  const tokenPayload = verifyAccessToken(token);
  if (!tokenPayload || !tokenPayload.sub) {
    res.setHeader('WWW-Authenticate', `Bearer realm="nTransactions MCP", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`);
    return sendJsonRpc(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: Invalid or expired Bearer token' }, id: reqId });
  }

  const uid = tokenPayload.sub;

  // UID Rate Limit check (30 req/min)
  if (!rateLimitUid(uid)) {
    return sendJsonRpc(res, 429, { jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded for user. Please wait a minute.' }, id: reqId });
  }

  // Handle tools/list
  if (method === 'tools/list') {
    return sendJsonRpc(res, 200, {
      jsonrpc: '2.0',
      result: { tools: TOOLS_SCHEMAS },
      id: reqId
    });
  }

  // Handle tools/call
  if (method === 'tools/call') {
    const { name, arguments: toolArgs } = params || {};
    if (!name) {
      return sendJsonRpc(res, 400, { jsonrpc: '2.0', error: { code: -32602, message: 'Missing tool name' }, id: reqId });
    }

    try {
      // ─── WRITE TOOL: add_transaction ──────────────────────────────────────
      if (name === 'add_transaction') {
        const validation = validateAddTransactionInput(toolArgs);
        if (!validation.valid) {
          return sendJsonRpc(res, 200, {
            jsonrpc: '2.0',
            result: {
              content: [{ type: 'text', text: `Validation Error: ${validation.error}` }],
              isError: true
            },
            id: reqId
          });
        }

        const input = validation.sanitized;
        const newRecordId = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const nowIso = new Date().toISOString();
        const isLoan = isLoanType(input.type);

        let finalRecord = null;

        await atomicUpdateUserData(uid, (currentData) => {
          // Bootstrap if brand new user
          if (!currentData || typeof currentData !== 'object') {
            currentData = buildSyncPayload({}, Date.now());
          }

          // Ensure default wallet matching submitWlt() schema
          if (!Array.isArray(currentData.wallets) || currentData.wallets.length === 0) {
            currentData.wallets = [{
              id: 'w_main',
              name: 'Main Wallet',
              type: 'cash',
              balance: 0,
              initialBalance: 0,
              color: '#0ce97f',
              at: nowIso,
              updatedAt: nowIso
            }];
          }

          const walletId = resolveWalletId(currentData.wallets, input.wallet);

          if (isLoan) {
            if (!Array.isArray(currentData.loans)) currentData.loans = [];
            finalRecord = {
              id: newRecordId,
              type: input.type,
              person: input.person,
              amount: input.amount,
              wallet: walletId,
              date: input.date,
              dueDate: input.dueDate,
              note: input.description,
              photo: '',
              payments: [],
              extraEntries: [],
              at: input.date,
              updatedAt: nowIso
            };
            currentData.loans.unshift(finalRecord);
          } else {
            if (!Array.isArray(currentData.transactions)) currentData.transactions = [];
            const categoryId = resolveCategoryId(currentData, input.type, input.category);
            const toWalletId = input.type === 'transfer' ? resolveWalletId(currentData.wallets, input.toWallet) : '';

            finalRecord = {
              id: newRecordId,
              type: input.type,
              category: categoryId,
              subcategory: '',
              amount: input.amount,
              wallet: walletId,
              toWallet: toWalletId,
              date: input.date,
              note: input.description,
              photo: '',
              at: input.date,
              updatedAt: nowIso
            };
            currentData.transactions.unshift(finalRecord);
          }

          recomputeAllWalletBalances(currentData);
          currentData.ts = Date.now();
          return currentData;
        });

        const typeLabel = input.type.replace('_', ' ').toUpperCase();
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: {
            content: [{
              type: 'text',
              text: `Successfully recorded ${typeLabel} transaction of ${input.amount} BDT (ID: ${newRecordId}).`
            }]
          },
          id: reqId
        });
      }

      // ─── READ TOOLS ────────────────────────────────────────────────────────
      const userState = (await getFirebaseUserData(uid)) || buildSyncPayload({}, Date.now());

      if (name === 'get_period_summary') {
        const period = (toolArgs && toolArgs.period) || 'all';
        const summary = calculatePeriodSummary(userState, period);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] },
          id: reqId
        });
      }

      if (name === 'get_outstanding_loans_and_deposits') {
        const typeFilter = (toolArgs && toolArgs.type) || 'all';
        const loansData = calculateOutstandingLoansAndDeposits(userState, typeFilter);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(loansData, null, 2) }] },
          id: reqId
        });
      }

      if (name === 'get_wallet_balances') {
        const walletFilter = toolArgs && toolArgs.walletName;
        const walletData = calculateWalletBalances(userState, walletFilter);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(walletData, null, 2) }] },
          id: reqId
        });
      }

      if (name === 'get_budget_status') {
        const period = (toolArgs && toolArgs.period) || 'monthly';
        const month = toolArgs && toolArgs.month;
        const budgetData = calculateBudgetStatus(userState, period, month);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(budgetData, null, 2) }] },
          id: reqId
        });
      }

      if (name === 'get_savings_status') {
        const period = (toolArgs && toolArgs.period) || 'monthly';
        const key = toolArgs && toolArgs.key;
        const savingsData = calculateSavingsStatus(userState, period, key);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(savingsData, null, 2) }] },
          id: reqId
        });
      }

      if (name === 'get_category_breakdown') {
        const period = toolArgs && toolArgs.period;
        const type = (toolArgs && toolArgs.type) || 'expense';
        const breakdownData = calculateCategoryBreakdown(userState, period, type);
        return sendJsonRpc(res, 200, {
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: JSON.stringify(breakdownData, null, 2) }] },
          id: reqId
        });
      }

      return sendJsonRpc(res, 400, { jsonrpc: '2.0', error: { code: -32601, message: `Method or tool '${name}' not found` }, id: reqId });
    } catch (e) {
      console.error('[MCP Tool Execution Error]', e);
      return sendJsonRpc(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: `Internal Tool Error: ${e.message}` }, id: reqId });
    }
  }

  return sendJsonRpc(res, 400, { jsonrpc: '2.0', error: { code: -32601, message: `Unknown method '${method}'` }, id: reqId });
};

module.exports._setMockDbUser = function(uid, data) {
  _localMockDb.set(uid, data);
};
module.exports._getMockDbUser = function(uid) {
  return _localMockDb.get(uid);
};
