import {
  analyze, bootstrap, dailyGrid, fitCapabilities, gapTrend, FRONTIER_MODES, fromYear, groupLags, releaseGrid, toYear,
} from "./core.js";

const GROUPS = [
  { key: "US closed", color: "--series-1", symbol: "circle", svg: "circle" },
  { key: "China", color: "--series-2", symbol: "diamond", svg: "diamond" },
  { key: "Open weights (non-China)", color: "--series-3", symbol: "square", svg: "square" },
  { key: "Other", color: "--series-other", symbol: "circle-open", svg: "ring" },
];
const LAG_GROUPS = GROUPS.slice(0, 3).map((g) => g.key);

// Labs offered in the "By lab" view. Each keeps a fixed color, so toggling others never
// repaints it. A lab's color is a shade of the group most of its models belong to, so blue
// still reads as US closed; within a group, labs also differ by line pattern. (Labs do cross
// groups, e.g. OpenAI's gpt-oss; the marker shape shows each model's own group.)
// These have the most frontier-level models (Z.ai and Mistral, next in line, are left out).
const LABS = [
  { key: "OpenAI", color: "--lab-1", dash: "solid" },
  { key: "Anthropic", color: "--lab-2", dash: "dash" },
  { key: "Google DeepMind", color: "--lab-3", dash: "solid" },
  { key: "xAI", color: "--lab-4", dash: "dot" },
  { key: "Meta AI", color: "--lab-5", dash: "solid" },
  { key: "DeepSeek", color: "--lab-6", dash: "solid" },
  { key: "Alibaba", color: "--lab-7", dash: "dash" },
  { key: "Moonshot", color: "--lab-8", dash: "solid" },
];
// SVG equivalents of Plotly's dash names, for the legend chips.
const DASH_SVG = { solid: "", dash: "5 3", dot: "1.5 3" };

// Frontier curves offered on the site (core.js also has "linear" and "broken", kept for the CLI).
const MODE_SHORT = { step: "Running max", interp: "Interpolated" };

const state = {
  data: null,
  selected: new Set(),
  mode: "interp",
  minBench: 2,
  lagUnit: "months",
  showTrend: true,
  scatterView: "leaders", // "leaders": each group's record-setters; "labs": each lab's record-setters; "all": every model
  labsOn: new Set(["OpenAI", "Anthropic", "Google DeepMind", "DeepSeek", "Moonshot"]),
  result: null,
  lags: null,
  grid: null,
  ci: null,
  sort: { key: "fdate", dir: -1 },
  filter: "",
  showCI: false,
};

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const groupMeta = (key) => GROUPS.find((g) => g.key === key) ?? GROUPS[3];
const isoOf = (t) => fromYear(t);
const monthLabel = (t) => new Date(fromYear(t)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const flagMark = (f) => (f ? "*" : "");

// ---------- boot ----------

async function main() {
  const resp = await fetch("data/frontier_clock.json");
  state.data = await resp.json();
  state.data.models.forEach((m) => {
    m._t = toYear(m.date);
    // Epoch sometimes lists aliases of one lab ("Google DeepMind,Google"); show the lab once.
    m.org = [...new Set(m.org.split(",").map((o) => LAB_ALIASES[o.trim()] ?? o.trim()).filter(Boolean))].join(", ");
  });
  state.data.benchmarks.forEach((_, i) => state.selected.add(i));
  $("credit").textContent = state.data.retrieved ? `Data retrieved ${state.data.retrieved}.` : "";
  buildControls();
  recompute();
  renderHeadline();
  // After a resize, redraw the charts that adapt to their width (labels, tick counts), then
  // have Plotly re-measure every chart: a redraw alone keeps the old width.
  let resizeTimer = null, lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return; // ignore mobile address-bar height changes
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.result) { renderScatter(); renderLabs(); }
      document.querySelectorAll(".chart").forEach((el) => Plotly.Plots.resize(el));
    }, 150);
  });
}

// Hero headline: today's gaps under the default settings, independent of the controls.
async function renderHeadline() {
  const { data } = state;
  const mode = "interp", minBench = 2;
  const res = analyze(data, data.benchmarks.map((_, i) => i), mode, { minBenchmarks: minBench });
  if (!res.frontier) return;
  const grid = releaseGrid(data);
  const lags = groupLags(res.rows, LAG_GROUPS, grid);
  // Coverage counts in the Method section: the full dataset, whatever the selection.
  $("cov-models").textContent = res.rows.filter((r) => !isBeforeCoverage(r)).length;
  $("cov-benches").textContent = data.benchmarks.length;
  $("cov-scores").textContent = res.fit.nObs.toLocaleString("en-US");
  const el = $("hero-stats");
  const div = (cls, text) => { const e = document.createElement("div"); e.className = cls; if (text != null) e.textContent = text; return e; };
  el.replaceChildren();
  const LEADS = { "China": "China is behind by", "Open weights (non-China)": "Non-China open weights are behind by" };
  const ciSlots = [];
  for (const g of GROUPS.slice(1, 3)) {
    const p = lags[g.key]?.at(-1);
    if (!p) continue;
    const item = div("item");
    item.style.borderColor = css(g.color);
    const best = div("muted", `best: ${p.best}`);
    ciSlots.push({ g: g.key, T: p.T, el: best });
    item.append(div("lead", LEADS[g.key] ?? `${g.key} is behind by`), div("value", `${p.lagMonths.toFixed(1)} months`), best);
    el.append(item);
  }
  // 90% interval after the best model's name, from the precomputed default run.
  const run = (await loadIntervals())?.runs[`all|${mode}|${minBench}`];
  for (const { g, T, el: best } of ciSlots) {
    const pt = run?.lags[g]?.at(-1);
    if (pt && Math.abs(toYear(pt[0]) - T) < 0.01) best.textContent += ` · 90% CI ${pt[1].toFixed(1)}–${pt[2].toFixed(1)} mo`;
  }
}

