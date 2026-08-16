const STORAGE_KEY = "tally.counters";

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

function loadCounters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return parsed.map((c) => ({ history: [], ...c }));
  } catch {
    return [];
  }
}

function saveCounters() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(counters));
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

function addCounter(name) {
  counters.push({ id: crypto.randomUUID(), name, count: 0, history: [] });
  saveCounters();
  renderHome();

  const newLi = listEl.lastElementChild;
  if (newLi) {
    newLi.classList.add("counter-enter");
    newLi.addEventListener("animationend", () => newLi.classList.remove("counter-enter"), { once: true });
  }
}

function removeCounter(id) {
  counters = counters.filter((c) => c.id !== id);
  saveCounters();
  renderHome();
}

// --- Shared count logic ---

function changeCount(id, delta) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  counter.count += delta;
  counter.history.push({ delta, at: Date.now() });
  saveCounters();

  const route = currentRoute();
  if (route.view === "detail" && route.id === id) {
    updateDetailCount(counter);
    renderHistory(counter);
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
}

function updateDetailCount(counter) {
  detailCountEl.textContent = counter.count;
  pulseElement(detailCountEl);
}

function renderHistory(counter) {
  historyListEl.innerHTML = "";
  historyEmptyEl.hidden = counter.history.length > 0;

  const entries = [...counter.history].reverse();
  for (const entry of entries) {
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
    historyListEl.appendChild(li);
  }
}

// --- Event wiring ---

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInputEl.value.trim();
  if (!name) return;
  addCounter(name);
  nameInputEl.value = "";
  nameInputEl.focus();
});

listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".counter");
  if (!li) return;
  const id = li.dataset.id;

  if (e.target.closest(".increment")) changeCount(id, 1);
  else if (e.target.closest(".decrement")) changeCount(id, -1);
  else if (e.target.closest(".remove")) removeCounter(id);
  // .counter-name is a plain <a href="#/counter/..."> — let it navigate natively.
});

detailIncrementEl.addEventListener("click", () => {
  const { id } = currentRoute();
  if (id) changeCount(id, 1);
});

detailDecrementEl.addEventListener("click", () => {
  const { id } = currentRoute();
  if (id) changeCount(id, -1);
});

backLinkEl.addEventListener("click", (e) => {
  e.preventDefault();
  location.hash = "";
});

window.addEventListener("hashchange", renderApp);

renderApp();
