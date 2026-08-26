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

// Idempotent migration: add share_code column for collaborative sharing.
try {
  db.exec(`ALTER TABLE counters ADD COLUMN share_code TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_counters_share_code ON counters(share_code)`);
} catch {}

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

  listCounters: db.prepare("SELECT id, name, count FROM counters WHERE user_id = ? ORDER BY created_at ASC"),
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

  getShareCode: db.prepare("SELECT share_code FROM counters WHERE id = ? AND user_id = ?"),
  setShareCode: db.prepare("UPDATE counters SET share_code = ? WHERE id = ? AND user_id = ?"),
  getCounterByShareCode: db.prepare("SELECT id, user_id, name, count FROM counters WHERE share_code = ?"),
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

// Returns an existing share code or generates a new unique one.
function getOrCreateShareCode(counterId, userId) {
  const row = s.getShareCode.get(counterId, userId);
  if (!row) return null; // counter not found or not owned by userId
  if (row.share_code) return row.share_code;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // omit O I 0 1 (ambiguous)
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    try {
      s.setShareCode.run(code, counterId, userId);
      return code;
    } catch {} // UNIQUE constraint collision — retry
  }
  return null;
}

function getCounterByShareCode(code) {
  return s.getCounterByShareCode.get(code.toUpperCase());
}

// ─── Taps ─────────────────────────────────────────────────────────────────────

const applyTap = db.transaction((counterId, delta, at, tz) => {
  s.insertTap.run(counterId, delta, at, tz || null);
  s.updateCount.run(delta, counterId);
  s.pruneTaps.run(counterId, counterId);
  return s.getCount.get(counterId)?.count ?? 0;
});

module.exports = {
  createUser, getUserByEmail, getUserById,
  getSubscription, isPremium, upsertSubscription, updateSubBySubscriptionId,
  listCounters, listCountersWithHistory, countCounters,
  getCounter, getCounterTaps, createCounter, deleteCounter, applyTap,
  getOrCreateShareCode, getCounterByShareCode,
};
