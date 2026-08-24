// counters.js — Core data functions with no DOM or global-state dependencies.
//
// When loaded as a plain <script> tag every symbol becomes a browser global
// available to app.js.  When require()'d in Node (for the test suite) every
// symbol is exported via the module.exports block at the bottom.
//
// Storage functions accept an optional `store` argument.  Callers that omit
// it get globalThis.localStorage (the real thing in the browser).  Tests pass
// a mock Map-backed object so they never touch real storage.

const SCHEMA_VERSION = 1;
const META_KEY = "tally.meta";

// Each entry migrates the raw counters array from that version to version+1.
// Keep migration functions defensive — they run on untrusted stored data.
const migrations = {
  // v0 (bare array) → v1 (versioned envelope): no per-counter field changes.
};

// At thousands of taps the full-rebuild DOM path becomes the bottleneck.
// Render only the newest HISTORY_DISPLAY_LIMIT entries; on each subsequent
// tap prepend a single row instead of clearing and rebuilding everything.
// HISTORY_STORE_LIMIT bounds the localStorage payload so JSON serialization
// stays fast regardless of tap count.
const HISTORY_DISPLAY_LIMIT = 100;
const HISTORY_STORE_LIMIT = 500;

const ACCENT_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
];

// Returns the localStorage key for a given profile's counter data.
function storageKey(profileId) {
  return `tally.counters.${profileId}`;
}

// ─── Counter sanitisation ─────────────────────────────────────────────────────

function sanitizeCounter(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count) ? raw.count : 0;
  // History entries are kept as-is (spread intact) so any future fields on
  // entries survive a round-trip through an older app version.
  const history = Array.isArray(raw.history)
    ? raw.history.filter(
        (e) => e && typeof e.delta === "number" && typeof e.at === "number"
      )
    : [];

  // Spread raw first so unknown fields added by future app versions are
  // preserved rather than silently dropped.
  return { ...raw, id, name, count, history };
}

// Assign fallback names to empty-named counters and append numeric suffixes to
// any duplicates so the invariant "all names are non-empty and unique
// (case-insensitively)" holds after loading potentially corrupted storage.
function repairCounterNames(list) {
  const seen = new Set();
  let fallback = 1;
  return list.map((c) => {
    let name = c.name;

    if (!name) {
      while (seen.has(`counter ${fallback}`)) fallback++;
      name = `Counter ${fallback++}`;
    }

    if (seen.has(name.toLowerCase())) {
      let n = 2;
      while (seen.has(`${name.toLowerCase()} ${n}`)) n++;
      name = `${name} ${n}`;
    }

    seen.add(name.toLowerCase());
    return name === c.name ? c : { ...c, name };
  });
}

// ─── Counter storage ──────────────────────────────────────────────────────────

function loadCounters(profileId, store) {
  store ??= globalThis.localStorage;
  if (!profileId || !store) return [];
  try {
    const raw = store.getItem(storageKey(profileId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);

    // Legacy format (pre-versioning): a bare array of counters.
    // Treat it as version 0 so migrations bring it up to SCHEMA_VERSION.
    let version, rawCounters;
    if (Array.isArray(parsed)) {
      version = 0;
      rawCounters = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.counters)
    ) {
      version = typeof parsed.version === "number" ? parsed.version : 0;
      rawCounters = parsed.counters;
    } else {
      return [];
    }

    // Run each pending migration in order.
    while (version < SCHEMA_VERSION) {
      if (migrations[version]) rawCounters = migrations[version](rawCounters);
      version++;
    }

    return repairCounterNames(rawCounters.map(sanitizeCounter).filter(Boolean));
  } catch (err) {
    console.error("Tally: failed to load counters", err);
    return [];
  }
}

// Throws on storage errors (e.g. quota exceeded).  Callers are responsible
// for catching and surfacing a storage-warning to the user.
function saveCounters(profileId, counters, store) {
  store ??= globalThis.localStorage;
  if (!profileId || !store) throw new Error("Cannot save: no active profile");
  store.setItem(
    storageKey(profileId),
    JSON.stringify({ version: SCHEMA_VERSION, counters })
  );
}

// ─── Profile registry storage ─────────────────────────────────────────────────

function loadMeta(store) {
  store ??= globalThis.localStorage;
  if (!store) return { version: 1, profiles: [] };
  try {
    const raw = store.getItem(META_KEY);
    if (!raw) return { version: 1, profiles: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.profiles)) {
      return { version: 1, profiles: [] };
    }
    return {
      version: parsed.version ?? 1,
      profiles: parsed.profiles.filter(
        (p) => p && typeof p.id === "string" && typeof p.name === "string"
      ),
    };
  } catch {
    return { version: 1, profiles: [] };
  }
}

function saveMeta(meta, store) {
  store ??= globalThis.localStorage;
  if (!store) return;
  try {
    store.setItem(META_KEY, JSON.stringify(meta));
  } catch (err) {
    console.error("Tally: failed to save profile list", err);
  }
}

// ─── Legacy migration ─────────────────────────────────────────────────────────
// Pre-profiles releases stored counters directly under "tally.counters".
// This function has no side-effects beyond storage reads/writes — callers
// in app.js wrap it inside withMetaLock for cross-tab safety.

function migrateIfNeeded(store) {
  store ??= globalThis.localStorage;
  if (!store) return;

  const LEGACY_KEY = "tally.counters";
  const legacy = store.getItem(LEGACY_KEY);
  if (!legacy) return;

  const meta = loadMeta(store);
  if (meta.profiles.length > 0) {
    // Already migrated; clean up the stale key if it lingered.
    store.removeItem(LEGACY_KEY);
    return;
  }

  const profileId = crypto.randomUUID();
  meta.profiles.push({ id: profileId, name: "My counters", pinHash: null });
  saveMeta(meta, store);
  store.setItem(storageKey(profileId), legacy);
  store.removeItem(LEGACY_KEY);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function accentFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return ACCENT_COLORS[hash % ACCENT_COLORS.length];
}

function formatTime(at) {
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

// ─── PIN hashing ──────────────────────────────────────────────────────────────
// PINs are hashed with SHA-256 keyed on the profile ID so two profiles with
// the same PIN produce different hashes.  The threat model is casual snooping
// on a shared device — not an adversary with direct localStorage access.

async function hashPIN(pin, profileId) {
  const data = new TextEncoder().encode(pin + ":" + profileId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Node.js / CommonJS export ────────────────────────────────────────────────
// Ignored in the browser (where `module` is not defined).

if (typeof module !== "undefined") {
  module.exports = {
    SCHEMA_VERSION,
    META_KEY,
    HISTORY_DISPLAY_LIMIT,
    HISTORY_STORE_LIMIT,
    ACCENT_COLORS,
    storageKey,
    sanitizeCounter,
    repairCounterNames,
    loadCounters,
    saveCounters,
    loadMeta,
    saveMeta,
    migrateIfNeeded,
    accentFor,
    formatTime,
    hashPIN,
  };
}
