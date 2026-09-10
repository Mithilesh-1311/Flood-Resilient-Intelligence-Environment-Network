"""
simulate_hardware.py

Hardware-free simulator for the SIH 2026 mesh network. Runs nc1.py's REAL,
UNMODIFIED control logic (PacketStats, the Dijkstra AI router, the mesh
health drain, the FastAPI /state + /reset_health endpoints) against a fake
in-process "gateway" that speaks the exact same newline-delimited JSON
protocol as the real ESP32-CAM gateway firmware
(SIH_Gateway_Firmware_FIXED.ino). Nothing about nc1.py's routing/health/PDR
decisions is re-implemented here - this script only supplies fake traffic
and lets nc1.py's own code make every real decision, exactly as it would
against physical hardware.

nc1.py is imported, never edited. The only "override" is nc1.GATEWAY_HOST,
changed in memory (not on disk) after import so nc1.py's TCP client
connects to this script's fake gateway on 127.0.0.1 instead of the
physical ESP32-CAM's fixed AP IP (192.168.4.1), which isn't reachable
without the real board.

WHAT IT SIMULATES (mirrors the real firmware's behavior)
  - Every PROBE_CYCLE_SECONDS: a batch of simulated neighbor-probe attempts
    for every source->mesh and mesh->mesh directed link (mirrors
    sendNeighborProbes() in SIH_Source_Node_Firmware_FIXED.ino and
    SIH_Mesh_Node_Firmware_FIXED.ino), reported as packet_stat messages -
    exactly what nc1.py's PacketStats.record() already expects. Each link
    has its own randomized "true" reliability, so PDR varies realistically
    instead of being flat.
  - Every TELEMETRY_CYCLE_SECONDS: one simulated sensor reading per source
    node (mirrors USE_SIMULATED_SENSORS=true in the source firmware).
  - A scripted fault injection partway through the run: a couple of the
    mesh links nc1.py is CURRENTLY relying on get their reliability
    slashed (like a real "metal box placed over a node"), so you can watch
    nc1.py's own Dijkstra router reroute around it live in this terminal.

Node<->G links are intentionally NOT simulated - the real firmware never
probes them either (confirmed by reading all three .ino files), and
nc1.py's own router already accounts for that gap internally via its
GATEWAY_LINK_PDR_FALLBACK constant.

USAGE
  Run from this directory (same folder as nc1.py):
    py -m pip install fastapi uvicorn      (if not already installed)
    py simulate_hardware.py

  Then, in another terminal / browser, while it runs:
    curl http://localhost:8000/state
    curl -X POST http://localhost:8000/reset_health

  Ctrl+C to stop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from typing import Dict, List, Optional, Tuple

# Configure logging BEFORE importing nc1, so this script's format wins
# (logging.basicConfig is a no-op once a handler already exists - nc1.py
# also calls it at import time).
logging.basicConfig(level=logging.INFO, format="%(asctime)s [SIM] %(message)s")
log = logging.getLogger("field_simulator")

import uvicorn

import nc1  # the real, unmodified controller - imported, never edited

# =============================================================================
# SIMULATION CONFIGURATION
# =============================================================================
SIM_GATEWAY_HOST = "127.0.0.1"        # nc1.py's TCP client target, overridden in memory only
PROBE_CYCLE_SECONDS = 2.0              # how often simulated probes+stats fire
PROBES_PER_CYCLE = 12                  # simulated attempts per link per cycle, so PDR reads as a
                                        # smooth percentage (e.g. 9/12=75.0%) instead of flapping 0/100%
TELEMETRY_CYCLE_SECONDS = 2.0

BASE_RELIABILITY_RANGE = (0.75, 1.0)   # each directed link's baseline "true" PDR, randomized once at startup

FAULT_INJECTION_DELAY_SECONDS = 25.0   # simulate a real-world failure partway through the run
FAULT_RELIABILITY = 0.05               # degraded links become almost entirely unreliable
FAULT_LINK_COUNT = 2                   # how many currently-in-use mesh links to knock out


# =============================================================================
# LINK RELIABILITY MODEL
# Reuses nc1.SOURCE_NODES / nc1.MESH_NODES directly rather than redefining
# the node topology here, so this simulator can never drift out of sync
# with nc1.py's own node list.
# =============================================================================

def _build_candidate_links() -> List[Tuple[str, str]]:
    links: List[Tuple[str, str]] = []
    for s in sorted(nc1.SOURCE_NODES):
        for m in sorted(nc1.MESH_NODES):
            links.append((s, m))
    for a in sorted(nc1.MESH_NODES):
        for b in sorted(nc1.MESH_NODES):
            if a != b:
                links.append((a, b))
    return links


CANDIDATE_LINKS = _build_candidate_links()
LINK_RELIABILITY: Dict[Tuple[str, str], float] = {
    link: random.uniform(*BASE_RELIABILITY_RANGE) for link in CANDIDATE_LINKS
}

_last_active_routes: List[List[str]] = []


def _log_link_table() -> None:
    log.info("Simulated 'true' link reliability for this run (ground truth - nc1.py only ever "
             "sees the noisy tx/rx counters derived from it, same as with real hardware):")
    for (a, b), p in sorted(LINK_RELIABILITY.items()):
        log.info(f"    {a:>3} -> {b:<3} : {p * 100:5.1f}%")


# =============================================================================
# FAKE GATEWAY - TCP SERVER
# Speaks the exact same newline-delimited JSON protocol as the real
# ESP32-CAM gateway firmware (SIH_Gateway_Firmware_FIXED.ino). nc1.py's
# existing TCP client connects to this exactly as it would to real hardware.
# =============================================================================

_connected_writer: Optional[asyncio.StreamWriter] = None
_writer_lock = asyncio.Lock()


async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    global _connected_writer
    peer = writer.get_extra_info("peername")
    log.info(f"nc1.py connected from {peer} - simulation traffic will now start flowing.")
    async with _writer_lock:
        _connected_writer = writer

    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                continue
            _handle_message_from_nc1(message)
    finally:
        async with _writer_lock:
            if _connected_writer is writer:
                _connected_writer = None
        log.info("nc1.py disconnected")


def _handle_message_from_nc1(message: Dict) -> None:
    """Mirrors what the real gateway firmware does with health_update/
    route_update: forward them to the field. There's no field hardware
    here, so we just make nc1.py's AI decisions visible in this terminal."""
    global _last_active_routes
    msg_type = message.get("type")
    if msg_type == "route_update":
        routes = message.get("routes", {})
        _last_active_routes = [list(v) for v in routes.values()]
        log.info("nc1.py ROUTE_UPDATE (Dijkstra's picks this cycle):")
        for name, hops in routes.items():
            log.info(f"    {name}: {' -> '.join(hops)} -> G")
    elif msg_type == "health_update":
        health = message.get("health", {})
        log.info("nc1.py HEALTH_UPDATE: " + ", ".join(f"{k}={v}%" for k, v in health.items()))


