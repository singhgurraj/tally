// dashboard.js — Chart rendering and CSV export for the Dashboard view.
// Loaded after counters.js (accentFor available as a global) and before app.js.
// Chart.js is loaded via script tag before this file.

let _activityChart = null;
let _totalsChart = null;

// Build N day-buckets (in local time) ending today.
function _makeBuckets(nDays) {
  const buckets = [];
  const today = new Date();
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    buckets.push({
      label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      start: d.getTime(),
      end: d.getTime() + 86400000,
    });
  }
  return buckets;
}

// Sum positive deltas in each bucket for one counter's history.
function _tapsPerBucket(history, buckets) {
  const sums = new Array(buckets.length).fill(0);
  for (const { delta, at } of history) {
    if (delta <= 0) continue;
    for (let i = 0; i < buckets.length; i++) {
      if (at >= buckets[i].start && at < buckets[i].end) {
        sums[i] += delta;
        break;
      }
    }
  }
  return sums;
}

function _isDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function _palette() {
  const dark = _isDark();
  return {
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    tick: dark ? '#97979f' : '#74747c',
    text: dark ? '#f1f1f1' : '#1a1a1a',
  };
}

function _renderActivityChart(counters, days) {
  const buckets = _makeBuckets(days);
  const { grid, tick, text } = _palette();
  const isSingle = counters.length === 1;

  const datasets = counters.map(c => {
    const color = accentFor(c.id);
    return {
      label: c.name,
      data: _tapsPerBucket(c.history, buckets),
      borderColor: color,
      backgroundColor: color + (isSingle ? '30' : '18'),
      borderWidth: 2,
      pointRadius: days <= 7 ? 4 : 2,
      pointHoverRadius: 6,
      tension: 0.35,
      fill: isSingle,
    };
  });

  if (_activityChart) _activityChart.destroy();
  const ctx = document.getElementById('activity-chart').getContext('2d');
  _activityChart = new Chart(ctx, {
    type: 'line',
    data: { labels: buckets.map(b => b.label), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: !isSingle,
          labels: { color: text, boxWidth: 12, padding: 16, font: { size: 12 } },
        },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: {
          grid: { color: grid },
          ticks: { color: tick, maxRotation: days > 14 ? 45 : 0, font: { size: 11 } },
        },
        y: {
          grid: { color: grid },
          ticks: { color: tick, stepSize: 1, font: { size: 11 } },
          beginAtZero: true,
        },
      },
    },
  });
}

function _renderTotalsChart(counters) {
  const { grid, tick } = _palette();
  // Dynamic height: at least 120 px, 44 px per counter bar.
  const wrapEl = document.getElementById('totals-chart-wrap');
  wrapEl.style.height = Math.max(120, counters.length * 44) + 'px';

  const colors = counters.map(c => accentFor(c.id));

  if (_totalsChart) _totalsChart.destroy();
  const ctx = document.getElementById('totals-chart').getContext('2d');
  _totalsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: counters.map(c => c.name),
      datasets: [{
        data: counters.map(c => Math.max(0, c.count)),
        backgroundColor: colors.map(c => c + 'cc'),
        borderColor: colors,
        borderWidth: 1.5,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { color: grid },
          ticks: { color: tick, stepSize: 1, font: { size: 11 } },
          beginAtZero: true,
        },
        y: {
          grid: { display: false },
          ticks: { color: tick, font: { size: 12 } },
        },
      },
    },
  });
}

// Public: rebuild charts for `counters` over `days` days.
// Called from app.js whenever the dashboard view is shown or range changes.
function renderDashboard(counters, days) {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.days) === days);
  });

  const hasCounters = counters.length > 0;
  document.getElementById('activity-chart-card').hidden = !hasCounters;
  document.getElementById('totals-chart-card').hidden = !hasCounters;
  document.getElementById('dashboard-empty').hidden = hasCounters;
  document.getElementById('export-data-btn').disabled = !hasCounters;

  if (!hasCounters) {
    if (_activityChart) { _activityChart.destroy(); _activityChart = null; }
    if (_totalsChart) { _totalsChart.destroy(); _totalsChart = null; }
    return;
  }

  _renderActivityChart(counters, days);
  _renderTotalsChart(counters);
}

// Public: export all counter data as a versioned JSON file suitable for
// re-import.  Preserves exact timestamps and timezone strings so history
// survives a full export → import round-trip without data loss.
function exportData(counters) {
  const payload = {
    version: 1,
    exportedAt: Date.now(),
    counters: counters.map(c => ({
      name: c.name,
      history: (c.history || []).map(({ delta, at, tz }) => {
        const entry = { delta, at };
        if (tz) entry.tz = tz;
        return entry;
      }),
    })),
  };

  const json = JSON.stringify(payload, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `tally-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
