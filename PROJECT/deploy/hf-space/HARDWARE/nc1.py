"""
network_controller.py

SIH 2026 - Environmental Monitoring & Self-Healing Wireless Mesh Network
Laptop-side central controller.

ARCHITECTURE
------------
- 10 field nodes: S1, S2, S3 (source/sensor nodes) + M1..M7 (mesh nodes)
- 1 gateway (ESP32-CAM). Physically it is still just a bridge (ESP-NOW <->
  TCP/JSON) - its firmware is untouched. In THIS controller's routing graph
  it is additionally represented as an 11th logical node, "G", so the AI
  router can score and pathfind all the way to the gateway (see NODE_ORDER).
    Gateway <-> Field network : ESP-NOW  (handled on the firmware side)
    Gateway <-> Laptop        : Wi-Fi, newline-delimited JSON over TCP
- This Python process is the single source of truth for network state:
    1. 11x11 PDR matrix              (REAL - computed from packet counters;
                                       G's row/col stay unmeasured/None since
                                       no firmware today sends node<->G probe
                                       or stats traffic - see AI ROUTING section)
    2. 11-element node health vector (MANUAL baseline; mesh nodes M1-M7 also
                                       auto-drain per relay cycle - see below)
    3. Sensor data from S1/S2/S3     (REAL - from gateway telemetry)
    4. Active routes                 (AI-driven: Dijkstra over PDR + health,
                                       always ending at G - same interface)
    5. Packet statistics
    6. Timestamps

The React frontend (and, later, an AI module) consume this state through
FastAPI (GET /state and a WebSocket) instead of keeping their own copies.

Only ONE file, everything in memory. No DB / Docker / Redis / MQTT / cloud.
"""

from __future__ import annotations

import asyncio
import heapq
import json
import logging
import random
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# Live Flood-Risk AI. Optional by design: if TensorFlow or ../models is not
# present, flood_ai reports available=False and this controller keeps running
# exactly as before - network state is never blocked on the model.
try:
    from flood_ai import FLOOD_AI
except Exception as _flood_ai_exc:  # noqa: BLE001
    FLOOD_AI = None
    _FLOOD_AI_IMPORT_ERROR = f"{type(_flood_ai_exc).__name__}: {_flood_ai_exc}"
else:
    _FLOOD_AI_IMPORT_ERROR = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("network_controller")


# =============================================================================
# CONFIGURATION SECTION
# =============================================================================

# ---- Network endpoints -----------------------------------------------------
# The ESP32-CAM gateway runs a Wi-Fi Access Point ("SIH-GATEWAY") with a
# fixed IP (192.168.4.1) and hosts the TCP server itself, since its IP is
# known in advance. The laptop joins that AP as a Wi-Fi station and this
# controller connects OUT to the gateway as a TCP client.
GATEWAY_HOST = "192.168.4.1"      # ESP32-CAM AP's fixed IP
GATEWAY_TCP_PORT = 9000
GATEWAY_RECONNECT_DELAY_SECONDS = 2.0   # wait between reconnect attempts

FRONTEND_HTTP_HOST = "0.0.0.0"
FRONTEND_HTTP_PORT = 8000

# ---- Timing -----------------------------------------------------------------
LOOP_INTERVAL_SECONDS = 2.0
PDR_STALE_AFTER_SECONDS = 10.0

# =============================================================================
# MANUAL HEALTH  (SIMULATED / MANUALLY EDITABLE FOR THE SIH DEMO)
# Health is NOT calculated automatically yet. Edit these values directly to
# demonstrate degraded / recovering nodes. The blue health LED on each
# physical node reflects this value (0-100).
# =============================================================================
MANUAL_HEALTH: Dict[str, int] = {
    "S1": 100,
    "S2": 100,
    "S3": 100,
    "M1": 100,
    "M2": 100,
    "M3": 100,
    "M4": 100,
    "M5": 100,
    "M6": 100,
    "M7": 100,
    "G": 100,
}
# S1-S3 and G stay constant (sensors are treated as constant-health for this
# demo; the gateway is mains-powered, never battery-drained). M1-M7 start at
# this manual baseline and are then managed live by _update_mesh_health():
# they drain while relaying and recover while resting (see
# MESH_HOP_HEALTH_COST_MIN/MAX and MESH_HEALTH_RECOVERY_PER_CYCLE below).
# POST /reset_health restores all mesh nodes to 100 at any time.

# =============================================================================
# AI-DRIVEN ROUTES
# Active routes are computed every control-loop cycle by get_routes_from_ai()
# (Dijkstra over PDR + health - see the AI ROUTING section below), not edited
# by hand. Routing constraint enforced by validate_routes(): each mesh node
# (M1-M7) may appear in AT MOST 2 routes total (across all routes combined),
# not "2 routes per source".
# =============================================================================

