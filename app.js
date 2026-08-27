// app.js — UI layer.  Counter data lives server-side (SQLite); this file
// manages view state, API calls, and real-time WebSocket sync.
// Utility globals from counters.js: accentFor, formatTime, HISTORY_DISPLAY_LIMIT,
// HISTORY_STORE_LIMIT.  Chart functions from dashboard.js: renderDashboard, exportData.

const FREE_COUNTER_LIMIT = 3;

// Authenticated user.  null = not logged in.
// Shape: { id: string, email: string, isPremium: boolean }
let currentUser = null;

// Active share-link session.  null = normal flow.
// Shape: { profileId: string, counterId: string, name: string, count: number }
let sharedSession = null;

// userId used for WS subscription / tap submission.
function effectiveProfileId() {
  return sharedSession ? sharedSession.profileId : currentUser?.id;
}

/** @type {{ id: string, name: string, count: number, history?: {delta:number,at:number,tz?:string}[] }[]} */
let counters = [];

let lastDetailId = null;

// ─── DOM refs: auth view ───────────────────────────────────────────────────────

const authViewEl = document.getElementById("auth-view");
const authLoginScreenEl = document.getElementById("auth-login-screen");
const authSignupScreenEl = document.getElementById("auth-signup-screen");
const loginFormEl = document.getElementById("login-form");
const loginEmailEl = document.getElementById("login-email");
const loginPasswordEl = document.getElementById("login-password");
const loginErrorEl = document.getElementById("login-error");
const loginSubmitBtnEl = document.getElementById("login-submit-btn");
const signupFormEl = document.getElementById("signup-form");
const signupEmailEl = document.getElementById("signup-email");
const signupPasswordEl = document.getElementById("signup-password");
const signupErrorEl = document.getElementById("signup-error");
const signupSubmitBtnEl = document.getElementById("signup-submit-btn");
const showSignupLinkEl = document.getElementById("show-signup-link");
const showLoginLinkEl = document.getElementById("show-login-link");

// ─── DOM refs: home view ───────────────────────────────────────────────────────

const homeViewEl = document.getElementById("home-view");
const listEl = document.getElementById("counter-list");
const emptyStateEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("counter-summary");
const formEl = document.getElementById("new-counter-form");
const nameInputEl = document.getElementById("new-counter-name");
const templateEl = document.getElementById("counter-template");
const activeProfileLabelEl = document.getElementById("active-profile-label");
const premiumBadgeEl = document.getElementById("premium-badge");
const logoutBtnEl = document.getElementById("logout-btn");

// ─── DOM refs: detail view ─────────────────────────────────────────────────────

const detailViewEl = document.getElementById("detail-view");
const detailDotEl = document.getElementById("detail-dot");
const detailNameEl = document.getElementById("detail-name");
const detailCountEl = document.getElementById("detail-count");
const detailIncrementEl = document.getElementById("detail-increment");
const detailDecrementEl = document.getElementById("detail-decrement");
const detailUndoBtnEl = document.getElementById("detail-undo-btn");
const detailRedoBtnEl = document.getElementById("detail-redo-btn");
const homeUndoBtnEl = document.getElementById("home-undo-btn");
const historyListEl = document.getElementById("history-list");
const historyEmptyEl = document.getElementById("history-empty");
const backLinkEl = document.getElementById("back-link");
const deleteBtnEl = document.getElementById("delete-counter-btn");
const deleteModalEl = document.getElementById("delete-modal");
const deleteModalTitleEl = document.getElementById("delete-modal-title");
const deleteModalCancelEl = document.getElementById("delete-modal-cancel");
const deleteModalConfirmEl = document.getElementById("delete-modal-confirm");

// ─── DOM refs: dashboard view ──────────────────────────────────────────────────

const dashboardViewEl = document.getElementById("dashboard-view");
const dashboardBackLinkEl = document.getElementById("dashboard-back-link");
const exportDataBtnEl = document.getElementById("export-data-btn");
const importDataBtnEl = document.getElementById("import-data-btn");
const importFileInputEl = document.getElementById("import-file-input");

let dashboardDays = 7;

// ─── DOM refs: shared view ─────────────────────────────────────────────────────

const sharedViewEl = document.getElementById("shared-view");
const sharedDotEl = document.getElementById("shared-dot");
const sharedNameEl = document.getElementById("shared-name");
const sharedCountEl = document.getElementById("shared-count");
const sharedIncrementEl = document.getElementById("shared-increment");
const sharedDecrementEl = document.getElementById("shared-decrement");
const sharedBackLinkEl = document.getElementById("shared-back-link");
const sharedPresenceEl = document.getElementById("shared-presence");
const shareBtnEl = document.getElementById("share-btn");
const detailPresenceEl = document.getElementById("detail-presence");

// ─── DOM refs: share modal ─────────────────────────────────────────────────────

const shareModalEl = document.getElementById("share-modal");
const shareCodeTextEl = document.getElementById("share-code-text");
const shareUrlInputEl = document.getElementById("share-url-input");
const shareModalCopyBtnEl = document.getElementById("share-modal-copy-btn");
const shareModalCloseBtnEl = document.getElementById("share-modal-close-btn");

// ─── DOM refs: join modal ──────────────────────────────────────────────────────

const joinBtnEl = document.getElementById("join-btn");
const joinModalEl = document.getElementById("join-modal");
const joinCodeInputEl = document.getElementById("join-code-input");
const joinErrorEl = document.getElementById("join-error");
const joinModalCancelBtnEl = document.getElementById("join-modal-cancel-btn");
const joinModalSubmitBtnEl = document.getElementById("join-modal-submit-btn");

