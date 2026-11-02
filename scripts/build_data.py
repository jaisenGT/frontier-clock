"""Download Epoch AI's benchmarking data and build site/data/frontier_clock.json.

Usage:
    python scripts/build_data.py            # download fresh zip, then build
    python scripts/build_data.py --offline  # rebuild from data/raw/ only

Data: Epoch AI, 'Capabilities & benchmarking' (CC BY 4.0), https://epoch.ai/benchmarks
"""

import argparse
import hashlib
import io
import json
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
DOMAINS_FILE = ROOT / "data" / "domains.json"
OVERRIDES_FILE = ROOT / "data" / "model_overrides.json"
OUT_FILE = ROOT / "site" / "data" / "frontier_clock.json"
ZIP_URL = "https://epoch.ai/data/benchmark_data.zip"

ECI_DIR = "epoch_capabilities_index"

# The frontier starts here: Epoch's data begins in Feb 2023 with open models, while
# the frontier models of the time (GPT-3.5, PaLM, Claude 1) are missing, so GPT-4 is
# the first model we trust as a frontier record. Models weaker than it (by Epoch's
# ECI) can't be dated within the data's coverage, and dropping them barely moves
# anyone else's dates, so they are left out entirely.
FRONTIER_START_MODEL = "GPT-4 (Mar 2023)"
MIN_MODELS_PER_BENCHMARK = 6


def download():
    print(f"Downloading {ZIP_URL}")
    with urllib.request.urlopen(ZIP_URL) as resp:
        payload = resp.read()
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        # Only extract the files we need, and never anything with a path outside RAW_DIR.
        wanted = {
            f"{ECI_DIR}/processed_data_for_eci.csv",
            f"{ECI_DIR}/eci_scores.csv",
            "benchmark_metadata.csv",
        }
        for name in zf.namelist():
            if name in wanted:
                target = RAW_DIR / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(zf.read(name))
    (RAW_DIR / "DOWNLOADED").write_text(date.today().isoformat())


def text(v):
    return v if isinstance(v, str) else ""


def num(v):
    return None if pd.isna(v) else float(v)


def group_of(country, access_group):
    """Coarse grouping used for the gap analysis."""
    countries = {c.strip() for c in str(country).split(",")}
    if "China" in countries:
        return "China"
    if access_group == "Open weights":
        return "Open weights (non-China)"
    # Epoch's "Other" accessibility (hosted-only, limited, unreleased) is closed too.
    if "United States of America" in countries:
        return "US closed"
    return "Other"


def build():
    scores = pd.read_csv(RAW_DIR / ECI_DIR / "processed_data_for_eci.csv")
    eci = pd.read_csv(RAW_DIR / ECI_DIR / "eci_scores.csv")
    bmeta = pd.read_csv(RAW_DIR / "benchmark_metadata.csv").set_index("benchmark")
    domain_map = json.loads(DOMAINS_FILE.read_text())["domains"]
    bench_domain = {b: d for d, bs in domain_map.items() for b in bs}

    overrides = json.loads(OVERRIDES_FILE.read_text())["models"]

    eci = eci.dropna(subset=["date"])
    anchor = eci.loc[eci["Model"] == FRONTIER_START_MODEL].iloc[0]
    frontier_start = anchor["date"]
    weak = eci["eci"] < anchor["eci"]
    print(f"Dropping {int(weak.sum())} models with ECI below {FRONTIER_START_MODEL} ({anchor['eci']})")
    eci = eci[~weak].sort_values(["date", "Model"]).reset_index(drop=True)
    model_idx = {m: i for i, m in enumerate(eci["Model"])}
    models = []
    for _, r in eci.iterrows():
        m = {
            "name": text(r["Display name"]) or r["Model"],
            "id": r["Model"],
            "date": r["date"],
            "org": text(r["Organization"]),
            "country": text(r["Country (of organization)"]),
            "access": text(r["Accessibility group"]),
            "eci": num(r["eci"]),
            "eciLow": num(r["eci_ci_low"]),
            "eciHigh": num(r["eci_ci_high"]),
        }
        m.update(overrides.get(r["Model"], {}))
        if not m["org"]:
            print(f"Warning: no organization for {r['Model']}; add it to {OVERRIDES_FILE.name}")
        m["group"] = group_of(m["country"], m["access"])
        models.append(m)

    scores = scores[scores["Model"].isin(model_idx)]
    # Benchmarks that only scored the dropped models (mostly saturated 2023-era ones)
    # can't anchor anything with a handful of scores left.
    per_bench = scores.groupby("benchmark")["Model"].nunique()
    sparse = per_bench[per_bench < MIN_MODELS_PER_BENCHMARK]
    if len(sparse):
        print(f"Dropping {len(sparse)} benchmarks with < {MIN_MODELS_PER_BENCHMARK} models: {', '.join(sparse.index)}")
    scores = scores[~scores["benchmark"].isin(sparse.index)]
    bench_names = sorted(scores["benchmark"].unique())
    bench_idx = {b: i for i, b in enumerate(bench_names)}
    benchmarks = []
    for b in bench_names:
        sub = scores[scores["benchmark"] == b]
        benchmarks.append({
            "name": b,
            "domain": bench_domain.get(b, "Unclassified"),
            "released": bmeta.loc[b, "release_date"] if b in bmeta.index else None,
            "nModels": int(sub["Model"].nunique()),
        })
    missing = [b for b in bench_names if b not in bench_domain]
    if missing:
        print(f"Warning: no domain for {missing}; assigned 'Unclassified'")

    # Mean over any duplicate (model, benchmark) rows.
    agg = scores.groupby(["Model", "benchmark"], as_index=False)["performance"].mean()
    triples = [
        [model_idx[r.Model], bench_idx[r.benchmark], round(float(r.performance), 5)]
        for r in agg.itertuples()
    ]

    out = {
        "source": "Epoch AI, 'Capabilities & benchmarking' (CC BY 4.0), https://epoch.ai/benchmarks",
        "retrieved": (RAW_DIR / "DOWNLOADED").read_text().strip() if (RAW_DIR / "DOWNLOADED").exists() else None,
        "frontierStart": frontier_start,
        # Epoch pins ECI by fixing two models' scores; they are the rows without a CI.
        # Our fitted capabilities are put on the same scale through these anchors.
        "anchors": [{"id": m["id"], "value": m["eci"]} for m in models if m["eciLow"] is None and m["eci"] is not None],
        "domains": [d for d in domain_map if any(b["domain"] == d for b in benchmarks)],
        "models": models,
        "benchmarks": benchmarks,
        "scores": triples,
    }
    # Content hash, so precomputed intervals can be matched to the data they came from.
    out["version"] = hashlib.sha256(json.dumps(out, sort_keys=True).encode()).hexdigest()[:12]
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {OUT_FILE.relative_to(ROOT)}: {len(models)} models, "
          f"{len(benchmarks)} benchmarks, {len(triples)} scores (version {out['version']})")
    print("Now run: node cli/precompute_intervals.mjs")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip download, use data/raw/")
    args = ap.parse_args()
    if not args.offline:
        download()
    build()
