// counters.test.js — unit tests for counters.js data functions.
// Run with: node --test counters.test.js
//
// All tests use an in-memory Map-backed store so they never touch real storage
// and never interfere with each other.

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Stub Web Crypto so hashPIN works outside a browser.  Node ≥ 15 provides
// globalThis.crypto natively; this guard ensures older CI images also work.
if (!globalThis.crypto) {
  globalThis.crypto = require("node:crypto").webcrypto;
}

const {
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
} = require("./counters.js");

// ---------------------------------------------------------------------------
// Mock storage — Map-backed localStorage shim
// ---------------------------------------------------------------------------

function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    _map: map,
  };
}

// ---------------------------------------------------------------------------
// storageKey
// ---------------------------------------------------------------------------

describe("storageKey", () => {
  it("prefixes profile id with tally.counters.", () => {
    assert.equal(storageKey("abc-123"), "tally.counters.abc-123");
  });

  it("handles an empty string without throwing", () => {
    assert.equal(storageKey(""), "tally.counters.");
  });
});

// ---------------------------------------------------------------------------
// sanitizeCounter
// ---------------------------------------------------------------------------

describe("sanitizeCounter", () => {
  it("returns null for non-object inputs", () => {
    assert.equal(sanitizeCounter(null), null);
    assert.equal(sanitizeCounter(undefined), null);
    assert.equal(sanitizeCounter("string"), null);
    assert.equal(sanitizeCounter(42), null);
  });

  it("preserves valid fields as-is", () => {
    const id = "fixed-uuid";
    const raw = { id, name: "Steps", count: 7, history: [] };
    const out = sanitizeCounter(raw);
    assert.equal(out.id, id);
    assert.equal(out.name, "Steps");
    assert.equal(out.count, 7);
    assert.deepEqual(out.history, []);
  });

  it("generates a new id when id is missing or empty", () => {
    const a = sanitizeCounter({ name: "A", count: 0, history: [] });
    const b = sanitizeCounter({ id: "", name: "B", count: 0, history: [] });
    assert.ok(typeof a.id === "string" && a.id.length > 0);
    assert.ok(typeof b.id === "string" && b.id.length > 0);
  });

  it("trims whitespace from name", () => {
    const out = sanitizeCounter({ id: "x", name: "  hello  ", count: 0, history: [] });
    assert.equal(out.name, "hello");
  });

  it("falls back count to 0 for NaN / Infinity / non-number", () => {
    assert.equal(sanitizeCounter({ id: "x", name: "A", count: NaN,      history: [] }).count, 0);
    assert.equal(sanitizeCounter({ id: "x", name: "A", count: Infinity, history: [] }).count, 0);
    assert.equal(sanitizeCounter({ id: "x", name: "A", count: "5",      history: [] }).count, 0);
    assert.equal(sanitizeCounter({ id: "x", name: "A", count: null,     history: [] }).count, 0);
  });

  it("filters out malformed history entries but keeps valid ones", () => {
    const history = [
      { delta: 1, at: 1000 },          // valid
      { delta: "x", at: 2000 },        // bad delta type
      { delta: 1 },                    // missing at
      null,                            // null entry
      { delta: -1, at: 3000 },         // valid
    ];
    const out = sanitizeCounter({ id: "x", name: "A", count: 0, history });
    assert.equal(out.history.length, 2);
    assert.equal(out.history[0].at, 1000);
    assert.equal(out.history[1].at, 3000);
  });

  it("preserves unknown future fields via spread", () => {
    const raw = { id: "x", name: "A", count: 0, history: [], futureField: "keep" };
    const out = sanitizeCounter(raw);
    assert.equal(out.futureField, "keep");
  });

  it("returns an empty history array when history is missing", () => {
    const out = sanitizeCounter({ id: "x", name: "A", count: 0 });
    assert.deepEqual(out.history, []);
  });
});

// ---------------------------------------------------------------------------
// repairCounterNames
// ---------------------------------------------------------------------------

describe("repairCounterNames", () => {
  it("assigns fallback names to empty-named counters", () => {
    const list = [
      { id: "1", name: "", count: 0, history: [] },
      { id: "2", name: "", count: 0, history: [] },
    ];
    const out = repairCounterNames(list);
    assert.equal(out[0].name, "Counter 1");
    assert.equal(out[1].name, "Counter 2");
  });

  it("does not rename non-empty unique names", () => {
    const list = [
      { id: "1", name: "Alpha", count: 0, history: [] },
      { id: "2", name: "Beta",  count: 0, history: [] },
    ];
    const out = repairCounterNames(list);
    assert.equal(out[0].name, "Alpha");
    assert.equal(out[1].name, "Beta");
  });

  it("appends numeric suffix to case-insensitive duplicates", () => {
    const list = [
      { id: "1", name: "steps", count: 0, history: [] },
      { id: "2", name: "Steps", count: 0, history: [] },
      { id: "3", name: "STEPS", count: 0, history: [] },
    ];
    const out = repairCounterNames(list);
    assert.equal(out[0].name, "steps");
    assert.equal(out[1].name, "Steps 2");
    assert.equal(out[2].name, "STEPS 3");
  });

  it("does not modify objects that need no repair (returns same ref)", () => {
    const c = { id: "1", name: "Unique", count: 0, history: [] };
    const out = repairCounterNames([c]);
    assert.strictEqual(out[0], c);
  });

  it("skips fallback numbers already taken by other counters", () => {
    const list = [
      { id: "1", name: "Counter 1", count: 0, history: [] },
      { id: "2", name: "",          count: 0, history: [] },
    ];
    const out = repairCounterNames(list);
    assert.equal(out[1].name, "Counter 2");
  });
});

