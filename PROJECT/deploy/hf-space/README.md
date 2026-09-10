---
title: FRiEND Controller
emoji: 🌊
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 8000
pinned: false
short_description: Flood-risk AI and self-healing mesh controller (simulation)
---

# FRiEND controller

Backend for the FRiEND Environmental Intelligence Command Center
(Smart India Hackathon 2026, PS 26178).

This Space runs `nc1.py` — the real Dijkstra router, mesh-health model and
GRU flood inference — against `simulate_hardware.py`'s simulated field network.
A hosted container cannot reach the physical ESP32-CAM gateway, so this
deployment is **always simulation**, and the dashboard labels it that way.

It is an API, not a page. Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /state` | Full controller state |
| `WS /ws` | The same state, pushed every 2 s |
| `POST /reset_health` | Restore mesh relay health to 100 |
| `GET /healthz` | Liveness |
