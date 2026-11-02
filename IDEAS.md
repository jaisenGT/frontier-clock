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

Open questions: which families have clean ladders (Qwen, Llama and Gemma have several sizes, but recipes differ between sizes), and whether Epoch has scored enough sizes or we need our own runs.

## 3. Per-lab frontier trends ✅ (scatter chart)

**Done:** the "Frontier-equivalent date vs. release date" chart has a **By lab** view: each lab's successive record-setting models joined into a trend line, so you can see which labs lead or trail one another. Labs can be toggled from the legend. Eight labs fit the categorical palette (OpenAI, Anthropic, Google DeepMind, xAI, Meta AI, DeepSeek, Alibaba, Moonshot); Z.ai and Mistral are left out.

**Not done:** the same per-lab breakdown for the "Gap to the frontier" chart. Awkward because the leading lab sits at zero and lab lines would overlap heavily; consider small multiples or a "best lab per group" variant instead.