# ---- RGB LED colors per route slot (configurable) ---------------------------
# R1/R2/R3.. map to route index 0/1/2... in the *validated, active* route list.
# If more routes than colors are ever used, extra routes cycle through this
# list (change/extend it as needed).
ROUTE_COLORS: List[str] = ["red", "green", "blue", "yellow", "magenta", "cyan"]
# =============================================================================
# NODE INDEX MAPPING
# 0=S1 1=S2 2=S3 3=M1 4=M2 5=M3 6=M4 7=M5 8=M6 9=M7 10=G
# "G" is the gateway, represented as an 11th logical node purely for this
# controller's PDR matrix / AI routing graph - the physical gateway and its
# firmware are unchanged (see module docstring).
# =============================================================================
NODE_ORDER: List[str] = ["S1", "S2", "S3", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "G"]
NODE_TO_INDEX: Dict[str, int] = {name: i for i, name in enumerate(NODE_ORDER)}
INDEX_TO_NODE: Dict[int, str] = {i: name for name, i in NODE_TO_INDEX.items()}
NUM_NODES: int = len(NODE_ORDER)

SOURCE_NODES = {"S1", "S2", "S3"}
MESH_NODES = {"M1", "M2", "M3", "M4", "M5", "M6", "M7"}
GATEWAY_NODE = "G"


def node_id_to_index(node_id: str) -> int:
    """Convert a node id like 'M4' to its matrix index (0-9)."""
    try:
        return NODE_TO_INDEX[node_id]
    except KeyError:
        raise ValueError(f"Unknown node id: {node_id!r}")


def index_to_node_id(index: int) -> str:
    """Convert a matrix index (0-9) back to its node id like 'M4'."""
    try:
        return INDEX_TO_NODE[index]
    except KeyError:
        raise ValueError(f"Index out of range: {index!r}")


def is_mesh_node(node_id: str) -> bool:
    return node_id in MESH_NODES


def is_source_node(node_id: str) -> bool:
    return node_id in SOURCE_NODES


def is_gateway_node(node_id: str) -> bool:
    return node_id == GATEWAY_NODE


# =============================================================================
# PDR (Packet Delivery Ratio) — REAL, never faked.
#
# PDR[A][B] = packets successfully received by B / packets transmitted by A * 100
# PDR is directional: PDR[A][B] != PDR[B][A] in general.
#
# The gateway reports packet counts for links it observes over ESP-NOW
# (type="packet_stat"). We accumulate those into per-interval counters and
# turn them into a fresh PDR reading every LOOP_INTERVAL_SECONDS, so real
# degradation (e.g. a metal box placed around a node) shows up promptly.
# =============================================================================

class PacketStats:
    """Cumulative + per-interval tx/rx counters for every directed link."""

    def __init__(self, size: int = 10):
        self.size = size
        # Cumulative totals (for stats/debug), never reset.
        self.total_tx = [[0] * size for _ in range(size)]
        self.total_rx = [[0] * size for _ in range(size)]
        # Interval counters, reset every cycle after PDR is computed from them.
        self.interval_tx = [[0] * size for _ in range(size)]
        self.interval_rx = [[0] * size for _ in range(size)]
        self.last_update = [[0.0] * size for _ in range(size)]

    def record(self, from_node: str, to_node: str, tx_delta: int, rx_delta: int) -> None:
        a = node_id_to_index(from_node)
        b = node_id_to_index(to_node)
        tx_delta = max(0, int(tx_delta))
        rx_delta = max(0, int(rx_delta))
        self.total_tx[a][b] += tx_delta
        self.total_rx[a][b] += rx_delta
        self.interval_tx[a][b] += tx_delta
        self.interval_rx[a][b] += rx_delta
        if tx_delta > 0 or rx_delta > 0:
            self.last_update[a][b] = time.time()

    def compute_pdr_matrix(self) -> List[List[Optional[float]]]:
        """
        Compute PDR for the interval that just elapsed and reset interval
        counters. A link with no transmissions this interval keeps its
        previous PDR value (None here means 'no data this interval'; the
        caller decides whether to hold the last known value).
        """
        pdr = [[None] * self.size for _ in range(self.size)]
        for a in range(self.size):
            for b in range(self.size):
                tx = self.interval_tx[a][b]
                rx = self.interval_rx[a][b]
                if tx > 0:
                    pdr[a][b] = round(min(rx, tx) / tx * 100.0, 1)
                else:
                    pdr[a][b] = None
        # Reset interval counters for the next window.
        self.interval_tx = [[0] * self.size for _ in range(self.size)]
        self.interval_rx = [[0] * self.size for _ in range(self.size)]
        return pdr


# =============================================================================
# ROUTE VALIDATION
# =============================================================================

class RouteValidationError(Exception):
    pass