// ---------- controls ----------

// Display names for domains whose data key reads poorly (keys stay as-is for intervals.json).
const DOMAIN_LABELS = { Unclassified: "Other (unclassified)" };
const domainLabel = (d) => DOMAIN_LABELS[d] ?? d;
const domainIds = (d) => state.data.benchmarks.map((b, i) => (b.domain === d ? i : -1)).filter((i) => i >= 0);
const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function buildControls() {
  const { data } = state;

  // Benchmarks dropdown: one row per domain (tri-state), expandable to its benchmarks.
  const list = $("domain-list");
  for (const d of data.domains) {
    const ids = domainIds(d);
    if (!ids.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "dd-domain";
    const row = document.createElement("div");
    row.className = "dd-row";
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.domain = d;
    cb.addEventListener("change", () => {
      ids.forEach((i) => (cb.checked ? state.selected.add(i) : state.selected.delete(i)));
      settingsChanged();
    });
    const name = document.createElement("span");
    name.textContent = domainLabel(d);
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = ids.length;
    label.append(cb, name, n);
    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "dd-expand";
    exp.setAttribute("aria-expanded", "false");
    exp.setAttribute("aria-label", `Show ${domainLabel(d)} benchmarks`);
    exp.innerHTML = CHEVRON;
    const benches = document.createElement("div");
    benches.className = "dd-benches";
    benches.hidden = true;
    exp.addEventListener("click", () => {
      benches.hidden = !benches.hidden;
      exp.setAttribute("aria-expanded", String(!benches.hidden));
    });
    for (const i of ids) {
      const b = data.benchmarks[i];
      const bl = document.createElement("label");
      bl.className = "dd-bench";
      const bcb = document.createElement("input");
      bcb.type = "checkbox";
      bcb.dataset.bench = i;
      bcb.addEventListener("change", () => {
        bcb.checked ? state.selected.add(i) : state.selected.delete(i);
        settingsChanged();
      });
      const bn = document.createElement("span");
      bn.textContent = b.name;
      const bc = document.createElement("span");
      bc.className = "n";
      bc.textContent = `${b.nModels} models`;
      bl.append(bcb, bn, bc);
      benches.append(bl);
    }
    row.append(label, exp);
    wrap.append(row, benches);
    list.append(wrap);
  }
  const btn = $("domain-btn"), panel = $("domain-panel");
  const setOpen = (open) => { panel.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", () => setOpen(panel.hidden));
  document.addEventListener("click", (e) => { if (!$("domain-dd").contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { setOpen(false); btn.focus(); } });
  $("sel-all").addEventListener("click", () => { data.benchmarks.forEach((_, i) => state.selected.add(i)); settingsChanged(); });
  $("sel-none").addEventListener("click", () => { state.selected.clear(); settingsChanged(); });

  const seg = $("mode-seg");
  for (const [k, label] of Object.entries(MODE_SHORT)) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.dataset.mode = k;
    b.textContent = label;
    b.title = FRONTIER_MODES[k];
    b.addEventListener("click", () => { state.mode = k; settingsChanged(); });
    seg.append(b);
  }

  const viewSeg = $("scatter-view");
  for (const [k, label] of [["leaders", "Group leaders"], ["labs", "By lab"], ["all", "All models"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.dataset.view = k;
    b.textContent = label;
    b.addEventListener("click", () => { state.scatterView = k; syncControls(); renderLegends(); renderScatter(); });
    viewSeg.append(b);
  }

  const lagSeg = $("lag-unit");
  for (const [k, label] of [["months", "Months"], ["cap", "Capability"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "radio";
    b.dataset.unit = k;
    b.textContent = label;
    b.addEventListener("click", () => { state.lagUnit = k; syncControls(); renderLag(); });
    lagSeg.append(b);
  }

  // Min. benchmarks menu (keep the options in sync with MIN_BENCH in cli/precompute_intervals.mjs).
  const mbBtn = $("minb-btn"), mbPanel = $("minb-panel");
  const mbOpts = [1, 2, 3, 5].map((n) => {
    const o = document.createElement("button");
    o.type = "button"; o.role = "option"; o.className = "dd-option"; o.dataset.n = n;
    o.textContent = n;
    o.addEventListener("click", () => { mbOpen(false); mbBtn.focus(); if (state.minBench !== n) { state.minBench = n; settingsChanged(); } });
    mbPanel.append(o);
    return o;
  });
  const mbOpen = (open) => {
    mbPanel.hidden = !open; mbBtn.setAttribute("aria-expanded", String(open));
    if (open) mbOpts.find((o) => Number(o.dataset.n) === state.minBench)?.focus();
  };
  mbBtn.addEventListener("click", () => mbOpen(mbPanel.hidden));
  document.addEventListener("click", (e) => { if (!$("minb-dd").contains(e.target)) mbOpen(false); });
  mbPanel.addEventListener("keydown", (e) => {
    const k = mbOpts.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mbOpts[(k + (e.key === "ArrowDown" ? 1 : mbOpts.length - 1)) % mbOpts.length].focus(); }
    if (e.key === "Escape" || e.key === "Tab") { mbOpen(false); if (e.key === "Escape") mbBtn.focus(); }
  });

  // Let a switch paint its new position before the (blocking) chart redraw.
  const afterPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  $("trend-toggle").addEventListener("change", (e) => { state.showTrend = e.target.checked; afterPaint().then(renderLag); });
  $("ci-toggle").addEventListener("change", (e) => { state.showCI = e.target.checked; afterPaint().then(updateIntervals); });
  $("search").addEventListener("input", (e) => { state.filter = e.target.value.toLowerCase(); renderTable(); });
  document.querySelectorAll("#model-table th").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "name" || key === "org" || key === "group" ? 1 : -1 };
      renderTable();
    }));
}

// Named selection ("all" or a single domain) for precomputed intervals, else null.
function selectionKey() {
  const { data, selected } = state;
  if (selected.size === data.benchmarks.length) return "all";
  for (const d of data.domains) {
    const ids = domainIds(d);
    if (ids.length && ids.length === selected.size && ids.every((i) => selected.has(i))) return d;
  }
  return null;
}

function selectionSummary() {
  const { data, selected } = state;
  const key = selectionKey();
  if (key === "all") return "All benchmarks";
  if (key) return domainLabel(key);
  if (!selected.size) return "None selected";
  const full = data.domains.filter((d) => { const ids = domainIds(d); return ids.length && ids.every((i) => selected.has(i)); });
  const coversExactly = full.reduce((n, d) => n + domainIds(d).length, 0) === selected.size;
  if (coversExactly && full.length <= 2) return full.map(domainLabel).join(" + ");
  if (coversExactly) return `${full.length} domains`;
  return `Custom · ${selected.size} benchmarks`;
}

function syncControls() {
  const { data } = state;
  document.querySelectorAll("#domain-list input[data-domain]").forEach((cb) => {
    const ids = domainIds(cb.dataset.domain);
    const on = ids.filter((i) => state.selected.has(i)).length;
    cb.checked = on === ids.length;
    cb.indeterminate = on > 0 && on < ids.length;
  });
  document.querySelectorAll("#domain-list input[data-bench]").forEach((cb) => (cb.checked = state.selected.has(Number(cb.dataset.bench))));
  $("domain-summary").textContent = selectionSummary();
  $("bench-count").textContent = `${state.selected.size} of ${data.benchmarks.length} benchmarks`;
  document.querySelectorAll("#mode-seg button").forEach((b) => b.setAttribute("aria-checked", b.dataset.mode === state.mode));
  $("minb-value").textContent = state.minBench;
  document.querySelectorAll("#minb-panel .dd-option").forEach((o) => o.setAttribute("aria-selected", Number(o.dataset.n) === state.minBench));
  document.querySelectorAll("#lag-unit button").forEach((b) => b.setAttribute("aria-checked", b.dataset.unit === state.lagUnit));
  document.querySelectorAll("#scatter-view button").forEach((b) => b.setAttribute("aria-checked", b.dataset.view === state.scatterView));
  const diagonal = " Each model along the diagonal was the world’s best model when it launched. The vertical gap between a model and the diagonal is how far behind that model was when it was released.";
  $("scatter-desc").textContent = "A model's frontier-equivalent date is the date when the frontier of AI models first reached that model’s capability. " +
    "For example, a model that reads “Mar 2025” was as good as the best model of March 2025, no matter when it was released. " + {
    leaders: "Each point is a model that has a higher score than every earlier model from its group.",
    labs: "Each point is a model that has a higher score than every earlier model from the same lab.",
    all: "Each point represents a model.",
  }[state.scatterView] + diagonal;
  $("mode-help").textContent = "Each point represents a specific model. The X-value is when that model was released, and the Y-value is the ECI-scaled capability score of that model. The black line is the frontier.";
  $("lag-desc").textContent = state.lagUnit === "months"
    ? "This graph visualizes the gap between the frontier, China, and non-China open weights, measured in time. Each point represents how many months earlier the frontier reached the same capabilities level as the best model available from that group at that moment in time."
    : "This graph visualizes the gap between the frontier, China, and non-China open weights, measured in ECI points (Claude 3.5 Sonnet = 130, GPT-5 = 150). Each point represents how many ECI points higher the frontier was than the best model available from that group at that moment in time.";
}

let recomputeTimer = null;
function settingsChanged() {
  state.ci = null;
  syncControls();
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 30);
}