// ---------------------------------------------------------------------------
// loadCounters / saveCounters round-trip
// ---------------------------------------------------------------------------

describe("loadCounters / saveCounters", () => {
  it("returns [] when the profile id is null or empty", () => {
    const store = makeStore();
    assert.deepEqual(loadCounters(null, store), []);
    assert.deepEqual(loadCounters("",   store), []);
  });

  it("returns [] when the key does not exist", () => {
    assert.deepEqual(loadCounters("profile-1", makeStore()), []);
  });

  it("round-trips a versioned envelope", () => {
    const store = makeStore();
    const pid = "pid-1";
    const data = [
      { id: "c1", name: "Steps", count: 3, history: [{ delta: 1, at: 1000 }] },
    ];
    saveCounters(pid, data, store);
    const loaded = loadCounters(pid, store);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].name, "Steps");
    assert.equal(loaded[0].count, 3);
  });

  it("reads a legacy bare-array format (version 0)", () => {
    const store = makeStore();
    const pid = "pid-legacy";
    const legacy = [{ id: "c1", name: "Old", count: 5, history: [] }];
    store.setItem(storageKey(pid), JSON.stringify(legacy));
    const loaded = loadCounters(pid, store);
    assert.equal(loaded[0].name, "Old");
    assert.equal(loaded[0].count, 5);
  });

  it("saves the current SCHEMA_VERSION in the envelope", () => {
    const store = makeStore();
    saveCounters("p1", [], store);
    const raw = JSON.parse(store.getItem(storageKey("p1")));
    assert.equal(raw.version, SCHEMA_VERSION);
  });

  it("returns [] and does not throw on corrupt JSON", () => {
    const store = makeStore({ [storageKey("p1")]: "not-json" });
    assert.doesNotThrow(() => loadCounters("p1", store));
    assert.deepEqual(loadCounters("p1", store), []);
  });

  it("applies repairCounterNames during load (deduplicates names)", () => {
    const store = makeStore();
    const pid = "p-repair";
    const bad = [
      { id: "a", name: "dup", count: 0, history: [] },
      { id: "b", name: "dup", count: 0, history: [] },
    ];
    store.setItem(storageKey(pid), JSON.stringify({ version: SCHEMA_VERSION, counters: bad }));
    const loaded = loadCounters(pid, store);
    assert.equal(loaded[0].name, "dup");
    assert.equal(loaded[1].name, "dup 2");
  });

  it("throws when profileId is missing (null)", () => {
    assert.throws(() => saveCounters(null, [], makeStore()));
  });

  it("isolates two profiles: writes to one do not affect the other", () => {
    const store = makeStore();
    const p1 = [{ id: "c1", name: "Alpha", count: 0, history: [] }];
    const p2 = [{ id: "c2", name: "Beta",  count: 0, history: [] }];
    saveCounters("prof-a", p1, store);
    saveCounters("prof-b", p2, store);
    assert.equal(loadCounters("prof-a", store)[0].name, "Alpha");
    assert.equal(loadCounters("prof-b", store)[0].name, "Beta");
  });
});

// ---------------------------------------------------------------------------
// loadMeta / saveMeta
// ---------------------------------------------------------------------------

describe("loadMeta / saveMeta", () => {
  it("returns an empty profile list when the store is empty", () => {
    const meta = loadMeta(makeStore());
    assert.deepEqual(meta.profiles, []);
    assert.equal(meta.version, 1);
  });

  it("round-trips a valid meta object", () => {
    const store = makeStore();
    const meta = { version: 1, profiles: [{ id: "p1", name: "Alice", pinHash: null }] };
    saveMeta(meta, store);
    const loaded = loadMeta(store);
    assert.equal(loaded.profiles.length, 1);
    assert.equal(loaded.profiles[0].name, "Alice");
  });

  it("filters out malformed profile entries", () => {
    const store = makeStore();
    const meta = {
      version: 1,
      profiles: [
        { id: "p1", name: "Good" },
        { name: "no id" },
        null,
        { id: "p3" },
      ],
    };
    store.setItem(META_KEY, JSON.stringify(meta));
    const loaded = loadMeta(store);
    assert.equal(loaded.profiles.length, 1);
    assert.equal(loaded.profiles[0].id, "p1");
  });

  it("returns empty list for corrupt JSON", () => {
    const store = makeStore({ [META_KEY]: "!!!" });
    const loaded = loadMeta(store);
    assert.deepEqual(loaded.profiles, []);
  });
});

