// app.js — UI layer.  All pure data/storage functions live in counters.js and
// are available here as browser globals (META_KEY, storageKey, loadCounters,
// saveCounters, loadMeta, saveMeta, migrateIfNeeded, accentFor, formatTime,
// hashPIN, ACCENT_COLORS, HISTORY_DISPLAY_LIMIT, HISTORY_STORE_LIMIT).

// sessionStorage key for the currently unlocked profile in this tab.
// sessionStorage is tab-scoped and clears when the tab closes, so the unlock
// state never carries over to a new browsing session on a shared machine.
const SESSION_KEY = "tally.session";
const META_LOCK_NAME = "tally.meta.lock";

// Which profile is currently unlocked in this tab. null = profile screen shown.
let activeProfileId = null;

/** @type {{id: string, name: string, count: number, history: {delta: number, at: number}[]}[]} */
let counters = [];

// Tracks the counter ID last opened in detail view so focus can return to its
// list item when the user navigates back.
let lastDetailId = null;

// --- DOM refs: home / detail ---

const homeViewEl = document.getElementById("home-view");
const listEl = document.getElementById("counter-list");
const emptyStateEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("counter-summary");
const formEl = document.getElementById("new-counter-form");
const nameInputEl = document.getElementById("new-counter-name");
const templateEl = document.getElementById("counter-template");

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

// --- DOM refs: profile view ---

const profileViewEl = document.getElementById("profile-view");
const profileListScreenEl = document.getElementById("profile-list-screen");
const profileListEl = document.getElementById("profile-list");
const profileEmptyEl = document.getElementById("profile-empty");
const newProfileBtnEl = document.getElementById("new-profile-btn");
const profileTemplateEl = document.getElementById("profile-template");

const profileCreateScreenEl = document.getElementById("profile-create-screen");
const createCancelLinkEl = document.getElementById("create-cancel-link");
const profileCreateFormEl = document.getElementById("profile-create-form");
const profileNameInputEl = document.getElementById("profile-name-input");
const profilePinInputEl = document.getElementById("profile-pin-input");
const profileCreateErrorEl = document.getElementById("profile-create-error");

const profileUnlockScreenEl = document.getElementById("profile-unlock-screen");
const unlockCancelLinkEl = document.getElementById("unlock-cancel-link");
const unlockDotEl = document.getElementById("unlock-dot");
const unlockProfileNameEl = document.getElementById("unlock-profile-name");
const profileUnlockFormEl = document.getElementById("profile-unlock-form");
const profileUnlockPinEl = document.getElementById("profile-unlock-pin");
const profileUnlockErrorEl = document.getElementById("profile-unlock-error");

const activeProfileLabelEl = document.getElementById("active-profile-label");
const lockBtnEl = document.getElementById("lock-btn");
const detailLockBtnEl = document.getElementById("detail-lock-btn");

// --- Storage helpers ---

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
// page-load snapshot. Locks API has near-universal support in evergreen
// browsers on secure contexts (https, or localhost); where unavailable we
// fall back to just re-reading fresh each time, which is not a hard
// guarantee under literally simultaneous clicks but removes the dominant,
// deterministic form of the bug (a tab clobbering another tab's earlier
// write with a stale full-array snapshot).

function withStorageLock(fn) {
  // Use a per-profile lock name so two profiles tapping simultaneously don't
  // contend with each other.
  const lockName = activeProfileId
    ? storageKey(activeProfileId) + ".lock"
    : "tally.counters.lock";
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(lockName, () => fn());
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
    counters = loadCounters(activeProfileId);
    const snapshot = JSON.stringify(counters);
    const result = mutator();
    try {
      saveCounters(activeProfileId, counters);
      setStorageWarning(false);
    } catch (err) {
      counters = JSON.parse(snapshot);
      setStorageWarning(true);
      throw err;
    }
    return result;
  });
}

function withMetaLock(fn) {
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(META_LOCK_NAME, () => fn());
  }
  return Promise.resolve().then(fn);
}

