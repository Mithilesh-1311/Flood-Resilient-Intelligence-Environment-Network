"""
replay_hardware.py

Replays REAL river-gauge data through the running FRiEND controller.

simulate_hardware.py drives nc1.py with a random walk. This script drives the
same, unmodified nc1.py with measurements from the held-out 2023-24 test split
of the project's own dataset (built by ../build_replay.py). The mesh network is
still simulated, because the dataset records rivers, not radio links, but every
water level, rain flag, temperature and humidity on the dashboard is a real
reading, and the flood model is scored against what the river actually did.

Two paths, both per 15-minute dataset row:

  1. telemetry  -> the fake gateway -> nc1.py, exactly like field firmware.
                   Feeds the sensor table, charts and topology.
  2. model step -> flood_ai.FLOOD_AI.push_replay_row(), in-process.
                   Carries the row's model-ready inputs (the same numbers the
                   offline test score used, parity-checked by build_replay.py)
                   and its ground truth, so each prediction can be shown next
                   to the real outcome.

Everything else is reused from simulate_hardware.py unchanged: the fake
gateway, the link-probe traffic and the scripted fault injection.

USAGE (from this directory)
    python replay_hardware.py

    FRIEND_REPLAY_FILE=path.csv   use a different replay file
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import math
import os
from pathlib import Path
from typing import Any, Dict, List

# Configure logging before simulate_hardware / nc1 are imported, so this
# script's prefix wins (logging.basicConfig is first-call-wins).
logging.basicConfig(level=logging.INFO, format="%(asctime)s [REPLAY] %(message)s")
log = logging.getLogger("gauge_replay")

import uvicorn  # noqa: E402

import simulate_hardware as sim  # noqa: E402  - fake gateway + probe + fault loops, unmodified

nc1 = sim.nc1

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE.parent / "flood_dataset"
REPLAY_FILE = Path(os.environ.get("FRIEND_REPLAY_FILE", DATA_DIR / "replay_test.csv"))
REPLAY_META = REPLAY_FILE.with_name(REPLAY_FILE.stem + "_meta.json")

SEQ_COLS = [f"seq_{i}" for i in range(1, 9)]
X_COLS = ["x_dh_dt", "x_d2h_dt2", "x_level_norm", "x_rain_dur", "x_dew_point", "x_vpd", "x_api"]
FLOAT_COLS = (["level_m", "water_level", "rain_mm", "temperature", "humidity", "h_crit_m",
               "level_norm", "dh_dt", "api", "rain_duration_min", "y_level_fut"]
              + SEQ_COLS + X_COLS)


def _num(value: str) -> float | None:
    """CSV cell -> float, or None for a missing reading (never NaN downstream)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def load_replay() -> Dict[str, List[Dict[str, Any]]]:
    """Rows grouped by node, in time order. Plain csv: the image needs no pandas."""
    if not REPLAY_FILE.exists():
        raise SystemExit(
            f"{REPLAY_FILE} not found. Build it once with `py build_replay.py` "
            "from the project root (needs ALL_STATIONS_labelled.csv)."
        )
    by_node: Dict[str, List[Dict[str, Any]]] = {}
    with REPLAY_FILE.open(newline="", encoding="utf-8") as fh:
        for raw in csv.DictReader(fh):
            row: Dict[str, Any] = {
                "node": raw["node"], "station": raw["station"], "split": raw["split"],
                "window": int(raw["window"]), "kind": raw["kind"], "time": raw["time"],
                "rain": raw["rain"] in ("1", "True", "true"),
                "y_flood": int(float(raw["y_flood"])),
            }
            for col in FLOAT_COLS:
                row[col] = _num(raw[col])
            by_node.setdefault(row["node"], []).append(row)
    return by_node


def _telemetry(row: Dict[str, Any], seq: int) -> Dict[str, Any]:
    """The same message shape the source-node firmware sends. Missing readings are
    omitted, exactly as the firmware omits a failed DHT read."""
    msg: Dict[str, Any] = {"type": "telemetry", "node": row["node"],
                           "rain": row["rain"], "sequence_number": seq}
    for key in ("water_level", "temperature", "humidity"):
        if row[key] is not None:
            msg[key] = round(row[key], 3)
    return msg


async def _replay_loop(by_node: Dict[str, List[Dict[str, Any]]]) -> None:
    """One dataset row per node every model step: 15 real minutes per
    LIVE_SECONDS_PER_MODEL_STEP seconds, looping back to the start at the end."""
    flood_ai = nc1.FLOOD_AI
    step = getattr(__import__("flood_ai"), "LIVE_SECONDS_PER_MODEL_STEP", 6.0)
    meta = json.loads(REPLAY_META.read_text()) if REPLAY_META.exists() else {}
    if flood_ai is not None:
        flood_ai.set_replay_info(meta, {n: len(r) for n, r in by_node.items()})

    cursor = {node: 0 for node in by_node}
    seq = {node: 0 for node in by_node}
    while True:
        for node in sorted(by_node):
            rows = by_node[node]
            row = rows[cursor[node]]
            if flood_ai is not None:
                flood_ai.push_replay_row(node, row, cursor[node])
            seq[node] += 1
            await sim._send_json_line(_telemetry(row, seq[node]))
            cursor[node] = (cursor[node] + 1) % len(rows)
        await asyncio.sleep(step)


async def main() -> None:
    by_node = load_replay()
    for node, rows in sorted(by_node.items()):
        windows = len({r["window"] for r in rows})
        log.info(f"{node}: {rows[0]['station']} ({rows[0]['split']} split), "
                 f"{len(rows)} real 15-min rows in {windows} window(s), "
                 f"{rows[0]['time']} .. {rows[-1]['time']}")

    nc1.GATEWAY_HOST = sim.SIM_GATEWAY_HOST
    server = await asyncio.start_server(sim._handle_client, host=sim.SIM_GATEWAY_HOST,
                                        port=nc1.GATEWAY_TCP_PORT)
    config = uvicorn.Config(nc1.app, host=nc1.FRONTEND_HTTP_HOST, port=nc1.FRONTEND_HTTP_PORT,
                            log_level="warning", loop="asyncio")
    log.info(f"Controller API on http://localhost:{nc1.FRONTEND_HTTP_PORT} - "
             "telemetry is REAL gauge data; the mesh network is simulated.")

    async with server:
        await asyncio.gather(
            server.serve_forever(),
            uvicorn.Server(config).serve(),
            sim._probe_and_stats_loop(),
            sim._fault_injection_loop(),
            _replay_loop(by_node),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped.")
