# FRiEND — Environmental Intelligence Command Center

Operations dashboard for the FRiEND flood-monitoring mesh (SIH 2026, PS 26178).

It is a **view onto the existing controller**, not a second brain. Every number
on screen comes from `HARDWARE/nc1.py`; the frontend performs no routing, no
inference, and no estimation of its own.

---

## Run it

Two processes. Start the controller first.

**1 — Controller (no hardware needed)**

```bash
cd PROJECT/HARDWARE
../.venv/Scripts/python replay_hardware.py        # REAL gauge data, simulated mesh
../.venv/Scripts/python simulate_hardware.py      # random-walk telemetry instead
```

(On macOS/Linux use `../.venv/bin/python`.) `replay_hardware.py` needs
`flood_dataset/replay_test.csv`, which `py build_replay.py` builds from the
labelled dataset. In replay mode the dashboard shows each prediction next to
what the river actually did.

Against real hardware, run `python nc1.py` instead (it connects out to the
ESP32-CAM gateway at `192.168.4.1:9000`). Either way the API is the same, and
the dashboard labels which one it is talking to.

**2 — Dashboard**

```bash
cd PROJECT/frontend
npm install       # first time only
npm run dev       # http://localhost:5173
```

Vite proxies `/state`, `/reset_health` and `/ws` to `127.0.0.1:8000`. Point it
elsewhere with `FRIEND_CONTROLLER=http://<host>:8000 npm run dev`.

`npm run build` produces a static bundle in `dist/`; it talks to whatever origin
serves it, so the controller needs CORS (already enabled) if served separately.

---

## The data contract

