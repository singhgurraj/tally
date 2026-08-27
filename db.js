// db.js — SQLite data layer (better-sqlite3).
const Database = require("better-sqlite3");
const path = require("path");
const { randomUUID } = require("crypto");

const db = new Database(path.join(__dirname, ".tally.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'free',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counters (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS taps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    counter_id TEXT NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    at INTEGER NOT NULL,
    tz TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_counters_user ON counters(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_taps_counter_at ON taps(counter_id, at);
`);

const s = {
  insertUser: db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"),
  getUserByEmail: db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  getUserById: db.prepare("SELECT id, email, created_at FROM users WHERE id = ?"),

  initSub: db.prepare("INSERT INTO subscriptions (user_id, status, updated_at) VALUES (?, ?, ?)"),
  getSub: db.prepare("SELECT * FROM subscriptions WHERE user_id = ?"),
  upsertSub: db.prepare(`
    INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = excluded.status,
      updated_at = excluded.updated_at
  `),
  updateSubBySubId: db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE stripe_subscription_id = ?"),

  listCounters: db.prepare("SELECT id, name, count FROM counters WHERE user_id = ? ORDER BY created_at ASC, rowid ASC"),
  countCounters: db.prepare("SELECT COUNT(*) AS n FROM counters WHERE user_id = ?"),
  getCounter: db.prepare("SELECT * FROM counters WHERE id = ? AND user_id = ?"),
  insertCounter: db.prepare("INSERT INTO counters (id, user_id, name, count, created_at) VALUES (?, ?, ?, 0, ?)"),
  deleteCounter: db.prepare("DELETE FROM counters WHERE id = ? AND user_id = ?"),

  insertTap: db.prepare("INSERT INTO taps (counter_id, delta, at, tz) VALUES (?, ?, ?, ?)"),
  getTaps: db.prepare("SELECT delta, at, tz FROM taps WHERE counter_id = ? ORDER BY at ASC LIMIT 500"),
  updateCount: db.prepare("UPDATE counters SET count = count + ? WHERE id = ?"),
  getCount: db.prepare("SELECT count FROM counters WHERE id = ?"),
  pruneTaps: db.prepare(`
    DELETE FROM taps WHERE counter_id = ? AND id NOT IN (
      SELECT id FROM taps WHERE counter_id = ? ORDER BY at DESC LIMIT 500
    )
  `),

  // Import helpers
  findCounterByName: db.prepare("SELECT id FROM counters WHERE user_id = ? AND name = ? COLLATE NOCASE"),
  tapExistsAt: db.prepare("SELECT 1 FROM taps WHERE counter_id = ? AND at = ? LIMIT 1"),
  recomputeCount: db.prepare("UPDATE counters SET count = (SELECT COALESCE(SUM(delta), 0) FROM taps WHERE counter_id = ?) WHERE id = ?"),
};

// ─── Users ────────────────────────────────────────────────────────────────────

const createUser = db.transaction((email, passwordHash) => {
  const id = randomUUID();
  s.insertUser.run(id, email, passwordHash, Date.now());
  s.initSub.run(id, "free", Date.now());
  return s.getUserById.get(id);
});

function getUserByEmail(email) { return s.getUserByEmail.get(email); }
function getUserById(id) { return s.getUserById.get(id); }

// ─── Subscriptions ────────────────────────────────────────────────────────────

function getSubscription(userId) { return s.getSub.get(userId); }

function isPremium(userId) { return s.getSub.get(userId)?.status === "active"; }

function upsertSubscription(userId, customerId, subscriptionId, status) {
  s.upsertSub.run(userId, customerId, subscriptionId, status, Date.now());
}

function updateSubBySubscriptionId(subscriptionId, status) {
  s.updateSubBySubId.run(status, Date.now(), subscriptionId);
}

// ─── Counters ─────────────────────────────────────────────────────────────────

function listCounters(userId) { return s.listCounters.all(userId); }

function listCountersWithHistory(userId) {
  const counters = s.listCounters.all(userId);
  for (const c of counters) c.history = s.getTaps.all(c.id);
  return counters;
}

function countCounters(userId) { return s.countCounters.get(userId).n; }

function getCounter(id, userId) { return s.getCounter.get(id, userId); }

function getCounterTaps(counterId) { return s.getTaps.all(counterId); }

function createCounter(userId, name) {
  const id = randomUUID();
  s.insertCounter.run(id, userId, name, Date.now());
  return id;
}

function deleteCounter(id, userId) { return s.deleteCounter.run(id, userId); }

// ─── Taps ─────────────────────────────────────────────────────────────────────

const applyTap = db.transaction((counterId, delta, at, tz) => {
  s.insertTap.run(counterId, delta, at, tz || null);
  s.updateCount.run(delta, counterId);
  s.pruneTaps.run(counterId, counterId);
  return s.getCount.get(counterId)?.count ?? 0;
});

// ─── Import ───────────────────────────────────────────────────────────────────
// Idempotent: matched by counter name (case-insensitive) and tap timestamp.
// Returns counts of newly created counters and inserted taps.

const importCounters = db.transaction((userId, countersToImport) => {
  let countersCreated = 0;
  let tapsImported = 0;
  // Use an incrementing base so each new counter gets a unique created_at,
  // preserving the order from the import file even when the loop runs fast.
  let importTs = Date.now();

  for (const { name, history } of countersToImport) {
    if (typeof name !== "string" || !name.trim()) continue;
    if (!Array.isArray(history)) continue;

    let row = s.findCounterByName.get(userId, name.trim());
    let counterId;
    if (row) {
      counterId = row.id;
    } else {
      counterId = randomUUID();
      s.insertCounter.run(counterId, userId, name.trim(), importTs++);
      countersCreated++;
    }

    for (const { delta, at, tz } of history) {
      if (typeof delta !== "number" || !Number.isFinite(delta)) continue;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (s.tapExistsAt.get(counterId, at)) continue;
      const safeTz = typeof tz === "string" && tz ? tz : null;
      s.insertTap.run(counterId, delta, at, safeTz);
      tapsImported++;
    }

    // Recompute authoritative count from all taps, then prune to storage limit.
    s.recomputeCount.run(counterId, counterId);
    s.pruneTaps.run(counterId, counterId);
  }

  return { countersCreated, tapsImported };
});

module.exports = {
  createUser, getUserByEmail, getUserById,
  getSubscription, isPremium, upsertSubscription, updateSubBySubscriptionId,
  listCounters, listCountersWithHistory, countCounters,
  getCounter, getCounterTaps, createCounter, deleteCounter, applyTap,
  importCounters,
};