def route_participation_count(routes: List[List[str]]) -> Dict[str, int]:
    """Count how many routes each mesh node (M1-M7) participates in."""
    counts: Dict[str, int] = {m: 0 for m in MESH_NODES}
    for route in routes:
        for node_id in route:
            if is_mesh_node(node_id):
                counts[node_id] += 1
    return counts


def validate_routes(routes: List[List[str]]) -> Dict[str, int]:
    """
    Validate that no mesh node participates in more than 2 active routes.
    Returns the participation counts if valid, raises RouteValidationError
    otherwise. This must be called before anything is sent to the gateway.
    """
    if not routes:
        return route_participation_count(routes)

    for route in routes:
        if not route or not is_source_node(route[0]):
            raise RouteValidationError(
                f"Route {route!r} must start with a source node (S1/S2/S3)."
            )
        for node_id in route:
            if node_id not in NODE_TO_INDEX:
                raise RouteValidationError(f"Route {route!r} contains unknown node {node_id!r}.")

    counts = route_participation_count(routes)
    violations = {m: c for m, c in counts.items() if c > 2}
    if violations:
        raise RouteValidationError(
            f"Mesh node route-count constraint violated (max 2 routes/node): {violations}"
        )
    return counts


# =============================================================================
# ROUTE LED ASSIGNMENT
#
# Each mesh node has two RGB LEDs: LED1 = route slot 1, LED2 = route slot 2.
# A mesh node's LED slots are assigned in the order routes are listed.
# If a node only appears in one route, LED2 is "OFF".
# =============================================================================

