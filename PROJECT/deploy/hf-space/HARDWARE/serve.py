"""
serve.py - hosted entrypoint for the FRiEND controller.

A cloud container cannot reach the physical gateway: 192.168.4.1 only exists on
the ESP32-CAM's own "SIH-GATEWAY" Wi-Fi. So a hosted controller always runs in
simulation. This wrapper runs simulate_hardware.main() exactly as
`python simulate_hardware.py` does - same fake gateway, same unmodified nc1.py
routing, health and flood inference - plus three hosting conveniences that need
no edits to nc1.py or simulate_hardware.py:

  - listens on $PORT when the platform sets one (Render, Railway, Cloud Run);
    Hugging Face Spaces uses the README's app_port (8000) instead
  - GET /         a small JSON self-description, so the Space URL shows
                  something useful instead of a 404
  - GET /healthz  a liveness probe
"""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Dict

# simulate_hardware configures logging and then imports nc1, so importing it
# first keeps its log format - the same order `python simulate_hardware.py` uses.
import simulate_hardware as sim

nc1 = sim.nc1

# simulate_hardware.main() reads this at call time, so overriding it here is
# enough to move the listener without touching either source file.
nc1.FRONTEND_HTTP_PORT = int(os.environ.get("PORT", nc1.FRONTEND_HTTP_PORT))


@nc1.app.get("/")
async def root() -> Dict[str, Any]:
    system = nc1.STATE.system or {}
    flood = nc1.STATE.flood_ai or {}
    return {
        "service": "FRiEND controller",
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
        asyncio.run(sim.main())
    except KeyboardInterrupt:
        pass
