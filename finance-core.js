// === FINANCE-CORE START ===
/**
 * finance-core.js — Canonical Single Source of Truth for Ledger & Crypto Logic
 * pure functions, zero DOM dependencies, zero localStorage dependencies.
 */

if (typeof LOAN_TYPES === 'undefined') {
  var LOAN_TYPES = Object.freeze({
    deposit: { label: 'Taking a Deposit', col: 'blue', walletDir: 'in', childLabel: 'Deposit Return', childDir: 'out' },
    deposit_given: { label: 'Making a Deposit', col: 'blue', walletDir: 'out', childLabel: 'Deposit Withdrawn', childDir: 'in' },
    loan_recv: { label: 'Loan Received', col: 'amber', walletDir: 'in', childLabel: 'Loan Repayment', childDir: 'out' },
    loan_given: { label: 'Loan Given', col: 'purple', walletDir: 'out', childLabel: 'Loan Collected', childDir: 'in' }
  });
}

function roundMoney(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

function deltaForTransaction(t, wid) {
  if (!t || !wid) return 0;
  if (t.type === 'expense') {
    return t.wallet === wid ? -roundMoney(t.amount) : 0;
  }
  if (t.type === 'income') {
    return t.wallet === wid ? +roundMoney(t.amount) : 0;
  }
  if (t.type === 'transfer') {
    const amt = roundMoney(t.amount);
    const fee = roundMoney(t.fee);
    if (t.wallet === wid && t.toWallet === wid) return -fee;
    if (t.wallet === wid) return -(amt + fee);
    if (t.toWallet === wid) return +amt;
  }
  return 0;
}

function deltaForLoanEntry(loan, wid) {
  if (!loan || !wid) return 0;
  let totalDelta = 0;
  const cfg = LOAN_TYPES[loan.type];
  if (!cfg) return 0;

  // Principal loan entry
  if (loan.wallet === wid) {
    const d = cfg.walletDir === 'in' ? +roundMoney(loan.amount) : -roundMoney(loan.amount);
    totalDelta += d;
  }
  // Loan repayments
  if (Array.isArray(loan.payments)) {
    loan.payments.forEach(p => {
      if (p.wallet === wid) {
        const d = cfg.childDir === 'in' ? +roundMoney(p.amount) : -roundMoney(p.amount);
        totalDelta += d;
      }
    });
  }
  // Extra loan entries
  if (Array.isArray(loan.extraEntries)) {
    loan.extraEntries.forEach(e => {
      if (e.wallet === wid) {
        const d = cfg.walletDir === 'in' ? +roundMoney(e.amount) : -roundMoney(e.amount);
        totalDelta += d;
      }
    });
  }
  return totalDelta;
}

function deltaForWltHistory(h, wid) {
  if (!h || !wid) return 0;
  const matchWid = h.wid || h.walletId;
  if (matchWid === wid) {
    // If it's a legacy adjustment entry, support old schema or new delta field
    if (h.delta !== undefined) return roundMoney(h.delta);
    if (h.isPositive !== undefined) {
      return roundMoney(h.isPositive ? h.amount : -h.amount);
    }
  }
  return 0;
}

function computeWalletBalance(wid, state) {
  if (!state || !wid) return 0;
  const w = (state.wallets || []).find(x => x && x.id === wid);
  if (!w) return 0;

  let historyDelta = 0;
  (state.wltHistory || []).forEach(h => {
    historyDelta += deltaForWltHistory(h, wid);
  });

  let txDelta = 0;
  (state.transactions || []).forEach(t => {
    txDelta += deltaForTransaction(t, wid);
  });

  let loanDelta = 0;
  (state.loans || []).forEach(l => {
    loanDelta += deltaForLoanEntry(l, wid);
  });

  const totalDeltas = historyDelta + txDelta + loanDelta;
  const initBal = w.initialBalance !== undefined
    ? roundMoney(w.initialBalance)
    : roundMoney((w.balance || 0) - totalDeltas);

  return roundMoney(initBal + totalDeltas);
}

function recomputeAllWalletBalances(state) {
  if (!state || !Array.isArray(state.wallets)) return;
  state.wallets.forEach(w => {
    if (!w || !w.id) return;
    if (w.initialBalance === undefined) {
      // Compute baseline for existing wallets lacking initialBalance
      let hD = 0, tD = 0, lD = 0;
      (state.wltHistory || []).forEach(h => { hD += deltaForWltHistory(h, w.id); });
      (state.transactions || []).forEach(t => { tD += deltaForTransaction(t, w.id); });
      (state.loans || []).forEach(l => { lD += deltaForLoanEntry(l, w.id); });
      w.initialBalance = roundMoney((w.balance || 0) - (hD + tD + lD));
    }
    w.balance = computeWalletBalance(w.id, state);
  });
  assertWalletInvariants(state);
}

function recomputeAllBalances(transactions = [], loans = [], wltHistory = [], wallets = []) {
  const resultMap = new Map();
  (wallets || []).forEach(w => {
    if (!w || !w.id) return;
    const dummyState = { wallets: [w], transactions, loans, wltHistory };
    const bal = computeWalletBalance(w.id, dummyState);
    resultMap.set(w.id, bal);
  });
  return resultMap;
}

function assertWalletInvariants(state) {
  if (!state || !Array.isArray(state.wallets)) return true;
  const sumW = state.wallets.reduce((acc, w) => acc + (w ? (w.balance || 0) : 0), 0);

  // Runtime guard: Check for double-counting risk (initialBalance AND wltHistory 'initial' delta)
  (state.wallets || []).forEach(w => {
    if (!w || !w.id) return;
    if (w.initialBalance) {
      const hasInitialHist = (state.wltHistory || []).some(h => (h.wid === w.id || h.walletId === w.id) && h.type === 'initial');
      if (hasInitialHist) {
        console.warn(`[NTX Invariant Warning] Wallet "${w.name}" (${w.id}) has both initialBalance and wltHistory 'initial' delta!`);
      }
    }
  });

  return true;
}

function buildSyncPayload(state, ts = Date.now()) {
  const S = state || {};
  return {
    transactions: S.transactions || [],
    wallets: S.wallets || [],
    budgets: S.budgets || [],
    loans: S.loans || [],
    recurringTransactions: S.recurringTransactions || [],
    customExpCats: S.customExpCats || [],
    customIncCats: S.customIncCats || [],
    subcategories: S.subcategories || {},
    expCatOrder: S.expCatOrder || [],
    incCatOrder: S.incCatOrder || [],
    hiddenExpCats: S.hiddenExpCats || [],
    hiddenIncCats: S.hiddenIncCats || [],
    savingsHistory: S.savingsHistory || [],
    savingsTargetSettings: S.savingsTargetSettings || {},
    wltHistory: S.wltHistory || [],
    tombstones: S.tombstones || {},
    username: S.username || '',
    currency: S.currency || 'BDT',
    syncProject: (typeof firebaseConfig !== 'undefined' && firebaseConfig.projectId) ? firebaseConfig.projectId : 'ntransactions-pro',
    ts
  };
}

// ============ ENCRYPTED BACKUP (Version 2 Standard) ============
async function deriveCryptoKey(passphrase, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function exportEncryptedBackup(passphrase, state) {
  if (!passphrase) throw new Error('Passphrase required');
  const enc = new TextEncoder();
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveCryptoKey(passphrase, salt);
  const payloadStr = JSON.stringify(buildSyncPayload(state));
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payloadStr));
  return {
    version: 2,
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(encrypted))
  };
}