async def _send_json_line(payload: Dict) -> None:
    async with _writer_lock:
        writer = _connected_writer
        if writer is None:
            return
        try:
            writer.write((json.dumps(payload) + "\n").encode("utf-8"))
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass


# =============================================================================
# TRAFFIC GENERATORS
# =============================================================================

async def _probe_and_stats_loop() -> None:
    """Every PROBE_CYCLE_SECONDS, simulate PROBES_PER_CYCLE probe attempts
    for each candidate link and report the tx/rx outcome as a packet_stat
    message - exactly the shape nc1.py's _process_gateway_message() and
    PacketStats.record() already consume."""
    while True:
        await asyncio.sleep(PROBE_CYCLE_SECONDS)
        for (a, b), reliability in LINK_RELIABILITY.items():
            successes = sum(1 for _ in range(PROBES_PER_CYCLE) if random.random() < reliability)
            await _send_json_line({
                "type": "packet_stat",
                "from": a,
                "to": b,
                "tx": PROBES_PER_CYCLE,
                "rx": successes,
            })


async def _telemetry_loop() -> None:
    """Every TELEMETRY_CYCLE_SECONDS, emit one plausible fake sensor
    reading per source node - mirrors USE_SIMULATED_SENSORS=true in the
    real source firmware, and populates STATE.sensor_data exactly like
    real telemetry would."""
    sim_state = {
        node: {"water_level": 45.0, "temperature": 28.0, "humidity": 70.0}
        for node in nc1.SOURCE_NODES
    }
    seq = {node: 0 for node in nc1.SOURCE_NODES}
    while True:
        await asyncio.sleep(TELEMETRY_CYCLE_SECONDS)
        for node in sorted(nc1.SOURCE_NODES):
            st = sim_state[node]
            st["water_level"] = max(0.0, min(100.0, st["water_level"] + random.uniform(-3, 3)))
            st["temperature"] += random.uniform(-1.0, 1.0)
            st["humidity"] = max(0.0, min(100.0, st["humidity"] + random.uniform(-2, 2)))
            seq[node] += 1
            await _send_json_line({
                "type": "telemetry",
                "node": node,
                "water_level": round(st["water_level"], 1),
                "rain": random.random() < 0.2,
                "temperature": round(st["temperature"], 1),
                "humidity": round(st["humidity"], 1),
                "sequence_number": seq[node],
            })


