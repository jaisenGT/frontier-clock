# Ideas

Possible extensions, not yet implemented unless marked.

## 1. Internal-availability dates

Frontier dates use public release, but labs use their best models internally well before release (e.g. Mythos was reportedly available to Anthropic employees in February). This understates the leader's lead.

Options, simplest first:

- **Flat offset:** shift every closed frontier lab's dates earlier by a fixed amount (e.g. 2 months) and show the gap as a range: public-release gap to gap plus the offset.
- **Per-model estimates:** add an optional `internalDate` to `data/model_overrides.json` from public reporting (with a source for each), and a toggle to build the frontier from internal dates where known.

Open questions: which labs to apply it to (open-weights labs presumably have smaller internal leads), and how to cite speculative dates honestly.

## 2. Scaling ladders within an open-weights family

Benchmark one open-weights family at several standardized sizes (e.g. X, 5X and 25X parameters, same data and recipe) and place each on the clock. This shows how many months of frontier progress a given multiple of scale buys, a rough exchange rate between compute and time.

Also useful for safety arguments: it estimates how quickly a given capability level becomes reachable at smaller scale, which bears on proliferation.

**Deprioritized (Nov 2026).** Checked against the data, the ladders are too confounded to show a clean trend:

- **Distillation flattens them.** Qwen3 8B → 235B (~30× parameters) gains only ~3 ECI points (136.1 → 139.1), against ~16 points/year of frontier progress; small siblings likely learn from the big model's outputs.
- **Mixture-of-experts parameters are ambiguous.** gpt-oss-120b has 6× the total parameters of gpt-oss-20b but only ~1.4× the active ones. Training compute would be the better unit.
- **Few usable ladders.** Qwen3, Qwen3.5 (9B → 397B-A17B), Llama 3.1 (70B, 405B only) and gpt-oss (20b, 120b). Clean research ladders (e.g. OLMo) mostly fall below the GPT-4 floor and can't be dated.

If revisited: plot frontier-equivalent date against training compute for all open-weights models instead of within families.