async function decryptEncryptedBackup(backupData, passphrase) {
  if (!passphrase || !backupData) throw new Error('Invalid backup data');
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Version 2 standard format
  if (backupData.ciphertext && backupData.salt && backupData.iv) {
    const salt = new Uint8Array(backupData.salt);
    const iv = new Uint8Array(backupData.iv);
    const ciphertext = new Uint8Array(backupData.ciphertext);
    const key = await deriveCryptoKey(passphrase, salt);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(dec.decode(decrypted));
  }

  // Version 1 backward compatibility format (legacy Android export)
  if (backupData.data && backupData.salt && backupData.iv) {
    const saltStr = String(backupData.salt);
    const salt = enc.encode(saltStr);
    const iv = new Uint8Array(backupData.iv);
    const data = new Uint8Array(backupData.data);
    const keyMaterial = await window.crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await window.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(dec.decode(decrypted));
  }

  throw new Error('Unsupported or malformed backup file version');
}

// ============ RUNTIME DETECTION & ROUTING ============
function isAndroidRuntime() {
  if (typeof window === 'undefined') return false;
  if (typeof window.NativeApp !== 'undefined') return true;
  if (window.location && window.location.pathname && window.location.pathname.startsWith('/assets')) return true;
  return false;
}

function getApiEndpoint(apiPath) {
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
  const protocol = (typeof window !== 'undefined' && window.location && window.location.protocol) ? window.location.protocol : '';

  // Android WebView or non-http origin -> absolute URL
  if (isAndroidRuntime()) {
    return 'https://ntransactions.pro.bd' + apiPath;
  }
  // Standard web production domain or localhost relative routing
  if (protocol.startsWith('http') && (/ntransactions\.pro\.bd|ntx\.nasimulrizvi\.com|ntransaction.*\.vercel\.app|localhost/.test(origin))) {
    return apiPath;
  }
  return 'https://ntransactions.pro.bd' + apiPath;
}

