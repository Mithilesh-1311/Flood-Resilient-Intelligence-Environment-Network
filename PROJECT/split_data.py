"""
split_data.py  -  PREPROCESSING STEP 2: split into train / validation / test
============================================================================

WHAT THIS DOES (plain words)
----------------------------
Cuts the labelled data into three piles the model will use differently:

  train      : the model learns from these rows
  validation : used while training to decide when to stop / pick settings
  test       : touched ONCE at the very end to report the honest score

RULE 1 - split by TIME, never at random.
  Rows 15 minutes apart are almost identical. If row 10:00 is in train and
  row 10:15 is in test, the model just "remembers" and looks perfect while
  having learned nothing. So whole calendar years go into one pile.

RULE 2 - never cut a flood event in half.
  A flood that starts on 31 Dec and ends on 2 Jan would otherwise have its
  rising limb in one pile and its peak in another. We find every flood event
  (a continuous stretch at/above the flood line, padded by a few hours on
  each side) and move the WHOLE event into the pile where it started.

HOW TO RUN
----------
    py split_data.py
Reads   flood_dataset/ALL_STATIONS_labelled.csv
Writes  flood_dataset/train.csv, val.csv, test.csv
        (+ ALL_STATIONS_split.csv = everything with a 'split' column)
"""

from pathlib import Path
import pandas as pd

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
INPUT_FILE = DATA_DIR / "ALL_STATIONS_labelled.csv"

# Which years go to which pile. Everything not listed is dropped.
SPLIT_YEARS = {
    "train": [2015, 2016, 2017, 2018, 2019, 2020],
    "val":   [2021, 2022],
    "test":  [2023, 2024],
}

FLOOD_LINE = 1.0        # level_norm at/above this = flooding
EVENT_PAD_HOURS = 6     # hours added before and after each flood so the whole
                        # rising limb and recession count as part of the event
STEP_MINUTES = 15


# =============================================================================
# STEP A - give every flood event an id (per station)
# =============================================================================
def tag_events(df: pd.DataFrame) -> pd.DataFrame:
    """
    Adds a column 'event_id':
        -1  = normal (dry) row
        0,1,2... = which flood event this row belongs to (per station)
    An event = a run of rows at/above the flood line, widened by
    EVENT_PAD_HOURS on both sides so the run-up and run-down are included.
    """
    df = df.sort_values(["station", "time"]).reset_index(drop=True)
    pad_rows = int(EVENT_PAD_HOURS * 60 / STEP_MINUTES)

    df["event_id"] = -1
    for station, grp in df.groupby("station", sort=False):
        flooding = (grp["level_norm"] >= FLOOD_LINE).to_numpy()

        # widen every flooding row by pad_rows on each side
        widened = pd.Series(flooding).rolling(2 * pad_rows + 1, center=True,
                                              min_periods=1).max().astype(bool).to_numpy()

        # number the continuous runs: a new run starts where widened flips 0 -> 1
        starts = widened & ~pd.Series(widened).shift(1, fill_value=False).to_numpy()
        run_number = starts.cumsum() - 1          # 0,0,0,1,1,2,...
        ids = pd.Series(run_number).where(widened, -1).to_numpy()
        df.loc[grp.index, "event_id"] = ids
    return df


# =============================================================================
# STEP B - assign a pile by year, then move whole events to where they started
# =============================================================================
def assign_split(df: pd.DataFrame) -> pd.DataFrame:
    year_to_split = {y: name for name, years in SPLIT_YEARS.items() for y in years}
    df["split"] = df["time"].dt.year.map(year_to_split)

    # For every flood event, find the split of its FIRST row and stamp it on
    # every row of that event - so an event never straddles two piles.
    is_event = df["event_id"] >= 0
    first_split = (
        df[is_event]
        .groupby(["station", "event_id"])["split"]
        .first()
        .rename("event_split")
    )
    df = df.join(first_split, on=["station", "event_id"])
    df.loc[is_event, "split"] = df.loc[is_event, "event_split"]
    df = df.drop(columns="event_split")

    # rows from years not listed in SPLIT_YEARS have split = NaN -> drop them
    return df[df["split"].notna()].copy()


# =============================================================================
# STEP C - report and save
# =============================================================================
def report(df: pd.DataFrame) -> None:
    print("\nRows and flood rows per pile:")
    summary = df.groupby("split").agg(rows=("y_flood", "size"),
                                      flood_rows=("y_flood", "sum"))
    summary["flood_%"] = (100 * summary["flood_rows"] / summary["rows"]).round(2)
    print(summary.loc[["train", "val", "test"]].to_string())

    print("\nFlood events per station per pile:")
    ev = (df[df["event_id"] >= 0]
          .groupby(["split", "station"])["event_id"].nunique()
          .unstack(fill_value=0))
    print(ev.reindex(["train", "val", "test"]).to_string())

    print("\nDate range per pile:")
    rng = df.groupby("split")["time"].agg(["min", "max"])
    print(rng.loc[["train", "val", "test"]].to_string())


def main() -> None:
    df = pd.read_csv(INPUT_FILE, parse_dates=["time"])
    df = tag_events(df)
    df = assign_split(df)

    for name in ("train", "val", "test"):
        part = df[df["split"] == name]
        part.to_csv(DATA_DIR / f"{name}.csv", index=False)
    df.to_csv(DATA_DIR / "ALL_STATIONS_split.csv", index=False)

    report(df)
    print(f"\nSaved train.csv / val.csv / test.csv in {DATA_DIR}/")


if __name__ == "__main__":
    main()
