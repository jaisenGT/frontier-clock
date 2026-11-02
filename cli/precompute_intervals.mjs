// Precompute bootstrap 90% intervals for the standard selections (all benchmarks and
// each single domain) × every frontier mode × every min-benchmarks option, so the site
// can show them instantly. Custom selections are still computed in the browser.
//
//   node cli/precompute_intervals.mjs [--reps 100]
//
// Writes site/data/intervals.json. Re-run after scripts/build_data.py.

import { readFileSync, writeFileSync } from "node:fs";
import { analyze, bootstrap, fromYear, monthlyGrid, toYear } from "../site/core.js";

// Frontier curves offered on the site (keep in sync with MODE_SHORT in site/app.js).
const SITE_MODES = ["step", "interp"];

const args = process.argv.slice(2);
const reps = Number(args[args.indexOf("--reps") + 1] || 0) || 100;
const MIN_BENCH = [1, 2, 3, 5]; // keep in sync with the <select> in index.html
const GROUPS = ["US closed", "China", "Open weights (non-China)"];

const dataUrl = new URL("../site/data/frontier_clock.json", import.meta.url);
const data = JSON.parse(readFileSync(dataUrl));
data.models.forEach((m) => (m._t = toYear(m.date)));

const selections = [{ key: "all", ids: data.benchmarks.map((_, i) => i) }];
for (const d of data.domains) {
  const ids = data.benchmarks.map((b, i) => (b.domain === d ? i : -1)).filter((i) => i >= 0);
  if (ids.length) selections.push({ key: d, ids });
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const runs = {};
const total = selections.length * SITE_MODES.length * MIN_BENCH.length;
let done = 0;
const t0 = performance.now();

for (const sel of selections) {
  for (const mode of SITE_MODES) {
    for (const minBenchmarks of MIN_BENCH) {
      done++;
      const base = analyze(data, sel.ids, mode, { minBenchmarks });
      if (!base.frontier) continue;
      const grid = monthlyGrid(toYear(data.frontierStart), Math.max(...base.rows.map((r) => r.t)));
      const ci = await bootstrap(data, sel.ids, mode, base, { reps, groups: GROUPS, grid, fitOpts: { minBenchmarks } });
      runs[`${sel.key}|${mode}|${minBenchmarks}`] = {
        dates: Object.fromEntries([...ci.dateCI].map(([i, { lo, hi }]) => [i, [r4(lo), r4(hi)]])),
        lags: Object.fromEntries(GROUPS.map((g) => [g, ci.lagCI[g].map((p) => [fromYear(p.T), r2(p.lo), r2(p.hi)])])),
      };
      process.stdout.write(`\r${done}/${total}  ${sel.key} | ${mode} | min ${minBenchmarks}`.padEnd(70));
    }
  }
}

const out = { version: data.version, reps, level: 0.9, runs };
writeFileSync(new URL("../site/data/intervals.json", import.meta.url), JSON.stringify(out));
console.log(`\nWrote site/data/intervals.json: ${Object.keys(runs).length} runs, ${reps} reps each, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
