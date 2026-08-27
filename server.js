// server.js — Tally sync server with auth, SQLite storage, and Stripe billing.
// Run: node server.js   (default port 3000)
// Env: SESSION_SECRET, STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, APP_URL

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const db = require("./db");

const stripe = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const app = express();

const FREE_COUNTER_LIMIT = 3;

// ─── Export / import format versioning ────────────────────────────────────────
// Bump EXPORT_VERSION and add a migration entry whenever the JSON export schema
// changes.  Each entry upgrades data from that version to version+1, so a file
// exported by any past release can always be imported by the current server.

const EXPORT_VERSION = 1;

// Slice a string to at most `max` grapheme clusters so emoji and other
// multi-code-unit characters are never split at a truncation boundary.
const _segmenter = new Intl.Segmenter();
function truncateName(str, max) {
  const segs = [..._segmenter.segment(str)];
  return segs.length <= max ? str : segs.slice(0, max).map(s => s.segment).join("");
}

const importMigrations = {
  // Example for a future schema bump:
  // 1: (data) => ({ ...data, counters: data.counters.map(c => ({ ...c, color: null })) }),
};

function migrateImportData(data) {
  let version = typeof data.version === "number" ? data.version : 0;
  if (version > EXPORT_VERSION) {
    throw new Error(`Export version ${version} is newer than this server supports (${EXPORT_VERSION})`);
  }
  while (version < EXPORT_VERSION) {
    if (importMigrations[version]) data = importMigrations[version](data);
    version++;
  }
  return data;
}

// ─── Stripe webhook (raw body — must precede express.json()) ──────────────────

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      const userId = obj.metadata?.userId || obj.subscription_data?.metadata?.userId;
      if (userId && obj.customer && obj.subscription) {
        db.upsertSubscription(userId, obj.customer, obj.subscription, "active");
      }
    } else if (event.type === "customer.subscription.updated") {
      db.updateSubBySubscriptionId(obj.id, obj.status === "active" ? "active" : "free");
    } else if (event.type === "customer.subscription.deleted") {
      db.updateSubBySubscriptionId(obj.id, "free");
    }
  } catch (err) {
    console.error("Tally: webhook handler error", err);
  }

  res.json({ received: true });
});

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "tally-dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);
app.use(express.static(path.join(__dirname)));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  next();
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required" });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (db.getUserByEmail(email.trim())) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = db.createUser(email.trim().toLowerCase(), passwordHash);
  req.session.userId = user.id;
  res.json({ user: { id: user.id, email: user.email }, isPremium: false });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const user = db.getUserByEmail(String(email).trim());
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: "Invalid email or password" });
  req.session.userId = user.id;
  res.json({ user: { id: user.id, email: user.email }, isPremium: db.isPremium(user.id) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = db.getUserById(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({ user: { id: user.id, email: user.email }, isPremium: db.isPremium(user.id) });
});

// ─── Counters ──────────────────────────────────────────────────────────────────

app.get("/api/counters", requireAuth, (req, res) => {
  const userId = req.session.userId;
  if (req.query.include === "history") {
    return res.json({ counters: db.listCountersWithHistory(userId) });
  }
  res.json({ counters: db.listCounters(userId) });
});

app.post("/api/counters", requireAuth, (req, res) => {
  const userId = req.session.userId;
  const name = typeof req.body.name === "string" ? truncateName(req.body.name.trim(), 60) : "";
  if (!name) return res.status(400).json({ error: "Counter name required" });

  if (!db.isPremium(userId) && db.countCounters(userId) >= FREE_COUNTER_LIMIT) {
    return res.status(403).json({ error: "Free tier limit reached", limit: FREE_COUNTER_LIMIT });
  }

  const id = db.createCounter(userId, name);
  res.json({ id, name });
});

app.delete("/api/counters/:id", requireAuth, (req, res) => {
  const result = db.deleteCounter(req.params.id, req.session.userId);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.get("/api/counters/:id", requireAuth, (req, res) => {
  const counter = db.getCounter(req.params.id, req.session.userId);
  if (!counter) return res.status(404).json({ error: "Not found" });
  res.json({
    counter: { id: counter.id, name: counter.name, count: counter.count, history: db.getCounterTaps(counter.id) },
  });
});

// ─── Taps ──────────────────────────────────────────────────────────────────────

// In-process dedup: prevents a retried batch from double-counting.
const recentTapKeys = new Set();

app.post("/api/taps", requireAuth, (req, res) => {
  const { taps } = req.body;
  if (!Array.isArray(taps)) return res.status(400).json({ error: "Bad request" });

  const userId = req.session.userId;
  for (const { counterId, delta, at, tz } of taps) {
    if (typeof counterId !== "string" || typeof delta !== "number" || typeof at !== "number") continue;
    const safeTz = typeof tz === "string" && tz ? tz : undefined;
    if (!db.getCounter(counterId, userId)) continue;

    const tapKey = `${counterId}:${at}`;
    if (recentTapKeys.has(tapKey)) continue;
    recentTapKeys.add(tapKey);
    if (recentTapKeys.size > 5000) {
      const arr = [...recentTapKeys];
      arr.slice(0, 2500).forEach((k) => recentTapKeys.delete(k));
    }

    db.applyTap(counterId, delta, at, safeTz);
  }

  res.json({ ok: true });
});

// ─── Import ────────────────────────────────────────────────────────────────────

app.post("/api/import", requireAuth, (req, res) => {
  const userId = req.session.userId;

  let data;
  try {
    data = migrateImportData(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message || "Unrecognised export format" });
  }

  if (!Array.isArray(data.counters)) {
    return res.status(400).json({ error: "Invalid import file: missing counters array" });
  }
  if (data.counters.length > 500) {
    return res.status(400).json({ error: "Import file contains too many counters (max 500)" });
  }

  try {
    const normalized = data.counters.map(c =>
      typeof c?.name === "string" ? { ...c, name: truncateName(c.name.trim(), 60) } : c
    );
    const { countersCreated, tapsImported } = db.importCounters(userId, normalized);

    res.json({ ok: true, countersCreated, tapsImported });
  } catch (err) {
    console.error("Tally: import error", err);
    res.status(500).json({ error: "Import failed — please try again" });
  }
});

// ─── Stripe ────────────────────────────────────────────────────────────────────

app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Stripe is not configured on this server" });
  if (!process.env.STRIPE_PRICE_ID) return res.status(503).json({ error: "STRIPE_PRICE_ID not set" });

  const userId = req.session.userId;
  const user = db.getUserById(userId);
  const sub = db.getSubscription(userId);

  let customerId = sub?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
    customerId = customer.id;
    db.upsertSubscription(userId, customerId, null, sub?.status || "free");
  }

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/`,
    subscription_data: { metadata: { userId } },
  });

  res.json({ url: checkoutSession.url });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tally server → http://localhost:${PORT}`);
  if (!stripe) console.log("  Stripe: not configured (set STRIPE_SECRET_KEY to enable)");
});
