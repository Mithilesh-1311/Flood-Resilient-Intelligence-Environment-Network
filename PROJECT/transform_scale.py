"""
transform_scale.py  -  PREPROCESSING STEPS 4 + 5: tame skewed columns, then scale
=================================================================================

WHAT THIS DOES (plain words)
----------------------------
Step 4 - tame the wild columns
  rain_duration_min, api        -> log1p  (squashes huge values, keeps small ones)
  dh_dt, d2h_dt2                -> signed log: sign(x) * log1p(|x| * 100)
                                   (extremes squashed, sign and order kept;
                                   clipping was tried and it flattened the
                                   flood rising limbs - floods are only 1 %
                                   of rows, so any percentile cut lands on them)

Step 5 - put every input on a similar scale
  the 7 scalar inputs           -> (x - mean) / std, mean & std from TRAIN
  the 8-step level window       -> divided by the station's flood line, so
                                   1.0 always means "at the flood line"

Every number used here (percentiles, means, stds) is learned from TRAIN
only and saved to preprocess_params.json - the live system will load the
same file at demo time.

OUTPUT: one "model-ready" file per pile with ONLY what the network eats:
  seq_1 .. seq_8         the level window, oldest first  (GRU input)
  x_dh_dt, x_d2h_dt2, x_level_norm, x_rain_dur, x_dew_point, x_vpd, x_api
                         the 7 scaled scalars           (dense input)
  y_flood, y_level_fut   the two targets
  time, station, node    kept for bookkeeping, NOT model inputs

HOW TO RUN
----------
    py transform_scale.py          (after fit_train_only.py)
Reads   flood_dataset/train.csv, val.csv, test.csv, station_params.json
Writes  flood_dataset/train_ready.csv, val_ready.csv, test_ready.csv
        flood_dataset/preprocess_params.json
"""

import json
from pathlib import Path
import numpy as np
import pandas as pd

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
SPLITS = ["train", "val", "test"]
STATION_PARAMS = DATA_DIR / "station_params.json"
OUT_PARAMS = DATA_DIR / "preprocess_params.json"

LOG_COLS = ["rain_duration_min", "api"]           # step 4a: log1p (values >= 0)

# step 4b: SIGNED log for columns that can be negative (falling river).
#   sign(x) * log1p(|x| * SCALE)
# Why not clipping: floods are ~1 % of rows, so any percentile clip lands on
# the flood rising limbs and flattens exactly what we need. Signed log keeps
# +/-, keeps the ordering (2 m/h is still bigger than 0.5 m/h) and just
# squashes the extremes. SCALE puts the "interesting" range near 1:
#   dh_dt   in m/h -> x100 = cm/h   (0.05 m/h -> log1p(5)  = 1.8,  2 m/h -> 5.3)
#   d2h_dt2 in m/h^2 -> x100        (same idea)
SIGNED_LOG_COLS = {"dh_dt": 100.0, "d2h_dt2": 100.0}

# the 7 scalar inputs after step 4, and the short names they get in the output
SCALAR_COLS = {
    "dh_dt":             "x_dh_dt",
    "d2h_dt2":           "x_d2h_dt2",
    "level_norm":        "x_level_norm",
    "rain_duration_min": "x_rain_dur",
    "dew_point_c":       "x_dew_point",
    "vpd_kpa":           "x_vpd",
    "api":               "x_api",
}
LAG_STEPS = 8


# =============================================================================
# STEP 4 - tame (same function for fit and apply; params decide the numbers)
# =============================================================================
def tame(df: pd.DataFrame) -> pd.DataFrame:
    """Nothing here is learned from data - pure formulas, same for every pile."""
    df = df.copy()
    for c in LOG_COLS:
        df[c] = np.log1p(df[c].clip(lower=0))       # log(1 + x); x >= 0 guaranteed
    for c, scale in SIGNED_LOG_COLS.items():
        df[c] = np.sign(df[c]) * np.log1p(np.abs(df[c]) * scale)
    return df


# =============================================================================
# STEP 5 - scale
# =============================================================================
def fit_scaler(train_tamed: pd.DataFrame) -> dict:
    """mean and std of each scalar column, from (already tamed) train."""
    return {c: {"mean": float(train_tamed[c].mean()),
                "std": float(train_tamed[c].std() + 1e-9)}
            for c in SCALAR_COLS}


def build_model_table(df: pd.DataFrame, scaler: dict) -> pd.DataFrame:
    """Produce the model-ready table: window + scaled scalars + targets."""
    out = pd.DataFrame({
        "time": df["time"], "station": df["station"], "node": df["node"],
    })

    # 8-step window, OLDEST FIRST (lag_8 ... lag_1), in flood-line units.
    # A GRU reads left to right, so the sequence must run past -> present.
    for i, k in enumerate(range(LAG_STEPS, 0, -1), start=1):
        out[f"seq_{i}"] = df[f"level_lag_{k}"] / df["h_crit_m"]

    # 7 scalars, standardised
    for c, name in SCALAR_COLS.items():
        out[name] = (df[c] - scaler[c]["mean"]) / scaler[c]["std"]

    # targets
    out["y_flood"] = df["y_flood"].astype(int)
    out["y_level_fut"] = df["level_norm_fut"]
    return out


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    piles = {s: pd.read_csv(DATA_DIR / f"{s}.csv", parse_dates=["time"]) for s in SPLITS}

    # ---- fit on train ------------------------------------------------------
    train_tamed = tame(piles["train"])
    scaler = fit_scaler(train_tamed)

    params = {"log_cols": LOG_COLS, "signed_log_cols": SIGNED_LOG_COLS,
              "scaler": scaler, "lag_steps": LAG_STEPS,
              "station_params": json.loads(STATION_PARAMS.read_text())}
    OUT_PARAMS.write_text(json.dumps(params, indent=2))

    print("Tamed dh_dt range in train (signed-log units):",
          f"[{train_tamed['dh_dt'].min():.2f}, {train_tamed['dh_dt'].max():.2f}]")
    print("Scaler (from train):")
    for c, s in scaler.items():
        print(f"  {c:18s} mean={s['mean']:8.3f}  std={s['std']:8.3f}")

    # ---- apply to every pile -----------------------------------------------
    print("\nWriting model-ready files:")
    for s in SPLITS:
        tamed = tame(piles[s])
        ready = build_model_table(tamed, scaler).dropna()
        ready.to_csv(DATA_DIR / f"{s}_ready.csv", index=False)
        print(f"  {s:5s} -> {s}_ready.csv  rows={len(ready):>8,}  "
              f"cols={len(ready.columns)}  flood={ready['y_flood'].mean() * 100:.2f} %")

    print(f"\nSaved {OUT_PARAMS}")


if __name__ == "__main__":
    main()
