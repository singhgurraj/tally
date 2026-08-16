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

/** @type {{id: string, name: string, count: number}[]} */
let counters = loadCounters();

const listEl = document.getElementById("counter-list");
const emptyStateEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("counter-summary");
const formEl = document.getElementById("new-counter-form");
const nameInputEl = document.getElementById("new-counter-name");
const templateEl = document.getElementById("counter-template");

function loadCounters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
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

function render() {
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
    node.querySelector(".counter-name").textContent = counter.name;
    node.querySelector(".counter-count").textContent = counter.count;
    listEl.appendChild(node);
  }
}

function addCounter(name) {
  counters.push({ id: crypto.randomUUID(), name, count: 0 });
  saveCounters();
  render();

  const newLi = listEl.lastElementChild;
  if (newLi) {
    newLi.classList.add("counter-enter");
    newLi.addEventListener("animationend", () => newLi.classList.remove("counter-enter"), { once: true });
  }
}

function changeCount(id, delta) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  counter.count += delta;
  saveCounters();

  const li = listEl.querySelector(`.counter[data-id="${id}"]`);
  const countEl = li?.querySelector(".counter-count");
  if (countEl) {
    countEl.textContent = counter.count;
    countEl.classList.remove("pulse");
    // Force reflow so the animation restarts on rapid clicks.
    void countEl.offsetWidth;
    countEl.classList.add("pulse");
  }
}

function removeCounter(id) {
  counters = counters.filter((c) => c.id !== id);
  saveCounters();
  render();
}

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
});

render();
