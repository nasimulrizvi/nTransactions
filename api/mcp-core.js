// ─────────────────────────────────────────────────────────────────────────────
// api/mcp-core.js  –  Server-side financial calculations & helpers for Remote MCP
//
// Reuses canonical financial math from finance-core.js.
// Pure functions, zero DOM dependencies.
// ─────────────────────────────────────────────────────────────────────────────

const financeCore = require('../finance-core');

const {
  roundMoney,
  computeWalletBalance,
  recomputeAllWalletBalances,
  LOAN_TYPES,
  buildSyncPayload
} = financeCore;

// ─── Loan Type Check ─────────────────────────────────────────────────────────

function isLoanType(type) {
  return type === 'loan_given' || type === 'loan_recv' || type === 'deposit' || type === 'deposit_given';
}

// ─── Input Validation & Sanitization ─────────────────────────────────────────

const ALLOWED_TYPES = new Set([
  'expense',
  'income',
  'transfer',
  'loan_given',
  'loan_recv',
  'deposit',
  'deposit_given'
]);

function sanitizeString(str, maxLength = 100) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\r\n\t]/g, ' ').replace(/<[^>]*>/g, '').trim().slice(0, maxLength);
}

function validateAddTransactionInput(input) {
  const { type, amount, category, wallet, toWallet, person, date, dueDate, description } = input || {};

  if (!type || !ALLOWED_TYPES.has(type)) {
    return {
      valid: false,
      error: `Invalid transaction type '${type}'. Must be one of: ${Array.from(ALLOWED_TYPES).join(', ')}.`
    };
  }

  const numAmount = parseFloat(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 1000000000) {
    return {
      valid: false,
      error: 'Amount must be a positive number greater than 0 and less than or equal to 1,000,000,000.'
    };
  }

  if (isLoanType(type)) {
    const cleanPerson = sanitizeString(person, 100);
    if (!cleanPerson) {
      return {
        valid: false,
        error: 'Person or organization name (person) is required for loan and deposit transactions.'
      };
    }
  }

  if (type === 'transfer') {
    const cleanTo = sanitizeString(toWallet, 100);
    if (!cleanTo) {
      return {
        valid: false,
        error: 'Destination wallet (toWallet) is required for transfer transactions.'
      };
    }
  }

  let txDate = new Date().toISOString();
  if (date && typeof date === 'string') {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) {
      txDate = new Date(parsed).toISOString();
    }
  }

  let cleanDueDate = '';
  if (dueDate && typeof dueDate === 'string') {
    const parsed = Date.parse(dueDate);
    if (Number.isFinite(parsed)) {
      cleanDueDate = new Date(parsed).toISOString().slice(0, 10);
    }
  }

  return {
    valid: true,
    sanitized: {
      type,
      amount: roundMoney(numAmount),
      category: sanitizeString(category, 100),
      wallet: sanitizeString(wallet, 100),
      toWallet: sanitizeString(toWallet, 100),
      person: sanitizeString(person, 100),
      date: txDate,
      dueDate: cleanDueDate,
      description: sanitizeString(description, 500)
    }
  };
}

// ─── Wallet & Category Resolution ────────────────────────────────────────────

function resolveWalletId(wallets, walletNameOrId) {
  if (!Array.isArray(wallets) || wallets.length === 0) return 'w_main';
  if (!walletNameOrId) return wallets[0].id;

  const target = String(walletNameOrId).trim().toLowerCase();
  const found = wallets.find(w => w && (w.id === walletNameOrId || String(w.name).trim().toLowerCase() === target));
  if (found) return found.id;

  // Fuzzy match
  const fuzzy = wallets.find(w => w && String(w.name).trim().toLowerCase().includes(target));
  if (fuzzy) return fuzzy.id;

  return wallets[0].id;
}

function resolveCategoryId(state, type, categoryNameOrId) {
  if (!categoryNameOrId || isLoanType(type) || type === 'transfer') return '';
  const target = String(categoryNameOrId).trim().toLowerCase();

  const customCats = type === 'expense' ? (state.customExpCats || []) : (state.customIncCats || []);
  const foundCustom = customCats.find(c => c && (c.id === categoryNameOrId || String(c.label || c.name).trim().toLowerCase() === target));
  if (foundCustom) return foundCustom.id;

  // Return sanitized name if no exact ID match so it stores as custom label
  return categoryNameOrId.trim();
}

// ─── Financial Read Computations ──────────────────────────────────────────────

function filterTransactionsByPeriod(transactions, period) {
  if (!Array.isArray(transactions)) return [];
  if (!period || typeof period !== 'string' || period === 'all') return transactions;

  const cleanPeriod = period.trim();

  // Date range e.g. "2026-01-01..2026-03-31"
  if (cleanPeriod.includes('..')) {
    const [startStr, endStr] = cleanPeriod.split('..').map(s => s.trim());
    return transactions.filter(t => {
      if (!t.date) return false;
      const d = t.date.slice(0, 10);
      return d >= startStr && d <= endStr;
    });
  }

  // Month (YYYY-MM) or Year (YYYY) prefix match
  return transactions.filter(t => t.date && t.date.startsWith(cleanPeriod));
}