// ---------- analysis ----------

function recompute() {
  syncControls();
  const ids = [...state.selected];
  if (!ids.length) {
    state.result = null;
    renderAll();
    return;
  }
  // Subsets are put on the all-benchmarks ECI scale (fit once, reused).
  const full = ids.length === state.data.benchmarks.length;
  if (!full && !state.reference) state.reference = fitCapabilities(state.data, state.data.benchmarks.map((_, i) => i)).capability;
  const res = analyze(state.data, ids, state.mode, { minBenchmarks: state.minBench, reference: full ? null : state.reference });
  state.result = res.frontier ? res : null;
  if (state.result) {
    // Gaps change only on release dates (state.grid, also used by the bootstrap);
    // the line is drawn per day so hovering moves one day at a time.
    state.grid = releaseGrid(state.data);
    state.dayGrid ??= dailyGrid(state.data);
    state.lags = groupLags(res.rows, LAG_GROUPS, state.dayGrid);
    if (ids.length === state.data.benchmarks.length) {
      const xs = [], ys = [];
      for (const r of res.rows) if (r.model.eci != null) { xs.push(r.c); ys.push(r.model.eci); }
      $("eci-corr").textContent = `r = ${pearson(xs, ys).toFixed(3)}`;
    }
  }
  renderAll();
  updateIntervals();
}

// ---------- intervals ----------

// Precomputed intervals (cli/precompute_intervals.mjs), loaded on first use.
let intervalsFile;
async function loadIntervals() {
  if (intervalsFile === undefined) {
    try {
      const f = await (await fetch("data/intervals.json")).json();
      intervalsFile = f.version === state.data.version ? f : null;
      if (!intervalsFile) console.warn("intervals.json is stale; re-run cli/precompute_intervals.mjs");
    } catch {
      intervalsFile = null;
    }
  }
  return intervalsFile;
}

