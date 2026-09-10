"""
build_replay.py  -  DEMO DATA: real held-out gauge data for the live replay
===========================================================================

WHAT THIS DOES (plain words)
----------------------------
The live demo used to feed the model a random walk. This script instead cuts
REAL river-gauge data out of ALL_STATIONS_labelled.csv so the controller can
replay it through the running system (see HARDWARE/replay_hardware.py).

It does not re-implement any preprocessing. It imports the pipeline's own steps
and runs them in the same order training did:

  split_data.tag_events + assign_split   whole calendar years, whole flood events
  fit_train_only.apply_params            train-only flood lines, targets recomputed
  transform_scale.tame + build_model_table   the model-ready inputs

So a replayed row carries exactly the inputs and labels the offline test score
was computed on. The parity check at the end proves it against test.npz.

WHICH ROWS
----------
The TEST split (2023-24): data the model never trained on and was never tuned
on. A station with no test rows falls back to validation, then - as a last
resort - to its most recent TRAIN floods. Low Briery (S2) needs that: its
record has no 2021-24 rows at all. Train rows are flagged seen_in_training and
the live scorecard keeps them out of its held-out total, because scoring a
model on data it learned from proves nothing.

A full test year is mostly a quiet river. For a demo, the script keeps windows
around each real flood: LEAD_HOURS of run-up, the flood itself, and TAIL_HOURS
of recession. That selection is disclosed in the metadata and in the UI,
because a scorecard over flood windows is not the same thing as a score over
the whole test year.

HOW TO RUN
----------
    py build_replay.py
Reads   flood_dataset/ALL_STATIONS_labelled.csv, station_params.json,
        preprocess_params.json, test.npz (parity check, optional)
Writes  flood_dataset/replay_test.csv        one row per 15-min step
        flood_dataset/replay_test_meta.json  windows, provenance, parity result
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import fit_train_only
import split_data
import transform_scale

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
INPUT_FILE = DATA_DIR / "ALL_STATIONS_labelled.csv"
STATION_PARAMS = DATA_DIR / "station_params.json"
PREPROCESS_PARAMS = DATA_DIR / "preprocess_params.json"
OUT_CSV = DATA_DIR / "replay_test.csv"
OUT_META = DATA_DIR / "replay_test_meta.json"

STEP_MINUTES = 15
LEAD_HOURS = 12        # run-up shown before each flood
TAIL_HOURS = 6         # recession shown after it
FLOOD_LINE = 1.0       # level_norm at/above this = flooding (same as split_data)
MAX_WINDOWS_PER_NODE = 24   # most recent windows kept per node
SPLIT_PREFERENCE = ("test", "val", "train")   # held-out first; train only as a disclosed last resort

SEQ_COLS = [f"seq_{i}" for i in range(1, 9)]
X_COLS = ["x_dh_dt", "x_d2h_dt2", "x_level_norm", "x_rain_dur", "x_dew_point", "x_vpd", "x_api"]
# Untransformed values carried alongside, for the dashboard only.
RAW_COLS = ["level_m", "water_level", "rain", "rain_mm", "temperature", "humidity",
            "h_crit_m", "level_norm", "dh_dt", "api", "rain_duration_min"]
OUT_COLS = (["node", "station", "split", "window", "kind", "time"] + RAW_COLS
            + SEQ_COLS + X_COLS + ["y_flood", "y_level_fut"])


# =============================================================================
# STEP A - reproduce the model-ready held-out rows with the pipeline's own code
# =============================================================================
def model_ready(split: str, df: pd.DataFrame, params: dict, scaler: dict) -> pd.DataFrame:
    pile = df[df["split"] == split]
    pile = fit_train_only.apply_params(pile, params)                 # frozen numbers + targets
    ready = transform_scale.build_model_table(transform_scale.tame(pile), scaler)
    ready = ready.join(pile[RAW_COLS])                               # same index as `pile`
    needed = SEQ_COLS + X_COLS + ["y_flood", "y_level_fut"]
    ready = ready.dropna(subset=needed)                              # as build_sequences does
    ready["split"] = split
    return ready.sort_values(["station", "time"]).reset_index(drop=True)


# =============================================================================
# STEP B - windows around real floods
# =============================================================================
def contiguous_segments(times: pd.Series) -> np.ndarray:
    """Segment id per row; a new segment starts at any gap in the 15-min grid."""
    gap = times.diff() != pd.Timedelta(minutes=STEP_MINUTES)
    return gap.cumsum().to_numpy()


def flood_windows(g: pd.DataFrame) -> list[tuple[int, int, str]]:
    """(first_row, last_row, kind) windows for one station, never spanning a gap."""
    g = g.reset_index(drop=True)
    seg = contiguous_segments(g["time"])
    flooding = (g["level_norm"] >= FLOOD_LINE).to_numpy()
    lead = LEAD_HOURS * 60 // STEP_MINUTES
    tail = TAIL_HOURS * 60 // STEP_MINUTES

    spans: list[list[int]] = []
    i = 0
    while i < len(g):
        if not flooding[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(g) and flooding[j + 1] and seg[j + 1] == seg[i]:
            j += 1
        lo, hi = max(0, i - lead), min(len(g) - 1, j + tail)
        # clip to the flood's own contiguous segment
        idx = np.where(seg == seg[i])[0]
        lo, hi = max(lo, idx[0]), min(hi, idx[-1])
        if spans and lo <= spans[-1][1] + 1 and seg[lo] == seg[spans[-1][0]]:
            spans[-1][1] = max(spans[-1][1], hi)                     # merge overlaps
        else:
            spans.append([lo, hi])
        i = j + 1

    if spans:
        return [(lo, hi, "flood_event") for lo, hi in spans]

    # No flood at all in this pile: replay the highest-water episode instead,
    # and say so, rather than silently showing a flat river.
    peak = int(g["level_norm"].idxmax())
    idx = np.where(seg == seg[peak])[0]
    return [(max(idx[0], peak - lead), min(idx[-1], peak + lead), "highest_water")]


# =============================================================================
# STEP C - prove the replay equals the offline test inputs
# =============================================================================
def parity_one(rows: pd.DataFrame, npz_path: Path) -> dict:
    """Every replayed row of one split vs the arrays the model was scored/trained on."""
    if not npz_path.exists():
        return {"checked": False, "rows": int(len(rows)), "reason": f"{npz_path.name} not found"}
    d = np.load(npz_path, allow_pickle=True)
    key = {(str(s), str(t)): i for i, (s, t) in enumerate(zip(d["station"], d["time"]))}

    missing, seq_err, x_err, flood_mismatch, level_err = 0, 0.0, 0.0, 0, 0.0
    for r in rows.itertuples(index=False):
        i = key.get((r.station, str(r.time)))
        if i is None:
            missing += 1
            continue
        seq = np.array([getattr(r, c) for c in SEQ_COLS])
        x = np.array([getattr(r, c) for c in X_COLS])
        seq_err = max(seq_err, float(np.abs(seq - d["X_seq"][i, :, 0]).max()))
        x_err = max(x_err, float(np.abs(x - d["X_scalar"][i]).max()))
        flood_mismatch += int(int(r.y_flood) != int(d["y_flood"][i]))
        level_err = max(level_err, abs(float(r.y_level_fut) - float(d["y_level"][i])))

    ok = missing == 0 and flood_mismatch == 0 and max(seq_err, x_err, level_err) < 1e-4
    return {
        "checked": True, "passed": ok, "against": npz_path.name, "rows": int(len(rows)),
        "missing_rows": missing, "y_flood_mismatches": flood_mismatch,
        "max_abs_err_seq": seq_err, "max_abs_err_scalars": x_err, "max_abs_err_y_level": level_err,
    }


def parity_check(replay: pd.DataFrame) -> dict:
    splits = {s: parity_one(replay[replay["split"] == s], DATA_DIR / f"{s}.npz")
              for s in sorted(replay["split"].unique())}
    checked = [p for p in splits.values() if p["checked"]]
    return {
        "checked": bool(checked),
        "passed": bool(checked) and all(p["passed"] for p in checked),
        "rows": int(sum(p["rows"] for p in checked)),
        "missing_rows": int(sum(p["missing_rows"] for p in checked)),
        "y_flood_mismatches": int(sum(p["y_flood_mismatches"] for p in checked)),
        "unchecked_rows": int(sum(p["rows"] for p in splits.values() if not p["checked"])),
        "splits": splits,
    }


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    params = json.loads(STATION_PARAMS.read_text())
    scaler = json.loads(PREPROCESS_PARAMS.read_text())["scaler"]

    print(f"Reading {INPUT_FILE} ...")
    df = pd.read_csv(INPUT_FILE, parse_dates=["time"])
    df = split_data.assign_split(split_data.tag_events(df))

    rows_per_split = (df.groupby(["station", "split"]).size().unstack(fill_value=0)
                      .reindex(columns=list(SPLIT_PREFERENCE), fill_value=0))
    print("Rows per split per station (after split_data):")
    print(rows_per_split.to_string())

    piles: dict[str, pd.DataFrame] = {}
    parts, meta_nodes = [], {}
    for (node, station), _ in df.groupby(["node", "station"]):
        g = pd.DataFrame()
        for split in SPLIT_PREFERENCE:
            if split not in piles:
                piles[split] = model_ready(split, df, params, scaler)
            g = piles[split][piles[split]["station"] == station]
            if not g.empty:
                break
        if g.empty:
            print(f"  ! {node} {station}: no usable rows in any split - skipped")
            continue
        g = g.reset_index(drop=True)
        windows = flood_windows(g)[-MAX_WINDOWS_PER_NODE:]
        info = []
        for w, (lo, hi, kind) in enumerate(windows):
            seg = g.iloc[lo:hi + 1].copy()
            seg["window"], seg["kind"] = w, kind
            parts.append(seg)
            info.append({
                "window": w, "kind": kind,
                "start": str(seg["time"].iloc[0]), "end": str(seg["time"].iloc[-1]),
                "rows": int(len(seg)), "hours": round(len(seg) * STEP_MINUTES / 60, 2),
                "peak_level_norm": round(float(seg["level_norm"].max()), 3),
                "rows_at_or_above_flood_line": int((seg["level_norm"] >= FLOOD_LINE).sum()),
                "y_flood_rows": int(seg["y_flood"].sum()),
            })
        split_used = str(g["split"].iloc[0])
        meta_nodes[node] = {"station": station, "split": split_used,
                            "seen_in_training": split_used == "train",
                            "h_crit_m": params[station]["h_crit_m"], "windows": info}
        print(f"  {node} {station:26s} split={g['split'].iloc[0]:4s}  "
              f"{len(windows)} window(s), {sum(i['rows'] for i in info)} rows")

    replay = pd.concat(parts, ignore_index=True)
    replay["rain"] = replay["rain"].astype(bool).astype(int)
    replay["time"] = replay["time"].astype(str)

    parity = parity_check(replay)
    print("\nParity with the model's own arrays:", json.dumps(parity, indent=2))

    replay[OUT_COLS].to_csv(OUT_CSV, index=False, float_format="%.7g")
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": INPUT_FILE.name,
        "split_years": split_data.SPLIT_YEARS,
        "selection": (f"windows around every flood in the held-out split: {LEAD_HOURS} h "
                      f"run-up, the flood, {TAIL_HOURS} h recession; gap-free 15-min rows only"),
        "step_minutes": STEP_MINUTES,
        "rows": int(len(replay)),
        "rows_per_split_per_station": {st: {k: int(v) for k, v in r.items()}
                                       for st, r in rows_per_split.iterrows()},
        "nodes": meta_nodes,
        "parity_with_test_npz": parity,
    }
    OUT_META.write_text(json.dumps(meta, indent=2))
    nan_env = int(replay[["temperature", "humidity"]].isna().any(axis=1).sum())
    print(f"\nWrote {OUT_CSV} ({len(replay):,} rows, {OUT_CSV.stat().st_size / 1e6:.2f} MB) "
          f"and {OUT_META}.  Rows with missing temp/humidity: {nan_env}")
    if parity.get("checked") and not parity.get("passed"):
        raise SystemExit("Parity check FAILED - the replay does not match the model's arrays.")


if __name__ == "__main__":
    main()
