"""
predict_demo.py  -  try the trained model on sample cases
=========================================================

TWO KINDS OF TEST CASE
----------------------
A. REAL rows pulled from test.npz (the model has never seen them):
     - a few "onset" rows   (river below the line, about to cross)
     - a few dry rows
     - a couple of already-flooding rows
   For each we show the model's answer next to the truth.

B. HAND-MADE scenarios: 2 hours of raw sensor-style readings
   (level in metres, rain yes/no, temperature, humidity), pushed through the
   SAME preprocessing the training data went through, then into the model.
   This is exactly the path the live system will use: raw node readings in,
   probability + forecast band out.

HOW TO RUN
----------
    py predict_demo.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import tensorflow as tf
from tensorflow import keras

from download_flood_dataset import dew_point_c, vpd_kpa   # same formulas as training
import pandas as pd

DATA_DIR = Path("flood_dataset")
MODEL_DIR = Path("models")
MC_SAMPLES = 20
STEP_MINUTES = 15
LAG_STEPS = 8
API_DECAY_K = 0.85               # must match download_flood_dataset.py
STATION = "Scalehill_RiverCocker"  # hand-made scenarios use this station's flood line

P = json.loads((DATA_DIR / "preprocess_params.json").read_text())
THR = json.loads((MODEL_DIR / "threshold.json").read_text())["threshold"]
MODEL = keras.models.load_model(MODEL_DIR / "flood_gru.keras", compile=False)
H_CRIT = P["station_params"][STATION]["h_crit_m"]


# =============================================================================
# MODEL CALL (MC-Dropout)
# =============================================================================
def predict(X_seq, X_scalar):
    ps, qs = [], []
    for _ in range(MC_SAMPLES):
        p, q = MODEL([X_seq, X_scalar], training=True)
        ps.append(p.numpy()[:, 0]); qs.append(q.numpy())
    ps, qs = np.stack(ps), np.stack(qs)
    return ps.mean(0), ps.std(0), np.sort(qs.mean(0), axis=1)


def show(label, p, s, q, truth=None):
    alarm = "ALARM" if p >= THR else "quiet"
    line = (f"  {label:44s} P(flood)={p:5.2f} ±{s:4.2f}  {alarm:5s} | "
            f"level +30min: {q[1]:.2f} [{q[0]:.2f}–{q[2]:.2f}] of flood line")
    if truth is not None:
        line += f" | truth: {'FLOOD' if truth else 'no flood'}"
    print(line)


# =============================================================================
# A. REAL ROWS FROM TEST
# =============================================================================
def real_cases(n_each=3):
    d = np.load(DATA_DIR / "test.npz", allow_pickle=True)
    sc = P["scaler"]["level_norm"]
    lvl_now = d["X_scalar"][:, 2] * sc["std"] + sc["mean"]
    y = d["y_flood"].astype(bool)
    rng = np.random.default_rng(0)

    groups = {
        "ONSET (below line, floods in 30 min)": np.where((lvl_now < 1) & y)[0],
        "DRY (below line, no flood)":           np.where((lvl_now < 1) & ~y)[0],
        "ALREADY FLOODING":                     np.where(lvl_now >= 1)[0],
    }
    print("\nA. REAL TEST ROWS")
    for name, idx in groups.items():
        pick = rng.choice(idx, size=min(n_each, len(idx)), replace=False)
        print(f"\n {name}")
        p, s, q = predict(d["X_seq"][pick], d["X_scalar"][pick])
        for k, i in enumerate(pick):
            show(f"{d['station'][i][:22]} {str(d['time'][i])[:16]}  now={lvl_now[i]:.2f}",
                 p[k], s[k], q[k], d["y_flood"][i])


# =============================================================================
# B. HAND-MADE SCENARIOS  (raw readings -> features -> model)
# =============================================================================
def features_from_raw(level_m, rain, temp_c, rh, api_start=0.0):
    """
    level_m, rain, temp_c, rh : lists of equal length (>= 9), one entry per
    15-min step, oldest first. Returns X_seq (1,8,1) and X_scalar (1,7) for
    the LAST step, built exactly like the training pipeline.
    """
    lv = np.asarray(level_m, float); rn = np.asarray(rain, bool)
    dt_h = STEP_MINUTES / 60

    # --- the 8-step window (the 8 readings BEFORE the current one), flood-line units
    seq = lv[-LAG_STEPS - 1:-1] / H_CRIT

    # --- current-step scalars, raw
    dh_dt = (lv[-1] - lv[-2]) / dt_h
    dh_dt_prev = (lv[-2] - lv[-3]) / dt_h
    d2h = (dh_dt - dh_dt_prev) / dt_h
    level_norm = lv[-1] / H_CRIT
    dur = 0
    for r in rn:                       # rain duration counter
        dur = dur + STEP_MINUTES if r else 0
    k_step = API_DECAY_K ** (1 / (24 * 60 / STEP_MINUTES))
    api = api_start
    for r in rn:                       # antecedent precipitation index
        api = api * k_step + float(r)
    dp = float(dew_point_c(pd.Series([temp_c[-1]]), pd.Series([rh[-1]]))[0])
    vpd = float(vpd_kpa(pd.Series([temp_c[-1]]), pd.Series([rh[-1]]))[0])

    # --- tame + scale, same as transform_scale.py
    raw = {"dh_dt": np.sign(dh_dt) * np.log1p(abs(dh_dt) * 100),
           "d2h_dt2": np.sign(d2h) * np.log1p(abs(d2h) * 100),
           "level_norm": level_norm,
           "rain_duration_min": np.log1p(dur),
           "dew_point_c": dp, "vpd_kpa": vpd,
           "api": np.log1p(api)}
    sc = P["scaler"]
    scalars = [(raw[c] - sc[c]["mean"]) / sc[c]["std"] for c in
               ["dh_dt", "d2h_dt2", "level_norm", "rain_duration_min", "dew_point_c", "vpd_kpa", "api"]]
    return (np.asarray(seq, np.float32).reshape(1, LAG_STEPS, 1),
            np.asarray(scalars, np.float32).reshape(1, -1))


def handmade_cases():
    print(f"\nB. HAND-MADE SCENARIOS  (station {STATION}, flood line = {H_CRIT:.2f} m)")
    n = 9   # 2 hours of 15-min readings + the current one
    cases = {
        "1 Dry, low, flat river":
            dict(level_m=[0.45] * n, rain=[0] * n, temp_c=[22] * n, rh=[60] * n),
        "2 Steady rain 2 h, river climbing fast (0.9→1.35 m)":
            dict(level_m=np.linspace(0.90, 1.35, n), rain=[1] * n, temp_c=[16] * n, rh=[97] * n,
                 api_start=40),
        "3 Rain, moderate rise (0.8→1.05 m)":
            dict(level_m=np.linspace(0.80, 1.05, n), rain=[1] * n, temp_c=[15] * n, rh=[95] * n,
                 api_start=25),
        "4 High (1.30 m) but flat, no rain":
            dict(level_m=[1.30] * n, rain=[0] * n, temp_c=[18] * n, rh=[70] * n),
        "5 Already above line and still rising":
            dict(level_m=np.linspace(1.35, 1.70, n), rain=[1] * n, temp_c=[14] * n, rh=[98] * n,
                 api_start=60),
        "6 Falling after a flood (1.6→1.2 m), rain stopped":
            dict(level_m=np.linspace(1.60, 1.20, n), rain=[1, 1, 1, 0, 0, 0, 0, 0, 0],
                 temp_c=[15] * n, rh=[85] * n, api_start=60),
        "7 Sudden jump in last 15 min only (0.7→1.0 m)":
            dict(level_m=[0.70] * (n - 1) + [1.00], rain=[0] * (n - 3) + [1, 1, 1],
                 temp_c=[20] * n, rh=[90] * n),
    }
    for name, kw in cases.items():
        xs, xc = features_from_raw(**kw)
        p, s, q = predict(xs, xc)
        show(name, p[0], s[0], q[0])


if __name__ == "__main__":
    print(f"alarm threshold = {THR:.2f}")
    real_cases()
    handmade_cases()