// ============ UNIFIED DIAGNOSTIC TEST SUITE ============
function runLedgerUnitTests(stateObj) {
  const state = stateObj || (typeof S !== 'undefined' ? S : { wallets: [], transactions: [], loans: [], wltHistory: [] });
  const results = [];
  const assert = (cond, msg) => {
    results.push({ name: msg, pass: !!cond });
  };

  try {
    // 1. Rounding precision
    assert(roundMoney(10.005) === 10.01, 'roundMoney(10.005) === 10.01');
    assert(roundMoney(5) === 5, 'roundMoney(5) === 5');

    // 2. Transaction delta calculation
    const dummyExp = { type: 'expense', amount: 50, wallet: 'w1' };
    assert(deltaForTransaction(dummyExp, 'w1') === -50, 'deltaForTransaction expense on source');
    assert(deltaForTransaction(dummyExp, 'w2') === 0, 'deltaForTransaction expense on other');

    const dummyXfer = { type: 'transfer', amount: 100, fee: 5, wallet: 'w1', toWallet: 'w2' };
    assert(deltaForTransaction(dummyXfer, 'w1') === -105, 'deltaForTransaction transfer out + fee');
    assert(deltaForTransaction(dummyXfer, 'w2') === 100, 'deltaForTransaction transfer in');

    // 3. Initial balance & computeWalletBalance
    const testState = {
      wallets: [{ id: 'w1', name: 'W1', initialBalance: 500, balance: 500 }],
      transactions: [{ id: 't1', type: 'expense', amount: 100, wallet: 'w1' }],
      loans: [],
      wltHistory: []
    };
    assert(computeWalletBalance('w1', testState) === 400, 'computeWalletBalance initialBalance 500 - tx 100 = 400');

    // 4. Legacy wallet backfill idempotency
    const legacyState = {
      wallets: [{ id: 'w_leg', name: 'Legacy W', balance: 1000 }],
      transactions: [{ id: 't2', type: 'expense', amount: 200, wallet: 'w_leg' }],
      loans: [],
      wltHistory: []
    };
    const beforeBal = computeWalletBalance('w_leg', legacyState); // without initialBalance field
    recomputeAllWalletBalances(legacyState);
    assert(legacyState.wallets[0].initialBalance === 1200, 'Legacy wallet backfills initialBalance correctly (1000 - (-200) = 1200)');
    const afterBal = computeWalletBalance('w_leg', legacyState);
    assert(beforeBal === afterBal, 'computeWalletBalance gives identical result before and after initialBalance backfill');

    // 5. Origin resolution routing
    const endpoint = getApiEndpoint('/api/sms-parse');
    assert(typeof endpoint === 'string' && endpoint.includes('/api/sms-parse'), 'getApiEndpoint resolves sms-parse path');
  } catch (err) {
    results.push({ name: 'Exception during test suite: ' + err.message, pass: false });
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  console.log(`[Ledger Unit Tests] ${passed}/${total} passed.`, results);
  return { passed, total, results };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOAN_TYPES,
    roundMoney,
    deltaForTransaction,
    deltaForLoanEntry,
    deltaForWltHistory,
    computeWalletBalance,
    recomputeAllWalletBalances,
    recomputeAllBalances,
    buildSyncPayload,
    runLedgerUnitTests
  };
}

// === FINANCE-CORE END ===

