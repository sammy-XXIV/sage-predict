const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const EMPTY_DB      = () => ({ users: {}, positions: {}, history: {}, alerts: {}, budgets: {}, streaks: {}, autoPredict: {}, wizardState: {}, pendingTrades: {}, pendingLadders: {}, copyTrading: {}, walletWatchers: {} });

let cache = EMPTY_DB();

async function fetchFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kv?key=eq.db&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    return rows?.[0]?.value || null;
  } catch (e) {
    console.error('Supabase fetch error:', e.message);
    return null;
  }
}

async function persistToSupabase(db) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/kv`, {
      method:  'POST',
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates',
      },
      body: JSON.stringify({ key: 'db', value: db }),
    });
  } catch (e) {
    console.error('Supabase persist error:', e.message);
  }
}

export async function initDb() {
  const data = await fetchFromSupabase();
  if (data) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    cache = { ...EMPTY_DB(), ...parsed };
    console.log('DB loaded from Supabase ✓');
  } else {
    console.log('Supabase empty — starting fresh');
  }
}

function load() { return cache; }

function save(db) {
  cache = db;
  persistToSupabase(db).catch(console.error);
}

function defaults(db) {
  db.alerts       = db.alerts       || {};
  db.budgets      = db.budgets      || {};
  db.streaks      = db.streaks      || {};
  db.autoPredict  = db.autoPredict  || {};
  db.wizardState  = db.wizardState  || {};
  db.pendingTrades = db.pendingTrades || {};
  return db;
}

// ── Users ──────────────────────────────────────────────────────────
export function getUser(telegramId) {
  return load().users[String(telegramId)] || null;
}
export function saveUser(telegramId, data) {
  const db = load();
  db.users[String(telegramId)] = { ...db.users[String(telegramId)], ...data };
  save(db);
}
export function getAllUsers() {
  return Object.entries(load().users).map(([id, u]) => ({ telegramId: id, ...u }));
}

// ── Positions ──────────────────────────────────────────────────────
export function getPositions(telegramId) {
  return load().positions[String(telegramId)] || [];
}
export function savePosition(telegramId, pos) {
  const db = load();
  if (!db.positions[String(telegramId)]) db.positions[String(telegramId)] = [];
  db.positions[String(telegramId)].push({ ...pos, id: Date.now(), createdAt: Date.now() });
  save(db);
}
export function updatePosition(telegramId, posId, updates) {
  const db = load();
  const positions = db.positions[String(telegramId)] || [];
  const idx = positions.findIndex(p => p.id === posId);
  if (idx >= 0) {
    db.positions[String(telegramId)][idx] = { ...positions[idx], ...updates };
    save(db);
  }
}
export function getAllActivePositions() {
  const db = load();
  const result = [];
  for (const [telegramId, positions] of Object.entries(db.positions || {})) {
    for (const pos of positions) {
      if (pos.status === 'open') result.push({ telegramId, ...pos });
    }
  }
  return result;
}
export function clearAllPositions() {
  const db = load();
  db.positions = {};
  save(db);
}
export function getAllUsersPositions() {
  return load().positions || {};
}

// ── Conversation history ───────────────────────────────────────────
export function getHistory(telegramId) {
  return load().history[String(telegramId)] || [];
}
export function saveHistory(telegramId, messages) {
  const db = load();
  let sliced = messages.slice(-20);
  while (sliced.length > 0) {
    const first = sliced[0];
    const isOrphanedToolResult = first.role === 'user' &&
      Array.isArray(first.content) &&
      first.content.some(b => b.type === 'tool_result');
    if (!isOrphanedToolResult) break;
    sliced = sliced.slice(2);
  }
  db.history[String(telegramId)] = sliced;
  save(db);
}
export function clearHistory(telegramId) {
  const db = load();
  delete db.history[String(telegramId)];
  save(db);
}
export function migrateHistory() {
  const db = load();
  db.history = {};
  save(db);
  console.log('Cleared all conversation history on startup');
}

// ── Price alerts ───────────────────────────────────────────────────
export function getAlerts(telegramId) {
  return load().alerts?.[String(telegramId)] || [];
}
export function saveAlert(telegramId, alert) {
  const db = defaults(load());
  if (!db.alerts[String(telegramId)]) db.alerts[String(telegramId)] = [];
  db.alerts[String(telegramId)].push({ ...alert, id: Date.now() });
  save(db);
}
export function removeAlert(telegramId, alertId) {
  const db = defaults(load());
  db.alerts[String(telegramId)] = (db.alerts[String(telegramId)] || []).filter(a => a.id !== alertId);
  save(db);
}
export function getAllAlerts() {
  const db = defaults(load());
  const result = [];
  for (const [telegramId, alerts] of Object.entries(db.alerts)) {
    for (const alert of alerts) result.push({ telegramId, ...alert });
  }
  return result;
}

// ── Daily budget ───────────────────────────────────────────────────
export function getBudget(telegramId) {
  return load().budgets?.[String(telegramId)] || null;
}
export function setBudget(telegramId, dailyLimit) {
  const db = defaults(load());
  const today = new Date().toDateString();
  db.budgets[String(telegramId)] = { dailyLimit, spentToday: 0, resetDate: today };
  save(db);
}
export function recordSpend(telegramId, amount) {
  const db = defaults(load());
  const today = new Date().toDateString();
  const b = db.budgets[String(telegramId)];
  if (!b) return;
  if (b.resetDate !== today) { b.spentToday = 0; b.resetDate = today; }
  b.spentToday = (b.spentToday || 0) + amount;
  save(db);
}
export function resetBudgets() {
  const db = defaults(load());
  const today = new Date().toDateString();
  for (const b of Object.values(db.budgets)) {
    if (b.resetDate !== today) { b.spentToday = 0; b.resetDate = today; }
  }
  save(db);
}

// ── Streaks ────────────────────────────────────────────────────────
export function getStreak(telegramId) {
  return load().streaks?.[String(telegramId)] || { count: 0, lastDate: null };
}
export function updateStreak(telegramId) {
  const db = defaults(load());
  const today = new Date().toDateString();
  const s = db.streaks[String(telegramId)] || { count: 0, lastDate: null };
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (s.lastDate === today) return s;
  s.count = s.lastDate === yesterday ? s.count + 1 : 1;
  s.lastDate = today;
  db.streaks[String(telegramId)] = s;
  save(db);
  return s;
}

// ── Auto-predict ───────────────────────────────────────────────────
export function getAutoPredict(telegramId) {
  return load().autoPredict?.[String(telegramId)] || null;
}
export function setAutoPredict(telegramId, config) {
  const db = defaults(load());
  db.autoPredict[String(telegramId)] = config;
  save(db);
}
export function clearAutoPredict(telegramId) {
  const db = defaults(load());
  delete db.autoPredict[String(telegramId)];
  save(db);
}
export function getAllAutoPredict() {
  return Object.entries(defaults(load()).autoPredict).map(([telegramId, cfg]) => ({ telegramId, ...cfg }));
}

// ── Arb auto-trade ─────────────────────────────────────────────────
export function getArbAuto(telegramId) {
  return load().arbAuto?.[String(telegramId)] || null;
}
export function setArbAuto(telegramId, config) {
  const db = defaults(load());
  if (!db.arbAuto) db.arbAuto = {};
  db.arbAuto[String(telegramId)] = config;
  save(db);
}
export function clearArbAuto(telegramId) {
  const db = defaults(load());
  if (db.arbAuto) delete db.arbAuto[String(telegramId)];
  save(db);
}
export function getAllArbAuto() {
  const db = defaults(load());
  if (!db.arbAuto) return [];
  return Object.entries(db.arbAuto).map(([telegramId, cfg]) => ({ telegramId, ...cfg }));
}

// ── Onboarding state (awaiting wallet choice or key import) ────────
export function setOnboardingState(telegramId, state) {
  const db = load();
  db.users[String(telegramId)] = db.users[String(telegramId)] || {};
  db.users[String(telegramId)]._onboarding = state; // 'choosing' | 'awaiting_key'
  save(db);
}
export function getOnboardingState(telegramId) {
  return load().users[String(telegramId)]?._onboarding || null;
}
export function clearOnboardingState(telegramId) {
  const db = load();
  if (db.users[String(telegramId)]) {
    delete db.users[String(telegramId)]._onboarding;
    save(db);
  }
}

// ── Trade wizard state ─────────────────────────────────────────────
export function setWizardState(telegramId, state) {
  const db = defaults(load());
  db.wizardState[String(telegramId)] = { ...state, updatedAt: Date.now() };
  save(db);
}
export function getWizardState(telegramId) {
  const s = load().wizardState?.[String(telegramId)];
  if (!s) return null;
  if (Date.now() - s.updatedAt > 10 * 60 * 1000) return null;
  return s;
}
export function clearWizardState(telegramId) {
  const db = load();
  if (!db.wizardState?.[String(telegramId)]) return;
  delete db.wizardState[String(telegramId)];
  save(db);
}

// ── Arb alerts opt-in ──────────────────────────────────────────────
export function getArbAlerts(telegramId) {
  return load().users[String(telegramId)]?.arbAlerts || false;
}
export function setArbAlerts(telegramId, enabled) {
  const db = load();
  if (!db.users[String(telegramId)]) db.users[String(telegramId)] = {};
  db.users[String(telegramId)].arbAlerts = enabled;
  save(db);
}

// ── Pending trades ─────────────────────────────────────────────────
export function setPendingTrade(telegramId, trade) {
  const db = defaults(load());
  db.pendingTrades[String(telegramId)] = { ...trade, queuedAt: Date.now() };
  save(db);
}
export function getPendingTrade(telegramId) {
  const trade = load().pendingTrades?.[String(telegramId)];
  if (!trade) return null;
  if (Date.now() - trade.queuedAt > 5 * 60 * 1000) return null;
  return trade;
}
export function clearPendingTrade(telegramId) {
  const db = load();
  if (!db.pendingTrades?.[String(telegramId)]) return;
  delete db.pendingTrades[String(telegramId)];
  save(db);
}

// ── Pending ladders ────────────────────────────────────────────────
export function setPendingLadder(telegramId, ladder) {
  const db = defaults(load());
  if (!db.pendingLadders) db.pendingLadders = {};
  db.pendingLadders[String(telegramId)] = { ...ladder, queuedAt: Date.now() };
  save(db);
}
export function getPendingLadder(telegramId) {
  const db = load();
  const ladder = db.pendingLadders?.[String(telegramId)];
  if (!ladder) return null;
  if (Date.now() - ladder.queuedAt > 5 * 60 * 1000) return null;
  return ladder;
}
export function clearPendingLadder(telegramId) {
  const db = load();
  if (!db.pendingLadders?.[String(telegramId)]) return;
  delete db.pendingLadders[String(telegramId)];
  save(db);
}

// ── Copy trading ───────────────────────────────────────────────────
export function setCopyTrading(followerId, config) {
  const db = defaults(load());
  if (!db.copyTrading) db.copyTrading = {};
  db.copyTrading[String(followerId)] = { ...config, since: Date.now() };
  save(db);
}
export function getCopyTrading(followerId) {
  return load().copyTrading?.[String(followerId)] || null;
}
export function clearCopyTrading(followerId) {
  const db = load();
  if (!db.copyTrading?.[String(followerId)]) return;
  delete db.copyTrading[String(followerId)];
  save(db);
}
export function getFollowers(leaderId) {
  const db = load();
  const result = [];
  for (const [fid, cfg] of Object.entries(db.copyTrading || {})) {
    if (String(cfg.followedId) === String(leaderId)) result.push({ followerId: fid, ...cfg });
  }
  return result;
}

// ── Wallet watchers (copy-trade any external Sui address) ──────────
export function setWalletWatcher(followerId, config) {
  const db = load();
  if (!db.walletWatchers) db.walletWatchers = {};
  db.walletWatchers[String(followerId)] = { ...config, since: Date.now() };
  save(db);
}
export function getWalletWatcher(followerId) {
  return load().walletWatchers?.[String(followerId)] || null;
}
export function clearWalletWatcher(followerId) {
  const db = load();
  if (!db.walletWatchers?.[String(followerId)]) return;
  delete db.walletWatchers[String(followerId)];
  save(db);
}
export function updateWalletWatcherCursor(followerId, cursor) {
  const db = load();
  if (!db.walletWatchers?.[String(followerId)]) return;
  db.walletWatchers[String(followerId)].lastEventCursor = cursor;
  save(db);
}
export function getAllWalletWatchers() {
  return Object.entries(load().walletWatchers || {}).map(([followerId, cfg]) => ({ followerId, ...cfg }));
}
