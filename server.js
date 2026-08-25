// server.js — Tally sync server.
// Serves static files and provides a WebSocket + REST API so every tap is
// forwarded to all connected devices in real-time.
//
// Run:  node server.js        (default port 3000)
//       PORT=8080 node server.js

const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Persistent state ────────────────────────────────────────────────────────
// Stored as JSON on disk so a server restart doesn't lose counts.
// Schema: { [profileId]: { [counterId]: { id, name, count, history } } }

const STATE_FILE = path.join(__dirname, ".server-state.json");

// Runtime state also tracks which tap keys we've already applied (dedup),
// stored as a plain Set — not serialized.
// profileStates[profileId][counterId] = { id, name, count, history, _tapKeys }
const profileStates = {};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const [pid, counters] of Object.entries(raw)) {
      profileStates[pid] = {};
      for (const [cid, c] of Object.entries(counters)) {
        profileStates[pid][cid] = { ...c, _tapKeys: new Set() };
      }
    }
  } catch (err) {
    console.error("Tally: failed to load server state", err);
  }
}

function saveState() {
  try {
    const out = {};
    for (const [pid, counters] of Object.entries(profileStates)) {
      out[pid] = {};
      for (const [cid, { _tapKeys, ...rest }] of Object.entries(counters)) {
        out[pid][cid] = rest;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(out));
  } catch (err) {
    console.error("Tally: failed to save server state", err);
  }
}

loadState();

// ─── WebSocket subscriptions ──────────────────────────────────────────────────
// Each connected client subscribes to one profile. We track the mapping so
// we can broadcast only to clients watching the same profile.

const wsClients = new Map(); // ws → profileId

wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "subscribe" && typeof msg.profileId === "string") {
        wsClients.set(ws, msg.profileId);
        // Push current state so the newly connected device catches up.
        const ps = profileStates[msg.profileId];
        if (ps) {
          const counters = Object.values(ps).map(({ _tapKeys, ...c }) => c);
          ws.send(JSON.stringify({ type: "state", counters }));
        }
      }
    } catch {}
  });

  ws.on("close", () => wsClients.delete(ws));
  ws.on("error", () => ws.close());
});

function broadcast(profileId, msg) {
  const payload = JSON.stringify(msg);
  for (const [ws, pid] of wsClients) {
    if (pid === profileId && ws.readyState === 1 /* OPEN */) {
      ws.send(payload);
    }
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// POST /api/taps — apply a batch of taps and broadcast each to subscribers.
// Body: { taps: [{ profileId, counterId, name, delta, at }, ...] }
// sendBeacon (used on page unload) sends application/json via a Blob, so the
// same express.json() middleware handles it without special-casing.
app.post("/api/taps", (req, res) => {
  const { taps } = req.body;
  if (!Array.isArray(taps)) {
    return res.status(400).json({ error: "Bad request" });
  }

  // Group broadcasts by profile so we only iterate wsClients once per profile.
  const broadcastQueue = new Map(); // profileId → [msg, ...]

  for (const { profileId, counterId, name, delta, at } of taps) {
    if (
      typeof profileId !== "string" ||
      typeof counterId !== "string" ||
      typeof delta !== "number" ||
      typeof at !== "number"
    ) {
      continue; // skip malformed entries, process the rest
    }

    if (!profileStates[profileId]) profileStates[profileId] = {};
    const ps = profileStates[profileId];

    if (!ps[counterId]) {
      ps[counterId] = {
        id: counterId,
        name: name || "",
        count: 0,
        history: [],
        _tapKeys: new Set(),
      };
    }

    const c = ps[counterId];

    // Deduplicate by (counterId, at) — prevents double-counting when a batch
    // is retried after a transient network failure.
    const tapKey = String(at);
    if (c._tapKeys.has(tapKey)) continue;
    c._tapKeys.add(tapKey);
    if (c._tapKeys.size > 2000) {
      [...c._tapKeys].slice(0, 1000).forEach((k) => c._tapKeys.delete(k));
    }

    if (name) c.name = name;
    c.count += delta;
    c.history.push({ delta, at });
    if (c.history.length > 500) c.history.splice(0, c.history.length - 500);

    if (!broadcastQueue.has(profileId)) broadcastQueue.set(profileId, []);
    broadcastQueue.get(profileId).push({ type: "tap", counterId, delta, at, count: c.count });
  }

  if (broadcastQueue.size > 0) {
    saveState();
    for (const [profileId, msgs] of broadcastQueue) {
      for (const msg of msgs) broadcast(profileId, msg);
    }
  }

  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tally server → http://localhost:${PORT}`);
});
