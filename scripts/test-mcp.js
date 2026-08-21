// ─────────────────────────────────────────────────────────────────────────────
// scripts/test-mcp.js  –  Automated Test Suite for Remote MCP Integration
// ─────────────────────────────────────────────────────────────────────────────

process.env.NODE_ENV = 'test';
process.env.USE_MOCK_DB = 'true';

const assert = require('assert');
const mcpAuth = require('../api/mcp-auth');
const mcpCore = require('../api/mcp-core');
const mcpHandler = require('../api/mcp');
const financeCore = require('../finance-core');

const {
  isLoanType,
  validateAddTransactionInput,
  calculatePeriodSummary,
  calculateOutstandingLoansAndDeposits,
  calculateWalletBalances,
  calculateBudgetStatus,
  calculateSavingsStatus,
  calculateCategoryBreakdown
} = mcpCore;

const { issueAccessToken, verifyAccessToken } = mcpAuth;
const { computeWalletBalance, recomputeAllWalletBalances } = financeCore;

async function runTests() {
  console.log('─────────────────────────────────────────────────────────────');
  console.log('  Running Remote MCP Comprehensive Test Suite');
  console.log('─────────────────────────────────────────────────────────────\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✓ PASSED: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✕ FAILED: ${name}`);
      console.error(`    ${err.message}\n`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✓ PASSED: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✕ FAILED: ${name}`);
      console.error(`    ${err.message}\n`);
      failed++;
    }
  }

  // 1. isLoanType routing check
  test('isLoanType() routes all 4 loan/deposit types correctly', () => {
    assert.strictEqual(isLoanType('loan_given'), true, 'loan_given must be loan type');
    assert.strictEqual(isLoanType('loan_recv'), true, 'loan_recv must be loan type');
    assert.strictEqual(isLoanType('deposit'), true, 'deposit must be loan type');
    assert.strictEqual(isLoanType('deposit_given'), true, 'deposit_given must be loan type');

    assert.strictEqual(isLoanType('expense'), false, 'expense must not be loan type');
    assert.strictEqual(isLoanType('income'), false, 'income must not be loan type');
    assert.strictEqual(isLoanType('transfer'), false, 'transfer must not be loan type');
  });

  // 2. Input validation checks
  test('validateAddTransactionInput() rejects invalid types, amounts, and missing conditional fields', () => {
    // Bad type
    const r1 = validateAddTransactionInput({ type: 'invalid_type', amount: 50 });
    assert.strictEqual(r1.valid, false, 'Rejects invalid type');

    // Negative / zero amount
    const r2 = validateAddTransactionInput({ type: 'expense', amount: -10 });
    assert.strictEqual(r2.valid, false, 'Rejects negative amount');

    const r3 = validateAddTransactionInput({ type: 'expense', amount: 0 });
    assert.strictEqual(r3.valid, false, 'Rejects zero amount');

    // Oversized amount (> 1B)
    const r4 = validateAddTransactionInput({ type: 'expense', amount: 2000000000 });
    assert.strictEqual(r4.valid, false, 'Rejects > 1B amount');

    // Missing person on loan_given
    const r5 = validateAddTransactionInput({ type: 'loan_given', amount: 100 });
    assert.strictEqual(r5.valid, false, 'Rejects loan_given without person');
    assert.ok(r5.error.includes('person'), 'Error message mentions person');

    // Missing person on deposit
    const r6 = validateAddTransactionInput({ type: 'deposit', amount: 100 });
    assert.strictEqual(r6.valid, false, 'Rejects deposit without person');

    // Missing toWallet on transfer
    const r7 = validateAddTransactionInput({ type: 'transfer', amount: 100, wallet: 'w1' });
    assert.strictEqual(r7.valid, false, 'Rejects transfer without toWallet');
    assert.ok(r7.error.includes('toWallet'), 'Error message mentions toWallet');

    // Valid expense
    const r8 = validateAddTransactionInput({ type: 'expense', amount: 45.5, category: 'Food' });
    assert.strictEqual(r8.valid, true, 'Accepts valid expense');
    assert.strictEqual(r8.sanitized.amount, 45.5);
  });

  // 3. OAuth Token issuance & verification
  test('OAuth token issuance and JWT verification', () => {
    const tokenObj = issueAccessToken('user_test_999');
    assert.ok(tokenObj.access_token, 'Issues access token string');
    assert.strictEqual(tokenObj.token_type, 'Bearer');

    const decoded = verifyAccessToken(tokenObj.access_token);
    assert.ok(decoded, 'Verifies valid access token');
    assert.strictEqual(decoded.sub, 'user_test_999');
  });

  // 4. Mock HTTP Server Helper for testing handler
  function createMockRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(s) { this.statusCode = s; return this; },
      end(data) { this.body = data; }
    };
  }

  // 5. Test JSON-RPC initialize and tools/list
  await testAsync('JSON-RPC initialize and tools/list endpoints', async () => {
    const reqInit = { method: 'POST', body: { jsonrpc: '2.0', method: 'initialize', id: 1 }, headers: {} };
    const resInit = createMockRes();
    await mcpHandler(reqInit, resInit);

    assert.strictEqual(resInit.statusCode, 200);
    const parsedInit = JSON.parse(resInit.body);
    assert.strictEqual(parsedInit.result.protocolVersion, '2024-11-05');

    const tokenObj = issueAccessToken('user_mcp_test');
    const reqList = {
      method: 'POST',
      body: { jsonrpc: '2.0', method: 'tools/list', id: 2 },
      headers: { authorization: `Bearer ${tokenObj.access_token}` }
    };
    const resList = createMockRes();
    await mcpHandler(reqList, resList);

    assert.strictEqual(resList.statusCode, 200);
    const parsedList = JSON.parse(resList.body);
    assert.strictEqual(parsedList.result.tools.length, 7, 'Returns 7 tools schemas');
  });

  // 6. Test brand-new user bootstrapping and all 7 transaction types
  await testAsync('Brand-new user bootstrapping and execution of all 7 transaction types', async () => {
    const uid = 'user_bootstrap_777';
    const tokenObj = issueAccessToken(uid);

    // Initial state is null
    assert.strictEqual(mcpHandler._getMockDbUser(uid), undefined);

    const callTool = async (args) => {
      const req = {
        method: 'POST',
        body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'add_transaction', arguments: args }, id: 10 },
        headers: { authorization: `Bearer ${tokenObj.access_token}` }
      };
      const res = createMockRes();
      await mcpHandler(req, res);
      return JSON.parse(res.body);
    };

    // 1. Expense
    const rExp = await callTool({ type: 'expense', amount: 100, category: 'Groceries' });
    assert.ok(!rExp.error, 'Expense call succeeds');

    const dbState = mcpHandler._getMockDbUser(uid);
    assert.ok(dbState, 'Database state bootstrapped cleanly');
    assert.strictEqual(dbState.transactions.length, 1);
    assert.strictEqual(dbState.transactions[0].type, 'expense');
    assert.strictEqual(dbState.wallets[0].balance, -100, 'Wallet balance updated to -100');

    // 2. Income
    await callTool({ type: 'income', amount: 500, category: 'Salary' });
    assert.strictEqual(dbState.transactions.length, 2);
    assert.strictEqual(dbState.wallets[0].balance, 400, 'Wallet balance updated (-100 + 500 = 400)');

    // 3. Deposit (Taking a Deposit -> loans[])
    await callTool({ type: 'deposit', amount: 200, person: 'Alice Deposit' });
    assert.strictEqual(dbState.loans.length, 1, 'Deposit lands in loans[], NOT transactions[]');
    assert.strictEqual(dbState.loans[0].type, 'deposit');
    assert.strictEqual(dbState.loans[0].person, 'Alice Deposit');
    assert.strictEqual(dbState.wallets[0].balance, 600, 'Deposit increases wallet balance (+200 -> 600)');

    // 4. Deposit Given (Making a Deposit -> loans[])
    await callTool({ type: 'deposit_given', amount: 50, person: 'Bank Vault' });
    assert.strictEqual(dbState.loans.length, 2, 'Deposit given lands in loans[]');
    assert.strictEqual(dbState.loans[0].type, 'deposit_given');
    assert.strictEqual(dbState.wallets[0].balance, 550, 'Deposit given reduces wallet balance (-50 -> 550)');

    // 5. Loan Given (Lending -> loans[])
    await callTool({ type: 'loan_given', amount: 150, person: 'Bob Loan' });
    assert.strictEqual(dbState.loans.length, 3, 'Loan given lands in loans[]');
    assert.strictEqual(dbState.loans[0].type, 'loan_given');
    assert.strictEqual(dbState.wallets[0].balance, 400, 'Loan given reduces wallet balance (-150 -> 400)');

    // 6. Loan Received (Borrowing -> loans[])
    await callTool({ type: 'loan_recv', amount: 300, person: 'Charlie Lender' });
    assert.strictEqual(dbState.loans.length, 4, 'Loan received lands in loans[]');
    assert.strictEqual(dbState.loans[0].type, 'loan_recv');
    assert.strictEqual(dbState.wallets[0].balance, 700, 'Loan received increases wallet balance (+300 -> 700)');

    // Add a second wallet for transfer
    dbState.wallets.push({ id: 'w_bank', name: 'Bank Wallet', type: 'bank', balance: 1000, initialBalance: 1000, color: '#3182ce', updatedAt: new Date().toISOString() });

    // 7. Transfer
    await callTool({ type: 'transfer', amount: 200, wallet: 'Main Wallet', toWallet: 'Bank Wallet' });
    assert.strictEqual(dbState.transactions.length, 3, 'Transfer lands in transactions[]');
    assert.strictEqual(dbState.transactions[0].type, 'transfer');

    recomputeAllWalletBalances(dbState);
    assert.strictEqual(dbState.wallets[0].balance, 500, 'Main wallet balance 700 - 200 = 500');
    assert.strictEqual(dbState.wallets[1].balance, 1200, 'Bank wallet balance 1000 + 200 = 1200');
  });

  // 7. Read tools calculations test
  await testAsync('Read tools return correct financial calculations and include deposits', async () => {
    const uid = 'user_read_test_888';
    const tokenObj = issueAccessToken(uid);

    const callRead = async (name, args = {}) => {
      const req = {
        method: 'POST',
        body: { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 20 },
        headers: { authorization: `Bearer ${tokenObj.access_token}` }
      };
      const res = createMockRes();
      await mcpHandler(req, res);
      const parsed = JSON.parse(res.body);
      return JSON.parse(parsed.result.content[0].text);
    };

    // Populate data with known figures
    const nowYm = new Date().toISOString().slice(0, 7);
    const mockData = {
      transactions: [
        { id: 't1', type: 'income', amount: 5000, date: `${nowYm}-01`, wallet: 'w_main' },
        { id: 't2', type: 'expense', amount: 1500, category: 'Rent', date: `${nowYm}-05`, wallet: 'w_main' },
        { id: 't3', type: 'expense', amount: 500, category: 'Food', date: `${nowYm}-10`, wallet: 'w_main' }
      ],
      wallets: [{ id: 'w_main', name: 'Cash Wallet', balance: 3000, initialBalance: 0 }],
      loans: [
        { id: 'l1', type: 'loan_given', person: 'Dave', amount: 1000, date: `${nowYm}-02`, payments: [] },
        { id: 'l2', type: 'deposit', person: 'Eve Safekeeping', amount: 400, date: `${nowYm}-03`, payments: [] }
      ],
      budgets: [
        { id: 'b1', category: 'overall', amount: 3000, month: nowYm, period: 'monthly' },
        { id: 'b2', category: 'Rent', amount: 1600, month: nowYm, period: 'monthly' }
      ]
    };
    mcpHandler._setMockDbUser(uid, mockData);

    // Test get_period_summary
    const summary = await callRead('get_period_summary', { period: nowYm });
    assert.strictEqual(summary.totals.income, 5000);
    assert.strictEqual(summary.totals.expense, 2000);
    assert.strictEqual(summary.totals.netCashflow, 3000);

    // Test get_outstanding_loans_and_deposits
    const loansData = await callRead('get_outstanding_loans_and_deposits', { type: 'all' });
    assert.strictEqual(loansData.count, 2, 'Returns both loan and deposit');
    assert.strictEqual(loansData.totals.outstandingReceivable, 1000, 'Dave loan given is receivable');
    assert.strictEqual(loansData.totals.outstandingPayable, 400, 'Eve deposit taken is payable');

    // Test get_wallet_balances
    const walletData = await callRead('get_wallet_balances');
    assert.strictEqual(walletData.wallets[0].balance, 3000);

    // Test get_budget_status
    const budgetData = await callRead('get_budget_status', { period: 'monthly', month: nowYm });
    assert.strictEqual(budgetData.overall.budgetAmount, 3000);
    assert.strictEqual(budgetData.overall.totalSpent, 2000);
    assert.strictEqual(budgetData.overall.pctUsed, 66.67);

    // Test get_savings_status
    const savingsData = await callRead('get_savings_status', { period: 'monthly', key: nowYm });
    assert.strictEqual(savingsData.totalIncome, 5000);
    assert.strictEqual(savingsData.totalExpense, 2000);
    assert.strictEqual(savingsData.actualSaved, 3000);

    // Test get_category_breakdown
    const breakdown = await callRead('get_category_breakdown', { period: nowYm, type: 'expense' });
    assert.strictEqual(breakdown.categories.length, 2);
    assert.strictEqual(breakdown.categories[0].category, 'Rent');
    assert.strictEqual(breakdown.categories[0].amount, 1500);
    assert.strictEqual(breakdown.categories[0].percentage, 75);
  });

  console.log(`\n─────────────────────────────────────────────────────────────`);
  console.log(`  Test Suite Completed: ${passed} Passed, ${failed} Failed`);
  console.log(`─────────────────────────────────────────────────────────────\n`);

  if (failed > 0) process.exit(1);
}

runTests();