// ─── DOM refs: upgrade modal ───────────────────────────────────────────────────

const upgradeModalEl = document.getElementById("upgrade-modal");
const upgradeCancelBtnEl = document.getElementById("upgrade-cancel-btn");
const upgradeConfirmBtnEl = document.getElementById("upgrade-confirm-btn");

// ─── API helpers ───────────────────────────────────────────────────────────────

async function fetchCurrentUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const { user, isPremium } = await res.json();
      currentUser = { ...user, isPremium };
    } else {
      currentUser = null;
    }
  } catch {
    currentUser = null;
  }
}

async function fetchCounters() {
  try {
    const res = await fetch("/api/counters");
    if (res.ok) {
      const data = await res.json();
      counters = data.counters;
    }
  } catch {}
}

async function handleLogin(email, password) {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error };
    currentUser = { ...data.user, isPremium: data.isPremium };
    await fetchCounters();
    syncConnect();
    startSyncTimer();
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't connect — please check your connection and try again." };
  }
}

async function handleSignup(email, password) {
  try {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error };
    currentUser = { ...data.user, isPremium: false };
    counters = [];
    syncConnect();
    startSyncTimer();
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't connect — please check your connection and try again." };
  }
}

async function handleLogout() {
  flushTapQueue();
  syncDisconnect();
  await fetch("/api/auth/logout", { method: "POST" });
  currentUser = null;
  counters = [];
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoRedoButtons();
  location.hash = "";
  renderApp();
}

// ─── Routing / render ──────────────────────────────────────────────────────────

