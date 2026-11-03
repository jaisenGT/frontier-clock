# Frontier Clock

Scores AI models by **frontier-equivalent date**: the date at which a model would have been the most capable model in the world.

## How it works

1. **Capability.** For a chosen set of benchmarks, fit an item-response model in the style of Epoch's Capabilities Index (ECI): `score ≈ sigmoid(a_b · (C_m − D_b))`. Scores are put on the ECI scale: with all benchmarks by pinning Epoch's anchor models (Claude 3.5 Sonnet = 130, GPT-5 = 150), which reproduces Epoch's published ECI (r ≈ 0.997, typically within a point); for a subset of benchmarks by matching the all-benchmarks scores of the same models.
2. **Frontier.** Record-setting models are those more capable at release than every earlier model. The frontier curve F(t) is built from the records:
   - running max: honest but lumpy (site)
   - interpolated records (site default)
   - linear trend, and a two-segment "accelerating" trend (CLI only, for robustness checks)
3. **Date.** A model's score is F⁻¹(C).
4. **Gap.** Each month, compare the best available model per group (US closed, China, non-China open weights) with the best available overall. The gap is shown in months and in capability units.
5. **Uncertainty.** Resample benchmarks with replacement (bootstrap), refit, and take percentile intervals.

All analysis lives in [site/core.js](site/core.js), a dependency-free ES module that runs in both the browser and Node.

## Layout

| Path | What |
|---|---|
| `scripts/serve.py` | Local server with caching disabled, for development |
| `scripts/build_data.py` | Downloads Epoch's `benchmark_data.zip` and writes `site/data/frontier_clock.json` |
| `data/domains.json` | Benchmark → domain mapping (hand-assigned, edit freely) |
| `data/model_overrides.json` | Fills in missing org/country/accessibility in Epoch's data |
| `site/` | Static website (`index.html`, `app.js`, `core.js`, `styles.css`) |
| `cli/analyze.mjs` | Same analysis from the command line |
| `IDEAS.md` | Possible extensions (not yet implemented unless marked) |
| `cli/precompute_intervals.mjs` | Precomputes bootstrap intervals into `site/data/intervals.json` for all-benchmarks and each single domain, every curve mode and minimum; custom selections are computed in the browser |

## Usage

```sh
# refresh data (needs pandas)
python scripts/build_data.py            # or --offline to rebuild from data/raw/
node cli/precompute_intervals.mjs       # 90% intervals for standard selections, 1,000 resamples (~15 min)

# view the site
python scripts/serve.py                 # open http://localhost:8765 (no caching)

# link-preview image (after a data refresh): with the server running, screenshot the card page at 1200x630
chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630   --virtual-time-budget=15000 --screenshot=site/og.png http://localhost:8765/og-card.html

# command line
node cli/analyze.mjs --validate                          # compare with Epoch ECI
node cli/analyze.mjs --mode broken --domain "Math" --top 20
```

Modes: `step`, `interp`, `linear`, `broken`. Domains are listed in `data/domains.json`.

## Known limitations

Most important first. Keep these in mind before quoting any number.

- **Public release dates, not internal availability.** Labs use stronger models internally for months before release, so the true lead of whoever is ahead (today, US labs) is probably *understated*. See [IDEAS.md](IDEAS.md) for a possible correction.
- **Months depend on frontier speed.** If frontier progress speeds up, a constant capability gap appears as a shrinking gap in months (and vice versa). Check the capability-units view before reading a trend in months.
- **Benchmaxxing and contamination.** Capabilities are only as good as Epoch's benchmark scores. A group whose models score higher on public benchmarks than their real-world capability would look closer to the frontier than it is. This is a limitation of the input data that we inherit rather than fix.
- **Winner's curse in the frontier records.** A record is a model whose *estimated* capability beats every earlier model, so estimation noise biases the record frontier upward and every other model's lag slightly upward. The benchmark bootstrap re-selects records but doesn't remove the bias. Small for now, but worth checking (e.g. require records to beat the previous one by more than their CI).
- **Benchmark coverage differs by group.** The median US closed model is scored on ~16 benchmarks, the median Chinese or non-China open-weights model on ~8–9, since expensive benchmarks are mostly run on frontier models. The IRT fit tolerates missing scores, but not systematically missing ones. Acceptable as long as each group's leading models are well covered; check the "Benchmarks" column for any model a headline number depends on.
- **Interpolation can squeeze dates when records cluster.** In `interp` mode, two records set days apart (e.g. Claude Fable 5.1 and GPT-6 Astra, Sep 2026) map every capability between them to those few days. Deliberately kept simple for now; the running-max mode is the cross-check.
- **Gap is measured against the overall leader.** The US closed lag is zero whenever a US closed model leads, by construction. US open-weights models (Llama, gpt-oss) count as "Open weights (non-China)"; Chinese models count as "China" whatever their access.
- Epoch's data starts in Feb 2023. Frontier records count only from GPT-4 (2023-03-14); weaker models get extrapolated dates, which are flagged.
- These benchmarks have no published descriptions yet and are unclassified: LMCA, DTBench, CL-bench, CL-bench Life.

## Data

Epoch AI, "Capabilities & benchmarking", https://epoch.ai/benchmarks, licensed CC BY 4.0. Underlying external benchmark results keep their original licenses.

## Contact

Questions, feedback or corrections: jaisen9911@gmail.com, or open an issue on GitHub.

## License

Code: [MIT](LICENSE). Data: Epoch AI's benchmark data, CC BY 4.0 (see [Data](#data)); the generated files in `site/data/` are derived from it and keep that license.
