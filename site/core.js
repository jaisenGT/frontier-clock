// Frontier Clock core: capability fitting, frontier curves, and frontier-equivalent dates.
// Pure ES module with no dependencies so it runs in the browser and in Node.

// ---------- dates ----------

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

export function toYear(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return 1970 + Date.UTC(y, m - 1, d) / MS_PER_YEAR;
}

export function fromYear(t) {
  return new Date((t - 1970) * MS_PER_YEAR).toISOString().slice(0, 10);
}

// ---------- seeded RNG (for bootstrap) ----------

export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- capability fit ----------
//
// Item-response model in the style of Epoch's ECI:
//   score[m,b] ≈ sigmoid(a_b * (C_m - D_b))
// C_m = model capability, D_b = benchmark difficulty, a_b = benchmark slope.
// Fit by weighted least squares with light L2 priors, using full-batch Adam.
// The scale of C is arbitrary; every frontier mode below is invariant to affine
// rescaling of C, so dates do not depend on it. For display we put C on Epoch's
// ECI scale:
//   - all benchmarks: map the two anchor models (data.anchors) to their ECI values;
//   - a subset (opts.reference = an all-benchmarks fit's capabilities): match the
//     mean and sd of the reference scores over the models placed by both, so every
//     selection is in the same "ECI points";
//   - otherwise standardize (mean 0, sd 1) and report scale: "relative".

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Geometric-mean benchmark slope is pinned here to fix the scale of C.
const LOG_MEAN_SLOPE = Math.log(10);

/**
 * @param data      parsed frontier_clock.json
 * @param benchIds  array of benchmark indices to use
 * @param opts.minBenchmarks  drop models with fewer scored benchmarks in the selection
 * @param opts.weights        optional Map benchIdx -> weight (bootstrap resampling)
 * @param opts.init           optional previous fit to warm-start from
 * @param opts.reference      optional all-benchmarks capabilities (ECI scale) to calibrate a subset against
 * @returns {capability: Float64Array (NaN for unfitted models), scale: "eci" | "relative", nBench, bench: {...}}
 */