function currentRoute() {
  if (location.hash === "#/dashboard") return { view: "dashboard" };
  const joinMatch = location.hash.match(/^#\/join\/([A-Z0-9]{6})$/i);
  if (joinMatch) return { view: "join", code: joinMatch[1].toUpperCase() };
  const sharedMatch = location.hash.match(/^#\/shared\/([^/]+)\/([^/]+)\/(.+)$/);
  if (sharedMatch) return {
    view: "shared",
    profileId: decodeURIComponent(sharedMatch[1]),
    counterId: decodeURIComponent(sharedMatch[2]),
    name: decodeURIComponent(sharedMatch[3]),
  };
  const detailMatch = location.hash.match(/^#\/counter\/(.+)$/);
  if (detailMatch) return { view: "detail", id: decodeURIComponent(detailMatch[1]) };
  return { view: "home" };
}

// renderApp may fetch data asynchronously (lazy history load for detail/dashboard).
// The callers that don't await it are fine: the async work finishes and the render
// happens naturally; nothing in the call chain depends on the resolved value.
async function renderApp({ moveFocus = false } = {}) {
  const route = currentRoute();

  // Dashboard requires auth.
  if (route.view === "dashboard") {
    if (!currentUser) { location.hash = ""; return; }
    authViewEl.hidden = true;
    homeViewEl.hidden = true;
    detailViewEl.hidden = true;
    sharedViewEl.hidden = true;
    dashboardViewEl.hidden = false;

    // Lazy-load history for all counters.
    if (counters.some((c) => !c.history)) {
      const res = await fetch("/api/counters?include=history");
      if (res.ok) {
        const { counters: full } = await res.json();
        for (const fc of full) {
          const c = counters.find((x) => x.id === fc.id);
          if (c) c.history = fc.history || [];
        }
      }
    }

    renderDashboard(counters, dashboardDays);
    return;
  }

  // Join via share code — resolve then redirect to shared view.
  if (route.view === "join") {
    sharedViewEl.hidden = false;
    authViewEl.hidden = true;
    homeViewEl.hidden = true;
    detailViewEl.hidden = true;
    dashboardViewEl.hidden = true;
    sharedNameEl.textContent = "Loading…";
    sharedCountEl.textContent = "–";
    try {
      const res = await fetch(`/api/share/${encodeURIComponent(route.code)}`);
      if (!res.ok) throw new Error("not found");
      const { counter } = await res.json();
      history.replaceState(null, "",
        `#/shared/${encodeURIComponent(counter.ownerId)}` +
        `/${encodeURIComponent(counter.id)}` +
        `/${encodeURIComponent(counter.name)}`
      );
      await enterSharedView(counter.ownerId, counter.id, counter.name);
    } catch {
      showToast("Counter not found. The link may be invalid.", { error: true });
      history.replaceState(null, "", location.pathname);
      renderApp();
    }
    return;
  }

  // Shared view: no auth needed.
  if (route.view === "shared") {
    if (!sharedSession || sharedSession.counterId !== route.counterId) {
      enterSharedView(route.profileId, route.counterId, route.name);
    } else {
      showSharedView();
    }
    return;
  }

  // Leaving shared view.
  if (sharedSession) {
    exitSharedView();
    if (currentUser) { syncConnect(); startSyncTimer(); }
  }

  // Not logged in: show auth screen.
  if (!currentUser) {
    homeViewEl.hidden = true;
    detailViewEl.hidden = true;
    sharedViewEl.hidden = true;
    dashboardViewEl.hidden = true;
    authViewEl.hidden = false;
    showAuthLoginScreen();
    return;
  }

  authViewEl.hidden = true;
  sharedViewEl.hidden = true;
  dashboardViewEl.hidden = true;

  if (activeProfileLabelEl) activeProfileLabelEl.textContent = currentUser.email;
  if (premiumBadgeEl) premiumBadgeEl.hidden = !currentUser.isPremium;

  if (route.view === "detail" && counters.some((c) => c.id === route.id)) {
    // Leave any previously joined counter room before joining a new one.
    if (lastDetailId && lastDetailId !== route.id) wsLeaveCounter(lastDetailId);
    lastDetailId = route.id;
    homeViewEl.hidden = true;
    detailViewEl.hidden = false;

    const counter = counters.find((c) => c.id === route.id);
    // Lazy-load history on first visit to detail view.
    if (!counter.history) {
      const res = await fetch(`/api/counters/${route.id}`);
      if (res.ok) {
        const { counter: detail } = await res.json();
        counter.history = detail.history || [];
        counter.count = detail.count;
      } else {
        counter.history = [];
      }
    }

    renderDetail(route.id);
    wsJoinCounter(route.id);
    if (moveFocus) detailNameEl.focus();
  } else {
    if (lastDetailId) wsLeaveCounter(lastDetailId);
    detailViewEl.hidden = true;
    homeViewEl.hidden = false;
    renderHome();
    if (moveFocus && lastDetailId) {
      const li = listEl.querySelector(`.counter[data-id="${lastDetailId}"]`);
      const target =
        li?.querySelector(".counter-name") ||
        listEl.querySelector(".counter-name") ||
        nameInputEl;
      target.focus();
    }
    lastDetailId = null;
  }
}

// ─── Auth view ─────────────────────────────────────────────────────────────────

function showAuthLoginScreen() {
  authLoginScreenEl.hidden = false;
  authSignupScreenEl.hidden = true;
  clearError(loginErrorEl);
  requestAnimationFrame(() => loginEmailEl.focus());
}

function showAuthSignupScreen() {
  authLoginScreenEl.hidden = true;
  authSignupScreenEl.hidden = false;
  clearError(signupErrorEl);
  requestAnimationFrame(() => signupEmailEl.focus());
}

// ─── Home view ─────────────────────────────────────────────────────────────────

// counterId → <li> element. Kept in sync with listEl so tap/sync handlers can
// update the DOM in O(1) without a querySelector scan over the whole list.
const counterElements = new Map();

function updateSummary() {
  emptyStateEl.hidden = counters.length > 0;
  summaryEl.hidden = counters.length === 0;
  if (currentUser?.isPremium) {
    summaryEl.textContent = `${counters.length} counter${counters.length !== 1 ? "s" : ""}`;
  } else {
    summaryEl.textContent = `${counters.length} / ${FREE_COUNTER_LIMIT} counters (free plan)`;
  }
}

function buildCounterNode(counter) {
  const frag = templateEl.content.cloneNode(true);
  const li = frag.querySelector(".counter");
  li.dataset.id = counter.id;
  li.style.setProperty("--accent-color", accentFor(counter.id));
  const nameLink = frag.querySelector(".counter-name");
  nameLink.textContent = counter.name;
  nameLink.href = `#/counter/${encodeURIComponent(counter.id)}`;
  frag.querySelector(".counter-count").textContent = counter.count;
  frag.querySelector(".decrement").setAttribute("aria-label", `Decrement ${counter.name}`);
  frag.querySelector(".increment").setAttribute("aria-label", `Increment ${counter.name}`);
  frag.querySelector(".remove").setAttribute("aria-label", `Delete ${counter.name}`);
  return { frag, li };
}

function renderHome() {
  listEl.innerHTML = "";
  counterElements.clear();
  updateSummary();
  for (const counter of counters) {
    const { frag, li } = buildCounterNode(counter);
    counterElements.set(counter.id, li);
    listEl.appendChild(frag);
  }
}

async function addCounter(name) {
  name = name.trim();
  if (!name) return { ok: false, reason: "empty" };

  // Client-side limit check so the upgrade modal shows immediately.
  if (!currentUser?.isPremium && counters.length >= FREE_COUNTER_LIMIT) {
    showUpgradeModal();
    return { ok: false, reason: "limit" };
  }

  try {
    const res = await fetch("/api/counters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 403) { showUpgradeModal(); return { ok: false, reason: "limit" }; }
      return { ok: false, reason: "error", message: data.error };
    }
    const counter = { id: data.id, name: data.name, count: 0 };
    counters.push(counter);
    announce(`Counter "${data.name}" added.`);
    updateSummary();
    const { frag, li: newLi } = buildCounterNode(counter);
    newLi.classList.add("counter-enter");
    newLi.addEventListener("animationend", () => newLi.classList.remove("counter-enter"), { once: true });
    counterElements.set(counter.id, newLi);
    listEl.appendChild(frag);
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

async function removeCounter(id) {
  const target = counters.find((c) => c.id === id);
  try { await fetch(`/api/counters/${id}`, { method: "DELETE" }); } catch {}
  counters = counters.filter((c) => c.id !== id);
  const li = counterElements.get(id);
  if (li) li.remove();
  counterElements.delete(id);
  updateSummary();
  if (target) announce(`Counter "${target.name}" deleted.`);
}

// ─── Upgrade modal ─────────────────────────────────────────────────────────────

function showUpgradeModal() {
  upgradeConfirmBtnEl.disabled = false;
  upgradeConfirmBtnEl.textContent = "Upgrade — $5/mo";
  upgradeModalEl.showModal();
  upgradeCancelBtnEl.focus();
}

upgradeCancelBtnEl.addEventListener("click", () => upgradeModalEl.close("cancel"));

upgradeConfirmBtnEl.addEventListener("click", async () => {
  upgradeConfirmBtnEl.disabled = true;
  upgradeConfirmBtnEl.textContent = "Loading…";
  try {
    const res = await fetch("/api/stripe/checkout", { method: "POST" });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      upgradeConfirmBtnEl.disabled = false;
      upgradeConfirmBtnEl.textContent = "Upgrade — $5/mo";
      showToast(data.error || "Couldn't start checkout — please try again.", { error: true });
    }
  } catch {
    upgradeConfirmBtnEl.disabled = false;
    upgradeConfirmBtnEl.textContent = "Upgrade — $5/mo";
    showToast("Couldn't start checkout — please check your connection.", { error: true });
  }
});

// ─── Undo / redo ───────────────────────────────────────────────────────────────
// undoStack entries: { counterId, delta, at }
//   `at` is the timestamp used when the tap was enqueued.  It lets us find and
//   cancel the tap in tapQueue before it is flushed to the server.
//
// redoStack entries: { counterId, delta }
//   No `at` — redo always creates a fresh tap with a new timestamp.
//
// Cancel-before-flush: if the original tap is still in tapQueue when undo fires,
// we remove it directly.  No reversal tap is sent, so the server never sees a
// phantom entry, the history list stays clean, and the dashboard charts are not
// skewed by undo/redo noise.  Only when the tap has already been flushed do we
// fall back to sending a reversal, with a guaranteed-unique timestamp so the
// server dedup never confuses the reversal with the original.

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50; // cap memory; oldest entries drop silently

function updateUndoRedoButtons() {
  const hasUndo = undoStack.length > 0;
  if (detailUndoBtnEl) detailUndoBtnEl.disabled = !hasUndo;
  if (detailRedoBtnEl) detailRedoBtnEl.disabled = redoStack.length === 0;
  if (homeUndoBtnEl) homeUndoBtnEl.hidden = !hasUndo;
}

// Monotonic timestamp — strictly increases even when Date.now() repeats across
// rapid taps, undos, and redos in the same millisecond.  This prevents two ops
// from sharing an `at` value that would collide in the server's dedup check.
let _lastTapAt = 0;
function nextTapAt() {
  const now = Date.now();
  _lastTapAt = now > _lastTapAt ? now : _lastTapAt + 1;
  return _lastTapAt;
}

// Apply a delta to a counter optimistically, enqueue the server tap, refresh
// the relevant UI element, and return the `at` timestamp so callers can store
// it in the undo stack for later queue-based cancellation.
function applyTapLocally(c, delta) {
  const at = nextTapAt();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  c.count += delta;
  if (c.history) {
    c.history.push({ delta, at, tz });
    if (c.history.length > HISTORY_STORE_LIMIT) {
      c.history.splice(0, c.history.length - HISTORY_STORE_LIMIT);
    }
  }
  enqueueTap(c.id, c.name, delta, at, tz);

  const route = currentRoute();
  if (route.view === "detail" && route.id === c.id) {
    updateDetailCount(c);
    if (c.history) prependHistoryEntry(c.history[c.history.length - 1], c.history.length);
  } else {
    const countEl = counterElements.get(c.id)?.querySelector(".counter-count");
    if (countEl) { countEl.textContent = c.count; pulseElement(countEl); }
  }
  return at;
}

// Refresh the counter's count display and history list after a cancellation
// (where a history entry was removed rather than appended).
function refreshCounterUI(c) {
  const route = currentRoute();
  if (route.view === "detail" && route.id === c.id) {
    detailCountEl.textContent = c.count;
    pulseElement(detailCountEl);
    renderHistory(c);
  } else {
    const countEl = counterElements.get(c.id)?.querySelector(".counter-count");
    if (countEl) { countEl.textContent = c.count; pulseElement(countEl); }
  }
}

function undoLastTap() {
  const action = undoStack.pop();
  if (!action) return;
  const c = counters.find((item) => item.id === action.counterId);
  if (!c) { updateUndoRedoButtons(); return; }

  // Prefer cancellation: find and remove the original tap from the queue so
  // no reversal entry ever touches the server or the history.
  const queueIdx = tapQueue.findIndex(
    (t) => t.counterId === action.counterId && t.at === action.at
  );
  if (queueIdx !== -1) {
    tapQueue.splice(queueIdx, 1);
    sentTapKeys.delete(`${action.counterId}:${action.at}`);
    c.count -= action.delta;
    if (c.history) {
      // Remove the matching history entry (search from the end — it's recent).
      for (let i = c.history.length - 1; i >= 0; i--) {
        if (c.history[i].at === action.at && c.history[i].delta === action.delta) {
          c.history.splice(i, 1);
          break;
        }
      }
    }
    refreshCounterUI(c);
  } else {
    // Already flushed — send a reversal tap.  nextTapAt() guarantees a unique
    // timestamp so the server dedup never silently drops this reversal.
    applyTapLocally(c, -action.delta);
  }

  redoStack.push({ counterId: action.counterId, delta: action.delta });
  updateUndoRedoButtons();
  announce(`Undid tap on "${c.name}".`);
}

function redoLastTap() {
  const action = redoStack.pop();
  if (!action) return;
  const c = counters.find((item) => item.id === action.counterId);
  if (!c) { updateUndoRedoButtons(); return; }
  const at = applyTapLocally(c, action.delta);
  undoStack.push({ counterId: action.counterId, delta: action.delta, at });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  updateUndoRedoButtons();
  announce(`Redid tap on "${c.name}".`);
}

// ─── Count logic ───────────────────────────────────────────────────────────────

async function changeCount(id, delta) {
  const c = counters.find((item) => item.id === id);
  if (!c) return;
  const at = applyTapLocally(c, delta);
  undoStack.push({ counterId: id, delta, at });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0; // new tap invalidates pending redo history
  updateUndoRedoButtons();
}

function pulseElement(el) {
  el.classList.remove("pulse");
  void el.offsetWidth; // force reflow so animation restarts on rapid taps
  el.classList.add("pulse");
}

// ─── Detail view ───────────────────────────────────────────────────────────────

function renderDetail(id) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  detailDotEl.style.setProperty("--accent-color", accentFor(counter.id));
  detailNameEl.textContent = counter.name;
  detailCountEl.textContent = counter.count;
  renderHistory(counter);
  deleteBtnEl.hidden = false;
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
  deltaEl.textContent = entry.delta > 0 ? `+${entry.delta}` : String(entry.delta);
  const timeEl = document.createElement("span");
  timeEl.className = "history-time";
  timeEl.textContent = formatTime(entry.at, entry.tz);
  li.appendChild(deltaEl);
  li.appendChild(timeEl);
  return li;
}

function renderHistory(counter) {
  historyListEl.innerHTML = "";
  const history = counter.history || [];
  historyEmptyEl.hidden = history.length > 0;
  const total = history.length;
  const slice = history.slice(-HISTORY_DISPLAY_LIMIT);
  for (let i = slice.length - 1; i >= 0; i--) {
    historyListEl.appendChild(buildHistoryEntry(slice[i]));
  }
  if (total > HISTORY_DISPLAY_LIMIT) historyListEl.appendChild(buildTruncationNote(total));
}

function buildTruncationNote(total) {
  const li = document.createElement("li");
  li.className = "history-truncated-note";
  li.textContent = `Showing latest ${HISTORY_DISPLAY_LIMIT} of ${total} taps`;
  return li;
}

function prependHistoryEntry(entry, totalStored) {
  historyEmptyEl.hidden = true;
  historyListEl.insertBefore(buildHistoryEntry(entry), historyListEl.firstChild);
  const entries = historyListEl.querySelectorAll(".history-entry");
  if (entries.length > HISTORY_DISPLAY_LIMIT) entries[entries.length - 1].remove();
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

// ─── Utilities ─────────────────────────────────────────────────────────────────

const nameErrorEl = document.getElementById("name-error");
const srAnnounceEl = document.getElementById("sr-announce");
const toastEl = document.getElementById("toast");

// Polite announcement for screen readers when the UI already reflects the
// change visually (e.g. a new counter appeared in the list).
function announce(msg) {
  if (!srAnnounceEl) return;
  srAnnounceEl.textContent = "";
  requestAnimationFrame(() => { srAnnounceEl.textContent = msg; });
}

// Visible notification for all users.  Pass { error: true } for failures so
// the toast uses a red background and an assertive ARIA role (interrupts the
// screen reader immediately rather than waiting for a pause).
let _toastTimer = null;
function showToast(msg, { error = false, duration = 5000 } = {}) {
  clearTimeout(_toastTimer);
  // Swap role before revealing so the attribute change fires a fresh SR event.
  toastEl.setAttribute("role", error ? "alert" : "status");
  toastEl.setAttribute("aria-live", error ? "assertive" : "polite");
  toastEl.textContent = msg;
  toastEl.classList.toggle("toast-error", error);
  toastEl.hidden = false;
  _toastTimer = setTimeout(() => { toastEl.hidden = true; }, duration);
}

function showError(el, msg) { el.textContent = msg; el.hidden = false; }
function clearError(el) { el.hidden = true; el.textContent = ""; }

// ─── Event wiring: auth ────────────────────────────────────────────────────────

showSignupLinkEl.addEventListener("click", (e) => { e.preventDefault(); showAuthSignupScreen(); });
showLoginLinkEl.addEventListener("click", (e) => { e.preventDefault(); showAuthLoginScreen(); });

loginEmailEl.addEventListener("input", () => clearError(loginErrorEl));
loginPasswordEl.addEventListener("input", () => clearError(loginErrorEl));

loginFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = loginEmailEl.value.trim();
  const password = loginPasswordEl.value;
  if (!email || !password) return;
  loginSubmitBtnEl.disabled = true;
  loginSubmitBtnEl.textContent = "Logging in…";
  const result = await handleLogin(email, password);
  loginSubmitBtnEl.disabled = false;
  loginSubmitBtnEl.textContent = "Log in";
  if (!result.ok) { showError(loginErrorEl, result.error || "Login failed"); return; }
  location.hash = "";
  renderApp();
});

signupEmailEl.addEventListener("input", () => clearError(signupErrorEl));
signupPasswordEl.addEventListener("input", () => clearError(signupErrorEl));

signupFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = signupEmailEl.value.trim();
  const password = signupPasswordEl.value;
  if (password.length < 8) {
    showError(signupErrorEl, "Password must be at least 8 characters.");
    signupPasswordEl.focus();
    return;
  }
  signupSubmitBtnEl.disabled = true;
  signupSubmitBtnEl.textContent = "Creating account…";
  const result = await handleSignup(email, password);
  signupSubmitBtnEl.disabled = false;
  signupSubmitBtnEl.textContent = "Create account";
  if (!result.ok) { showError(signupErrorEl, result.error || "Signup failed"); return; }
  location.hash = "";
  renderApp();
});

