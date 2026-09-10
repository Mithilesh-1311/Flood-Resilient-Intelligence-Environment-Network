"""
build_sequences.py  -  PREPROCESSING STEP 6: package the tables into model arrays
================================================================================

WHAT THIS DOES (plain words)
----------------------------
The *_ready.csv files are flat spreadsheets. A GRU does not eat spreadsheets;
it eats arrays shaped (rows, time-steps, values). This script reshapes each
pile into four arrays and saves them in one compressed .npz file:

  X_seq    (N, 8, 1)  the 8-step level window, OLDEST FIRST  -> GRU input
  X_scalar (N, 7)     the 7 scaled "right now" numbers        -> dense input
  y_flood  (N,)       0/1 - flood within 30 min?              -> Head A target
  y_level  (N,)       level (flood-line units) at +30 min     -> Head B target

Also stored, for bookkeeping only (never fed to the model):
  time     (N,)  timestamps as strings
  station  (N,)  station name  - lets you score per station later

Steps 8 and 9 of the plan happen here for free:
  8. rows with any missing value are dropped  (a NaN would poison training)
  9. station / node are NOT included in X    (the model must not memorise sites)

HOW TO RUN
----------
    py build_sequences.py          (after transform_scale.py)
Reads   flood_dataset/train_ready.csv, val_ready.csv, test_ready.csv
Writes  flood_dataset/train.npz, val.npz, test.npz
"""

from pathlib import Path
import numpy as np
import pandas as pd

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
SPLITS = ["train", "val", "test"]

LAG_STEPS = 8
SEQ_COLS = [f"seq_{i}" for i in range(1, LAG_STEPS + 1)]       # seq_1 = oldest
SCALAR_COLS = ["x_dh_dt", "x_d2h_dt2", "x_level_norm", "x_rain_dur",
               "x_dew_point", "x_vpd", "x_api"]


# =============================================================================
# THE RESHAPE
# =============================================================================
def to_arrays(df: pd.DataFrame) -> dict:
    """Turn one pile's table into the four model arrays (+ bookkeeping)."""
    needed = SEQ_COLS + SCALAR_COLS + ["y_flood", "y_level_fut"]
    df = df.dropna(subset=needed).reset_index(drop=True)      # step 8

    return {
        # (N, 8) -> (N, 8, 1): each time-step carries ONE number (the level)
        "X_seq":    df[SEQ_COLS].to_numpy(dtype=np.float32).reshape(-1, LAG_STEPS, 1),
        "X_scalar": df[SCALAR_COLS].to_numpy(dtype=np.float32),
        "y_flood":  df["y_flood"].to_numpy(dtype=np.float32),
        "y_level":  df["y_level_fut"].to_numpy(dtype=np.float32),
        # bookkeeping - stored as strings, never used as input (step 9)
        "time":     df["time"].astype(str).to_numpy(),
        "station":  df["station"].astype(str).to_numpy(),
    }


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    for s in SPLITS:
        df = pd.read_csv(DATA_DIR / f"{s}_ready.csv")
        arr = to_arrays(df)
        np.savez_compressed(DATA_DIR / f"{s}.npz", **arr)
        print(f"{s:5s}  X_seq={arr['X_seq'].shape}  X_scalar={arr['X_scalar'].shape}  "
              f"y_flood={arr['y_flood'].shape}  floods={int(arr['y_flood'].sum()):,}  "
              f"-> {s}.npz")

    # quick sanity check on the very first training row
    d = np.load(DATA_DIR / "train.npz")
    print("\nSanity - first train window (oldest -> newest, flood-line units):")
    print("  ", np.round(d["X_seq"][0, :, 0], 3))
    print("   scalars:", np.round(d["X_scalar"][0], 2))
    print("   y_flood:", d["y_flood"][0], " y_level:", round(float(d["y_level"][0]), 3))


if __name__ == "__main__":
    main()