// Mutates the profile registry atomically, parallel to mutateCounters.
// `mutator` receives the meta object and modifies it in place.
function mutateMeta(mutator) {
  return withMetaLock(() => {
    const meta = loadMeta();
    const result = mutator(meta);
    saveMeta(meta);
    return result;
  });
}

// --- Session management ---

function getSession() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}

function setSession(profileId) {
  try { sessionStorage.setItem(SESSION_KEY, profileId); } catch { /* unavailable */ }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* unavailable */ }
}

// --- Profile activation ---

function activateProfile(profileId) {
  activeProfileId = profileId;
  setSession(profileId);
  counters = loadCounters(activeProfileId);
}

function handleLock() {
  clearSession();
  activeProfileId = null;
  counters = [];
  location.hash = "";
  renderApp();
}

// --- Profile view sub-screens ---

function showProfileListScreen() {
  profileListScreenEl.hidden = false;
  profileCreateScreenEl.hidden = true;
  profileUnlockScreenEl.hidden = true;
  renderProfileList();
  requestAnimationFrame(() => {
    const first = profileListEl.querySelector(".profile-select-btn");
    (first || newProfileBtnEl).focus();
  });
}

function showProfileCreateScreen() {
  profileListScreenEl.hidden = true;
  profileCreateScreenEl.hidden = false;
  profileUnlockScreenEl.hidden = true;
  profileCreateErrorEl.hidden = true;
  profileNameInputEl.value = "";
  profilePinInputEl.value = "";
  requestAnimationFrame(() => profileNameInputEl.focus());
}

function showUnlockScreen(profileId) {
  const meta = loadMeta();
  const profile = meta.profiles.find((p) => p.id === profileId);
  if (!profile) { showProfileListScreen(); return; }

  profileListScreenEl.hidden = true;
  profileCreateScreenEl.hidden = true;
  profileUnlockScreenEl.hidden = false;
  profileUnlockScreenEl.dataset.profileId = profileId;
  unlockDotEl.style.setProperty("--accent-color", accentFor(profile.id));
  unlockProfileNameEl.textContent = profile.name;
  profileUnlockPinEl.value = "";
  profileUnlockErrorEl.hidden = true;
  requestAnimationFrame(() => profileUnlockPinEl.focus());
}

function renderProfileList() {
  const meta = loadMeta();
  profileListEl.innerHTML = "";
  profileEmptyEl.hidden = meta.profiles.length > 0;

  for (const profile of meta.profiles) {
    const node = profileTemplateEl.content.cloneNode(true);
    const btn = node.querySelector(".profile-select-btn");
    const dot = node.querySelector(".counter-dot");
    const nameEl = node.querySelector(".profile-item-name");
    const lockEl = node.querySelector(".profile-lock-indicator");

    dot.style.setProperty("--accent-color", accentFor(profile.id));
    nameEl.textContent = profile.name;
    btn.dataset.profileId = profile.id;

    if (profile.pinHash) {
      lockEl.hidden = false;
      btn.setAttribute("aria-label", `${profile.name} — PIN protected`);
    } else {
      lockEl.hidden = true;
    }

    profileListEl.appendChild(node);
  }
}

// --- Routing / main render ---