// ─── Event wiring: home ────────────────────────────────────────────────────────

if (logoutBtnEl) logoutBtnEl.addEventListener("click", handleLogout);

nameInputEl.addEventListener("input", () => clearError(nameErrorEl));

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInputEl.value.trim();
  if (!name) return;
  const result = await addCounter(name);
  if (!result.ok) {
    if (result.reason !== "limit") {
      showError(nameErrorEl, result.message || "Couldn't save — please try again.");
    }
    return;
  }
  clearError(nameErrorEl);
  nameInputEl.value = "";
  nameInputEl.focus();
});

listEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".counter");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.closest(".increment")) await changeCount(id, 1);
  else if (e.target.closest(".decrement")) await changeCount(id, -1);
  else if (e.target.closest(".remove")) {
    const name = counters.find((c) => c.id === id)?.name ?? "this counter";
    if (await openDeleteModal(name)) await removeCounter(id);
  }
});

// ─── Delete modal ──────────────────────────────────────────────────────────────

let _deleteModalResolve = null;

deleteModalEl.addEventListener("close", () => {
  if (_deleteModalResolve) {
    _deleteModalResolve(deleteModalEl.returnValue === "confirm");
    _deleteModalResolve = null;
  }
});

deleteModalCancelEl.addEventListener("click", () => deleteModalEl.close("cancel"));
deleteModalConfirmEl.addEventListener("click", () => deleteModalEl.close("confirm"));