let ciToken = 0;
async function updateIntervals() {
  const token = ++ciToken;
  const status = $("ci-status");
  if (!state.showCI || !state.result) {
    status.textContent = "";
    if (state.ci) { state.ci = null; renderAll(); }
    return;
  }
  if (state.ci) return;
  const file = await loadIntervals();
  if (token !== ciToken) return;
  const key = selectionKey();
  const run = key && file?.runs[`${key}|${state.mode}|${state.minBench}`];
  if (run) {
    state.ci = {
      dateCI: new Map(Object.entries(run.dates).map(([i, [lo, hi]]) => [Number(i), { lo, hi }])),
      capCI: new Map(Object.entries(run.caps ?? {}).map(([i, [lo, hi]]) => [Number(i), { lo, hi }])),
      lagCI: Object.fromEntries(Object.entries(run.lags).map(([g, pts]) =>
        [g, pts.map(([T, lo, hi, capLo, capHi]) => ({ T: toYear(T), lo, hi, capLo, capHi }))])),
      trendCI: Object.fromEntries(Object.entries(run.trends ?? {}).map(([g, [lo, hi, capLo, capHi]]) => [g, { lo, hi, capLo, capHi }])),
      reps: file.reps,
    };
    status.textContent = "";
    status.title = `Precomputed from ${file.reps} benchmark-bootstrap refits`;
    renderAll();
    return;
  }
  // Custom selection: compute in the browser.
  const reps = 100;
  const ci = await bootstrap(state.data, [...state.selected], state.mode, state.result, {
    reps,
    groups: LAG_GROUPS,
    grid: state.grid,
    days: state.dayGrid,
    fitOpts: { minBenchmarks: state.minBench, reference: state.selected.size === state.data.benchmarks.length ? null : state.reference },
    onProgress: (d, n) => { if (token === ciToken) status.textContent = `computing ${Math.round((100 * d) / n)}%`; },
  });
  if (token !== ciToken) return;
  state.ci = ci;
  status.textContent = "";
  status.title = `Computed from ${reps} benchmark-bootstrap refits`;
  renderAll();
}

// Models weaker than the first trusted frontier record (GPT-4, Mar 2023) can't be
// dated within the data's coverage. They stay in the fit but are hidden from display.
function isBeforeCoverage(r) {
  return r.flag === "below" || r.fdate < toYear(state.data.frontierStart) - 1e-6;
}
function shownRows() {
  return state.result ? state.result.rows.filter((r) => !isBeforeCoverage(r)) : [];
}

// Capability units: ECI scale normally; standardized only if calibration was impossible.
function capUnit() {
  return state.result?.fit.scale === "relative"
    ? { short: "SD", long: "SD, uncalibrated", scale: "standardized; too few models to calibrate" }
    : { short: "points", long: "ECI points", scale: "ECI-scaled" };
}

function emptyMessage() {
  return state.selected.size ? "Too few models in this selection to draw a frontier. Add more benchmarks." : "Select at least one benchmark.";
}

// Models that beat every earlier model in `rows`, e.g. one group's or one lab's (same rule as the gap chart).
function leaders(rows) {
  const mine = [...rows].sort((a, b) => a.t - b.t || b.c - a.c);
  const out = [];
  let best = -Infinity;
  for (const r of mine) if (r.c > best) { best = r.c; out.push(r); }
  return out;
}

function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < n; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; }
  return a / Math.sqrt(b * c);
}

// ---------- rendering ----------

function renderAll() {
  renderCharts();
  renderTable();
}

function renderCharts() {
  renderLegends();
  renderScatter();
  renderLag();
  renderFrontier();
  renderLabs();
}

