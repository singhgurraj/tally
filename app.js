const STORAGE_KEY = "tally.counters";

/** @type {{id: string, name: string, count: number}[]} */
let counters = loadCounters();

const listEl = document.getElementById("counter-list");
const emptyStateEl = document.getElementById("empty-state");
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

function render() {
  listEl.innerHTML = "";
  emptyStateEl.hidden = counters.length > 0;

  for (const counter of counters) {
    const node = templateEl.content.cloneNode(true);
    const li = node.querySelector(".counter");
    li.dataset.id = counter.id;
    node.querySelector(".counter-name").textContent = counter.name;
    node.querySelector(".counter-count").textContent = counter.count;
    listEl.appendChild(node);
  }
}

function addCounter(name) {
  counters.push({ id: crypto.randomUUID(), name, count: 0 });
  saveCounters();
  render();
}

function changeCount(id, delta) {
  const counter = counters.find((c) => c.id === id);
  if (!counter) return;
  counter.count += delta;
  saveCounters();
  render();
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