function openDeleteModal(counterName) {
  deleteModalTitleEl.textContent = `Delete "${counterName}"?`;
  return new Promise((resolve) => {
    _deleteModalResolve = resolve;
    deleteModalEl.showModal();
    deleteModalCancelEl.focus();
  });
}

// ─── Event wiring: detail view ─────────────────────────────────────────────────

detailIncrementEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await changeCount(id, 1);
});

detailDecrementEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await changeCount(id, -1);
});

homeUndoBtnEl.addEventListener("click", () => undoLastTap());
detailUndoBtnEl.addEventListener("click", () => undoLastTap());
detailRedoBtnEl.addEventListener("click", () => redoLastTap());

document.addEventListener("keydown", (e) => {
  const mod = navigator.platform.startsWith("Mac") ? e.metaKey : e.ctrlKey;
  if (!mod) return;
  if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undoLastTap(); }
  else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); redoLastTap(); }
});

backLinkEl.addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });

deleteBtnEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  const name = counters.find((c) => c.id === id)?.name ?? "this counter";
  if (await openDeleteModal(name)) {
    if (id) await removeCounter(id);
    location.hash = "";
  }
});

// ─── Event wiring: share button / share modal ──────────────────────────────────

shareBtnEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (!id || !currentUser) return;
  shareBtnEl.disabled = true;
  shareBtnEl.textContent = "Loading…";
  try {
    const res = await fetch(`/api/counters/${id}/share`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "error");
    const shareUrl = `${location.origin}${location.pathname}#/join/${data.code}`;
    shareCodeTextEl.textContent = data.code;
    shareUrlInputEl.value = shareUrl;
    shareModalEl.showModal();
    shareModalCloseBtnEl.focus();
  } catch {
    showToast("Couldn't generate share link — please try again.", { error: true });
  } finally {
    shareBtnEl.disabled = false;
    shareBtnEl.textContent = "Share";
  }
});

