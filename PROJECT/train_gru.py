"""
train_gru.py  -  train the two-head GRU flood model (TensorFlow / Keras)
========================================================================

WHAT THIS DOES (plain words)
----------------------------
Loads train.npz / val.npz / test.npz and trains ONE small network with TWO
outputs:

   level window (8 steps) --> GRU(32) --+
                                        +--> concat --> Dropout --> Dense(32)
   7 scalars ---------------------------+                             |
                                                  +-------------------+-------------------+
                                                  |                                       |
                                      Head A "flood": sigmoid                 Head B "level": 3 numbers
                                      P(flood within 30 min)                  q10 / q50 / q90 of level at +30 min

Training tricks used:
  * per-row weights on Head A (step 7): dry row = 1, flood row = POS_WEIGHT,
    ONSET row (below the line but crossing within the horizon) =
    POS_WEIGHT * ONSET_BOOST - the rows an early-warning system lives for
  * pinball loss on Head B                    (learns the three quantiles)
  * dropout kept ON at prediction time        (MC-Dropout -> uncertainty)
  * early stopping on validation loss         (stop before overfitting)

After training it:
  1. picks the alarm threshold on VALIDATION ONSET rows (river below the line)
     - the cut that gives the best onset CSI, not the best all-rows CSI
  2. reports POD / FAR / CSI on TEST, overall and per station
  3. saves the model, the threshold and the metrics

HOW TO RUN
----------
    py -m pip install tensorflow
    py train_gru.py
Outputs go to  models/  (flood_gru.keras, threshold.json, metrics.json)
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import tensorflow as tf
from tensorflow import keras
from tensorflow.keras import layers

# =============================================================================
# CONFIGURATION
# =============================================================================
DATA_DIR = Path("flood_dataset")
MODEL_DIR = Path("models")

SEED = 42
GRU_UNITS = 32
DENSE_UNITS = 32
DROPOUT = 0.2
POS_WEIGHT = 40.0            # how much harder a missed flood row is punished (step 7)
ONSET_BOOST = 5.0            # EXTRA multiplier for "onset" rows: river still BELOW the
                             # line but crossing within the horizon. These are the rows
                             # an early-warning system lives for (~0.06 % of data), so
                             # they get POS_WEIGHT * ONSET_BOOST.
FLOOD_LINE = 1.0             # level_norm at/above this = flooding
QUANTILES = [0.1, 0.5, 0.9]  # Head B outputs
LOSS_WEIGHT_FLOOD = 1.0      # relative importance of the two heads in total loss
LOSS_WEIGHT_LEVEL = 1.0

EPOCHS = 30
BATCH_SIZE = 512
LEARNING_RATE = 1e-3
PATIENCE = 5                 # early stopping: epochs without val improvement

MC_SAMPLES = 20              # dropout passes at prediction time (uncertainty)

np.random.seed(SEED)
tf.random.set_seed(SEED)


# =============================================================================
# DATA
# =============================================================================
def load(split: str) -> dict:
    d = np.load(DATA_DIR / f"{split}.npz", allow_pickle=True)
    return {k: d[k] for k in d.files}


_SCALER = json.loads((DATA_DIR / "preprocess_params.json").read_text())["scaler"]["level_norm"]


def current_level_norm(X_scalar: np.ndarray) -> np.ndarray:
    """Undo the standardisation of x_level_norm (column 2) -> river level NOW,
    in flood-line units. Used to know which rows are 'below the line'."""
    return X_scalar[:, 2] * _SCALER["std"] + _SCALER["mean"]


def row_weights(d: dict) -> np.ndarray:
    """
    Step 7, per row:
        dry row                          -> 1
        flood row (already above line)   -> POS_WEIGHT
        onset row (below line, will cross) -> POS_WEIGHT * ONSET_BOOST
    """
    y = d["y_flood"].astype(bool)
    below = current_level_norm(d["X_scalar"]) < FLOOD_LINE
    w = np.ones(len(y), dtype=np.float32)
    w[y] = POS_WEIGHT
    w[y & below] = POS_WEIGHT * ONSET_BOOST
    return w


# =============================================================================
# LOSSES  (both return ONE value PER ROW so Keras can apply the row weights)
# =============================================================================
def bce_per_row():
    """Plain binary cross-entropy, per row. Class weighting comes from sample_weight."""
    def loss(y_true, y_pred):
        y_true = tf.reshape(tf.cast(y_true, tf.float32), (-1, 1))   # (N,1) to match y_pred
        y_pred = tf.clip_by_value(y_pred, 1e-7, 1.0 - 1e-7)
        per_row = -(y_true * tf.math.log(y_pred) + (1.0 - y_true) * tf.math.log(1.0 - y_pred))
        return tf.reshape(per_row, (-1,))                            # (N,)
    return loss


def pinball_loss(quantiles):
    """
    Quantile (pinball) loss. For each quantile q:
        err = y_true - y_pred
        loss = max(q * err, (q - 1) * err)
    Under-predicting the q90 output costs 0.9*err, over-predicting only 0.1*err,
    so that output learns to sit high; q10 learns to sit low; q50 = median.
    """
    q = tf.constant(quantiles, dtype=tf.float32)          # shape (3,)
    def loss(y_true, y_pred):                             # y_true (N,) or (N,1); y_pred (N,3)
        y_true = tf.reshape(tf.cast(y_true, tf.float32), (-1, 1))   # -> (N,1) so it broadcasts
        err = y_true - y_pred
        return tf.reduce_mean(tf.maximum(q * err, (q - 1.0) * err), axis=-1)   # (N,)
    return loss


# =============================================================================
# MODEL
# =============================================================================
def build_model(seq_len: int, n_scalar: int) -> keras.Model:
    seq_in = keras.Input(shape=(seq_len, 1), name="seq")
    sca_in = keras.Input(shape=(n_scalar,), name="scalar")

    h = layers.GRU(GRU_UNITS, name="gru")(seq_in)               # reads the window
    x = layers.Concatenate(name="concat")([h, sca_in])           # add the "now" numbers
    x = layers.Dropout(DROPOUT, name="mc_dropout")(x)            # stays on at inference
    x = layers.Dense(DENSE_UNITS, activation="relu", name="dense")(x)

    flood = layers.Dense(1, activation="sigmoid", name="flood")(x)      # Head A
    level = layers.Dense(len(QUANTILES), activation=None, name="level")(x)  # Head B

    model = keras.Model(inputs=[seq_in, sca_in], outputs=[flood, level], name="flood_gru")
    model.compile(
        optimizer=keras.optimizers.Adam(LEARNING_RATE),
        loss={"flood": bce_per_row(), "level": pinball_loss(QUANTILES)},
        loss_weights={"flood": LOSS_WEIGHT_FLOOD, "level": LOSS_WEIGHT_LEVEL},
    )
    return model


# =============================================================================
# PREDICTION WITH MC-DROPOUT
# =============================================================================
def predict_mc(model: keras.Model, X_seq, X_scalar, n_samples: int = MC_SAMPLES):
    """
    Run the network n_samples times with dropout ON. Returns:
      p_mean  (N,)   average flood probability
      p_std   (N,)   spread of those probabilities = how unsure the model is
      q_mean  (N,3)  average q10/q50/q90 of future level (sorted so q10<=q50<=q90)
    """
    probs, quants = [], []
    for _ in range(n_samples):
        p, q = model([X_seq, X_scalar], training=True)      # training=True keeps dropout on
        probs.append(p.numpy()[:, 0])
        quants.append(q.numpy())
    probs = np.stack(probs)                                 # (S, N)
    quants = np.stack(quants)                               # (S, N, 3)
    return probs.mean(0), probs.std(0), np.sort(quants.mean(0), axis=1)


def predict_mc_batched(model, X_seq, X_scalar, batch=20000):
    """Same as predict_mc but in chunks so 600k rows fit in memory."""
    outs = [predict_mc(model, X_seq[i:i + batch], X_scalar[i:i + batch])
            for i in range(0, len(X_seq), batch)]
    return (np.concatenate([o[0] for o in outs]),
            np.concatenate([o[1] for o in outs]),
            np.concatenate([o[2] for o in outs]))


# =============================================================================
# WARNING METRICS  (POD / FAR / CSI)
# =============================================================================
def warning_metrics(y_true, p, threshold: float) -> dict:
    """
    hits          = flood happened AND we alarmed
    misses        = flood happened AND we stayed silent
    false alarms  = no flood AND we alarmed
    POD = hits / (hits + misses)          "of the real floods, how many did we catch"
    FAR = false alarms / (hits + FA)      "of our alarms, how many were wrong"
    CSI = hits / (hits + misses + FA)     one number balancing both
    """
    alarm = p >= threshold
    y = y_true.astype(bool)
    hits = int(np.sum(alarm & y))
    misses = int(np.sum(~alarm & y))
    fa = int(np.sum(alarm & ~y))
    pod = hits / max(hits + misses, 1)
    far = fa / max(hits + fa, 1)
    csi = hits / max(hits + misses + fa, 1)
    return {"threshold": float(threshold), "hits": hits, "misses": misses,
            "false_alarms": fa, "POD": round(pod, 3), "FAR": round(far, 3), "CSI": round(csi, 3)}


def best_threshold(y_true, p, mask=None) -> float:
    """
    Try many cut-offs on VALIDATION, keep the one with the highest CSI.
    `mask` restricts the search to a subset of rows - we pass "river below
    the flood line" so the threshold is tuned for ONSET warnings, not for the
    easy already-flooding rows.
    """
    if mask is not None:
        y_true, p = y_true[mask], p[mask]
    best_t, best_csi = 0.5, -1.0
    for t in np.arange(0.05, 0.96, 0.01):
        csi = warning_metrics(y_true, p, t)["CSI"]
        if csi > best_csi:
            best_t, best_csi = float(t), csi
    return best_t


def quantile_coverage(y_true, q) -> float:
    """Fraction of true future levels that fall inside the q10-q90 band (ideal ~0.80)."""
    return float(np.mean((y_true >= q[:, 0]) & (y_true <= q[:, 2])))


# =============================================================================
# MAIN
# =============================================================================
def main() -> None:
    MODEL_DIR.mkdir(exist_ok=True)
    tr, va, te = load("train"), load("val"), load("test")
    print(f"train {len(tr['y_flood']):,}  val {len(va['y_flood']):,}  test {len(te['y_flood']):,}")

    model = build_model(tr["X_seq"].shape[1], tr["X_scalar"].shape[1])
    model.summary()

    # ---- train ---------------------------------------------------------------
    callbacks = [
        keras.callbacks.EarlyStopping(monitor="val_loss", patience=PATIENCE,
                                      restore_best_weights=True),
        keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=1),
    ]
    # row weights: only Head A ("flood") is weighted; Head B sees every row equally
    w_tr = row_weights(tr)
    w_va = row_weights(va)
    print(f"onset rows in train: {int((w_tr == POS_WEIGHT * ONSET_BOOST).sum()):,}")

    # targets and sample weights are given as lists in OUTPUT ORDER: [flood, level]
    model.fit(
        {"seq": tr["X_seq"], "scalar": tr["X_scalar"]},
        [tr["y_flood"], tr["y_level"]],
        sample_weight=[w_tr, np.ones_like(w_tr)],
        validation_data=({"seq": va["X_seq"], "scalar": va["X_scalar"]},
                         [va["y_flood"], va["y_level"]],
                         [w_va, np.ones_like(w_va)]),
        epochs=EPOCHS, batch_size=BATCH_SIZE, callbacks=callbacks, verbose=2,
    )

    # ---- choose the alarm threshold on validation ONSET rows -------------------
    p_val, _, q_val = predict_mc_batched(model, va["X_seq"], va["X_scalar"])
    below_val = current_level_norm(va["X_scalar"]) < FLOOD_LINE
    thr = best_threshold(va["y_flood"], p_val, mask=below_val)
    val_metrics = warning_metrics(va["y_flood"], p_val, thr)
    val_metrics["onset_rows"] = warning_metrics(va["y_flood"][below_val], p_val[below_val], thr)
    val_metrics["band_coverage"] = round(quantile_coverage(va["y_level"], q_val), 3)
    print(f"\nVALIDATION  threshold={thr:.2f}  {val_metrics}")

    # ---- final honest score on test ------------------------------------------
    p_te, s_te, q_te = predict_mc_batched(model, te["X_seq"], te["X_scalar"])
    test_metrics = warning_metrics(te["y_flood"], p_te, thr)
    test_metrics["band_coverage"] = round(quantile_coverage(te["y_level"], q_te), 3)
    test_metrics["mean_uncertainty"] = round(float(s_te.mean()), 4)
    below_te = current_level_norm(te["X_scalar"]) < FLOOD_LINE
    test_metrics["onset_rows"] = warning_metrics(te["y_flood"][below_te], p_te[below_te], thr)
    print(f"TEST        {test_metrics}")

    per_station = {}
    for st in np.unique(te["station"]):
        m = te["station"] == st
        per_station[str(st)] = warning_metrics(te["y_flood"][m], p_te[m], thr)
        print(f"  {st:28s} {per_station[str(st)]}")

    # ---- save ----------------------------------------------------------------
    model.save(MODEL_DIR / "flood_gru.keras")
    (MODEL_DIR / "threshold.json").write_text(json.dumps(
        {"threshold": thr, "threshold_tuned_on": "validation onset rows",
         "pos_weight": POS_WEIGHT, "onset_boost": ONSET_BOOST,
         "quantiles": QUANTILES, "mc_samples": MC_SAMPLES}, indent=2))
    (MODEL_DIR / "metrics.json").write_text(json.dumps(
        {"validation": val_metrics, "test": test_metrics, "test_per_station": per_station},
        indent=2))
    print(f"\nSaved model + threshold + metrics to {MODEL_DIR}/")


if __name__ == "__main__":
    main()
