"""
fit_train_only.py  -  PREPROCESSING STEP 3: compute station numbers from TRAIN only
===================================================================================

WHAT THIS DOES (plain words)
----------------------------
Two numbers per station were originally computed over ALL ten years:

  level min / max  -> used to build water_level (0-100 %)
  h_crit_m         -> the flood line (99th percentile of level), used to build
                      level_norm, y_flood and level_norm_fut

Using all years means the flood line "knows" how high the 2023-24 floods
went - which is the test set. That is leakage. This script recomputes those
numbers from TRAIN rows only, freezes them in a small JSON file, and applies
the same frozen numbers to train, val and test. Because the flood line moves,
the targets (y_flood, level_norm_fut) are recomputed too.

The JSON file is also what the live system will use at demo time - the same
frozen numbers, no peeking.

HOW TO RUN
----------
    py fit_train_only.py          (after split_data.py)
Reads   flood_dataset/train.csv, val.csv, test.csv
Writes  the same three files, updated in place
        flood_dataset/station_params.json   (the frozen numbers)
"""

import json
from pathlib import Path
import pandas as pd

from make_targets import add_targets          # reuse the labelling logic from step 1

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
SPLITS = ["train", "val", "test"]
H_CRIT_PERCENTILE = 0.99      # flood line = this percentile of TRAIN level
PARAMS_FILE = DATA_DIR / "station_params.json"


# =============================================================================
# STEP A - learn the numbers from train
# =============================================================================
def fit_params(train: pd.DataFrame) -> dict:
    """For each station: level min, level max, flood line - from train rows only."""
    params = {}
    for station, grp in train.groupby("station"):
        params[station] = {
            "level_min_m": float(grp["level_m"].min()),
            "level_max_m": float(grp["level_m"].max()),
            "h_crit_m": float(grp["level_m"].quantile(H_CRIT_PERCENTILE)),
            "train_rows": int(len(grp)),
        }
    return params


# =============================================================================
# STEP B - apply the frozen numbers to any pile
# =============================================================================
def apply_params(df: pd.DataFrame, params: dict) -> pd.DataFrame:
    """
    Rebuild water_level, h_crit_m, level_norm and the 8 lag columns' partner
    (level_norm is what the model uses), then recompute the targets.
    Done station by station so each station uses its own numbers.
    """
    parts = []
    for station, grp in df.groupby("station", sort=False):
        p = params.get(station)
        if p is None:
            # a station with no train rows cannot be scaled honestly - skip it
            print(f"  ! {station} has no train rows - dropped from this pile")
            continue
        g = grp.copy()
        span = p["level_max_m"] - p["level_min_m"]
        g["water_level"] = ((g["level_m"] - p["level_min_m"]) / span * 100.0).clip(0, 100)
        g["h_crit_m"] = p["h_crit_m"]
        g["level_norm"] = g["level_m"] / p["h_crit_m"]
        # targets depend on level_norm, so redo them with the new flood line
        g = g.drop(columns=["y_flood", "level_norm_fut"], errors="ignore")
        g = add_targets(g)
        parts.append(g)
    return pd.concat(parts, ignore_index=True)


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    piles = {s: pd.read_csv(DATA_DIR / f"{s}.csv", parse_dates=["time"]) for s in SPLITS}

    params = fit_params(piles["train"])
    PARAMS_FILE.write_text(json.dumps(params, indent=2))
    print("Frozen numbers (from TRAIN only):")
    for st, p in params.items():
        print(f"  {st:28s} min={p['level_min_m']:.3f}  max={p['level_max_m']:.3f}  "
              f"flood line={p['h_crit_m']:.3f} m")

    print("\nApplying to every pile and recomputing targets:")
    for s in SPLITS:
        out = apply_params(piles[s], params)
        out.to_csv(DATA_DIR / f"{s}.csv", index=False)
        n_pos = int(out["y_flood"].sum())
        print(f"  {s:5s} rows={len(out):>8,}  flood rows={n_pos:>6,} ({100 * n_pos / len(out):.2f} %)")

    print(f"\nSaved {PARAMS_FILE}")


if __name__ == "__main__":
    main()
