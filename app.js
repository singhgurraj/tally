const STORAGE_KEY = "tally.counters";

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

/** @type {{id: string, name: string, count: number, history: {delta: number, at: number}[]}[]} */
let counters = loadCounters();

// Home view elements
const homeViewEl = document.getElementById("home-view");
const listEl = document.getElementById("counter-list");
const emptyStateEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("counter-summary");
const formEl = document.getElementById("new-counter-form");
const nameInputEl = document.getElementById("new-counter-name");
const templateEl = document.getElementById("counter-template");

// Detail view elements
const detailViewEl = document.getElementById("detail-view");
const detailDotEl = document.getElementById("detail-dot");
const detailNameEl = document.getElementById("detail-name");
const detailCountEl = document.getElementById("detail-count");
const detailIncrementEl = document.getElementById("detail-increment");
const detailDecrementEl = document.getElementById("detail-decrement");
const historyListEl = document.getElementById("history-list");
const historyEmptyEl = document.getElementById("history-empty");
const backLinkEl = document.getElementById("back-link");
const deleteBtnEl = document.getElementById("delete-counter-btn");
const deleteConfirmEl = document.getElementById("delete-confirm");
const deleteCancelBtnEl = document.getElementById("delete-cancel-btn");
const deleteConfirmBtnEl = document.getElementById("delete-confirm-btn");

function sanitizeCounter(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
  const name = typeof raw.name === "string" ? raw.name : "";
  const count = typeof raw.count === "number" && Number.isFinite(raw.count) ? raw.count : 0;
  const history = Array.isArray(raw.history)
    ? raw.history.filter(
        (e) => e && typeof e.delta === "number" && typeof e.at === "number"
      )
    : [];

  return { id, name, count, history };
}

function loadCounters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeCounter).filter(Boolean);
  } catch (err) {
    console.error("Tally: failed to load counters from localStorage", err);
    return [];
  }
}

function saveCounters() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counters));
    setStorageWarning(false);
  } catch (err) {
    console.error("Tally: failed to save counters to localStorage", err);
    setStorageWarning(true);
    throw err;
  }
}

function setStorageWarning(show) {
  const el = document.getElementById("storage-warning");
  if (el) el.hidden = !show;
}

// --- Cross-tab safe writes ---
//
// Each tab keeps its own in-memory `counters` array, so two tabs editing at
// once can otherwise race: both read a stale snapshot, both write it back,
// and whichever tab saves last silently drops the other tab's tap. To avoid
// that, every mutation re-reads the latest data from localStorage and saves
// again inside a single exclusive `navigator.locks` critical section, so a
// tap always applies on top of the most current state instead of a stale
// page-load snapshot. Locks page has near-universal support in evergreen
// browsers on secure contexts (https, or localhost); where unavailable we
// fall back to just re-reading fresh each time, which is not a hard
// guarantee under literally simultaneous clicks but removes the dominant,
// deterministic form of the bug (a tab clobbering another tab's earlier
// write with a stale full-array snapshot).

const STORAGE_LOCK_NAME = "tally.counters.lock";

function withStorageLock(fn) {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(STORAGE_LOCK_NAME, () => fn());
  }
  return Promise.resolve().then(fn);
}

// Runs `mutator` with `counters` refreshed from localStorage immediately
// beforehand, then persists the result — all inside one exclusive lock so
// no other tab's mutation can interleave. `mutator` reads/reassigns the
// module-level `counters` directly and may return a value to hand back to
// the caller (e.g. the counter that was just changed).
function mutateCounters(mutator) {
  return withStorageLock(() => {
    counters = loadCounters();
    const snapshot = JSON.stringify(counters);
    const result = mutator();
    try {
      saveCounters();
    } catch (err) {
      counters = JSON.parse(snapshot);
      throw err;
    }
    return result;
  });
}

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

// --- Routing ---

function currentRoute() {
  const match = location.hash.match(/^#\/counter\/(.+)$/);
  if (match) return { view: "detail", id: decodeURIComponent(match[1]) };
  return { view: "home" };
}

function renderApp() {
  const route = currentRoute();

  if (route.view === "detail" && counters.some((c) => c.id === route.id)) {
    homeViewEl.hidden = true;
    detailViewEl.hidden = false;
    renderDetail(route.id);
  } else {
    detailViewEl.hidden = true;
    homeViewEl.hidden = false;
    renderHome();
  }
}

// --- Home view ---

function renderHome() {
  listEl.innerHTML = "";
  emptyStateEl.hidden = counters.length > 0;
  summaryEl.hidden = counters.length === 0;
  summaryEl.textContent =
    counters.length === 1 ? "1 counter" : `${counters.length} counters`;

  for (const counter of counters) {
    const node = templateEl.content.cloneNode(true);
    const li = node.querySelector(".counter");
    li.dataset.id = counter.id;
    li.style.setProperty("--accent-color", accentFor(counter.id));
    const nameLink = node.querySelector(".counter-name");
    nameLink.textContent = counter.name;
    nameLink.href = `#/counter/${encodeURIComponent(counter.id)}`;
    node.querySelector(".counter-count").textContent = counter.count;
    listEl.appendChild(node);
  }
}

async function addCounter(name) {
  try {
    await mutateCounters(() => {
      counters.push({ id: crypto.randomUUID(), name, count: 0, history: [] });
    });
  } catch {
    return;
  }
  renderHome();

  const newLi = listEl.lastElementChild;
  if (newLi) {
    newLi.classList.add("counter-enter");
    newLi.addEventListener("animationend", () => newLi.classList.remove("counter-enter"), { once: true });
  }
}

async function removeCounter(id) {
  try {
    await mutateCounters(() => {
      counters = counters.filter((c) => c.id !== id);
    });
  } catch {
    return;
  }
  renderHome();
}

// --- Shared count logic ---

async function changeCount(id, delta) {
  let counter;
  try {
    counter = await mutateCounters(() => {
      const c = counters.find((item) => item.id === id);
      if (!c) return null;
      c.count += delta;
      c.history.push({ delta, at: Date.now() });
      if (c.history.length > HISTORY_STORE_LIMIT) {
        c.history.splice(0, c.history.length - HISTORY_STORE_LIMIT);
      }
      return c;
    });
  } catch {
    return;
  }
  if (!counter) return;

  const route = currentRoute();
  if (route.view === "detail" && route.id === id) {
    updateDetailCount(counter);
    prependHistoryEntry(
      counter.history[counter.history.length - 1],
      counter.history.length
    );
  } else {
    const li = listEl.querySelector(`.counter[data-id="${id}"]`);
    const countEl = li?.querySelector(".counter-count");
    if (countEl) {
      countEl.textContent = counter.count;
      pulseElement(countEl);
    }
  }
}

function pulseElement(el) {
  el.classList.remove("pulse");
  // Force reflow so the animation restarts on rapid clicks.
  void el.offsetWidth;
  el.classList.add("pulse");
}

// --- Detail view ---

function renderDetail(id) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;

  detailDotEl.style.setProperty("--accent-color", accentFor(counter.id));
  detailNameEl.textContent = counter.name;
  detailCountEl.textContent = counter.count;
  renderHistory(counter);

  deleteBtnEl.hidden = false;
  deleteConfirmEl.hidden = true;
}