// ---------------------------------------------------------------------------
// migrateIfNeeded
// ---------------------------------------------------------------------------

describe("migrateIfNeeded", () => {
  it("does nothing when there is no legacy key", () => {
    const store = makeStore();
    migrateIfNeeded(store);
    assert.deepEqual(loadMeta(store).profiles, []);
  });

  it("migrates a legacy bare-array into a new profile", () => {
    const legacy = JSON.stringify([{ id: "c1", name: "Reps", count: 10, history: [] }]);
    const store = makeStore({ "tally.counters": legacy });
    migrateIfNeeded(store);
    const meta = loadMeta(store);
    assert.equal(meta.profiles.length, 1);
    assert.equal(meta.profiles[0].name, "My counters");
    assert.equal(meta.profiles[0].pinHash, null);

    const pid = meta.profiles[0].id;
    const counters = loadCounters(pid, store);
    assert.equal(counters[0].name, "Reps");
    assert.equal(counters[0].count, 10);
  });

  it("removes the legacy key after migration", () => {
    const store = makeStore({ "tally.counters": "[]" });
    migrateIfNeeded(store);
    assert.equal(store.getItem("tally.counters"), null);
  });

  it("does not create a second migration profile if profiles already exist", () => {
    const store = makeStore({ "tally.counters": "[]" });
    const meta = { version: 1, profiles: [{ id: "existing", name: "Mine", pinHash: null }] };
    saveMeta(meta, store);
    migrateIfNeeded(store);
    assert.equal(loadMeta(store).profiles.length, 1);
  });

  it("is idempotent: calling twice yields one profile", () => {
    const store = makeStore({ "tally.counters": "[]" });
    migrateIfNeeded(store);
    migrateIfNeeded(store);
    assert.equal(loadMeta(store).profiles.length, 1);
  });
});

// ---------------------------------------------------------------------------
// accentFor
// ---------------------------------------------------------------------------

describe("accentFor", () => {
  it("returns one of the known accent colors", () => {
    for (let i = 0; i < 20; i++) {
      const id = crypto.randomUUID();
      const color = accentFor(id);
      assert.ok(ACCENT_COLORS.includes(color), `unexpected color ${color} for id ${id}`);
    }
  });

  it("is deterministic for the same id", () => {
    const id = "stable-id-123";
    assert.equal(accentFor(id), accentFor(id));
  });

  it("produces different colors for different ids (probabilistic)", () => {
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const colors = new Set(ids.map(accentFor));
    // With 20 random UUIDs and 8 colors, the chance all land on one color is
    // (1/8)^19 ≈ 0. In practice we expect ≥ 2 distinct colors.
    assert.ok(colors.size > 1);
  });

  it("handles an empty string without throwing", () => {
    assert.doesNotThrow(() => accentFor(""));
  });
});

// ---------------------------------------------------------------------------
// hashPIN
// ---------------------------------------------------------------------------

describe("hashPIN", () => {
  it("produces a 64-character hex string", async () => {
    const hash = await hashPIN("1234", "profile-1");
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const h1 = await hashPIN("9999", "p-abc");
    const h2 = await hashPIN("9999", "p-abc");
    assert.equal(h1, h2);
  });

  it("produces different hashes for the same PIN on different profiles", async () => {
    const h1 = await hashPIN("1234", "profile-A");
    const h2 = await hashPIN("1234", "profile-B");
    assert.notEqual(h1, h2);
  });

  it("produces different hashes for different PINs on the same profile", async () => {
    const pid = "same-profile";
    const h1 = await hashPIN("1111", pid);
    const h2 = await hashPIN("2222", pid);
    assert.notEqual(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// formatTime
// ---------------------------------------------------------------------------

describe("formatTime", () => {
  it("returns a non-empty string for a valid timestamp", () => {
    const result = formatTime(Date.now());
    assert.ok(typeof result === "string" && result.length > 0);
  });

  it("returns a non-empty string for epoch zero", () => {
    const result = formatTime(0);
    assert.ok(typeof result === "string" && result.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("SCHEMA_VERSION is a positive integer", () => {
    assert.ok(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1);
  });

  it("HISTORY_DISPLAY_LIMIT is less than HISTORY_STORE_LIMIT", () => {
    assert.ok(HISTORY_DISPLAY_LIMIT < HISTORY_STORE_LIMIT);
  });

  it("ACCENT_COLORS contains at least one entry and all are valid CSS hex colors", () => {
    assert.ok(ACCENT_COLORS.length > 0);
    for (const c of ACCENT_COLORS) {
      assert.match(c, /^#[0-9a-f]{6}$/i, `invalid hex color: ${c}`);
    }
  });

  it("META_KEY is a non-empty string", () => {
    assert.ok(typeof META_KEY === "string" && META_KEY.length > 0);
  });
});
