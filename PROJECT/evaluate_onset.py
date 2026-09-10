"""
evaluate_onset.py  -  the HONEST score: onset-only warnings and lead time
=========================================================================

WHY THIS SCRIPT EXISTS (plain words)
------------------------------------
train_gru.py scores every row, including rows where the river is ALREADY
above the flood line. Those are easy ("it's flooding now, so it will still
be flooding in 30 min") and they inflate POD/CSI.

An early-warning system is judged on something harder:
  "While the river was still BELOW the line, did we raise the alarm
   before it crossed - and how many minutes before?"

This script answers that, three ways:

  1. ONSET ROW METRICS  - POD / FAR / CSI computed only on rows where the
                          river is currently below the flood line.
  2. EVENT-LEVEL SCORE  - for every flood event: was there ANY alarm in the
                          hours before the crossing?  (caught / missed)
  3. LEAD TIME          - minutes between the FIRST alarm and the crossing,
                          per event; reported as median and mean.
  plus false-alarm episodes: alarm runs below the line that were NOT
  followed by a crossing within 30 min.

HOW TO RUN
----------
    py evaluate_onset.py             (after train_gru.py)
Reads   flood_dataset/test.npz, preprocess_params.json,
        models/flood_gru.keras, models/threshold.json
Writes  models/onset_metrics.json, models/event_lead_times.csv
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import tensorflow as tf
from tensorflow import keras

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
MODEL_DIR = Path("models")
SPLIT = "test"                 # which pile to score (use "val" while tuning)

STEP_MINUTES = 15
HORIZON_MIN = 30               # must match make_targets.py
FLOOD_LINE = 1.0               # level_norm at/above this = flooding
LOOKBACK_HOURS = 6             # how far before a crossing we look for the first alarm
MAX_SILENT_ROWS = 2            # alarm may flicker off for at most this many rows (30 min)
                               # and still count as one continuous warning
MC_SAMPLES = 20                # dropout passes, same as training


# =============================================================================
# LOAD EVERYTHING
# =============================================================================
def load_inputs():
    d = np.load(DATA_DIR / f"{SPLIT}.npz", allow_pickle=True)
    params = json.loads((DATA_DIR / "preprocess_params.json").read_text())
    thr = json.loads((MODEL_DIR / "threshold.json").read_text())["threshold"]
    # compile=False: we only predict, so the custom losses are not needed
    model = keras.models.load_model(MODEL_DIR / "flood_gru.keras", compile=False)
    return d, params, thr, model


def predict_prob(model, X_seq, X_scalar, batch=20000) -> np.ndarray:
    """Mean flood probability over MC_SAMPLES dropout passes, in chunks."""
    out = []
    for i in range(0, len(X_seq), batch):
        ps = [model([X_seq[i:i + batch], X_scalar[i:i + batch]], training=True)[0].numpy()[:, 0]
              for _ in range(MC_SAMPLES)]
        out.append(np.mean(ps, axis=0))
    return np.concatenate(out)


def current_level_norm(X_scalar: np.ndarray, params: dict) -> np.ndarray:
    """
    Undo the standardisation of x_level_norm (column 2) to get the river's
    CURRENT level in flood-line units. Needed to know "below the line now?".
    """
    s = params["scaler"]["level_norm"]
    return X_scalar[:, 2] * s["std"] + s["mean"]


# =============================================================================
# 1. ONSET ROW METRICS
# =============================================================================
def row_metrics(y, alarm) -> dict:
    y = y.astype(bool)
    hits = int(np.sum(alarm & y)); misses = int(np.sum(~alarm & y)); fa = int(np.sum(alarm & ~y))
    return {"rows": int(len(y)), "positives": int(y.sum()), "hits": hits, "misses": misses,
            "false_alarms": fa,
            "POD": round(hits / max(hits + misses, 1), 3),
            "FAR": round(fa / max(hits + fa, 1), 3),
            "CSI": round(hits / max(hits + misses + fa, 1), 3)}


# =============================================================================
# 2 + 3. EVENT-LEVEL SCORE AND LEAD TIME
# =============================================================================
def event_analysis(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """
    df has columns: time, station, level_norm, alarm  (one station at a time
    is handled inside). Walks through time, finds each crossing of the flood
    line, and looks back up to LOOKBACK_HOURS (stopping at any data gap) for
    the first alarm.
    """
    lookback_rows = int(LOOKBACK_HOURS * 60 / STEP_MINUTES)
    step = pd.Timedelta(minutes=STEP_MINUTES)
    horizon_rows = HORIZON_MIN // STEP_MINUTES
    events, fa_episodes = [], 0

    for station, g in df.groupby("station", sort=False):
        g = g.sort_values("time").reset_index(drop=True)
        t = g["time"].to_numpy(); lvl = g["level_norm"].to_numpy(); al = g["alarm"].to_numpy()
        above = lvl >= FLOOD_LINE
        # a crossing = row is above AND previous row (15 min earlier, no gap) was below
        prev_below = np.r_[False, ~above[:-1]]
        contiguous = np.r_[False, (t[1:] - t[:-1]) == step]
        crossings = np.where(above & prev_below & contiguous)[0]

        for c in crossings:
            # Walk backwards from the crossing. Keep going while the alarm is
            # "sustained": no silent stretch longer than MAX_SILENT_ROWS. The
            # earliest alarm row reached this way is the start of the warning.
            # (A lone alarm hours earlier, followed by silence, does not count.)
            first_alarm = None
            silent = 0
            i = c - 1
            while i >= 0 and c - i <= lookback_rows and (t[i + 1] - t[i]) == step and lvl[i] < FLOOD_LINE:
                if al[i]:
                    first_alarm = i
                    silent = 0
                else:
                    silent += 1
                    if silent > MAX_SILENT_ROWS:
                        break
                i -= 1
            lead = None if first_alarm is None else int((t[c] - t[first_alarm]) / pd.Timedelta(minutes=1))
            events.append({"station": station, "crossing_time": t[c], "caught": first_alarm is not None,
                           "lead_time_min": lead})

        # false-alarm episodes: contiguous alarm runs below the line with no
        # crossing within HORIZON after the run ends
        below_alarm = al & ~above
        run_start = below_alarm & ~np.r_[False, below_alarm[:-1]]
        for s_idx in np.where(run_start)[0]:
            e = s_idx
            while e + 1 < len(g) and below_alarm[e + 1]:
                e += 1
            future = above[e + 1:e + 1 + horizon_rows]
            if not future.any():
                fa_episodes += 1

    ev = pd.DataFrame(events)
    caught = ev["caught"].sum() if len(ev) else 0
    leads = ev.loc[ev["caught"], "lead_time_min"] if len(ev) else pd.Series(dtype=float)
    summary = {
        "events": int(len(ev)), "caught": int(caught), "missed": int(len(ev) - caught),
        "event_POD": round(float(caught) / max(len(ev), 1), 3),
        "false_alarm_episodes": int(fa_episodes),
        "lead_time_median_min": float(leads.median()) if len(leads) else None,
        "lead_time_mean_min": round(float(leads.mean()), 1) if len(leads) else None,
        "lead_time_max_min": float(leads.max()) if len(leads) else None,
        "lookback_hours": LOOKBACK_HOURS,
    }
    return ev, summary


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    d, params, thr, model = load_inputs()
    p = predict_prob(model, d["X_seq"], d["X_scalar"])
    alarm = p >= thr
    lvl_now = current_level_norm(d["X_scalar"], params)
    below = lvl_now < FLOOD_LINE

    print(f"{SPLIT}: {len(p):,} rows, threshold {thr:.2f}")

    # ---- 1. onset rows only --------------------------------------------------
    onset = row_metrics(d["y_flood"][below], alarm[below])
    print("\n1. ONSET ROWS (river currently below the flood line):")
    print("  ", onset)
    per_station = {}
    for st in np.unique(d["station"]):
        m = below & (d["station"] == st)
        per_station[str(st)] = row_metrics(d["y_flood"][m], alarm[m])
        print(f"   {st:28s} {per_station[str(st)]}")

    # ---- 2 + 3. events and lead time ------------------------------------------
    df = pd.DataFrame({"time": pd.to_datetime(d["time"]), "station": d["station"],
                       "level_norm": lvl_now, "alarm": alarm})
    ev, summary = event_analysis(df)
    print("\n2. EVENTS (was there an alarm before the crossing?):")
    print("  ", summary)
    if len(ev):
        print("\n   per station:")
        for st, g in ev.groupby("station"):
            leads = g.loc[g["caught"], "lead_time_min"]
            print(f"   {st:28s} events={len(g):3d} caught={int(g['caught'].sum()):3d} "
                  f"median lead={leads.median() if len(leads) else float('nan'):.0f} min")
        print("\n3. LEAD TIME distribution (minutes before crossing, caught events only):")
        print("  ", ev.loc[ev["caught"], "lead_time_min"].describe().round(1).to_dict())

    # ---- save ------------------------------------------------------------------
    (MODEL_DIR / "onset_metrics.json").write_text(json.dumps(
        {"split": SPLIT, "threshold": thr, "onset_rows": onset,
         "onset_rows_per_station": per_station, "events": summary}, indent=2))
    ev.to_csv(MODEL_DIR / "event_lead_times.csv", index=False)
    print(f"\nSaved models/onset_metrics.json and models/event_lead_times.csv")


if __name__ == "__main__":
    main()
