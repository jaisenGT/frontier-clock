// Command-line analysis using the same core as the website.
//
//   node cli/analyze.mjs [--mode step|interp|linear|broken] [--domain "Math"] [--top 25] [--validate]
//
// --validate compares the all-benchmark capability fit with Epoch's published ECI.

import { readFileSync } from "node:fs";
import { analyze, fitCapabilities, fromYear, FRONTIER_MODES, groupLags, monthlyGrid } from "../site/core.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const mode = opt("mode", "interp");
const domain = opt("domain", null);
const top = Number(opt("top", 25));

const data = JSON.parse(readFileSync(new URL("../site/data/frontier_clock.json", import.meta.url)));
const benchIds = data.benchmarks.map((b, i) => (!domain || b.domain === domain ? i : -1)).filter((i) => i >= 0);
if (!benchIds.length) {
  console.error(`No benchmarks in domain "${domain}". Domains: ${data.domains.join(", ")}`);
  process.exit(1);
}

const t0 = performance.now();
// Subsets are calibrated to the all-benchmarks ECI scale (see core.js).
const allIds = data.benchmarks.map((_, i) => i);
const reference = domain ? fitCapabilities(data, allIds).capability : null;
const res = analyze(data, benchIds, mode, { reference });
const unit = res.fit.scale === "eci" ? "ECI pts" : "SD";
if (!res.frontier) {
  console.error(`Too few models (${res.fit.nFitted}) in this selection to build a frontier.`);
  process.exit(1);
}
console.log(`Fit ${res.fit.nFitted} models on ${benchIds.length} benchmarks (${res.fit.nObs} scores) in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`Frontier mode: ${FRONTIER_MODES[res.frontier.mode]}`);
if (res.frontier.fit) {
  const f = res.frontier.fit;
  console.log(`  break at ${fromYear(f.tau)}; slope ${f.slope1.toFixed(2)} -> ${f.slope2.toFixed(2)} ${unit}/yr`);
} else {
  console.log(`  trend slope ${res.frontier.trend.slope.toFixed(2)} ${unit}/yr`);
}
console.log("\nFrontier records:");
for (const r of res.frontier.records) console.log(`  ${fromYear(r.t)}  ${r.c.toFixed(2)}  ${data.models[r.i].name}`);

if (args.includes("--validate")) {
  const xs = [], ys = [];
  for (const row of res.rows) if (Number.isFinite(row.model.eci)) { xs.push(row.c); ys.push(row.model.eci); }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
  const rx = rank(xs), ry = rank(ys);
  const mrx = mean(rx), mry = mean(ry);
  let a = 0, b = 0, c = 0;
  rx.forEach((v, i) => { a += (v - mrx) * (ry[i] - mry); b += (v - mrx) ** 2; c += (ry[i] - mry) ** 2; });
  console.log(`\nValidation vs Epoch ECI (n=${xs.length}): Pearson r=${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}, Spearman ρ=${(a / Math.sqrt(b * c)).toFixed(3)}`);
}

const rows = [...res.rows].sort((a, b) => b.fdate - a.fdate).slice(0, top);
console.log(`\nTop ${top} by frontier-equivalent date:`);
for (const r of rows) {
  const lag = (r.lagYears * 12).toFixed(1).padStart(6);
  console.log(`  ${fromYear(r.fdate)}${r.flag ? "*" : " "}  released ${r.model.date}  lag ${lag} mo  ${r.model.group.padEnd(25)} ${r.model.name}`);
}

const groups = ["US closed", "China", "Open weights (non-China)"];
const grid = monthlyGrid(2023.5, Math.max(...res.rows.map((r) => r.t)));
const lags = groupLags(res.rows, groups, grid);
console.log("\nLag behind frontier (months), every 6 months:");
console.log(`  ${"date".padEnd(10)}  ${groups.map((g) => g.slice(0, 14).padStart(14)).join("  ")}`);
grid.forEach((T, j) => {
  if (j % 6) return;
  const cells = groups.map((g) => {
    const p = lags[g].find((x) => x.T === T);
    return (p ? p.lagMonths.toFixed(1) : "-").padStart(14);
  });
  console.log(`  ${fromYear(T)}  ${cells.join("  ")}`);
});
