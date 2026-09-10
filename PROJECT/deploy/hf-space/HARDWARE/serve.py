"""
serve.py - hosted entrypoint for the FRiEND controller.

A cloud container cannot reach the physical gateway: 192.168.4.1 only exists on
the ESP32-CAM's own "SIH-GATEWAY" Wi-Fi. So a hosted controller drives nc1.py
from one of the two field stand-ins, chosen with FRIEND_TELEMETRY:

  replay     (default) replay_hardware.py - REAL river-gauge rows from the
             project's held-out test data; the mesh network is simulated
  simulated  simulate_hardware.py - the random-walk telemetry

If the replay file is missing, it falls back to `simulated` and says so at GET /.
Either runner is started exactly as `python <runner>.py` would; nc1.py is not
modified. Three hosting conveniences are added here:

  - listens on $PORT when the platform sets one (Render, Railway, Cloud Run);
    Hugging Face Spaces uses the README's app_port (8000) instead
  - GET /         a small JSON self-description, so the Space URL shows
                  something useful instead of a 404
  - GET /healthz  a liveness probe
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict

_REPLAY_FILE = Path(__file__).resolve().parent.parent / "flood_dataset" / "replay_test.csv"
_REQUESTED = os.environ.get("FRIEND_TELEMETRY", "replay").strip().lower()
TELEMETRY = "replay" if _REQUESTED == "replay" and _REPLAY_FILE.exists() else "simulated"

# Each runner configures logging and then imports nc1, so import the chosen one
# first - the same order `python <runner>.py` uses.
if TELEMETRY == "replay":
    import replay_hardware as runner
else:
    import simulate_hardware as runner
    if _REQUESTED == "replay":
        logging.getLogger("serve").warning(
            "FRIEND_TELEMETRY=replay but %s is missing - falling back to simulated telemetry",
            _REPLAY_FILE,
        )

nc1 = runner.nc1

# Both runners read this at call time, so overriding it here is enough to move
# the listener without touching any source file.
nc1.FRONTEND_HTTP_PORT = int(os.environ.get("PORT", nc1.FRONTEND_HTTP_PORT))


@nc1.app.get("/")
async def root() -> Dict[str, Any]:
    system = nc1.STATE.system or {}
    flood = nc1.STATE.flood_ai or {}
    return {
        "service": "FRiEND controller",
        "telemetry": TELEMETRY,
        "telemetry_requested": _REQUESTED,
        "data_source": system.get("data_source", "SIMULATION"),
        "gateway_connected": system.get("gateway_connected"),
        "flood_ai": flood.get("status", "not_loaded"),
        "cycle": system.get("cycle"),
        "endpoints": {"state": "/state", "stream": "/ws", "reset_health": "POST /reset_health"},
        "note": "API only. Open the FRiEND dashboard to view this controller.",
    }


@nc1.app.get("/healthz")
async def healthz() -> Dict[str, Any]:
    return {"status": "ok", "cycle": (nc1.STATE.system or {}).get("cycle"), "time": time.time()}


if __name__ == "__main__":
    try:
        asyncio.run(runner.main())
    except KeyboardInterrupt:
        pass