shareModalCloseBtnEl.addEventListener("click", () => shareModalEl.close());

shareModalCopyBtnEl.addEventListener("click", async () => {
  const url = shareUrlInputEl.value;
  try {
    await navigator.clipboard.writeText(url);
    shareModalCopyBtnEl.textContent = "Copied!";
    setTimeout(() => { shareModalCopyBtnEl.textContent = "Copy"; }, 2000);
  } catch {
    shareUrlInputEl.select();
  }
});

// ─── Event wiring: join modal ──────────────────────────────────────────────────

if (joinBtnEl) joinBtnEl.addEventListener("click", () => {
  clearError(joinErrorEl);
  joinCodeInputEl.value = "";
  joinModalEl.showModal();
  joinCodeInputEl.focus();
});

joinModalCancelBtnEl.addEventListener("click", () => joinModalEl.close());

joinCodeInputEl.addEventListener("input", () => {
  clearError(joinErrorEl);
  joinCodeInputEl.value = joinCodeInputEl.value.toUpperCase();
});

joinModalSubmitBtnEl.addEventListener("click", async () => {
  const code = joinCodeInputEl.value.trim().toUpperCase();
  if (code.length !== 6) {
    showError(joinErrorEl, "Enter the full 6-character code.");
    return;
  }
  joinModalSubmitBtnEl.disabled = true;
  joinModalSubmitBtnEl.textContent = "Joining…";
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error("not found");
    const { counter } = await res.json();
    joinModalEl.close();
    location.hash = `#/join/${code}`;
  } catch {
    showError(joinErrorEl, "Counter not found. Check the code and try again.");
  } finally {
    joinModalSubmitBtnEl.disabled = false;
    joinModalSubmitBtnEl.textContent = "Join";
  }
});

// ─── Event wiring: shared view ─────────────────────────────────────────────────

sharedIncrementEl.addEventListener("click", () => sharedTap(1));
sharedDecrementEl.addEventListener("click", () => sharedTap(-1));
sharedBackLinkEl.addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });

// ─── Event wiring: dashboard ───────────────────────────────────────────────────

dashboardBackLinkEl.addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });

dashboardViewEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  dashboardDays = Number(btn.dataset.days);
  renderDashboard(counters, dashboardDays);
});

exportDataBtnEl.addEventListener("click", async () => {
  // Ensure full history is loaded before exporting.
  if (counters.some((c) => !c.history)) {
    const res = await fetch("/api/counters?include=history");
    if (res.ok) {
      const { counters: full } = await res.json();
      for (const fc of full) {
        const c = counters.find((x) => x.id === fc.id);
        if (c) c.history = fc.history || [];
      }
    }
  }
  exportData(counters);
});

importDataBtnEl.addEventListener("click", () => {
  importFileInputEl.value = "";
  importFileInputEl.click();
});

importFileInputEl.addEventListener("change", async () => {
  const file = importFileInputEl.files?.[0];
  if (!file) return;

  importDataBtnEl.disabled = true;
  importDataBtnEl.textContent = "Importing…";

  let text;
  try {
    text = await file.text();
  } catch {
    showToast("Import failed: could not read the file.", { error: true });
    importDataBtnEl.disabled = false;
    importDataBtnEl.textContent = "Import";
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    showToast("Import failed: the file doesn't appear to be a valid Tally export.", { error: true });
    importDataBtnEl.disabled = false;
    importDataBtnEl.textContent = "Import";
    return;
  }

  try {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Import failed: ${data.error || "Unknown error"}`, { error: true });
      return;
    }
    await fetchCounters();
    renderApp();
    const msg = [
      data.countersCreated ? `${data.countersCreated} counter${data.countersCreated !== 1 ? "s" : ""} added` : "",
      data.tapsImported ? `${data.tapsImported} tap${data.tapsImported !== 1 ? "s" : ""} imported` : "",
    ].filter(Boolean).join(", ");
    showToast(msg ? `Import complete: ${msg}.` : "Import complete — no new data.");
  } catch {
    showToast("Import failed — please check your connection and try again.", { error: true });
  } finally {
    importDataBtnEl.disabled = false;
    importDataBtnEl.textContent = "Import";
  }
});

// ─── WebSocket sync ────────────────────────────────────────────────────────────

const SYNC_INTERVAL_MS = 3000;

let syncWs = null;
let syncReconnectTimer = null;
let syncIntervalTimer = null;

// Counter presence room tracking.
let _pendingJoinCounterId = null;
let _joinedCounterId = null;

function wsJoinCounter(counterId) {
  _pendingJoinCounterId = counterId;
  _joinedCounterId = counterId;
  if (syncWs?.readyState === 1) {
    syncWs.send(JSON.stringify({ type: "join-counter", counterId }));
    _pendingJoinCounterId = null;
  }
}

function wsLeaveCounter(counterId) {
  if (_joinedCounterId === counterId) _joinedCounterId = null;
  _pendingJoinCounterId = null;
  if (syncWs?.readyState === 1) {
    syncWs.send(JSON.stringify({ type: "leave-counter", counterId }));
  }
  // Clear presence display.
  if (detailPresenceEl) { detailPresenceEl.textContent = ""; detailPresenceEl.hidden = true; detailPresenceEl.classList.remove("active"); }
  if (sharedPresenceEl) { sharedPresenceEl.textContent = ""; sharedPresenceEl.hidden = true; sharedPresenceEl.classList.remove("active"); }
}

const tapQueue = [];
const sentTapKeys = new Set();

function syncConnect() {
  const pid = effectiveProfileId();
  if (!pid || syncWs) return;
  const wsUrl = location.origin.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  syncWs = ws;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "subscribe", profileId: pid }));
    if (_pendingJoinCounterId) {
      ws.send(JSON.stringify({ type: "join-counter", counterId: _pendingJoinCounterId }));
      _pendingJoinCounterId = null;
    }
  });

  ws.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "tap") {
        if (sharedSession) applySharedTap(msg);
        else applySyncedTap(msg);
      } else if (msg.type === "state") {
        if (sharedSession) applySharedState(msg.counters);
        else applySyncedState(msg.counters);
      } else if (msg.type === "presence") {
        applyPresence(msg);
      }
    } catch {}
  });

  ws.addEventListener("close", () => {
    if (syncWs === ws) syncWs = null;
    if (effectiveProfileId()) syncReconnectTimer = setTimeout(syncConnect, 3000);
  });

  ws.addEventListener("error", () => ws.close());
}

function syncDisconnect() {
  clearTimeout(syncReconnectTimer);
  clearInterval(syncIntervalTimer);
  syncIntervalTimer = null;
  if (syncWs) { syncWs.close(); syncWs = null; }
}

function startSyncTimer() {
  if (syncIntervalTimer) return;
  syncIntervalTimer = setInterval(flushTapQueue, SYNC_INTERVAL_MS);
}

function enqueueTap(counterId, counterName, delta, at, tz) {
  const key = `${counterId}:${at}`;
  sentTapKeys.add(key);
  if (sentTapKeys.size > 500) {
    const arr = [...sentTapKeys];
    arr.slice(0, 250).forEach((k) => sentTapKeys.delete(k));
  }
  tapQueue.push({ profileId: effectiveProfileId(), counterId, name: counterName, delta, at, tz });
}

async function flushTapQueue() {
  if (!currentUser || tapQueue.length === 0) return;
  const batch = tapQueue.splice(0, tapQueue.length);
  try {
    const res = await fetch("/api/taps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taps: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    tapQueue.unshift(...batch);
  }
}

// ─── Shared view ───────────────────────────────────────────────────────────────

function showSharedView() {
  authViewEl.hidden = true;
  homeViewEl.hidden = true;
  detailViewEl.hidden = true;
  sharedViewEl.hidden = false;
  sharedNameEl.textContent = sharedSession.name;
  sharedCountEl.textContent = sharedSession.count;
  sharedDotEl.style.setProperty("--accent-color", accentFor(sharedSession.counterId));
  requestAnimationFrame(() => sharedNameEl.focus());
}

async function enterSharedView(profileId, counterId, name) {
  syncDisconnect();
  sharedSession = { profileId, counterId, name, count: 0 };
  showSharedView();
  syncConnect();
  startSyncTimer();
  wsJoinCounter(counterId);

  try {
    const res = await fetch(
      `/api/counter/${encodeURIComponent(profileId)}/${encodeURIComponent(counterId)}`
    );
    if (res.ok) {
      const { counter } = await res.json();
      if (sharedSession && sharedSession.counterId === counterId) {
        sharedSession.count = counter.count;
        sharedCountEl.textContent = counter.count;
      }
    }
  } catch {}
}

function exitSharedView() {
  if (sharedSession) wsLeaveCounter(sharedSession.counterId);
  flushTapQueue();
  syncDisconnect();
  sharedSession = null;
}

async function sharedTap(delta) {
  if (!sharedSession) return;
  const at = Date.now();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  sharedSession.count += delta;
  sharedCountEl.textContent = sharedSession.count;
  pulseElement(sharedCountEl);
  enqueueTap(sharedSession.counterId, sharedSession.name, delta, at, tz);
}

function applySharedTap({ counterId, delta, at, count }) {
  const key = `${counterId}:${at}`;
  if (sentTapKeys.has(key)) { sentTapKeys.delete(key); return; }
  if (!sharedSession || sharedSession.counterId !== counterId) return;
  sharedSession.count = count;
  sharedCountEl.textContent = count;
  pulseElement(sharedCountEl);
}

function applyPresence({ counterId, viewers }) {
  const teammates = viewers - 1; // subtract self
  const text = teammates <= 0 ? "" : teammates === 1 ? "1 teammate here" : `${teammates} teammates here`;
  const isActive = teammates > 0;

  const route = currentRoute();
  if (route.view === "detail" && route.id === counterId && detailPresenceEl) {
    detailPresenceEl.textContent = text;
    detailPresenceEl.hidden = !text;
    detailPresenceEl.classList.toggle("active", isActive);
  }
  if (sharedSession?.counterId === counterId && sharedPresenceEl) {
    sharedPresenceEl.textContent = text;
    sharedPresenceEl.hidden = !text;
    sharedPresenceEl.classList.toggle("active", isActive);
  }
}

function applySharedState(serverCounters) {
  if (!sharedSession || !Array.isArray(serverCounters)) return;
  const sc = serverCounters.find((c) => c.id === sharedSession.counterId);
  if (!sc) return;
  sharedSession.count = sc.count;
  sharedCountEl.textContent = sc.count;
}

// ─── Synced tap / state from another device ────────────────────────────────────

function applySyncedTap({ counterId, delta, at, count, tz }) {
  const key = `${counterId}:${at}`;
  if (sentTapKeys.has(key)) { sentTapKeys.delete(key); return; }

  const c = counters.find((item) => item.id === counterId);
  if (!c) return;

  c.count = count;
  if (c.history) {
    c.history.push({ delta, at, ...(tz ? { tz } : {}) });
    if (c.history.length > HISTORY_STORE_LIMIT) {
      c.history.splice(0, c.history.length - HISTORY_STORE_LIMIT);
    }
  }

  const route = currentRoute();
  if (route.view === "detail" && route.id === counterId) {
    updateDetailCount(c);
    if (c.history) prependHistoryEntry(c.history[c.history.length - 1], c.history.length);
  } else {
    const countEl = counterElements.get(counterId)?.querySelector(".counter-count");
    if (countEl) { countEl.textContent = c.count; pulseElement(countEl); }
  }
}

function applySyncedState(serverCounters) {
  if (!Array.isArray(serverCounters) || serverCounters.length === 0) return;
  let hasUnknown = false;
  for (const sc of serverCounters) {
    const c = counters.find((item) => item.id === sc.id);
    if (!c) { hasUnknown = true; continue; }
    if (c.count !== sc.count) {
      c.count = sc.count;
      const countEl = counterElements.get(c.id)?.querySelector(".counter-count");
      if (countEl) { countEl.textContent = c.count; pulseElement(countEl); }
    }
  }
  // An unknown counter means another device created one — re-fetch and rebuild.
  if (hasUnknown) fetchCounters().then(() => renderHome());
}

// ─── Background flush ──────────────────────────────────────────────────────────

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushTapQueue();
});

window.addEventListener("beforeunload", () => {
  if (tapQueue.length > 0 && effectiveProfileId()) {
    const blob = new Blob([JSON.stringify({ taps: tapQueue })], { type: "application/json" });
    navigator.sendBeacon?.("/api/taps", blob);
  }
});

window.addEventListener("hashchange", () => renderApp({ moveFocus: true }));

// ─── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await fetchCurrentUser();

  if (currentUser) {
    await fetchCounters();
    syncConnect();
    startSyncTimer();
  }

  // Clean up Stripe checkout redirect param.
  const params = new URLSearchParams(location.search);
  if (params.get("checkout") === "success") {
    history.replaceState({}, "", location.pathname + location.hash);
  }

  renderApp();
})();