export function fitCapabilities(data, benchIds, opts = {}) {
  const {
    minBenchmarks = 2,
    iters = 1500,
    lr = 0.05,
    lambdaC = 0.02,
    lambdaD = 0.002,
    lambdaA = 0.2,
    weights = null,
    init = null,
    reference = null,
  } = opts;
  const nModels = data.models.length;
  const nBenchAll = data.benchmarks.length;
  const inSel = new Uint8Array(nBenchAll);
  let nSel = 0;
  for (const b of benchIds) if (!inSel[b] && (!weights || (weights.get(b) ?? 0) > 0)) { inSel[b] = 1; nSel++; }

  const nBench = new Int32Array(nModels);
  for (const [m, b] of data.scores) if (inSel[b]) nBench[m]++;
  const keep = new Uint8Array(nModels);
  for (let m = 0; m < nModels; m++) keep[m] = nBench[m] >= minBenchmarks ? 1 : 0;

  const obs = data.scores.filter(([m, b]) => inSel[b] && keep[m]);
  const N = obs.length;
  const om = new Int32Array(N), ob = new Int32Array(N), oy = new Float64Array(N), ow = new Float64Array(N);
  let wSum = 0;
  obs.forEach(([m, b, y], i) => {
    om[i] = m; ob[i] = b; oy[i] = y;
    ow[i] = weights ? weights.get(b) : 1;
    wSum += ow[i];
  });

  // Parameters: C (models), D and s = log a (benchmarks).
  const C = new Float64Array(nModels), D = new Float64Array(nBenchAll), S = new Float64Array(nBenchAll);
  if (init) {
    C.set(init.rawC); D.set(init.bench.D); S.set(init.bench.S);
  } else {
    // Initialize from logits of mean scores.
    const logit = (p) => Math.log(Math.min(0.98, Math.max(0.02, p)) / (1 - Math.min(0.98, Math.max(0.02, p))));
    const mSum = new Float64Array(nModels), mCnt = new Float64Array(nModels);
    const bSum = new Float64Array(nBenchAll), bCnt = new Float64Array(nBenchAll);
    for (let i = 0; i < N; i++) {
      mSum[om[i]] += oy[i]; mCnt[om[i]]++;
      bSum[ob[i]] += oy[i]; bCnt[ob[i]]++;
    }
    const a0 = Math.exp(LOG_MEAN_SLOPE);
    for (let m = 0; m < nModels; m++) C[m] = mCnt[m] ? logit(mSum[m] / mCnt[m]) / a0 : 0;
    for (let b = 0; b < nBenchAll; b++) D[b] = bCnt[b] ? -logit(bSum[b] / bCnt[b]) / a0 : 0;
    S.fill(LOG_MEAN_SLOPE);
  }

  // Adam state.
  const params = [C, D, S];
  const grads = params.map((p) => new Float64Array(p.length));
  const mom = params.map((p) => new Float64Array(p.length));
  const vel = params.map((p) => new Float64Array(p.length));
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const [gC, gD, gS] = grads;

  for (let it = 1; it <= iters; it++) {
    gC.fill(0); gD.fill(0); gS.fill(0);
    for (let i = 0; i < N; i++) {
      const m = om[i], b = ob[i];
      const a = Math.exp(S[b]);
      const diff = C[m] - D[b];
      const p = sigmoid(a * diff);
      const dz = (2 * ow[i] * (p - oy[i]) * p * (1 - p)) / wSum;
      gC[m] += dz * a;
      gD[b] -= dz * a;
      gS[b] += dz * a * diff;
    }
    for (let m = 0; m < nModels; m++) if (keep[m]) gC[m] += (2 * lambdaC * C[m]) / nModels;
    for (let b = 0; b < nBenchAll; b++) {
      if (!inSel[b]) continue;
      gD[b] += (2 * lambdaD * D[b]) / nBenchAll;
      gS[b] += (2 * lambdaA * (S[b] - LOG_MEAN_SLOPE)) / nBenchAll;
    }
    const corr1 = 1 - b1 ** it, corr2 = 1 - b2 ** it;
    for (let k = 0; k < 3; k++) {
      const p = params[k], g = grads[k], mo = mom[k], ve = vel[k];
      for (let j = 0; j < p.length; j++) {
        if (g[j] === 0) continue;
        mo[j] = b1 * mo[j] + (1 - b1) * g[j];
        ve[j] = b2 * ve[j] + (1 - b2) * g[j] * g[j];
        p[j] -= (lr * (mo[j] / corr1)) / (Math.sqrt(ve[j] / corr2) + eps);
      }
    }
    // Fix the scale (C*k, a/k fit identically) by pinning the mean log-slope,
    // and keep each slope within a sane band around it.
    let shift = 0;
    for (let b = 0; b < nBenchAll; b++) if (inSel[b]) shift += S[b];
    shift = shift / (nSel || 1) - LOG_MEAN_SLOPE;
    for (let b = 0; b < nBenchAll; b++)
      if (inSel[b]) S[b] = Math.max(LOG_MEAN_SLOPE - 3, Math.min(LOG_MEAN_SLOPE + 3, S[b] - shift));
  }

  let cnt = 0;
  for (let m = 0; m < nModels; m++) if (keep[m]) cnt++;
  const { scale, a, b } = capabilityScale(data, C, keep, reference);
  const capability = new Float64Array(nModels).fill(NaN);
  for (let m = 0; m < nModels; m++) if (keep[m]) capability[m] = a + b * C[m];

  return { capability, scale, nBench, rawC: C, bench: { D, S }, nFitted: cnt, nObs: N };
}