function updateDetailCount(counter) {
  detailCountEl.textContent = counter.count;
  pulseElement(detailCountEl);
}

function buildHistoryEntry(entry) {
  const li = document.createElement("li");
  li.className = "history-entry";

  const deltaEl = document.createElement("span");
  deltaEl.className = `history-delta ${entry.delta > 0 ? "positive" : "negative"}`;
  deltaEl.textContent = entry.delta > 0 ? `+${entry.delta}` : `${entry.delta}`;

  const timeEl = document.createElement("span");
  timeEl.className = "history-time";
  timeEl.textContent = formatTime(entry.at);

  li.appendChild(deltaEl);
  li.appendChild(timeEl);
  return li;
}

function renderHistory(counter) {
  historyListEl.innerHTML = "";
  historyEmptyEl.hidden = counter.history.length > 0;

  const total = counter.history.length;
  // Render newest-first, capped to avoid creating thousands of DOM nodes.
  const slice = counter.history.slice(-HISTORY_DISPLAY_LIMIT);
  for (let i = slice.length - 1; i >= 0; i--) {
    historyListEl.appendChild(buildHistoryEntry(slice[i]));
  }

  if (total > HISTORY_DISPLAY_LIMIT) {
    historyListEl.appendChild(buildTruncationNote(total));
  }
}

function buildTruncationNote(total) {
  const li = document.createElement("li");
  li.className = "history-truncated-note";
  li.textContent = `Showing latest ${HISTORY_DISPLAY_LIMIT} of ${total} taps`;
  return li;
}

// O(1) update: prepend one row instead of rebuilding the entire list.
function prependHistoryEntry(entry, totalStored) {
  historyEmptyEl.hidden = true;
  historyListEl.insertBefore(buildHistoryEntry(entry), historyListEl.firstChild);

  // Drop the oldest visible entry once we exceed the display limit.
  const entries = historyListEl.querySelectorAll(".history-entry");
  if (entries.length > HISTORY_DISPLAY_LIMIT) {
    entries[entries.length - 1].remove();
  }

  // Keep the truncation note accurate.
  let note = historyListEl.querySelector(".history-truncated-note");
  if (totalStored > HISTORY_DISPLAY_LIMIT) {
    if (!note) {
      note = buildTruncationNote(totalStored);
      historyListEl.appendChild(note);
    } else {
      note.textContent = `Showing latest ${HISTORY_DISPLAY_LIMIT} of ${totalStored} taps`;
    }
  }
}

// --- Event wiring ---

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInputEl.value.trim();
  if (!name) return;
  await addCounter(name);
  nameInputEl.value = "";
  nameInputEl.focus();
});

listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".counter");
  if (!li) return;
  const id = li.dataset.id;

  if (e.target.closest(".increment")) await changeCount(id, 1);
  else if (e.target.closest(".decrement")) await changeCount(id, -1);
  else if (e.target.closest(".remove")) li.classList.add("confirming");
  else if (e.target.closest(".confirm-cancel-btn")) li.classList.remove("confirming");
  else if (e.target.closest(".confirm-delete-btn")) await removeCounter(id);
  // .counter-name is a plain <a href="#/counter/..."> — let it navigate natively.
});

detailIncrementEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await changeCount(id, 1);
});

detailDecrementEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await changeCount(id, -1);
});

backLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});

deleteBtnEl.addEventListener("click", () => {
  deleteBtnEl.hidden = true;
  deleteConfirmEl.hidden = false;
});

deleteCancelBtnEl.addEventListener("click", () => {
  deleteConfirmEl.hidden = true;
  deleteBtnEl.hidden = false;
});

deleteConfirmBtnEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await removeCounter(id);
  location.hash = "";
});

window.addEventListener("hashchange", renderApp);

// Another tab changed the data (e.g. tapped the same counter) — pick up its
// write immediately instead of showing a stale count until this tab does
// its own mutation or the page is reloaded.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  counters = loadCounters();
  renderApp();
});

renderApp();