async def _fault_injection_loop() -> None:
    """After FAULT_INJECTION_DELAY_SECONDS, degrade a couple of the mesh
    links nc1.py is CURRENTLY relying on, so you can watch its Dijkstra
    router reroute around the failure live - the "self-healing" scenario."""
    await asyncio.sleep(FAULT_INJECTION_DELAY_SECONDS)
    if not _last_active_routes:
        log.info("Fault injection: no active routes yet to target, skipping this run.")
        return

    in_use_links: List[Tuple[str, str]] = []
    for route in _last_active_routes:
        for a, b in zip(route, route[1:]):
            if (a, b) in LINK_RELIABILITY:
                in_use_links.append((a, b))

    random.shuffle(in_use_links)
    targets = in_use_links[:FAULT_LINK_COUNT]
    if not targets:
        log.info("Fault injection: no eligible in-use links found, skipping.")
        return

    log.warning("=" * 70)
    log.warning("FAULT INJECTION - simulating a real-world failure on (an) active link(s):")
    for a, b in targets:
        LINK_RELIABILITY[(a, b)] = FAULT_RELIABILITY
        log.warning(f"    {a} -> {b} reliability dropped to {FAULT_RELIABILITY * 100:.0f}%")
    log.warning("Watch the ROUTE_UPDATE lines above/below to see nc1.py's AI reroute around it.")
    log.warning("=" * 70)


# =============================================================================
# ENTRY POINT
# =============================================================================

async def main() -> None:
    log.info("Starting hardware-free field network simulator for nc1.py")
    log.info("nc1.py's source file is NOT modified - only nc1.GATEWAY_HOST is overridden "
             f"in memory to {SIM_GATEWAY_HOST!r} so its TCP client reaches this fake gateway.")
    _log_link_table()

    # Redirect nc1's TCP client target - this changes only the imported
    # module's in-memory attribute; nc1.py on disk is untouched.
    nc1.GATEWAY_HOST = SIM_GATEWAY_HOST

    server = await asyncio.start_server(_handle_client, host=SIM_GATEWAY_HOST, port=nc1.GATEWAY_TCP_PORT)
    log.info(f"Fake gateway TCP server listening on {SIM_GATEWAY_HOST}:{nc1.GATEWAY_TCP_PORT}")

    # nc1.app's own `lifespan` context manager (unchanged, in nc1.py) starts
    # gateway_client_task() and control_loop() automatically once the
    # FastAPI app boots - we do not start those ourselves.
    config = uvicorn.Config(
        nc1.app,
        host=nc1.FRONTEND_HTTP_HOST,
        port=nc1.FRONTEND_HTTP_PORT,
        log_level="warning",
        loop="asyncio",
    )
    uv_server = uvicorn.Server(config)

    log.info(f"nc1.py's real FastAPI app will serve http://localhost:{nc1.FRONTEND_HTTP_PORT}/state")
    log.info(f"Fault injection scheduled at t+{FAULT_INJECTION_DELAY_SECONDS:.0f}s. Ctrl+C to stop.")

    async with server:
        await asyncio.gather(
            server.serve_forever(),
            uv_server.serve(),
            _probe_and_stats_loop(),
            _telemetry_loop(),
            _fault_injection_loop(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Stopped.")
