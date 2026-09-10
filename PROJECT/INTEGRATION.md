# FRiEND — what was added, and what was left alone

The task was to build the command-centre frontend against the existing system.
This file records exactly what changed on the backend so nothing has to be
taken on trust. The full diff for `nc1.py` is in `nc1.integration.patch`.

## Summary

| File | Status |
| --- | --- |
| `HARDWARE/nc1.py` | **77 lines added, 0 removed.** Purely additive. |
| `HARDWARE/flood_ai.py` | **New.** Live flood inference service. |
| `HARDWARE/simulate_hardware.py` | **Unchanged.** |
| `HARDWARE/*.ino` | **Unchanged.** |
| `models/*`, `flood_dataset/*` | **Unchanged.** Read-only. |
| `train_gru.py`, `predict_demo.py`, and the rest of the pipeline | **Unchanged.** |
| `frontend/` | **New.** The dashboard. |

No routing, health, PDR or packet logic was touched. `get_routes_from_ai`,
`_dijkstra_best_path`, `_update_mesh_health`, `PacketStats`, `validate_routes`
and `control_loop`'s existing steps are byte-for-byte what they were.

> One incidental note: the first pass of the patch script rewrote `nc1.py` with
> CRLF endings. That has been reverted — the file is LF, as it was.

## The five additions to `nc1.py`

1. **CORS middleware.** The dashboard is a separate static app. In development
   Vite proxies to `:8000`, but the built bundle needs this to work when served
   from another host during the demo.

2. **Two fields on `NetworkState`** — `flood_ai` and `system` — and the matching
   two keys in `as_dict()`. Every pre-existing key is untouched, so any other
   consumer of `/state` or `/ws` sees exactly what it saw before.

3. **A guarded import of `flood_ai`.** If TensorFlow or `models/` is missing,
   `FLOOD_AI` is `None` and the controller runs exactly as it always did.

4. **Step 9b in the control loop.** Feeds `STATE.sensor_data` into the model's
   rolling windows and runs inference. The GRU call goes through
   `run_in_executor`, so MC-Dropout never blocks the 2 s loop.

5. **Step 9c, the `system` block.** The controller describes itself: gateway
   connection, endpoint, loop interval, uptime, cycle count, dashboard client
   count, and whether its TCP target is the real gateway or loopback. That last
   field is what lets the dashboard state `SIMULATION` vs `LIVE HARDWARE`
   instead of guessing.

Plus a one-line model preload in `lifespan` (on a worker thread, so startup is
not delayed) and two module-level counters.

## Why `flood_ai.py` had to exist

`nc1.py` has never done flood prediction. The trained GRU sat in `models/` and
was only ever exercised offline by `predict_demo.py`. The frontend brief calls
for a live flood-risk panel, so something had to connect the two.

`flood_ai.py` is that bridge and nothing more. Its feature builder is a port of
`predict_demo.features_from_raw()` with pandas swapped for numpy; the two helper
formulas are copied verbatim from `download_flood_dataset.py`. Same window, same
derived columns, same taming transforms, same scaler, same threshold. It does
not retrain, re-tune or re-interpret anything.

### Two mismatches it has to bridge, both disclosed in the UI

**Units.** The source firmware reports `water_level` as 0–100 % of the analog
sensor's span:

```c
int raw = analogRead(PIN_WATER_ANALOG);
int pct = map(raw, WATER_RAW_DRY, WATER_RAW_FULL, 0, 100);
```

The model was trained on river stage in metres against a per-station flood line.
So each source node carries a calibration mapping 0–100 % onto metres. `0 %` is
the station's lowest observed stage; `100 %` is `1.15 ×` the flood line — a
sensor is mounted so that full scale means *flooding*, not *the worst flood in
the ten-year record*.

This matters, and it was got wrong first: mapping onto the full historic
`level_min_m..level_max_m` range put a mid-scale reading above the flood line at
every station, pinning all three nodes at `P(flood) = 1.0` permanently.

It is a **stated calibration, not a measurement**, and the dashboard labels it
as such (`STATED CALIBRATION` on the Sensors and Flood AI modules). If a node is
installed against a surveyed staff gauge, put the real numbers in
`NODE_CALIBRATION` and the assumption drops away.

**Cadence.** The model steps every 15 minutes; 8 steps is a 2-hour window. Live
telemetry arrives every ~2 s. `LIVE_SECONDS_PER_MODEL_STEP = 6.0` commits one
model step per 6 s of wall clock — 150× compression — so the window fills in
under a minute rather than over two hours. Forecasts are still +30 **model**-
minutes ahead, and the chart says where that lands in wall-clock terms. Set it
to `900.0` for real-time operation against deployed hardware.

### Node → station mapping

Read from the `role` field that `download_flood_dataset.py` wrote into each
`flood_dataset/<station>_meta.json`:

| Node | Station | Flood line |
| --- | --- | --- |
| S1 | Scalehill, River Cocker | 1.410 m |
| S2 | Low Briery, River Greta | 1.642 m |
| S3 | Boscastle, River Valency | 1.164 m |

### It degrades honestly

If TensorFlow is absent, the model file is missing, or inference throws, the
payload carries `available: false` and the reason. It emits **no numbers at
all** — the dashboard shows `MODEL OFFLINE` with that reason rather than
substituting a placeholder. Same for a node whose window has not filled: status
`warming_up` with a step count, and no probability field.

## Environment

`models/flood_gru.keras` was saved with **Keras 3.15.1**, which needs
**Python 3.11+**. On 3.10 it fails to deserialise (`GlorotUniform.__init__() got
an unexpected keyword argument 'input_axes'`) and the AI reports itself offline.

A venv is at `.venv` (Python 3.11); `requirements.txt` reproduces it.

Two pre-existing environment problems were found and *not* silently worked
around:

- The global Python 3.10 had `fastapi 0.115.0` with `starlette 1.6.0`, which
  cannot work together — any FastAPI app there dies with
  `Router.__init__() got an unexpected keyword argument 'on_startup'`. The venv
  pins a compatible pair; the global environment was left as it was.
- Installing `tensorflow-cpu` into that global 3.10 environment earlier in this
  work pulled `protobuf` down to 4.25.9, which leaves the globally-installed
  `streamlit 1.63.0` unsatisfied (`pip check` reports it). If Streamlit is used
  for anything else, `pip install "protobuf>=5.26.1"` restores it — the FRiEND
  venv is unaffected either way.

## Verification

`frontend/verify.mjs` drives the real dashboard against the real controller in a
real browser and checks 22 behaviours, including the ones that are easy to fake:
that chart history grows and survives navigation, that unmeasured PDR renders as
a dash rather than 0 %, that the gateway row is empty, that alert events trace to
real reroutes, and that `RESET MESH HEALTH` reaches the controller.

```bash
cd HARDWARE && ../.venv/Scripts/python simulate_hardware.py    # terminal 1
cd frontend && npm run dev                                     # terminal 2
cd frontend && npm run verify                                  # terminal 3
```

Last run: **22/22**, screenshots in `frontend/verify-shots/`.
