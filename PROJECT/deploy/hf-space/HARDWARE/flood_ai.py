"""
flood_ai.py

FRiEND - live Flood-Risk AI inference service.

WHAT THIS IS
------------
nc1.py owns the network (PDR, health, Dijkstra routing). It has never owned
flood prediction: the trained GRU lives one directory up in ../models and was
only ever exercised offline by ../predict_demo.py. This module is the missing
bridge - it takes the live telemetry nc1.py already receives from S1/S2/S3 and
runs it through the SAME model, with the SAME preprocessing, that
predict_demo.py uses.

Nothing here re-implements or second-guesses the model. The feature builder is
a line-for-line port of predict_demo.features_from_raw() with pandas swapped
for plain numpy (the two helper formulas are copied verbatim from
../download_flood_dataset.py), so a live reading and an offline reading of the
same numbers produce the same answer.

MODEL (read from ../models, never invented here)
    two-head GRU:  seq(8,1) + scalar(7) -> GRU(32) -> concat -> MC-Dropout(0.2)
                   -> Dense(32,relu) -> [ P(flood), quantiles q10/q50/q90 ]
    horizon        +30 min
    uncertainty    MC-Dropout, 20 stochastic passes (std of P across passes)
    alarm          P >= threshold from ../models/threshold.json

TWO HONEST CAVEATS, BOTH SURFACED IN THE PAYLOAD SO THE UI CAN LABEL THEM
------------------------------------------------------------------------
1. UNITS. The field hardware reports water_level as 0-100 % of the analog
   water sensor's span (SIH_Source_Node_Firmware_FIXED.ino: `int pct =
   map(raw, WATER_RAW_DRY, WATER_RAW_FULL, 0, 100)`). The model was trained on
   river stage in METRES against a per-station flood line. So each source node
   carries an explicit, editable calibration (see NODE_CALIBRATION) mapping
   0-100 % onto that station's observed stage range from
   ../flood_dataset/station_params.json. This is a stated calibration, not a
   measurement - it is emitted as `calibration` on every node so the frontend
   can say so out loud.

2. CADENCE. The model steps every 15 min (8 steps = a 2 h window). Live
   telemetry arrives every ~2 s. Waiting 2 real hours to fill one window is
   useless in a demo, so LIVE_SECONDS_PER_MODEL_STEP compresses time: each
   whole bin of live readings is committed as one "15-minute" model step. The
   payload reports `time_compressed` and the exact ratio; the frontend labels
   the forecast accordingly. Set LIVE_SECONDS_PER_MODEL_STEP = 900.0 for
   real-time (uncompressed) operation against real deployed hardware.

The whole module degrades honestly: if TensorFlow or the model file is absent
it reports available=False with a reason and emits NO numbers at all, rather
than substituting placeholders.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

import numpy as np

log = logging.getLogger("flood_ai")

# =============================================================================
# PATHS - resolved relative to this file so it works from any cwd
# =============================================================================
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
MODEL_DIR = PROJECT_ROOT / "models"
DATA_DIR = PROJECT_ROOT / "flood_dataset"

MODEL_FILE = MODEL_DIR / "flood_gru.keras"
THRESHOLD_FILE = MODEL_DIR / "threshold.json"
METRICS_FILE = MODEL_DIR / "metrics.json"
ONSET_METRICS_FILE = MODEL_DIR / "onset_metrics.json"
PREPROCESS_FILE = DATA_DIR / "preprocess_params.json"

# =============================================================================
# CONSTANTS - all mirror the training pipeline exactly
# =============================================================================
STEP_MINUTES = 15          # make_targets.py / download_flood_dataset.py
HORIZON_MIN = 30           # make_targets.py HORIZON_MIN
LAG_STEPS = 8              # build_sequences.py LAG_STEPS
API_DECAY_K = 0.85         # download_flood_dataset.py API_DECAY_K
MC_SAMPLES = 20            # train_gru.py MC_SAMPLES
SCALAR_COLS = ["dh_dt", "d2h_dt2", "level_norm", "rain_duration_min",
               "dew_point_c", "vpd_kpa", "api"]

# Live-demo time compression (see caveat 2 above).
LIVE_SECONDS_PER_MODEL_STEP = 6.0

# Keep a little more than one window so the sequence is always fillable.
HISTORY_STEPS = LAG_STEPS + 8

# Source node -> training station. Straight from the `role` field written into
# ../flood_dataset/<station>_meta.json by download_flood_dataset.py.
NODE_STATION: Dict[str, str] = {
    "S1": "Scalehill_RiverCocker",
    "S2": "LowBriery_RiverGreta",
    "S3": "Boscastle_RiverValency",
}

# How far above the station's flood line the water sensor's 100 % mark sits.
# A level sensor is mounted on a staff gauge chosen so that full scale means
# "definitively flooding" - not so that full scale is the worst flood in the
# station's ten-year record. Mapping 0-100 % onto the full historic
# level_min..level_max range instead would put a mid-scale reading (~50 %)
# above the flood line at every station, which is both physically wrong and
# useless to look at. 1.15 = full scale is 15 % above the flood line.
SENSOR_FULL_SCALE_OVER_HCRIT = 1.15

# Filled from station_params.json at load(): maps the sensor's 0-100 % span
# onto metres of river stage for that station. EDITABLE - if a node is
# physically installed against a surveyed staff gauge, put the real numbers here
# and this assumption drops away.
NODE_CALIBRATION: Dict[str, Dict[str, float]] = {}


# =============================================================================
# FEATURE HELPERS - copied verbatim from ../download_flood_dataset.py
# (pandas Series -> float scalars; the arithmetic is untouched)
# =============================================================================
def dew_point_c(t_c: float, rh: float) -> float:
    """Magnus formula. Same constants as download_flood_dataset.dew_point_c."""
    a, b = 17.625, 243.04
    rh_clipped = min(100.0, max(1.0, rh))
    gamma = math.log(rh_clipped / 100.0) + (a * t_c) / (b + t_c)
    return (b * gamma) / (a - gamma)


def vpd_kpa(t_c: float, rh: float) -> float:
    """Tetens formula. Same constants as download_flood_dataset.vpd_kpa."""
    es = 0.6108 * math.exp((17.27 * t_c) / (t_c + 237.3))
    return es * (1.0 - min(100.0, max(0.0, rh)) / 100.0)


# =============================================================================
# ROLLING PER-NODE HISTORY
# =============================================================================
class NodeHistory:
    """
    Bins the ~2 s live telemetry stream into model steps.

    Readings landing in the same LIVE_SECONDS_PER_MODEL_STEP bin are averaged
    (rain is OR-ed - any rain in the bin counts as a raining step, matching the
    wet/dry flag the training pipeline used). When a bin closes it is committed
    as one step, exactly as if 15 minutes of river had elapsed.
    """

    def __init__(self, node_id: str) -> None:
        self.node_id = node_id
        self.steps: Deque[Dict[str, float]] = deque(maxlen=HISTORY_STEPS)
        self._bin_start: Optional[float] = None
        self._acc: List[Dict[str, Any]] = []
        self.last_reading_at: float = 0.0
        self.total_steps: int = 0

    def add(self, reading: Dict[str, Any], now: Optional[float] = None) -> None:
        """Fold one telemetry reading in. Ignores readings missing water_level."""
        now = time.time() if now is None else now
        level_pct = reading.get("water_level")
        if level_pct is None:
            return
        self.last_reading_at = now
        if self._bin_start is None:
            self._bin_start = now

        self._acc.append({
            "level_pct": float(level_pct),
            "rain": bool(reading.get("rain", False)),
            # DHT failures show up as absent keys; carry the last good value
            # forward rather than inventing one.
            "temperature": reading.get("temperature"),
            "humidity": reading.get("humidity"),
        })

        if now - self._bin_start >= LIVE_SECONDS_PER_MODEL_STEP:
            self._commit_bin()
            self._bin_start = now

    def _commit_bin(self) -> None:
        if not self._acc:
            return
        prev = self.steps[-1] if self.steps else None
        temps = [r["temperature"] for r in self._acc if r["temperature"] is not None]
        hums = [r["humidity"] for r in self._acc if r["humidity"] is not None]

        raining = bool(any(r["rain"] for r in self._acc))

        # Running rain-duration and API, advanced one model step at a time -
        # the same recurrences download_flood_dataset.py applies across the
        # training series (API_DECAY_K per day, wet/dry flag not mm).
        k_step = API_DECAY_K ** (1.0 / (24 * 60 / STEP_MINUTES))
        prev_dur = prev["rain_duration_min"] if prev else 0.0
        prev_api = prev["api"] if prev else 0.0

        step = {
            "level_pct": float(np.mean([r["level_pct"] for r in self._acc])),
            "rain": raining,
            "rain_duration_min": (prev_dur + STEP_MINUTES) if raining else 0.0,
            "api": prev_api * k_step + (1.0 if raining else 0.0),
            "temperature": float(np.mean(temps)) if temps
                           else (prev["temperature"] if prev else 20.0),
            "humidity": float(np.mean(hums)) if hums
                        else (prev["humidity"] if prev else 80.0),
            "t": time.time(),
        }
        self.steps.append(step)
        self.total_steps += 1
        self._acc = []

    @property
    def ready(self) -> bool:
        # features_from_raw needs the 8-step window plus the current step,
        # and dh_dt_prev reaches one step further back.
        return len(self.steps) >= LAG_STEPS + 1


# =============================================================================
# THE INFERENCE SERVICE
# =============================================================================
class FloodAI:
    """
    Thread-safe, lazily-loaded wrapper around ../models/flood_gru.keras.

    load() is slow (TensorFlow import + model deserialisation), so nc1.py runs
    it once on a worker thread at startup. predict_all() is likewise run in a
    thread executor - it must never block the asyncio control loop.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model = None
        self._params: Dict[str, Any] = {}
        self._threshold: float = 0.0
        self._threshold_meta: Dict[str, Any] = {}
        self._evaluation: Dict[str, Any] = {}
        self.available = False
        self.status = "not_loaded"
        self.reason: Optional[str] = None
        self.histories: Dict[str, NodeHistory] = {
            n: NodeHistory(n) for n in NODE_STATION
        }
        self._last_result: Dict[str, Any] = {}
        self._last_inference_ms: float = 0.0

    # -- loading -------------------------------------------------------------
    def load(self) -> None:
        """Import TensorFlow and load the trained model. Safe to call twice."""
        with self._lock:
            if self.available:
                return
            self.status = "loading"
        try:
            if not MODEL_FILE.exists():
                raise FileNotFoundError(f"{MODEL_FILE} not found")
            if not PREPROCESS_FILE.exists():
                raise FileNotFoundError(f"{PREPROCESS_FILE} not found")

            params = json.loads(PREPROCESS_FILE.read_text())
            thr_meta = json.loads(THRESHOLD_FILE.read_text())

            # Offline evaluation numbers, passed through untouched. These are
            # MODEL EVALUATION, never live status - the frontend keeps them in
            # a separate, explicitly labelled panel.
            evaluation: Dict[str, Any] = {}
            if METRICS_FILE.exists():
                evaluation["metrics"] = json.loads(METRICS_FILE.read_text())
            if ONSET_METRICS_FILE.exists():
                evaluation["onset"] = json.loads(ONSET_METRICS_FILE.read_text())

            import os
            os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
            from tensorflow import keras  # noqa: WPS433 - deliberately lazy

            model = keras.models.load_model(MODEL_FILE, compile=False)

            # Build the per-node % -> metres calibration from the station
            # ranges the model was actually trained on.
            station_params = params.get("station_params", {})
            calib: Dict[str, Dict[str, float]] = {}
            for node, station in NODE_STATION.items():
                sp = station_params.get(station)
                if not sp:
                    continue
                h_crit = float(sp["h_crit_m"])
                calib[node] = {
                    "station": station,
                    # 0 % = the station's lowest observed stage (dry bed).
                    "level_min_m": float(sp["level_min_m"]),
                    # 100 % = just above the flood line (see the constant above).
                    "level_max_m": round(h_crit * SENSOR_FULL_SCALE_OVER_HCRIT, 3),
                    "h_crit_m": h_crit,
                    "station_level_max_m": float(sp["level_max_m"]),
                }
            NODE_CALIBRATION.update(calib)

            with self._lock:
                self._model = model
                self._params = params
                self._threshold = float(thr_meta["threshold"])
                self._threshold_meta = thr_meta
                self._evaluation = evaluation
                self.available = True
                self.status = "ready"
                self.reason = None
            log.info("Flood AI ready: %s (threshold=%.2f)", MODEL_FILE.name, self._threshold)

        except Exception as exc:  # noqa: BLE001 - any failure must degrade honestly
            with self._lock:
                self.available = False
                self.status = "unavailable"
                self.reason = f"{type(exc).__name__}: {exc}"
            log.warning("Flood AI unavailable - %s", self.reason)

    # -- telemetry intake ----------------------------------------------------
    def ingest(self, sensor_data: Dict[str, Dict[str, Any]]) -> None:
        """Feed nc1.py's current STATE.sensor_data in. Cheap; call every cycle."""
        now = time.time()
        for node, reading in sensor_data.items():
            hist = self.histories.get(node)
            if hist is not None and isinstance(reading, dict):
                hist.add(reading, now=now)

    # -- feature construction ------------------------------------------------
    def _level_metres(self, node: str, level_pct: float) -> float:
        """
        Map the firmware's 0-100 % water-sensor reading onto river stage in
        metres, using this node's station calibration. STATED CALIBRATION -
        emitted in the payload so the UI can label it as such.
        """
        cal = NODE_CALIBRATION[node]
        lo, hi = cal["level_min_m"], cal["level_max_m"]
        return lo + (max(0.0, min(100.0, level_pct)) / 100.0) * (hi - lo)

    def _build_features(self, node: str, hist: NodeHistory):
        """
        Port of predict_demo.features_from_raw(). Same window, same derived
        columns, same taming transforms, same scaler - only the plumbing differs.
        Returns (X_seq (1,8,1), X_scalar (1,7), level_now_m, level_norm_now).
        """
        h_crit = NODE_CALIBRATION[node]["h_crit_m"]
        steps = list(hist.steps)
        lv = np.array([self._level_metres(node, s["level_pct"]) for s in steps], float)
        dt_h = STEP_MINUTES / 60.0

        # 8-step window = the readings BEFORE the current one, in flood-line units
        seq = lv[-LAG_STEPS - 1:-1] / h_crit

        dh_dt = (lv[-1] - lv[-2]) / dt_h
        dh_dt_prev = (lv[-2] - lv[-3]) / dt_h
        d2h = (dh_dt - dh_dt_prev) / dt_h
        level_norm = lv[-1] / h_crit

        cur = steps[-1]
        dur = cur["rain_duration_min"]
        api = cur["api"]
        dp = dew_point_c(cur["temperature"], cur["humidity"])
        vpd = vpd_kpa(cur["temperature"], cur["humidity"])

        # tame + scale, identical to transform_scale.py
        raw = {
            "dh_dt": np.sign(dh_dt) * np.log1p(abs(dh_dt) * 100),
            "d2h_dt2": np.sign(d2h) * np.log1p(abs(d2h) * 100),
            "level_norm": level_norm,
            "rain_duration_min": np.log1p(dur),
            "dew_point_c": dp,
            "vpd_kpa": vpd,
            "api": np.log1p(api),
        }
        sc = self._params["scaler"]
        scalars = [(raw[c] - sc[c]["mean"]) / sc[c]["std"] for c in SCALAR_COLS]

        return (
            np.asarray(seq, np.float32).reshape(1, LAG_STEPS, 1),
            np.asarray(scalars, np.float32).reshape(1, -1),
            float(lv[-1]),
            float(level_norm),
        )

    # -- inference -----------------------------------------------------------
    def predict_all(self) -> Dict[str, Any]:
        """
        Run one MC-Dropout inference pass per ready source node.

        BLOCKING - nc1.py calls this via run_in_executor. Batches every ready
        node into a single model call so the 20 stochastic passes are paid for
        once, not three times.
        """
        if not self.available or self._model is None:
            return self._payload(nodes={})

        ready = [(n, h) for n, h in self.histories.items()
                 if h.ready and n in NODE_CALIBRATION]
        if not ready:
            return self._payload(nodes={})

        t0 = time.perf_counter()
        try:
            seqs, scas, metas = [], [], []
            for node, hist in ready:
                xs, xc, level_m, level_norm = self._build_features(node, hist)
                seqs.append(xs)
                scas.append(xc)
                metas.append((node, hist, level_m, level_norm))

            X_seq = np.concatenate(seqs, axis=0)
            X_sca = np.concatenate(scas, axis=0)

            # MC-Dropout: training=True keeps the dropout layer stochastic at
            # inference, exactly as train_gru.predict_mc / predict_demo.predict do.
            #
            # The MC_SAMPLES stochastic passes are done as ONE forward pass over
            # a tiled batch rather than MC_SAMPLES sequential calls. Keras
            # Dropout draws an independent mask per batch row, so a tiled row is
            # statistically identical to a separate pass - and this turned a
            # ~500 ms control-loop cost into a single graph call.
            n = X_seq.shape[0]
            p_all, q_all = self._model(
                [np.tile(X_seq, (MC_SAMPLES, 1, 1)), np.tile(X_sca, (MC_SAMPLES, 1))],
                training=True,
            )
            ps = np.asarray(p_all)[:, 0].reshape(MC_SAMPLES, n)      # (MC, N)
            qs = np.asarray(q_all).reshape(MC_SAMPLES, n, -1)        # (MC, N, 3)
            p_mean, p_std = ps.mean(0), ps.std(0)
            q_mean = np.sort(qs.mean(0), axis=1)    # enforce q10<=q50<=q90

            self._last_inference_ms = (time.perf_counter() - t0) * 1000.0

            nodes: Dict[str, Any] = {}
            for i, (node, hist, level_m, level_norm) in enumerate(metas):
                h_crit = NODE_CALIBRATION[node]["h_crit_m"]
                q = q_mean[i]
                nodes[node] = {
                    "status": "ok",
                    "station": NODE_CALIBRATION[node]["station"],
                    "h_crit_m": round(h_crit, 3),
                    "calibration": {
                        "level_min_m": NODE_CALIBRATION[node]["level_min_m"],
                        "level_max_m": NODE_CALIBRATION[node]["level_max_m"],
                        "source": (
                            "0 % = station lowest observed stage; 100 % = "
                            f"{SENSOR_FULL_SCALE_OVER_HCRIT:g}x the flood line"
                        ),
                    },
                    "level_m": round(level_m, 3),
                    "level_norm": round(level_norm, 4),
                    "flood_probability": round(float(p_mean[i]), 4),
                    "uncertainty": round(float(p_std[i]), 4),
                    "alarm": bool(p_mean[i] >= self._threshold),
                    "forecast": {
                        "q10_norm": round(float(q[0]), 4),
                        "q50_norm": round(float(q[1]), 4),
                        "q90_norm": round(float(q[2]), 4),
                        "q10_m": round(float(q[0]) * h_crit, 3),
                        "q50_m": round(float(q[1]) * h_crit, 3),
                        "q90_m": round(float(q[2]) * h_crit, 3),
                    },
                    "model_steps": hist.total_steps,
                    "last_reading_at": hist.last_reading_at,
                }
            result = self._payload(nodes=nodes)
            self._last_result = result
            return result

        except Exception as exc:  # noqa: BLE001
            log.warning("Flood AI inference failed: %s: %s", type(exc).__name__, exc)
            return self._payload(nodes={}, error=f"{type(exc).__name__}: {exc}")

    # -- payload -------------------------------------------------------------
    def _payload(self, nodes: Dict[str, Any], error: Optional[str] = None) -> Dict[str, Any]:
        """
        Assemble the flood_ai block that rides along in nc1.py's state.

        Nodes that are not ready are reported with an explicit status
        ("warming_up" / "no_data") and NO numeric fields, so the frontend can
        render "-" / "NO DATA" instead of a misleading zero.
        """
        for node in NODE_STATION:
            if node in nodes:
                continue
            hist = self.histories[node]
            nodes[node] = {
                "status": "warming_up" if hist.total_steps or hist.last_reading_at else "no_data",
                "station": NODE_STATION[node],
                "model_steps": hist.total_steps,
                "steps_required": LAG_STEPS + 1,
                "last_reading_at": hist.last_reading_at,
            }

        scored = [(n, d) for n, d in nodes.items() if d.get("status") == "ok"]
        worst = None
        if scored:
            node, data = max(scored, key=lambda kv: kv[1]["flood_probability"])
            worst = {
                "node": node,
                "flood_probability": data["flood_probability"],
                "uncertainty": data["uncertainty"],
                "level_m": data["level_m"],
                "level_norm": data["level_norm"],
                "alarm": data["alarm"],
                "forecast": data["forecast"],
                "h_crit_m": data["h_crit_m"],
            }

        return {
            "available": self.available,
            "status": self.status,
            "reason": self.reason,
            "error": error,
            "model": {
                "file": MODEL_FILE.name,
                "architecture": "GRU(32) + 7 scalars -> MC-Dropout(0.2) -> Dense(32) -> [P(flood), q10/q50/q90]",
                "horizon_minutes": HORIZON_MIN,
                "quantiles": self._threshold_meta.get("quantiles", [0.1, 0.5, 0.9]),
                "mc_samples": MC_SAMPLES,
                "threshold": self._threshold,
                "threshold_tuned_on": self._threshold_meta.get("threshold_tuned_on"),
                "lag_steps": LAG_STEPS,
                "step_minutes": STEP_MINUTES,
                "inference_ms": round(self._last_inference_ms, 1),
            },
            "cadence": {
                "live_seconds_per_model_step": LIVE_SECONDS_PER_MODEL_STEP,
                "model_step_minutes": STEP_MINUTES,
                "time_compressed": LIVE_SECONDS_PER_MODEL_STEP < STEP_MINUTES * 60,
                "compression_ratio": round((STEP_MINUTES * 60) / LIVE_SECONDS_PER_MODEL_STEP, 1),
            },
            "nodes": nodes,
            "worst": worst,
            "evaluation": self._evaluation,
            "updated": time.time(),
        }

    def snapshot(self) -> Dict[str, Any]:
        """Last computed payload, or an empty honest one before the first pass."""
        return self._last_result or self._payload(nodes={})


# Module-level singleton - nc1.py holds exactly one of these.
FLOOD_AI = FloodAI()