function baseLayout(extra = {}) {
  const axis = {
    gridcolor: css("--grid"), linecolor: css("--axis"), zeroline: false,
    tickfont: { color: css("--text-muted"), size: 12 }, title: { font: { color: css("--text-secondary"), size: 13 } },
    showline: true, ticks: "", automargin: true,
  };
  return {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { family: css("--font-ui"), color: css("--text-primary"), size: 13 },
    margin: { l: 56, r: 16, t: 28, b: 44 },
    showlegend: false,
    hovermode: "closest",
    hoverlabel: { bgcolor: css("--surface"), bordercolor: css("--axis"), font: { color: css("--text-primary"), size: 12 } },
    xaxis: { ...axis, ...(extra.xaxis ?? {}) },
    yaxis: { ...axis, ...(extra.yaxis ?? {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "xaxis" && k !== "yaxis")),
  };
}
const plotConfig = { responsive: true, displayModeBar: false };

// Placeholder with a centered message. Static: no zoom, pan or hover on an empty chart.
function emptyChart(id, msg) {
  const legend = { "chart-scatter": "legend-scatter", "chart-lag": "legend-lag", "chart-frontier": "legend-frontier", "chart-labs": "legend-labs" }[id];
  if (legend) $(legend).hidden = true;
  Plotly.react(id, [], baseLayout({
    xaxis: { visible: false, type: "linear" }, yaxis: { visible: false, type: "linear" },
    annotations: [{ text: msg, xref: "paper", yref: "paper", x: 0.5, y: 0.5, showarrow: false, font: { size: 14, color: css("--text-secondary") } }],
  }), { ...plotConfig, staticPlot: true });
}

function legendSvg(g, line = false) {
  const color = css(g.color);
  if (line) return `<svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
  const shapes = {
    circle: `<circle cx="5" cy="5" r="4" fill="${color}"/>`,
    diamond: `<rect x="1.5" y="1.5" width="7" height="7" fill="${color}" transform="rotate(45 5 5)"/>`,
    square: `<rect x="1" y="1" width="8" height="8" fill="${color}"/>`,
    ring: `<circle cx="5" cy="5" r="3.5" fill="none" stroke="${color}" stroke-width="1.5"/>`,
  };
  return `<svg width="10" height="10">${shapes[g.svg]}</svg>`;
}

// Trend slopes (from renderLag) beside the gap chart's legend entries.
function showTrendNotes() {
  for (const s of $("legend-lag").children) {
    s.querySelector(".trend")?.remove();
    const note = state.trendNotes?.[s.dataset.key];
    if (!note) continue;
    const t = document.createElement("span");
    t.className = "trend";
    t.textContent = note;
    s.append(t);
  }
}

function renderLegends() {
  for (const id of ["legend-scatter", "legend-lag", "legend-frontier", "legend-labs"]) $(id).hidden = false;
  const fill = (el, groups, line) => {
    el.replaceChildren();
    for (const g of groups) {
      const s = document.createElement("span");
      s.innerHTML = legendSvg(g, line);
      s.append(g.key);
      s.dataset.key = g.key;
      el.append(s);
    }
  };
  if (state.scatterView === "labs") {
    // Lab chips double as toggles.
    const el = $("legend-scatter");
    el.replaceChildren();
    for (const l of LABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(state.labsOn.has(l.key)));
      b.innerHTML = `<svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" stroke="${css(l.color)}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="${DASH_SVG[l.dash]}"/></svg>`;
      b.append(l.key);
      b.addEventListener("click", () => {
        state.labsOn.has(l.key) ? state.labsOn.delete(l.key) : state.labsOn.add(l.key);
        renderLegends();
        renderScatter();
      });
      el.append(b);
    }
  } else {
    fill($("legend-scatter"), state.scatterView === "leaders" ? GROUPS.slice(0, 3) : GROUPS, false);
  }
  const diag = document.createElement("span");
  diag.innerHTML = `<svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="${css("--text-muted")}" stroke-width="1"/></svg>`;
  diag.append("Frontier (y = x)");
  $("legend-scatter").append(diag);
  fill($("legend-lag"), GROUPS.slice(0, 3), true);
  showTrendNotes();
  fill($("legend-frontier"), GROUPS.slice(0, 3), false);
  fill($("legend-labs"), GROUPS.slice(0, 3), false);
  const rel = document.createElement("span");
  rel.innerHTML = `<svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="${css("--text-muted")}" stroke-width="1.5"/></svg>`;
  rel.append("Release date");
  $("legend-labs").append(rel);
  const ink = css("--frontier");
  const curve = document.createElement("span");
  curve.innerHTML = `<svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="${ink}" stroke-width="2"/></svg>`;
  curve.append("Frontier curve");
  $("legend-frontier").append(curve);
}

function hoverText(r) {
  const ci = state.ci?.dateCI.get(r.i), capCi = state.ci?.capCI?.get(r.i);
  const ciTxt = ci ? `<br>90% interval: ${monthLabel(ci.lo)} – ${monthLabel(ci.hi)}` : "";
  const capTxt = `<br>Capability: ${r.c.toFixed(1)} ${capUnit().short}` + (capCi ? ` (90%: ${capCi.lo.toFixed(1)} – ${capCi.hi.toFixed(1)})` : "");
  const flag = r.flag ? `<br><i>${{ extrapolated: "extrapolated beyond observed records", above: "beyond the latest record", below: "below the earliest record" }[r.flag]}</i>` : "";
  const lab = r.model.org ? `${escapeHtml(r.model.org)} · ` : "";
  return `<b>${escapeHtml(r.model.name)}</b><br>${lab}${escapeHtml(groupMeta(r.model.group).key)}` +
    `<br>Frontier-equivalent: <b>${monthLabel(r.fdate)}</b>${ciTxt}` +
    `<br>Released: ${monthLabel(r.t)} · ${(r.lagYears * 12).toFixed(1)} mo behind` + capTxt +
    `<br>${r.nBench} benchmarks${r.isRecord ? " · frontier record" : ""}${flag}`;
}

// ---------- labs' best models (dumbbell) ----------

const LAB_ALIASES = { Google: "Google DeepMind" };
const labOf = (m) => {
  const org = (m.org || "Unknown").split(",")[0].trim();
  return LAB_ALIASES[org] ?? org;
};

// Product line: the name without version numbers, e.g. "Claude Fable 5.1" -> "Claude Fable",
// "Qwen3.7-Max" -> "Qwen Max", "GPT-6.1 Sol" -> "GPT Sol".
function productLine(name) {
  const words = name.replace(/\(.*?\)/g, " ").split(/[\s-]+/).filter(Boolean)
    .map((w) => w.replace(/[-_]?v?\d[\w.]*$/i, ""))
    .filter((w) => w && !/\d/.test(w) && !/^(preview|exp|latest)$/i.test(w));
  return words.join(" ") || name;
}

// For each lab that released a model in the past year: the best model of each product line,
// keeping lines within LINE_WINDOW years of the lab's best, at most LINES_PER_LAB of them.
const LINE_WINDOW = 0.25, LINES_PER_LAB = 3;
function labBestRows(rows) {
  const tMax = Math.max(...rows.map((r) => r.t));
  const byLab = new Map();
  for (const r of rows) {
    const lab = labOf(r.model);
    if (!byLab.has(lab)) byLab.set(lab, []);
    byLab.get(lab).push(r);
  }
  const out = [];
  for (const rs of byLab.values()) {
    if (Math.max(...rs.map((r) => r.t)) < tMax - 1) continue;
    const best = Math.max(...rs.map((r) => r.fdate));
    const lines = new Map();
    for (const r of rs) {
      const f = productLine(r.model.name);
      if (!lines.has(f) || r.fdate > lines.get(f).fdate) lines.set(f, r);
    }
    out.push(...[...lines.values()].filter((r) => best - r.fdate <= LINE_WINDOW)
      .sort((a, b) => b.fdate - a.fdate).slice(0, LINES_PER_LAB));
  }
  return out.sort((a, b) => b.fdate - a.fdate);
}

function renderLabs() {
  const res = state.result;
  if (!res) {
    $("chart-labs").style.height = "";
    return emptyChart("chart-labs", emptyMessage());
  }
  const rows = labBestRows(shownRows());
  const names = rows.map((r) => r.model.name);
  const surface = css("--surface"), ring = css("--text-muted");
  const traces = [];
  if (state.ci) {
    // 90% interval for each frontier-equivalent date, as a soft band behind the dot.
    for (const g of GROUPS) {
      const xs = [], ys = [];
      for (const r of rows) {
        const ci = state.ci.dateCI.get(r.i);
        if (ci && groupMeta(r.model.group) === g) xs.push(isoOf(ci.lo), isoOf(ci.hi), null), ys.push(r.model.name, r.model.name, null);
      }
      if (xs.length) traces.push({ x: xs, y: ys, mode: "lines", line: { color: css(g.color), width: 7 }, opacity: 0.18, hoverinfo: "skip" });
    }
  }
  // Connector: release date -> frontier-equivalent date.
  const cx = [], cy = [];
  for (const r of rows) cx.push(isoOf(r.t), isoOf(r.fdate), null), cy.push(r.model.name, r.model.name, null);
  traces.push({ x: cx, y: cy, mode: "lines", line: { color: css("--axis"), width: 2 }, hoverinfo: "skip" });
  // Release date: hollow ring.
  traces.push({
    x: rows.map((r) => isoOf(r.t)), y: names, mode: "markers",
    marker: { symbol: "circle-open", size: 9, color: ring, line: { width: 1.5 } },
    text: rows.map(hoverText), hovertemplate: "%{text}<extra></extra>",
  });
  // Frontier-equivalent date: filled, by group.
  for (const g of GROUPS) {
    const mine = rows.filter((r) => groupMeta(r.model.group) === g);
    if (!mine.length) continue;
    traces.push({
      x: mine.map((r) => isoOf(r.fdate)), y: mine.map((r) => r.model.name), mode: "markers",
      marker: { color: css(g.color), symbol: g.symbol, size: 11, line: { color: surface, width: 1 } },
      text: mine.map(hoverText), hovertemplate: "%{text}<extra></extra>",
    });
  }
  const width = $("chart-labs").clientWidth, narrow = width < 600;
  // Ticks from the plotting width: the model names on the left take a good share of it.
  const plotWidth = width - Math.max(...names.map((n) => n.length)) * 6.6 - 24;
  const nticks = Math.max(2, Math.min(10, Math.round(plotWidth / 90)));
  // Lag in months beside each row (0.0 for models that were the frontier at release).
  const annotations = rows.map((r) => ({
    x: isoOf(r.t), y: r.model.name, xanchor: "left", xshift: 9, showarrow: false,
    text: `${Math.max(0, r.lagYears * 12).toFixed(1)} mo${narrow ? "" : " behind"}`, font: { size: 11, color: css("--text-muted") },
  }));
  const el = $("chart-labs");
  el.style.height = `${Math.max(260, rows.length * 28 + 70)}px`;
  const t0 = Math.min(...rows.map((r) => Math.min(r.t, r.fdate))), t1 = Math.max(...rows.map((r) => r.t));
  Plotly.react(el, traces, baseLayout({
    margin: { l: 8, r: 16, t: 8, b: 40 },
    xaxis: { type: "date", side: "bottom", range: [isoOf(t0 - 0.1), isoOf(t1 + (narrow ? 0.4 : 0.32))], nticks, tickangle: 0 },
    yaxis: { type: "category", categoryorder: "array", categoryarray: names, autorange: "reversed", showgrid: false, ticks: "", tickfont: { size: 12, color: css("--text-secondary") } },
    hovermode: "closest",
    annotations,
  }), plotConfig);
  const count = new Set(rows.map((r) => labOf(r.model))).size;
  $("labs-count").textContent = count;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderScatter() {
  const res = state.result;
  if (!res) return emptyChart("chart-scatter", emptyMessage());
  const rows = shownRows();
  const tMin = Math.min(...rows.map((r) => r.t)), tMax = Math.max(...rows.map((r) => r.t));
  const surface = css("--surface");
  const traces = [{
    x: [isoOf(tMin), isoOf(tMax)], y: [isoOf(tMin), isoOf(tMax)],
    mode: "lines", line: { color: css("--text-muted"), width: 1 }, hoverinfo: "skip",
  }];
  // One series per group, or per lab in the "labs" view. Leader views connect each series'
  // successive record-setters into a trend line; markers always take their group's shape.
  const view = state.scatterView;
  const series = view === "labs"
    ? LABS.filter((l) => state.labsOn.has(l.key))
      .map((l) => ({ color: css(l.color), dash: l.dash, label: l.key, rows: leaders(rows.filter((r) => labOf(r.model) === l.key)) }))
    : (view === "leaders" ? GROUPS.slice(0, 3) : GROUPS).map((g) => {
      const mine = rows.filter((r) => groupMeta(r.model.group) === g);
      return { color: css(g.color), rows: view === "leaders" ? leaders(mine) : mine };
    });
  const withTrend = view !== "all";
  const shown = [];
  for (const s of series) {
    const mine = s.rows, color = s.color;
    if (!mine.length) continue;
    shown.push(...mine);
    if (withTrend) {
      traces.push({
        x: mine.map((r) => isoOf(r.t)), y: mine.map((r) => isoOf(r.fdate)),
        mode: "lines", line: { color, width: 2, dash: s.dash ?? "solid" }, opacity: view === "labs" ? 0.9 : 0.6, hoverinfo: "skip",
      });
    }
    const symbols = mine.map((r) => groupMeta(r.model.group).symbol);
    const trace = {
      x: mine.map((r) => isoOf(r.t)), y: mine.map((r) => isoOf(r.fdate)),
      mode: "markers", type: "scatter",
      marker: {
        color, symbol: symbols, size: mine.map((r) => (r.isRecord || withTrend ? 10 : 8)),
        opacity: mine.map((r) => (r.flag ? 0.4 : 1)),
        line: { color: symbols.map((sym) => (sym.endsWith("open") ? color : surface)), width: symbols.map((sym) => (sym.endsWith("open") ? 1.5 : 1)) },
      },
      text: mine.map(hoverText), hovertemplate: "%{text}<extra></extra>",
    };
    s.top = mine.reduce((a, b) => (b.fdate > a.fdate ? b : a));
    if (state.ci) {
      const ci = mine.map((r) => state.ci.dateCI.get(r.i));
      // Plotly error bars need numeric axes; draw intervals as thin vertical segments instead.
      const xs = [], ys = [];
      mine.forEach((r, k) => { if (ci[k]) { xs.push(isoOf(r.t), isoOf(r.t), null); ys.push(isoOf(ci[k].lo), isoOf(ci[k].hi), null); } });
      traces.push({ x: xs, y: ys, mode: "lines", line: { color, width: 1 }, opacity: 0.45, hoverinfo: "skip" });
    }
    traces.push(trace);
  }
  // Direct labels for each group's most advanced model (each lab's name in the lab view), set
  // in a gutter to the right of the newest release so they never sit on top of points.
  // Nudged apart vertically. Narrow screens have no room for them: no labels, no gutter.
  const narrow = $("chart-scatter").clientWidth < 720;
  const labelled = narrow ? [] : (view === "labs" ? series : series.slice(0, 3)).filter((s) => s.top).sort((a, b) => b.top.fdate - a.top.fdate);
  const tMaxRel = Math.max(...rows.map((r) => r.t));
  const labelX = tMaxRel + 0.08;
  const yMax = Math.max(...rows.map((r) => r.fdate));
  const yMinT = Math.min(...rows.map((r) => r.fdate));
  const minGap = (yMax - yMinT) * 0.06;
  let prevY = Infinity;
  const annotations = labelled.map(({ top, label, color }) => {
    const ly = Math.min(top.fdate, prevY - minGap);
    prevY = ly;
    return {
      x: isoOf(top.t), y: isoOf(top.fdate), ax: isoOf(labelX), ay: isoOf(ly), axref: "x", ayref: "y",
      text: label ? `<b>${escapeHtml(label)}</b>` : escapeHtml(top.model.name), xanchor: "left", showarrow: true, arrowhead: 0, arrowwidth: 1, standoff: 6,
      arrowcolor: label ? color : css("--axis"), font: { size: 11, color: label ? color : css("--text-secondary") },
    };
  });
  const yMin = isoOf(Math.min(...rows.map((r) => r.fdate)) - 0.12);
  Plotly.react("chart-scatter", traces, baseLayout({
    xaxis: { type: "date", title: { text: "Release date" }, range: [isoOf(Math.min(...rows.map((r) => r.t)) - 0.1), isoOf(tMaxRel + (narrow ? 0.1 : 0.62))] },
    yaxis: { type: "date", title: { text: "Frontier-equivalent date" }, range: [yMin, isoOf(yMax + 0.15)] },
    annotations,
  }), plotConfig);
}

function renderLag() {
  const res = state.result;
  if (!res) return emptyChart("chart-lag", emptyMessage());
  const months = state.lagUnit === "months";
  const traces = [];
  // Invisible first trace: names the frontier leader once, at the top of the hover box.
  const leaders = new Map();
  for (const g of LAG_GROUPS) for (const p of state.lags[g] ?? []) leaders.set(p.T, p.leader);
  const lt = [...leaders.keys()].sort((a, b) => a - b);
  traces.push({
    x: lt.map(isoOf), y: lt.map(() => 0), mode: "lines", line: { width: 0, color: "rgba(0,0,0,0)" },
    text: lt.map((T) => `Frontier: <b>${escapeHtml(leaders.get(T))}</b>`), hovertemplate: "%{text}<extra></extra>",
  });
  for (const g of GROUPS.slice(0, 3)) {
    const series = state.lags[g.key];
    if (!series?.length) continue;
    const color = css(g.color);
    // Intervals files from before capability bands have no capLo/capHi: no band then.
    const band = state.ci?.lagCI[g.key]?.filter((p) => months || p.capLo != null);
    if (band?.length) {
      traces.push({ x: band.map((p) => isoOf(p.T)), y: band.map((p) => (months ? p.hi : p.capHi)), mode: "lines", line: { width: 0, shape: "hv" }, hoverinfo: "skip" });
      traces.push({ x: band.map((p) => isoOf(p.T)), y: band.map((p) => (months ? p.lo : p.capLo)), mode: "lines", line: { width: 0, shape: "hv" }, fill: "tonexty", fillcolor: hexA(color, 0.15), hoverinfo: "skip" });
    }
    traces.push({
      x: series.map((p) => isoOf(p.T)),
      y: series.map((p) => (months ? p.lagMonths : p.capGap)),
      mode: "lines", line: { color, width: 2, shape: "hv" }, name: g.key,
      text: series.map((p) => `<b>${months ? p.lagMonths.toFixed(1) + " months" : p.capGap.toFixed(1) + " " + capUnit().short}</b> · ${escapeHtml(g.key)}<br>best: ${escapeHtml(p.best)}`),
      hovertemplate: "%{text}<extra></extra>",
    });
  }
  // Straight-line trend of each non-leading group's gap (the US closed gap is zero whenever
  // a US closed model leads, so a trend says little), with its slope beside the group's legend entry.
  const notes = {};
  if (state.showTrend) {
    for (const g of GROUPS.slice(1, 3)) {
      const tr = gapTrend(state.lags[g.key], months ? "lagMonths" : "capGap", state.dayGrid);
      if (!tr) continue;
      traces.push({
        x: [isoOf(tr.t0), isoOf(tr.t1)], y: [tr.y0, tr.y1], mode: "lines",
        line: { color: css(g.color), width: 1.5, dash: "dash" }, hoverinfo: "skip",
      });
      const ci = state.ci?.trendCI?.[g.key];
      const lo = months ? ci?.lo : ci?.capLo, hi = months ? ci?.hi : ci?.capHi;
      const unit = months ? "months" : capUnit().short;
      const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
      notes[g.key] = `${sgn(tr.slope)} ${unit}/year` + (lo != null ? ` (90% CI ${sgn(lo)} to ${sgn(hi)})` : "");
    }
  }
  state.trendNotes = notes;
  showTrendNotes();
  // Start the axis just before the first non-leading group has a model at frontier level.
  const firsts = GROUPS.slice(1, 3).map((g) => state.lags[g.key]?.[0]?.T).filter(Number.isFinite);
  const x0 = firsts.length ? Math.min(...firsts) - 0.15 : null;
  Plotly.react("chart-lag", traces, baseLayout({
    hovermode: "x unified",
    xaxis: { type: "date", title: { text: "" }, ...(x0 ? { range: [isoOf(x0), isoOf(state.grid.at(-1) + 0.05)] } : {}), showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: css("--axis"), spikedash: "solid" },
    yaxis: { title: { text: months ? "Months behind frontier" : `Capability gap (${capUnit().long})` }, rangemode: "tozero" },
  }), plotConfig);
}

function renderFrontier() {
  const res = state.result;
  if (!res) return emptyChart("chart-frontier", emptyMessage());
  const { frontier } = res;
  const rows = shownRows();
  const surface = css("--surface");
  const traces = [];
  for (const g of GROUPS) {
    const mine = rows.filter((r) => groupMeta(r.model.group) === g);
    if (!mine.length) continue;
    if (state.ci?.capCI) {
      // 90% capability intervals as thin vertical segments (as on the scatter chart).
      const xs = [], ys = [];
      for (const r of mine) {
        const ci = state.ci.capCI.get(r.i);
        if (ci) xs.push(isoOf(r.t), isoOf(r.t), null), ys.push(ci.lo, ci.hi, null);
      }
      traces.push({ x: xs, y: ys, mode: "lines", line: { color: css(g.color), width: 1 }, opacity: 0.45, hoverinfo: "skip" });
    }
    traces.push({
      x: mine.map((r) => isoOf(r.t)), y: mine.map((r) => r.c),
      mode: "markers", name: g.key, opacity: 0.85,
      marker: { color: css(g.color), symbol: g.symbol, size: 7, line: { color: g.symbol.endsWith("open") ? css(g.color) : surface, width: 1 } },
      text: mine.map(hoverText), hovertemplate: "%{text}<extra></extra>",
    });
  }
  const tMin = Math.min(...rows.map((r) => r.t)), tMax = Math.max(...rows.map((r) => r.t));
  const ink = css("--frontier");
  if (frontier.mode === "step") {
    const recs = frontier.records;
    traces.push({
      x: [...recs.map((r) => isoOf(r.t)), isoOf(tMax)], y: [...recs.map((r) => r.c), recs[recs.length - 1].c],
      mode: "lines", line: { color: ink, width: 2, shape: "hv" }, hoverinfo: "skip",
    });
  } else {
    const n = 200, xs = [], ys = [];
    for (let k = 0; k <= n; k++) { const t = tMin + ((tMax - tMin) * k) / n; xs.push(isoOf(t)); ys.push(frontier.F(t)); }
    traces.push({ x: xs, y: ys, mode: "lines", line: { color: ink, width: 2 }, hoverinfo: "skip" });
  }
  const cs = rows.flatMap((r) => { const ci = state.ci?.capCI?.get(r.i); return ci ? [r.c, ci.lo, ci.hi] : [r.c]; });
  const lo = Math.min(...cs), hi = Math.max(...cs), pad = (hi - lo) * 0.05;
  Plotly.react("chart-frontier", traces, baseLayout({
    xaxis: { type: "date", title: { text: "Release date" } },
    yaxis: { title: { text: `Capability (${capUnit().scale})` }, range: [lo - pad, hi + pad] },
  }), plotConfig);
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function renderTable() {
  const tbody = document.querySelector("#model-table tbody");
  tbody.replaceChildren();
  const res = state.result;
  document.querySelectorAll("#model-table th").forEach((th) =>
    th.setAttribute("aria-sort", th.dataset.key === state.sort.key ? (state.sort.dir > 0 ? "ascending" : "descending") : "none"));
  if (!res) return;
  const key = state.sort.key, dir = state.sort.dir;
  const val = (r) => ({ name: r.model.name, org: r.model.org, group: r.model.group, t: r.t, fdate: r.fdate, lag: r.lagYears, nBench: r.nBench }[key]);
  const rows = shownRows()
    .filter((r) => !state.filter || r.model.name.toLowerCase().includes(state.filter) || r.model.org.toLowerCase().includes(state.filter))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.isRecord) tr.classList.add("record");
    const td = (text, cls) => { const c = document.createElement("td"); c.textContent = text; if (cls) c.className = cls; tr.append(c); return c; };
    const name = td("");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = css(groupMeta(r.model.group).color);
    name.append(dot, r.model.name);
    td(r.model.org);
    td(r.model.group);
    td(monthLabel(r.t), "num");
    const f = td(`${monthLabel(r.fdate)}${flagMark(r.flag)}`, "num reading-cell");
    const ci = state.ci?.dateCI.get(r.i);
    if (ci) {
      const s = document.createElement("span");
      s.className = "ci";
      s.textContent = ` ${monthLabel(ci.lo)} – ${monthLabel(ci.hi)}`;
      f.append(s);
    }
    td(`${(r.lagYears * 12).toFixed(1)} mo`, "num");
    td(String(r.nBench), "num");
    frag.append(tr);
  }
  tbody.append(frag);
}


// Show focus rings only for keyboard use: Chrome also shows them when a select or input is clicked.
const root = document.documentElement;
document.addEventListener("pointerdown", () => (root.dataset.input = "mouse"), true);
document.addEventListener("keydown", (e) => { if (e.key === "Tab") root.dataset.input = "keyboard"; }, true);

main();