function currentRoute() {
  const match = location.hash.match(/^#\/counter\/(.+)$/);
  if (match) return { view: "detail", id: decodeURIComponent(match[1]) };
  return { view: "home" };
}

// moveFocus should be true only on deliberate user-driven navigations (hash
// change), not on initial page load or cross-tab storage syncs.
function renderApp({ moveFocus = false } = {}) {
  if (!activeProfileId) {
    homeViewEl.hidden = true;
    detailViewEl.hidden = true;
    profileViewEl.hidden = false;
    showProfileListScreen();
    return;
  }

  profileViewEl.hidden = true;

  // Keep the profile label in the home-view header current.
  if (activeProfileLabelEl) {
    const meta = loadMeta();
    const profile = meta.profiles.find((p) => p.id === activeProfileId);
    activeProfileLabelEl.textContent = profile ? profile.name : "";
  }

  const route = currentRoute();

  if (route.view === "detail" && counters.some((c) => c.id === route.id)) {
    lastDetailId = route.id;
    homeViewEl.hidden = true;
    detailViewEl.hidden = false;
    renderDetail(route.id);
    if (moveFocus) detailNameEl.focus();
  } else {
    detailViewEl.hidden = true;
    homeViewEl.hidden = false;
    renderHome();
    if (moveFocus && lastDetailId) {
      // Return focus to the counter's list item link, or fall back to the first
      // counter or the new-counter input if the counter was just deleted.
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
    node.querySelector(".decrement").setAttribute("aria-label", `Decrement ${counter.name}`);
    node.querySelector(".increment").setAttribute("aria-label", `Increment ${counter.name}`);
    node.querySelector(".remove").setAttribute("aria-label", `Delete ${counter.name}`);
    listEl.appendChild(node);
  }
}

async function addCounter(name) {
  name = name.trim();
  if (!name) return { ok: false, reason: "empty" };

  let outcome;
  try {
    outcome = await mutateCounters(() => {
      const lower = name.toLowerCase();
      if (counters.some((c) => c.name.toLowerCase() === lower)) {
        return { ok: false, reason: "duplicate" };
      }
      counters.push({ id: crypto.randomUUID(), name, count: 0, history: [] });
      return { ok: true };
    });
  } catch {
    return { ok: false, reason: "error" };
  }

  if (!outcome.ok) return outcome;

  renderHome();
  const newLi = listEl.lastElementChild;
  if (newLi) {
    newLi.classList.add("counter-enter");
    newLi.addEventListener("animationend", () => newLi.classList.remove("counter-enter"), { once: true });
  }
  return { ok: true };
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

// --- Event wiring: profile view ---

profileListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".profile-select-btn");
  if (!btn) return;
  const profileId = btn.dataset.profileId;
  const meta = loadMeta();
  const profile = meta.profiles.find((p) => p.id === profileId);
  if (!profile) return;

  if (profile.pinHash) {
    showUnlockScreen(profileId);
  } else {
    activateProfile(profileId);
    renderApp();
  }
});

newProfileBtnEl.addEventListener("click", () => showProfileCreateScreen());

createCancelLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  showProfileListScreen();
});

profileCreateFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = profileNameInputEl.value.trim();
  if (!name) return;

  const meta = loadMeta();
  if (meta.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    profileCreateErrorEl.textContent = "A profile with that name already exists.";
    profileCreateErrorEl.hidden = false;
    profileNameInputEl.select();
    return;
  }

  const pin = profilePinInputEl.value;
  if (pin && !/^\d{4}$/.test(pin)) {
    profileCreateErrorEl.textContent = "PIN must be exactly 4 digits (0–9).";
    profileCreateErrorEl.hidden = false;
    profilePinInputEl.select();
    return;
  }

  profileCreateErrorEl.hidden = true;

  const profileId = crypto.randomUUID();
  const pinHash = pin ? await hashPIN(pin, profileId) : null;

  await mutateMeta((meta) => {
    meta.profiles.push({ id: profileId, name, pinHash });
  });

  activateProfile(profileId);
  renderApp();
});

profileNameInputEl.addEventListener("input", () => { profileCreateErrorEl.hidden = true; });
profilePinInputEl.addEventListener("input", () => { profileCreateErrorEl.hidden = true; });

unlockCancelLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  showProfileListScreen();
});

profileUnlockFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const profileId = profileUnlockScreenEl.dataset.profileId;
  const pin = profileUnlockPinEl.value;

  const meta = loadMeta();
  const profile = meta.profiles.find((p) => p.id === profileId);
  if (!profile) { showProfileListScreen(); return; }

  const entered = await hashPIN(pin, profileId);
  if (entered !== profile.pinHash) {
    profileUnlockErrorEl.textContent = "Incorrect PIN. Try again.";
    profileUnlockErrorEl.hidden = false;
    profileUnlockPinEl.value = "";
    profileUnlockPinEl.focus();
    return;
  }

  profileUnlockErrorEl.hidden = true;
  activateProfile(profileId);
  renderApp();
});

profileUnlockPinEl.addEventListener("input", () => {
  profileUnlockErrorEl.hidden = true;
  // Auto-submit as soon as 4 digits are entered so the user doesn't have to
  // press Unlock or hit Enter.
  if (profileUnlockPinEl.value.length === 4) {
    profileUnlockFormEl.requestSubmit();
  }
});

// --- Event wiring: lock ---

if (lockBtnEl) lockBtnEl.addEventListener("click", handleLock);
if (detailLockBtnEl) detailLockBtnEl.addEventListener("click", handleLock);

// --- Event wiring: home view ---

const nameErrorEl = document.getElementById("name-error");

function showNameError(msg) {
  nameErrorEl.textContent = msg;
  nameErrorEl.hidden = false;
}

function clearNameError() {
  nameErrorEl.hidden = true;
  nameErrorEl.textContent = "";
}

nameInputEl.addEventListener("input", clearNameError);

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = nameInputEl.value.trim();
  if (!name) return;
  const result = await addCounter(name);
  if (!result.ok) {
    if (result.reason === "duplicate") {
      showNameError("A counter with that name already exists.");
      nameInputEl.select();
    }
    return;
  }
  clearNameError();
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
    li.classList.add("confirming");
    li.querySelector(".confirm-cancel-btn").focus();
  } else if (e.target.closest(".confirm-cancel-btn")) {
    li.classList.remove("confirming");
    li.querySelector(".remove").focus();
  } else if (e.target.closest(".confirm-delete-btn")) await removeCounter(id);
  // .counter-name is a plain <a href="#/counter/..."> — let it navigate natively.
});

// --- Event wiring: detail view ---

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
  deleteCancelBtnEl.focus();
});

deleteCancelBtnEl.addEventListener("click", () => {
  deleteConfirmEl.hidden = true;
  deleteBtnEl.hidden = false;
  deleteBtnEl.focus();
});

deleteConfirmBtnEl.addEventListener("click", async () => {
  const { id } = currentRoute();
  if (id) await removeCounter(id);
  location.hash = "";
});

// --- Cross-tab sync ---

window.addEventListener("hashchange", () => renderApp({ moveFocus: true }));

// Another tab changed the data — pick up its write immediately instead of
// showing a stale count until this tab does its own mutation or the page
// is reloaded.
window.addEventListener("storage", (e) => {
  // Counter data changed in another tab for the currently active profile.
  if (activeProfileId && e.key === storageKey(activeProfileId)) {
    counters = loadCounters(activeProfileId);
    renderApp();
    return;
  }
  // Profile list changed in another tab (e.g. a new profile was created).
  if (e.key === META_KEY && !activeProfileId) {
    renderProfileList();
  }
});

// --- Boot ---
// Run the legacy migration first (wrapped in the meta lock so two tabs can't
// both create a migration profile), then restore the tab session (if any)
// before the first render.

(async () => {
  await withMetaLock(() => migrateIfNeeded());

  const sessionId = getSession();
  if (sessionId) {
    const meta = loadMeta();
    if (meta.profiles.some((p) => p.id === sessionId)) {
      activeProfileId = sessionId;
      counters = loadCounters(activeProfileId);
    }
  } else {
    // Auto-login when there is exactly one PIN-free profile — the common case
    // after a fresh install or after migrating a single-user setup.
    const meta = loadMeta();
    if (meta.profiles.length === 1 && !meta.profiles[0].pinHash) {
      activateProfile(meta.profiles[0].id);
    }
  }

  renderApp();
})();