def assign_route_leds(
    routes: List[List[str]],
    colors: Optional[List[str]] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    Returns, for every mesh node:
        {
          "M4": {"led1": {"route": "R1", "color": "red"},
                 "led2": {"route": "R2", "color": "green"}},
          "M1": {"led1": {"route": "R1", "color": "red"},
                 "led2": "OFF"},
          ...
        }
    Mesh nodes that appear in no active route get both LEDs "OFF".
    """
    colors = colors or ROUTE_COLORS
    route_names = [f"R{i + 1}" for i in range(len(routes))]
    route_color_by_name = {
        name: colors[i % len(colors)] for i, name in enumerate(route_names)
    }

    slots: Dict[str, Dict[str, Any]] = {
        m: {"led1": "OFF", "led2": "OFF"} for m in MESH_NODES
    }

    # Walk mesh nodes in the order they appear across routes, assigning the
    # first free LED slot on each mesh node.
    for route_idx, route in enumerate(routes):
        route_name = route_names[route_idx]
        for node_id in route:
            if not is_mesh_node(node_id):
                continue
            entry = slots[node_id]
            if entry["led1"] == "OFF":
                entry["led1"] = {"route": route_name, "color": route_color_by_name[route_name]}
            elif entry["led2"] == "OFF":
                entry["led2"] = {"route": route_name, "color": route_color_by_name[route_name]}
            # A third occurrence would violate validate_routes() and never
            # reach here, since routes are validated first.

    return slots


# =============================================================================
# AI ROUTING - DIJKSTRA OVER PDR + HEALTH
#
# Every control-loop cycle, each source (S1, S2, S3) gets an independent
# route computed by a Dijkstra search over the 11-node graph (S1-S3, M1-M7,
# G), ending at the gateway node G. The "goodness" of a directed hop a->b is:
#
#     score(a, b) = 0.6 * PDR[a][b] + 0.2 * health[a] + 0.2 * health[b]
#
# Dijkstra minimizes cumulative COST, so this is inverted via
# cost(a, b) = 100 - score(a, b): minimizing total cost == maximizing the
# weighted PDR/health path, so the algorithm iteratively picks the next
# best hop exactly as specified.
#
# Firmware realities (confirmed by reading all three .ino files) shape two
# hard constraints here:
#   - No source or mesh node ever probes/measures a link to G directly -
#     sendNeighborProbes() only targets the 7 mesh nodes, on both the
#     source and mesh firmware. So PDR[x][G]/PDR[G][x] are always None
#     (honestly unmeasured) in the REAL pdr_matrix. GATEWAY_LINK_PDR_FALLBACK
#     is used ONLY inside _link_weight() below for G-adjacent edges, and is
#     never written back into pdr_matrix - the matrix stays real/never-faked.
#   - A source node's firmware only accepts a route with >= 2 hop entries
#     (itself + at least one mesh relay) - a direct S->G route can never be
#     sent to the field. MIN_MESH_HOPS enforces this at the graph level
#     (a source->G edge is never reachable below that many mesh hops), so a
#     source with no viable multi-hop path is simply held for that cycle
#     rather than routed directly.
# =============================================================================

MESH_HOP_HEALTH_COST_MIN = 5
MESH_HOP_HEALTH_COST_MAX = 15
MESH_HEALTH_RECOVERY_PER_CYCLE = 20
# A mesh node NOT relaying in a given cycle recovers this much health
# instead (resting / recharging). Without recovery the whole mesh floors at
# 0% within ~30s of runtime, at which point the two health terms in the
# Dijkstra weight below stop differentiating between nodes and routing
# silently degenerates to PDR-only. With it, health settles into a live
# equilibrium: heavily-used nodes dip, rested nodes climb, and the router
# genuinely spreads load. Set to 0 to restore pure monotonic burn-down.
# Health lost by a relaying mesh node each control-loop cycle is drawn
# fresh, independently per node, from this [min, max] range - not a fixed
# amount - so two nodes relaying the same cycle can lose different amounts.

MIN_MESH_HOPS = 2
MAX_MESH_HOPS = 4
# Matches firmware's MAX_HOPS_PER_ROUTE=5 wire limit (source + up to 4 mesh
# hops); MIN_MESH_HOPS=2 forbids ever computing a direct source->G route.

GATEWAY_LINK_PDR_FALLBACK = 100.0
# No firmware measures a node<->G link (see above), so it is always
# unmeasured in the real PDR matrix. Used only as an edge-weight input for
# Dijkstra's G-adjacent edges - never written into STATE.pdr_matrix.

GATEWAY_INDEX = NODE_TO_INDEX[GATEWAY_NODE]


def _link_weight(
    pdr_matrix: List[List[Optional[float]]],
    node_health: List[int],
    a_idx: int,
    b_idx: int,
) -> Optional[float]:
    """
    Weighted 'goodness' score for the directed link a->b:
        0.6 * PDR[a][b] + 0.2 * health[a] + 0.2 * health[b]
    Returns None if the link has no real PDR data and isn't gateway-adjacent
    (i.e. genuinely unusable this cycle - same as "no data yet" today).
    """
    pdr = pdr_matrix[a_idx][b_idx]
    if pdr is None:
        if a_idx != GATEWAY_INDEX and b_idx != GATEWAY_INDEX:
            return None
        pdr = GATEWAY_LINK_PDR_FALLBACK
    return 0.6 * pdr + 0.2 * node_health[a_idx] + 0.2 * node_health[b_idx]


def _dijkstra_best_path(
    pdr_matrix: List[List[Optional[float]]],
    node_health: List[int],
    start: str,
    blocked_mesh: Set[str],
) -> Optional[List[str]]:
    """
    Expanded-state Dijkstra from `start` (a source node) to the gateway "G",
    minimizing cumulative cost = sum(100 - _link_weight(a, b)) over the
    path. State = (node index, frozenset of mesh-node indices already
    visited on this path), so a path never revisits a mesh node and its
    mesh-hop count is simply len(that frozenset). Only an arrival at G with
    MIN_MESH_HOPS <= mesh_hops <= MAX_MESH_HOPS is accepted as a solution;
    `blocked_mesh` (mesh nodes already at their 2-route cap from earlier
    sources this cycle) are excluded from the search entirely. Returns the
    full path ending in "G", or None if no valid path exists.
    """
    start_idx = NODE_TO_INDEX[start]
    blocked_idx = {NODE_TO_INDEX[m] for m in blocked_mesh}
    mesh_indices = [NODE_TO_INDEX[m] for m in MESH_NODES]

    initial_state = (start_idx, frozenset())
    best_cost: Dict[Tuple[int, FrozenSet[int]], float] = {initial_state: 0.0}
    predecessor: Dict[Tuple[int, FrozenSet[int]], Tuple[int, FrozenSet[int]]] = {}

    counter = 0  # tie-breaker so heapq never has to compare frozensets directly
    heap: List[Tuple[float, int, int, FrozenSet[int]]] = [(0.0, counter, start_idx, frozenset())]

    while heap:
        cost, _, node_idx, visited = heapq.heappop(heap)
        state = (node_idx, visited)
        if cost > best_cost.get(state, float("inf")):
            continue  # a cheaper route to this state was already relaxed

        if node_idx == GATEWAY_INDEX:
            if MIN_MESH_HOPS <= len(visited) <= MAX_MESH_HOPS:
                path_indices = [GATEWAY_INDEX]
                cur = state
                while cur in predecessor:
                    cur = predecessor[cur]
                    path_indices.append(cur[0])
                path_indices.reverse()
                return [INDEX_TO_NODE[i] for i in path_indices]
            continue  # wrong hop count - G has no outgoing edges, dead end

        if len(visited) < MAX_MESH_HOPS:
            for next_idx in mesh_indices:
                if next_idx in blocked_idx or next_idx in visited:
                    continue
                weight = _link_weight(pdr_matrix, node_health, node_idx, next_idx)
                if weight is None:
                    continue
                next_visited = visited | {next_idx}
                next_state = (next_idx, next_visited)
                next_cost = cost + (100.0 - weight)
                if next_cost < best_cost.get(next_state, float("inf")):
                    best_cost[next_state] = next_cost
                    predecessor[next_state] = state
                    counter += 1
                    heapq.heappush(heap, (next_cost, counter, next_idx, next_visited))

        if len(visited) >= MIN_MESH_HOPS:
            weight = _link_weight(pdr_matrix, node_health, node_idx, GATEWAY_INDEX)
            if weight is not None:
                next_state = (GATEWAY_INDEX, visited)
                next_cost = cost + (100.0 - weight)
                if next_cost < best_cost.get(next_state, float("inf")):
                    best_cost[next_state] = next_cost
                    predecessor[next_state] = state
                    counter += 1
                    heapq.heappush(heap, (next_cost, counter, GATEWAY_INDEX, visited))

    return None  # no path satisfying the mesh-hop bounds exists this cycle


def get_routes_from_ai(
    pdr_matrix: List[List[Optional[float]]],
    node_health: List[int],
    sensor_data: Dict[str, Dict[str, Any]],
) -> List[List[str]]:
    """
    Dijkstra-based routing: for S1, S2, S3 (fixed order), find the min-cost
    path to G that takes MIN_MESH_HOPS..MAX_MESH_HOPS mesh relays, weighting
    each hop by 0.6*PDR + 0.2*health[sender] + 0.2*health[receiver]. Mesh
    nodes already used by 2 routes earlier in this same pass are excluded
    from later sources, so validate_routes()'s "max 2 routes per mesh node"
    check downstream almost always passes on the first try. The trailing
    "G" is stripped before returning - firmware already treats "no next
    hop" as "I'm the last hop, forward straight to the gateway" (see
    SIH_Mesh_Node_Firmware_FIXED.ino), so the wire format is unchanged.

    Signature is fixed: (pdr_matrix, node_health, sensor_data) -> routes.
    """
    mesh_usage: Dict[str, int] = {m: 0 for m in MESH_NODES}
    routes: List[List[str]] = []

    for source in ("S1", "S2", "S3"):
        blocked_mesh = {m for m, count in mesh_usage.items() if count >= 2}
        path = _dijkstra_best_path(pdr_matrix, node_health, source, blocked_mesh)
        if path is None:
            log.warning(
                f"AI routing: no viable {MIN_MESH_HOPS}-{MAX_MESH_HOPS}-hop path "
                f"found for {source} (mesh relays exhausted/unhealthy) - held this cycle"
            )
            continue
        route = path[:-1]  # drop trailing "G" - implicit last hop on the wire
        for node_id in route:
            if is_mesh_node(node_id):
                mesh_usage[node_id] += 1
        routes.append(route)

    return routes


def _update_mesh_health(routes: List[List[str]]) -> None:
    """
    Mesh battery model, applied once per control-loop cycle:
      - a mesh node relaying in an active route LOSES a fresh,
        independently-drawn random percentage
        (MESH_HOP_HEALTH_COST_MIN..MAX) - battery drain from relay duty.
      - a mesh node NOT relaying this cycle RECOVERS
        MESH_HEALTH_RECOVERY_PER_CYCLE instead - resting / recharging.
    Both are clamped to the 0..100 range. Sensor (S1-S3) and gateway (G)
    health stay constant, per spec.

    Because the Dijkstra router prefers healthier nodes, drain concentrates
    on whichever nodes are currently healthiest, they dip, and traffic
    shifts to rested ones - a negative feedback loop that spreads load
    across the mesh instead of collapsing every node to 0%.
    POST /reset_health still restores all mesh nodes to 100 immediately.
    """
    relaying = {node_id for route in routes for node_id in route if is_mesh_node(node_id)}
    for node_id in MESH_NODES:
        if node_id in relaying:
            drain = random.randint(MESH_HOP_HEALTH_COST_MIN, MESH_HOP_HEALTH_COST_MAX)
            MANUAL_HEALTH[node_id] = max(0, MANUAL_HEALTH[node_id] - drain)
        elif MESH_HEALTH_RECOVERY_PER_CYCLE:
            MANUAL_HEALTH[node_id] = min(
                100, MANUAL_HEALTH[node_id] + MESH_HEALTH_RECOVERY_PER_CYCLE
            )


# =============================================================================
# CENTRAL STATE
# =============================================================================

@dataclass
class NetworkState:
    pdr_matrix: List[List[Optional[float]]] = field(
        default_factory=lambda: [[None] * NUM_NODES for _ in range(NUM_NODES)]
    )
    node_health: List[int] = field(default_factory=lambda: [100] * NUM_NODES)
    sensor_data: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    active_routes: List[List[str]] = field(default_factory=list)
    route_slots: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    route_participation: Dict[str, int] = field(default_factory=dict)
    packet_stats_summary: Dict[str, Any] = field(default_factory=dict)
    flood_ai: Dict[str, Any] = field(default_factory=dict)
    system: Dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "nodes": NODE_ORDER,
            "pdr_matrix": self.pdr_matrix,
            "node_health": self.node_health,
            "sensor_data": self.sensor_data,
            "active_routes": self.active_routes,
            "route_slots": self.route_slots,
            "route_participation": self.route_participation,
            "packet_stats_summary": self.packet_stats_summary,
            "flood_ai": self.flood_ai,
            "system": self.system,
            "timestamp": self.timestamp,
        }


STATE = NetworkState()
STATS = PacketStats(size=NUM_NODES)

_started_at = time.time()
_cycle_count = [0]

# Last-known PDR value per link. A quiet link is held briefly, then expires
# if measurement reports stop arriving (e.g. a node/link disappears).
_last_pdr: List[List[Optional[float]]] = [[None] * NUM_NODES for _ in range(NUM_NODES)]


# =============================================================================
# GATEWAY COMMUNICATION (TCP, newline-delimited JSON)
#
# The ESP32-CAM gateway hosts the Wi-Fi AP ("SIH-GATEWAY") with a fixed IP
# (192.168.4.1) and runs the TCP SERVER itself, since its IP is known in
# advance. This controller is therefore a TCP CLIENT: it connects OUT to
# GATEWAY_HOST:GATEWAY_TCP_PORT and auto-reconnects if the link drops (Wi-Fi
# flakiness during the physical demo, gateway reboot, etc.).
#
# Message types:
#   FROM gateway -> laptop:
#     "telemetry"   : sensor reading from S1/S2/S3
#     "packet_stat" : tx/rx counts for one or more directed links
#   FROM laptop -> gateway:
#     "health_update" : current health vector, so LED brightness can be set
#     "route_update"  : validated active routes + LED slot assignment
#
# The gateway is a bridge only; it performs no AI inference.
# =============================================================================

_gateway_reader: Optional[asyncio.StreamReader] = None
_gateway_writer: Optional[asyncio.StreamWriter] = None
_gateway_lock = asyncio.Lock()
_gateway_connected = asyncio.Event()


async def gateway_client_task() -> None:
    """
    Runs forever: connect to the gateway, read newline-delimited JSON
    messages until the connection drops, then wait and reconnect.
    """
    global _gateway_reader, _gateway_writer
    while True:
        try:
            log.info(f"Connecting to gateway at {GATEWAY_HOST}:{GATEWAY_TCP_PORT} ...")
            reader, writer = await asyncio.open_connection(GATEWAY_HOST, GATEWAY_TCP_PORT)
            async with _gateway_lock:
                _gateway_reader = reader
                _gateway_writer = writer
            _gateway_connected.set()
            log.info("Gateway connected.")

            while True:
                line = await reader.readline()
                if not line:
                    break  # gateway closed the connection
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    log.warning(f"Malformed message from gateway: {exc}")
                    continue
                _process_gateway_message(message)

        except (ConnectionRefusedError, OSError) as exc:
            log.warning(f"Gateway connection failed: {exc}")
        except asyncio.IncompleteReadError:
            pass
        finally:
            async with _gateway_lock:
                if _gateway_writer is not None:
                    _gateway_writer.close()
                _gateway_reader = None
                _gateway_writer = None
            _gateway_connected.clear()
            log.info("Gateway disconnected.")

        await asyncio.sleep(GATEWAY_RECONNECT_DELAY_SECONDS)


def _process_gateway_message(message: Dict[str, Any]) -> None:
    """Step 1/2 of the loop: fold an incoming gateway message into state."""
    msg_type = message.get("type")

    if msg_type == "telemetry":
        node_id = message.get("node")
        if node_id not in SOURCE_NODES:
            log.warning(f"telemetry from non-source node ignored: {node_id!r}")
            return
        reading = {
            "water_level": message.get("water_level"),
            "rain": message.get("rain"),
            "temperature": message.get("temperature"),
            "humidity": message.get("humidity"),
        }
        # AO from MH-RD is optional/informational only.
        if "rain_analog" in message:
            reading["rain_analog"] = message["rain_analog"]
        STATE.sensor_data[node_id] = {k: v for k, v in reading.items() if v is not None}

    elif msg_type == "packet_stat":
        links = message.get("links")
        if links is None and "from" in message and "to" in message:
            links = [message]
        for link in links or []:
            try:
                STATS.record(
                    link["from"], link["to"],
                    link.get("tx", 0), link.get("rx", 0),
                )
            except (ValueError, KeyError) as exc:
                log.warning(f"Bad packet_stat entry {link!r}: {exc}")

    else:
        log.warning(f"Unknown message type from gateway: {msg_type!r}")


async def _broadcast_to_gateway(message: Dict[str, Any]) -> None:
    """Send a JSON message (health_update / route_update) to the gateway."""
    if not _gateway_connected.is_set():
        return  # nothing to send until the gateway link is up
    payload = (json.dumps(message) + "\n").encode("utf-8")
    async with _gateway_lock:
        writer = _gateway_writer
        if writer is None:
            return
        try:
            writer.write(payload)
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError) as exc:
            log.warning(f"Failed to send to gateway: {exc}")


async def send_health_update(node_health: List[int]) -> None:
    health_by_name = {NODE_ORDER[i]: node_health[i] for i in range(NUM_NODES)}
    await _broadcast_to_gateway({
        "type": "health_update",
        "health": health_by_name,
        "timestamp": time.time(),
    })


async def send_route_update(
    routes: List[List[str]],
    route_slots: Dict[str, Dict[str, Any]],
) -> None:
    route_names = {f"R{i + 1}": route for i, route in enumerate(routes)}
    await _broadcast_to_gateway({
        "type": "route_update",
        "routes": route_names,
        "route_slots": route_slots,
        "timestamp": time.time(),
    })


# =============================================================================
# FRONTEND WEBSOCKET CLIENTS
# =============================================================================

_ws_clients: List[WebSocket] = []
_ws_lock = asyncio.Lock()


async def _broadcast_to_frontend(state_dict: Dict[str, Any]) -> None:
    async with _ws_lock:
        dead = []
        for ws in _ws_clients:
            try:
                await ws.send_json(state_dict)
            except Exception:
                dead.append(ws)
        for ws in dead:
            _ws_clients.remove(ws)


# =============================================================================
# MAIN 2-SECOND CONTROL LOOP
# =============================================================================

async def control_loop() -> None:
    global _last_pdr
    while True:
        loop_start = time.time()

        # 1 & 2. Incoming gateway messages are processed continuously by
        #        _handle_gateway_connection() as they arrive (non-blocking).

        # 3. Calculate PDR from this interval's packet counters.
        fresh_pdr = STATS.compute_pdr_matrix()
        merged_pdr: List[List[Optional[float]]] = [[None] * NUM_NODES for _ in range(NUM_NODES)]
        now = time.time()
        for a in range(NUM_NODES):
            for b in range(NUM_NODES):
                if fresh_pdr[a][b] is not None:
                    merged_pdr[a][b] = fresh_pdr[a][b]
                elif (
                    _last_pdr[a][b] is not None
                    and STATS.last_update[a][b] > 0
                    and (now - STATS.last_update[a][b]) <= PDR_STALE_AFTER_SECONDS
                ):
                    merged_pdr[a][b] = _last_pdr[a][b]
                else:
                    merged_pdr[a][b] = None
        _last_pdr = merged_pdr
        STATE.pdr_matrix = merged_pdr

        # 4. Read manually configured health.
        node_health = [MANUAL_HEALTH[NODE_ORDER[i]] for i in range(NUM_NODES)]
        STATE.node_health = node_health

        # 5. Sensor data already updated live in STATE.sensor_data via telemetry.

        # 6/7. Prepare AI input and get routes (Dijkstra over PDR + health).
        candidate_routes = get_routes_from_ai(STATE.pdr_matrix, node_health, STATE.sensor_data)

        # 8. Validate route constraints before anything goes to the gateway.
        try:
            participation = validate_routes(candidate_routes)
            STATE.active_routes = candidate_routes
            STATE.route_participation = participation
            STATE.route_slots = assign_route_leds(candidate_routes, ROUTE_COLORS)
            # Mesh nodes relaying this cycle drain battery health; resting
            # ones recover. Feeds into next cycle's route recompute.
            _update_mesh_health(STATE.active_routes)
        except RouteValidationError as exc:
            log.error(f"Route validation FAILED, keeping previous active routes: {exc}")
            # Keep last-known-good routes/slots in STATE untouched.

        # 9. Send health and route info to gateway.
        await send_health_update(STATE.node_health)
        await send_route_update(STATE.active_routes, STATE.route_slots)

        # 9b. Flood-Risk AI. Telemetry is folded into the per-node rolling
        #     windows every cycle (cheap); the GRU itself runs in a worker
        #     thread so MC-Dropout never stalls this 2 s loop.
        if FLOOD_AI is not None:
            FLOOD_AI.ingest(STATE.sensor_data)
            if FLOOD_AI.available:
                try:
                    STATE.flood_ai = await asyncio.get_running_loop().run_in_executor(
                        None, FLOOD_AI.predict_all
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning(f"Flood AI cycle failed: {exc}")
            else:
                STATE.flood_ai = FLOOD_AI.snapshot()
        else:
            STATE.flood_ai = {
                "available": False,
                "status": "unavailable",
                "reason": _FLOOD_AI_IMPORT_ERROR,
                "nodes": {},
                "worst": None,
                "evaluation": {},
            }

        # 9c. Self-description, so the dashboard can state plainly whether it
        #     is watching real hardware or the simulator, and never imply one
        #     is the other. Derived from real state only.
        _cycle_count[0] += 1
        STATE.system = {
            "gateway_connected": _gateway_connected.is_set(),
            "gateway_host": GATEWAY_HOST,
            "gateway_port": GATEWAY_TCP_PORT,
            "data_source": (
                "SIMULATION" if GATEWAY_HOST in ("127.0.0.1", "localhost", "::1")
                else "LIVE_HARDWARE"
            ),
            "loop_interval_seconds": LOOP_INTERVAL_SECONDS,
            "pdr_stale_after_seconds": PDR_STALE_AFTER_SECONDS,
            "started_at": _started_at,
            "uptime_seconds": round(time.time() - _started_at, 1),
            "cycle": _cycle_count[0],
            "ws_clients": len(_ws_clients),
        }

        # 10. Update frontend state.
        STATE.packet_stats_summary = {
            "total_tx": STATS.total_tx,
            "total_rx": STATS.total_rx,
        }
        STATE.timestamp = time.time()
        await _broadcast_to_frontend(STATE.as_dict())

        # 11. Print concise status.
        _print_debug_status()

        # 12. Repeat, without unnecessarily blocking / drifting.
        elapsed = time.time() - loop_start
        await asyncio.sleep(max(0.0, LOOP_INTERVAL_SECONDS - elapsed))


def _print_debug_status() -> None:
    print("\n" + "=" * 70)
    print(f"[{time.strftime('%H:%M:%S')}] NETWORK STATE")
    print("-" * 70)

    print("PDR matrix (rows=from, cols=to; '-' = no data yet):")
    header = "      " + " ".join(f"{n:>6}" for n in NODE_ORDER)
    print(header)
    for a in range(NUM_NODES):
        row = []
        for b in range(NUM_NODES):
            v = STATE.pdr_matrix[a][b]
            row.append(f"{v:6.1f}" if v is not None else f"{'-':>6}")
        print(f"{NODE_ORDER[a]:>5} " + " ".join(row))

    print("-" * 70)
    print("Health: " + ", ".join(f"{NODE_ORDER[i]}={STATE.node_health[i]}%" for i in range(NUM_NODES)))

    print("-" * 70)
    print("Sensors:")
    for s in ("S1", "S2", "S3"):
        print(f"  {s}: {STATE.sensor_data.get(s, '(no data yet)')}")

    print("-" * 70)
    print("Active routes:")
    for i, route in enumerate(STATE.active_routes):
        print(f"  R{i + 1}: {' -> '.join(route)}")

    print("Mesh participation counts:", STATE.route_participation)
    print("=" * 70)


# =============================================================================
# FASTAPI FRONTEND API
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    gateway_task = asyncio.create_task(gateway_client_task())
    loop_task = asyncio.create_task(control_loop())
    if FLOOD_AI is not None:
        # Importing TensorFlow and deserialising the GRU takes seconds; do it
        # on a worker thread so the API and control loop come up immediately.
        asyncio.get_running_loop().run_in_executor(None, FLOOD_AI.load)

    try:
        yield
    finally:
        loop_task.cancel()
        gateway_task.cancel()


app = FastAPI(title="SIH 2026 Mesh Network Controller", lifespan=lifespan)

# The FRiEND dashboard is a separate static app (frontend/). In dev it is
# proxied through Vite on :5173; allowing any origin here means the built
# bundle also works when opened from any demo machine on the LAN.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/state")
async def get_state() -> Dict[str, Any]:
    return STATE.as_dict()


@app.post("/reset_health")
async def reset_health() -> Dict[str, Any]:
    """
    Reset all mesh node (M1-M7) health back to 100. Mesh health otherwise
    only changes via _update_mesh_health() (drain while relaying, recover
    while resting), so this is the manual override for restarting a demo
    without restarting the process. S1-S3 and G are constant and untouched.
    """
    for m in MESH_NODES:
        MANUAL_HEALTH[m] = 100
    return {"status": "ok", "health": dict(MANUAL_HEALTH)}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    async with _ws_lock:
        _ws_clients.append(websocket)
    try:
        await websocket.send_json(STATE.as_dict())
        while True:
            # Frontend doesn't need to send anything; just keep the socket
            # open and drain any incoming pings/messages.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with _ws_lock:
            if websocket in _ws_clients:
                _ws_clients.remove(websocket)


# =============================================================================
# ENTRY POINT
# =============================================================================

def main() -> None:
    uvicorn.run(app, host=FRONTEND_HTTP_HOST, port=FRONTEND_HTTP_PORT, log_level="info")


if __name__ == "__main__":
    main()