function calculatePeriodSummary(state, period) {
  const txs = filterTransactionsByPeriod(state.transactions || [], period);
  const loans = state.loans || [];

  let expense = 0;
  let income = 0;
  let transfer = 0;

  txs.forEach(t => {
    const amt = roundMoney(t.amount);
    if (t.type === 'expense') expense += amt;
    else if (t.type === 'income') income += amt;
    else if (t.type === 'transfer') transfer += amt;
  });

  // Calculate loan / deposit activity within period
  let loanGivenActivity = 0;
  let loanRecvActivity = 0;
  let depositTakenActivity = 0;
  let depositGivenActivity = 0;

  loans.forEach(l => {
    if (!l.date || (period && period !== 'all' && !l.date.startsWith(period))) return;
    const amt = roundMoney(l.amount);
    if (l.type === 'loan_given') loanGivenActivity += amt;
    else if (l.type === 'loan_recv') loanRecvActivity += amt;
    else if (l.type === 'deposit') depositTakenActivity += amt;
    else if (l.type === 'deposit_given') depositGivenActivity += amt;
  });

  const netCashflow = roundMoney(income - expense);

  return {
    period: period || 'all',
    transactionCount: txs.length,
    totals: {
      income: roundMoney(income),
      expense: roundMoney(expense),
      transfer: roundMoney(transfer),
      netCashflow
    },
    loanDepositActivity: {
      loanGiven: roundMoney(loanGivenActivity),
      loanReceived: roundMoney(loanRecvActivity),
      depositTaken: roundMoney(depositTakenActivity),
      depositGiven: roundMoney(depositGivenActivity)
    }
  };
}

function calculateOutstandingLoansAndDeposits(state, typeFilter = 'all') {
  const loans = state.loans || [];
  const results = [];

  loans.forEach(l => {
    if (!l || !l.type) return;
    const cfg = LOAN_TYPES[l.type];
    if (!cfg) return;

    const principal = roundMoney(l.amount || 0);
    const extraTotal = (l.extraEntries || []).reduce((s, e) => s + roundMoney(e.amount || 0), 0);
    const totalAmount = roundMoney(principal + extraTotal);
    const paidAmount = (l.payments || []).reduce((s, p) => s + roundMoney(p.amount || 0), 0);
    const remainingAmount = roundMoney(totalAmount - paidAmount);

    if (remainingAmount <= 0) return; // Only outstanding / unsettled

    const isLoanCategory = (l.type === 'loan_given' || l.type === 'loan_recv');
    const isDepositCategory = (l.type === 'deposit' || l.type === 'deposit_given');

    if (typeFilter === 'loans' && !isLoanCategory) return;
    if (typeFilter === 'deposits' && !isDepositCategory) return;

    results.push({
      id: l.id,
      type: l.type,
      typeLabel: cfg.label,
      person: l.person || 'Unknown',
      originalAmount: totalAmount,
      paidAmount: roundMoney(paidAmount),
      remainingAmount,
      dueDate: l.dueDate || '',
      date: l.date || ''
    });
  });

  const totalOutstandingGiven = results
    .filter(r => r.type === 'loan_given' || r.type === 'deposit_given')
    .reduce((s, r) => s + r.remainingAmount, 0);

  const totalOutstandingOwed = results
    .filter(r => r.type === 'loan_recv' || r.type === 'deposit')
    .reduce((s, r) => s + r.remainingAmount, 0);

  return {
    count: results.length,
    totals: {
      outstandingReceivable: roundMoney(totalOutstandingGiven), // Money owed to user
      outstandingPayable: roundMoney(totalOutstandingOwed)       // Money user owes / must return
    },
    items: results
  };
}

function calculateWalletBalances(state, walletFilter) {
  recomputeAllWalletBalances(state);
  const wallets = state.wallets || [];
  const list = [];

  let totalBalance = 0;

  wallets.forEach(w => {
    if (!w || !w.id) return;
    const bal = roundMoney(w.balance || 0);
    totalBalance += bal;

    if (!walletFilter || w.id === walletFilter || String(w.name).toLowerCase().includes(String(walletFilter).toLowerCase())) {
      list.push({
        id: w.id,
        name: w.name,
        type: w.type || 'cash',
        balance: bal,
        initialBalance: roundMoney(w.initialBalance || 0)
      });
    }
  });

  return {
    currency: state.currency || 'BDT',
    totalBalance: roundMoney(totalBalance),
    wallets: list
  };
}