One WebSocket for the whole app. `GET /state` is used only for the first paint
and as a fallback; `/ws` carries every subsequent frame, one every 2 s.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/ws` | WS | Full state snapshot each control cycle |
| `/state` | GET | Same payload, for initial sync |
| `/reset_health` | POST | Restore M1–M7 health to 100 |

Frame shape (`nc1.NetworkState.as_dict`):

```jsonc
{
  "nodes": ["S1","S2","S3","M1","M2","M3","M4","M5","M6","M7","G"],
  "pdr_matrix": [[null, 91.7, ...], ...],   // 11×11, rows = FROM, null = unmeasured
  "node_health": [100, 100, 100, 97, ...],  // same index order as `nodes`
  "sensor_data": { "S1": { "water_level": 45.1, "rain": false, ... } },
  "active_routes": [["S1","M1","M6"], ...], // trailing "G" stripped by nc1
  "route_slots": { "M1": { "led1": {...}, "led2": "OFF" } },
  "route_participation": { "M1": 1, ... },
  "packet_stats_summary": { "total_tx": [[...]], "total_rx": [[...]] },
  "flood_ai": { ... },                      // added by HARDWARE/flood_ai.py
  "system": { ... },                        // controller self-description
  "timestamp": 1788984930.11
}
```

---

## Rules this UI follows

**Missing data is never zero.** `pdr_matrix` carries `null` for any link the
controller did not measure this interval. Those render as `—` with a "no data"
tooltip. Averages are taken over measured entries only. The gateway row and
column stay empty because no firmware probes a node↔G link — the router
substitutes a fallback weight internally and never writes it into the matrix.

**Live values and model evaluation never share a panel.** Anything tagged
`LIVE TELEMETRY` is this cycle's output. POD / FAR / CSI / lead time are tagged
`MODEL EVALUATION`, sit on a different ground, and are read verbatim from
`models/metrics.json` and `models/onset_metrics.json` — they describe the
trained model, not the running network.

**Simulation is stated, not implied.** The controller reports whether its TCP
client is pointed at the real gateway or at loopback, and whether the river
readings are replayed real data. The header shows one of three things:

- `LIVE HARDWARE`
- `SIMULATION`
- `REAL GAUGE REPLAY` with `SIMULATED MESH`

In replay mode the rivers are real, but the radio network is not.

**Two calibrations are disclosed in the UI, because the model and the hardware
do not speak the same units.** See "Honest caveats" below.

**Events come only from state changes.** The alert rail and timeline are
produced by diffing consecutive frames (`src/realtime/events.ts`). A quiet
network produces a quiet rail. Where an event states a cause, that cause is
evidenced from the same two frames — the health that dropped, the PDR that
fell — and is omitted when neither is visible.

**Connectivity problems are never hidden.** `LIVE`, `STALE`, `RECONNECTING` and
`OFFLINE` are four visibly distinct states, each showing the age of the last
frame. A stale feed and a dead one do not look alike.

---

## Honest caveats

Both are surfaced in the payload and labelled in the UI.

**Units.** The firmware reports `water_level` as 0–100 % of the analog water
sensor's span. The GRU was trained on river stage in metres against a
per-station flood line. `flood_ai.py` therefore maps each source node's 0–100 %
onto that station's observed stage range from `station_params.json`. This is a
**stated calibration, not a measurement**, and the dashboard says so wherever
the metre value appears.

**Cadence.** The model steps every 15 minutes (8 steps = a 2 h window). Live
telemetry arrives every ~2 s. `LIVE_SECONDS_PER_MODEL_STEP = 6.0` commits one
model step per 6 s of wall clock, a 150× compression, so the window fills inside
a demo instead of over two real hours. Forecasts are still +30 **model**-minutes
ahead, and the chart says where that lands in wall-clock terms. Set it to
`900.0` for real-time operation.

---

## Architecture

```
src/
  types/friend.ts          wire types — nothing here that nc1.py doesn't send
  lib/
    constants.ts           node order, fixed topology coords, severity bands
    format.ts              formatters; `num()` returns — for null, never 0
    derive.ts              pure derivations (node/route/network summaries)
  realtime/
    store.ts               THE WebSocket. reconnect, staleness, history, events
    RealtimeProvider.tsx   selector hook; components re-render on their slice only
    history.ts             capped ring buffer + windowing
    events.ts              frame-diff → alert events
  components/
    primitives/            Panel, Readout, StatusDot, Tag, NoData, Bar, Segmented
    charts/                chartTheme, WaterLevelChart, LiveChart
    topology/              NetworkTopology (fixed positions, animated routes)
    panels/                MetricStrip, AlertRail, RoutePanel, SensorPanels,
                           FloodPanels, NetworkPanels
    shell/                 AppShell, ConnectionIndicator, OperatorActions
  pages/                   Overview, Network, FloodAI, Sensors, Routing,
                           NodeHealth, Analytics
```

**One socket, selector subscriptions.** `RealtimeStore` is a plain class, not
React state: an 11×11 matrix arriving every 2 s should not walk the component
tree. `useRealtime(selector, isEqual)` re-renders a component only when its
slice actually changes. Charts depend on a frame counter, not on the state
object, so they redraw once per frame and never on unrelated updates.

**History lives in one place.** The controller is stateless about the past —
every frame is a snapshot of *now* — so all trends are accumulated client-side
in a single capped ring buffer (1800 frames ≈ 1 hour at the 2 s cycle). Charts
read a window out of it. Nothing resets when a component mounts or the route
changes; points roll off the left edge as the window slides.

---

## Routes

| Path | Module |
| --- | --- |
| `/` | Command centre |
| `/network` | Mesh topology + node inspector |
| `/flood-ai` | Live inference and model evaluation |
| `/sensors` | Source-node telemetry |
| `/routing` | Active paths, reroute log, relay load |
| `/health` | Per-node health and PDR |
| `/analytics` | PDR matrix, packet counters, controller state |

## Accessibility

Reduced motion is honoured globally (including the SVG route flow). Topology
nodes are keyboard-focusable buttons with descriptive labels. State is never
carried by colour alone: node role is also a shape, health is also an arc and a
number, severity is also a word.