// Affine map C -> a + b*C onto the ECI scale via the anchors, else standardized.
function capabilityScale(data, C, keep, reference) {
  if (reference) {
    const xs = [], ys = [];
    for (let m = 0; m < C.length; m++) if (keep[m] && Number.isFinite(reference[m])) { xs.push(C[m]); ys.push(reference[m]); }
    if (xs.length >= 3) {
      const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
      const sd = (v, mu) => Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
      const mx = mean(xs), my = mean(ys), sx = sd(xs, mx), sy = sd(ys, my);
      if (sx > 1e-9) return { scale: "eci", a: my - (sy / sx) * mx, b: sy / sx };
    }
  }
  const idx = (id) => data.models.findIndex((m) => m.id === id);
  const anc = (data.anchors ?? []).map((x) => ({ m: idx(x.id), v: x.value })).filter((x) => x.m >= 0 && keep[x.m]);
  if (anc.length >= 2 && C[anc[1].m] - C[anc[0].m] > 1e-6 === anc[1].v - anc[0].v > 0) {
    const b = (anc[1].v - anc[0].v) / (C[anc[1].m] - C[anc[0].m]);
    return { scale: "eci", a: anc[0].v - b * C[anc[0].m], b };
  }
  let mean = 0, cnt = 0;
  for (let m = 0; m < C.length; m++) if (keep[m]) { mean += C[m]; cnt++; }
  mean /= cnt || 1;
  let sd = 0;
  for (let m = 0; m < C.length; m++) if (keep[m]) sd += (C[m] - mean) ** 2;
  sd = Math.sqrt(sd / Math.max(1, cnt - 1)) || 1;
  return { scale: "relative", a: -mean / sd, b: 1 / sd };
}

// ---------- frontier ----------

/** Models that set a new capability record at release. points: [{t, c, i}] */
export function frontierRecords(points) {
  const sorted = points.filter((p) => Number.isFinite(p.c)).sort((a, b) => a.t - b.t || b.c - a.c);
  const recs = [];
  let best = -Infinity;
  for (const p of sorted) {
    if (p.c > best + 1e-9) {
      recs.push(p);
      best = p.c;
    }
  }
  return recs;
}