function calculateBudgetStatus(state, period = 'monthly', monthStr) {
  const currentMonth = monthStr || (state.month || new Date().toISOString().slice(0, 7));
  const currentYear = currentMonth.slice(0, 4);

  const budgets = state.budgets || [];
  const txs = state.transactions || [];

  // Filter expenses for month or year
  const periodTxs = txs.filter(t => t.type === 'expense' && t.date && t.date.startsWith(period === 'yearly' ? currentYear : currentMonth));
  const totalSpent = periodTxs.reduce((s, t) => s + roundMoney(t.amount), 0);

  // Overall budget
  const overallBgt = budgets.find(b => b.category === 'overall' && (period === 'yearly' ? b.year === currentYear : b.month === currentMonth));
  const budgetAmount = overallBgt ? roundMoney(overallBgt.amount) : 0;
  const pctUsed = budgetAmount > 0 ? roundMoney((totalSpent / budgetAmount) * 100) : 0;
  const remaining = budgetAmount > 0 ? roundMoney(budgetAmount - totalSpent) : 0;

  // Category budgets
  const catBudgets = budgets.filter(b => b.category !== 'overall' && b.category !== 'savings' && (period === 'yearly' ? b.year === currentYear : b.month === currentMonth));
  const categoryDetails = catBudgets.map(b => {
    const catSpent = periodTxs.filter(t => t.category === b.category).reduce((s, t) => s + roundMoney(t.amount), 0);
    const catAmt = roundMoney(b.amount);
    return {
      category: b.category,
      budgetAmount: catAmt,
      spentAmount: catSpent,
      pctUsed: catAmt > 0 ? roundMoney((catSpent / catAmt) * 100) : 0,
      remaining: catAmt > 0 ? roundMoney(catAmt - catSpent) : 0
    };
  });

  return {
    period,
    key: period === 'yearly' ? currentYear : currentMonth,
    overall: {
      budgetAmount,
      totalSpent: roundMoney(totalSpent),
      pctUsed,
      remaining
    },
    categoryBudgets: categoryDetails
  };
}

function calculateSavingsStatus(state, period = 'monthly', keyStr) {
  const currentKey = keyStr || (period === 'yearly' ? new Date().getFullYear().toString() : new Date().toISOString().slice(0, 7));
  const txs = state.transactions || [];
  const budgets = state.budgets || [];

  const incomeTxs = txs.filter(t => t.type === 'income' && t.date && t.date.startsWith(currentKey));
  const totalIncome = incomeTxs.reduce((s, t) => s + roundMoney(t.amount), 0);

  const expTxs = txs.filter(t => t.type === 'expense' && t.date && t.date.startsWith(currentKey));
  const totalExpense = expTxs.reduce((s, t) => s + roundMoney(t.amount), 0);

  const actualSaved = Math.max(0, roundMoney(totalIncome - totalExpense));

  // Find manual or target pct
  const manualBgt = budgets.find(b => b.category === 'savings' && (period === 'yearly' ? b.year === currentKey : b.month === currentKey));
  let targetAmount = 0;

  if (manualBgt) {
    targetAmount = roundMoney(manualBgt.amount);
  } else {
    // Default 20% target
    targetAmount = roundMoney(totalIncome * 0.20);
  }

  const pctAchieved = targetAmount > 0 ? roundMoney((actualSaved / targetAmount) * 100) : 0;

  return {
    period,
    key: currentKey,
    totalIncome: roundMoney(totalIncome),
    totalExpense: roundMoney(totalExpense),
    actualSaved: roundMoney(actualSaved),
    targetAmount: roundMoney(targetAmount),
    pctAchieved
  };
}

function calculateCategoryBreakdown(state, period, type = 'expense') {
  const txs = filterTransactionsByPeriod(state.transactions || [], period).filter(t => t.type === type);
  const totalAmt = txs.reduce((s, t) => s + roundMoney(t.amount), 0);

  const catMap = new Map();
  txs.forEach(t => {
    const cat = t.category || 'Uncategorized';
    const amt = roundMoney(t.amount);
    catMap.set(cat, (catMap.get(cat) || 0) + amt);
  });

  const categories = Array.from(catMap.entries()).map(([category, amount]) => {
    return {
      category,
      amount: roundMoney(amount),
      percentage: totalAmt > 0 ? roundMoney((amount / totalAmt) * 100) : 0
    };
  }).sort((a, b) => b.amount - a.amount);

  return {
    period: period || 'all',
    type,
    totalAmount: roundMoney(totalAmt),
    categories
  };
}

module.exports = {
  isLoanType,
  sanitizeString,
  validateAddTransactionInput,
  resolveWalletId,
  resolveCategoryId,
  calculatePeriodSummary,
  calculateOutstandingLoansAndDeposits,
  calculateWalletBalances,
  calculateBudgetStatus,
  calculateSavingsStatus,
  calculateCategoryBreakdown
};
