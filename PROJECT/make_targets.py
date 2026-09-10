"""
make_targets.py  -  PREPROCESSING STEP 1: create the target (label) columns
==========================================================================

WHAT THIS DOES (plain words)
----------------------------
The feature files only contain INPUTS (what the model sees). A model also
needs the ANSWER for every row so it can learn. This script adds two answer
columns to every row by looking HORIZON_MIN minutes into the future:

  y_flood        : 1 if the river reaches/crosses the flood line at ANY point
                   within the next HORIZON_MIN minutes, else 0.
                   -> target for Head A (the alarm, yes/no)

  level_norm_fut : the river level (as a fraction of the flood line) exactly
                   HORIZON_MIN minutes from now.
                   -> target for Head B (the forecast with q10/q50/q90)

"Flood line" = the station's h_crit_m, already stored in the features file.
level_norm = level_m / h_crit_m, so 1.0 means "at the flood line".

IMPORTANT DETAIL - time gaps
Rows were dropped earlier where the gauge had gaps, so "2 rows ahead" is not
always "30 minutes ahead". We check the actual timestamps and only create a
label when the future rows really are HORIZON_MIN minutes away. Rows whose
future is missing get no label and are dropped.

HOW TO RUN
----------
    py make_targets.py
Reads   flood_dataset/<station>_features.csv
Writes  flood_dataset/<station>_labelled.csv  and  flood_dataset/ALL_STATIONS_labelled.csv
"""

from pathlib import Path
import numpy as np
import pandas as pd

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
STEP_MINUTES = 15          # spacing between rows (must match the downloader)
HORIZON_MIN = 30           # how far ahead we predict. 30 min = 2 rows.
FLOOD_LINE = 1.0           # level_norm value that counts as "flood" (1.0 = h_crit)

# One file per station. The combined ALL_STATIONS file is skipped - it mixes
# stations, so "2 rows ahead" would not mean "30 min ahead at the same site".
STATION_FILES = sorted(f for f in DATA_DIR.glob("*_features.csv")
                       if not f.name.startswith("ALL_STATIONS"))


# =============================================================================
# THE LABELLING FUNCTION
# =============================================================================
def add_targets(df: pd.DataFrame) -> pd.DataFrame:
    """
    Input : one station's features table, sorted by time.
    Output: same table + y_flood + level_norm_fut, rows without a valid
            future removed.
    """
    df = df.sort_values("time").reset_index(drop=True)
    steps = HORIZON_MIN // STEP_MINUTES               # 30 / 15 = 2 rows ahead

    # ---- Is the future actually there? ----------------------------------
    # For every row, the timestamp `steps` rows later must be exactly
    # HORIZON_MIN minutes later. If a gap was dropped in between, it won't be.
    future_time = df["time"].shift(-steps)
    expected = df["time"] + pd.Timedelta(minutes=HORIZON_MIN)
    has_future = future_time == expected

    # ---- Target B: level (fraction of flood line) at t + HORIZON --------
    df["level_norm_fut"] = df["level_norm"].shift(-steps)

    # ---- Target A: does it cross the flood line within the horizon? ----
    # Look at rows t+1 ... t+steps and take the highest level_norm among them.
    # (pandas rolling looks backwards, so we reverse, roll, reverse back.)
    future_max = (
        df["level_norm"][::-1]
        .rolling(window=steps, min_periods=steps)
        .max()[::-1]
        .shift(-1)
    )
    df["y_flood"] = (future_max >= FLOOD_LINE).astype(int)

    # ---- Keep only rows whose future really exists -----------------------
    df = df[has_future & df["level_norm_fut"].notna()].copy()
    return df


# =============================================================================
# RUN FOR EVERY STATION
# =============================================================================
def main() -> None:
    all_parts = []
    for f in STATION_FILES:
        df = pd.read_csv(f, parse_dates=["time"])
        out = add_targets(df)
        name = f.name.replace("_features.csv", "")
        out.to_csv(DATA_DIR / f"{name}_labelled.csv", index=False)

        n_pos = int(out["y_flood"].sum())
        print(f"{name:32s} rows={len(out):>8,}  flood rows={n_pos:>6,} "
              f"({100 * n_pos / len(out):.2f} %)")
        all_parts.append(out)

    combined = pd.concat(all_parts, ignore_index=True)
    combined.to_csv(DATA_DIR / "ALL_STATIONS_labelled.csv", index=False)
    print(f"\nCombined: {len(combined):,} rows -> ALL_STATIONS_labelled.csv")


if __name__ == "__main__":
    main()