function olsLine(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n, my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

// Broken-stick fit c = α + β t + γ max(0, t − τ), τ searched over a grid.
function brokenStick(ts, cs) {
  const n = ts.length;
  if (n < 6) return null;
  const sorted = [...ts].sort((a, b) => a - b);
  const lo = sorted[2], hi = sorted[n - 3];
  let best = null;
  for (let k = 0; k <= 60; k++) {
    const tau = lo + ((hi - lo) * k) / 60;
    // Solve 3-param least squares via normal equations.
    const X = ts.map((t) => [1, t - tau, Math.max(0, t - tau)]);
    const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Xty = [0, 0, 0];
    for (let i = 0; i < n; i++)
      for (let r = 0; r < 3; r++) {
        Xty[r] += X[i][r] * cs[i];
        for (let c = 0; c < 3; c++) XtX[r][c] += X[i][r] * X[i][c];
      }
    const beta = solve3(XtX, Xty);
    if (!beta) continue;
    const [a0, b0, g0] = beta;
    if (b0 <= 0 || b0 + g0 <= 0) continue;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (cs[i] - (a0 + b0 * X[i][1] + g0 * X[i][2])) ** 2;
    if (!best || sse < best.sse) best = { tau, cTau: a0, slope1: b0, slope2: b0 + g0, sse };
  }
  return best;
}

function solve3(A, y) {
  const M = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

export const FRONTIER_MODES = {
  step: "Running max (honest, lumpy)",
  interp: "Interpolated records",
  linear: "Linear trend",
  broken: "Accelerating trend (one break)",
};

/**
 * Build a frontier curve F(t) and its inverse from the record-setting models.
 * Every mode is invariant to affine rescaling of capability.
 * inverse(c) returns {t, flag} where flag is null, "extrapolated", "above" or "below".
 */
export function buildFrontier(records, mode) {
  const ts = records.map((r) => r.t), cs = records.map((r) => r.c);
  const t0 = ts[0], tN = ts[ts.length - 1], c0 = cs[0], cN = cs[cs.length - 1];
  const line = olsLine(ts, cs);
  const slope = line.slope > 0 ? line.slope : 1e-6;
  const inRange = (t) => (t < t0 || t > tN ? "extrapolated" : null);

  if (mode === "step") {
    return {
      mode, records, trend: line,
      F: (t) => { let v = -Infinity; for (const r of records) if (r.t <= t) v = r.c; return v; },
      inverse: (c) => {
        if (c > cN) return { t: tN, flag: "above" };
        for (const r of records) if (r.c >= c) return { t: r.t, flag: c < c0 ? "below" : null };
        return { t: tN, flag: "above" };
      },
    };
  }

  if (mode === "interp") {
    return {
      mode, records, trend: line,
      F: (t) => {
        if (t <= t0) return c0 + (t - t0) * slope;
        if (t >= tN) return cN + (t - tN) * slope;
        for (let i = 1; i < records.length; i++)
          if (t <= ts[i]) return cs[i - 1] + ((cs[i] - cs[i - 1]) * (t - ts[i - 1])) / (ts[i] - ts[i - 1]);
        return cN;
      },
      inverse: (c) => {
        if (c <= c0) return { t: t0 + (c - c0) / slope, flag: c < c0 ? "extrapolated" : null };
        if (c >= cN) return { t: tN + (c - cN) / slope, flag: c > cN ? "extrapolated" : null };
        for (let i = 1; i < records.length; i++)
          if (c <= cs[i]) return { t: ts[i - 1] + ((c - cs[i - 1]) * (ts[i] - ts[i - 1])) / (cs[i] - cs[i - 1]), flag: null };
        return { t: tN, flag: null };
      },
    };
  }

  if (mode === "broken") {
    const fit = brokenStick(ts, cs);
    if (fit) {
      const { tau, cTau, slope1, slope2 } = fit;
      return {
        mode, records, trend: line, fit,
        F: (t) => cTau + (t < tau ? slope1 : slope2) * (t - tau),
        inverse: (c) => {
          const t = tau + (c - cTau) / (c < cTau ? slope1 : slope2);
          return { t, flag: inRange(t) };
        },
      };
    }
    // Too few records for a break: fall through to linear.
  }

  return {
    mode: "linear", records, trend: line,
    F: (t) => line.intercept + slope * t,
    inverse: (c) => {
      const t = (c - line.intercept) / slope;
      return { t, flag: inRange(t) };
    },
  };
}

// ---------- full analysis ----------

/**
 * Run the whole pipeline for one benchmark selection and frontier mode.
 * Returns per-model rows and the frontier curve.
 */
export function analyze(data, benchIds, mode, opts = {}) {
  const fit = fitCapabilities(data, benchIds, opts);
  return analyzeFit(data, fit, mode);
}

// Before data.frontierStart the true frontier models (GPT-3.5, PaLM, Claude 1, ...)
// are absent from the data, so records only count from that date on. Weaker models
// still get a date, flagged as extrapolated/below.
export function analyzeFit(data, fit, mode) {
  const points = data.models.map((m, i) => ({ t: m._t ?? (m._t = toYear(m.date)), c: fit.capability[i], i }));
  const start = data.frontierStart ? toYear(data.frontierStart) : -Infinity;
  const records = frontierRecords(points.filter((p) => p.t >= start));
  if (records.length < 2) return { fit, frontier: null, rows: [] };
  const frontier = buildFrontier(records, mode);
  const recordSet = new Set(records.map((r) => r.i));
  const rows = [];
  for (const p of points) {
    if (!Number.isFinite(p.c)) continue;
    const inv = frontier.inverse(p.c);
    rows.push({
      i: p.i,
      model: data.models[p.i],
      t: p.t,
      c: p.c,
      fdate: inv.t,
      flag: inv.flag,
      lagYears: p.t - inv.t,
      isRecord: recordSet.has(p.i),
      nBench: fit.nBench[p.i],
    });
  }
  return { fit, frontier, rows };
}

// Running best (by frontier-equivalent date and by capability) of `rows` at each grid time.
export function runningBest(rows, grid) {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const out = [];
  let k = 0, best = null, bestC = -Infinity;
  for (const T of grid) {
    while (k < sorted.length && sorted[k].t <= T) {
      if (!best || sorted[k].fdate > best.fdate) best = sorted[k];
      bestC = Math.max(bestC, sorted[k].c);
      k++;
    }
    out.push(best ? { T, best, bestC } : null);
  }
  return out;
}

/**
 * How far each group's best available model trails the best available model overall.
 * At each grid time T:
 *   lagMonths = 12 * (frontier date of best model overall − frontier date of group's best)
 *   capGap    = best capability overall − group's best capability (ECI points, or SD if fit.scale is "relative")
 * The leading group sits at 0; both are zero-or-positive by construction.
 */
export function groupLags(rows, groups, grid) {
  const overall = runningBest(rows, grid);
  const out = {};
  for (const g of groups) {
    const mine = runningBest(rows.filter((r) => r.model.group === g), grid);
    out[g] = grid.map((T, j) => (mine[j] && overall[j] ? {
      T,
      lagMonths: 12 * (overall[j].best.fdate - mine[j].best.fdate),
      capGap: overall[j].bestC - mine[j].bestC,
      best: mine[j].best.model.name,
      leader: overall[j].best.model.name,
    } : null)).filter(Boolean);
  }
  return out;
}

export function monthlyGrid(t0, t1) {
  const grid = [];
  const start = new Date((t0 - 1970) * MS_PER_YEAR);
  let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1;
  for (;;) {
    if (m > 11) { m = 0; y++; }
    const t = 1970 + Date.UTC(y, m, 1) / MS_PER_YEAR;
    if (t > t1) break;
    grid.push(t);
    m++;
  }
  return grid;
}

/**
 * Bootstrap over benchmarks: resample the selected benchmarks with replacement,
 * refit (warm-started), rebuild the frontier and recompute dates.
 * Calls onProgress(done, total) between replicates; yields to the event loop so
 * the page stays responsive.
 * Returns Maps modelIdx -> {lo, hi} for frontier dates (dateCI) and capabilities (capCI),
 * and per-group gap bands in months (lo, hi) and capability (capLo, capHi).
 * Pass fitOpts.reference for a subset so every refit uses the base fit's scale.
 */
export async function bootstrap(data, benchIds, mode, base, opts = {}) {
  const { reps = 40, level = 0.9, seed = 1, groups = [], grid = [], onProgress, fitOpts = {} } = opts;
  const rng = mulberry32(seed);
  const samples = new Map(), capSamples = new Map();
  const lagSamples = Object.fromEntries(groups.map((g) => [g, grid.map(() => [])]));
  const capGapSamples = Object.fromEntries(groups.map((g) => [g, grid.map(() => [])]));
  for (let r = 0; r < reps; r++) {
    const weights = new Map();
    for (let k = 0; k < benchIds.length; k++) {
      const b = benchIds[Math.floor(rng() * benchIds.length)];
      weights.set(b, (weights.get(b) ?? 0) + 1);
    }
    const fit = fitCapabilities(data, benchIds, { ...fitOpts, weights, init: base.fit, iters: 400 });
    const res = analyzeFit(data, fit, mode);
    if (!res.frontier) continue;
    for (const row of res.rows) {
      if (!samples.has(row.i)) { samples.set(row.i, []); capSamples.set(row.i, []); }
      samples.get(row.i).push(row.fdate);
      capSamples.get(row.i).push(row.c);
    }
    if (groups.length) {
      const lags = groupLags(res.rows, groups, grid);
      for (const g of groups) {
        const byT = new Map(lags[g].map((p) => [p.T, p]));
        grid.forEach((T, j) => {
          if (!byT.has(T)) return;
          lagSamples[g][j].push(byT.get(T).lagMonths);
          capGapSamples[g][j].push(byT.get(T).capGap);
        });
      }
    }
    onProgress?.(r + 1, reps);
    await new Promise((res) => setTimeout(res, 0));
  }
  const q = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    const x = (s.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
    return s[lo] + (s[hi] - s[lo]) * (x - lo);
  };
  const a = (1 - level) / 2;
  const dateCI = new Map(), capCI = new Map();
  for (const [i, arr] of samples) {
    if (arr.length < reps / 2) continue;
    const caps = capSamples.get(i);
    dateCI.set(i, { lo: q(arr, a), hi: q(arr, 1 - a) });
    capCI.set(i, { lo: q(caps, a), hi: q(caps, 1 - a) });
  }
  const lagCI = {};
  for (const g of groups)
    lagCI[g] = grid.map((T, j) => {
      const m = lagSamples[g][j], c = capGapSamples[g][j];
      return m.length >= reps / 2 ? { T, lo: q(m, a), hi: q(m, 1 - a), capLo: q(c, a), capHi: q(c, 1 - a) } : null;
    }).filter(Boolean);
  return { dateCI, capCI, lagCI, reps };
}
