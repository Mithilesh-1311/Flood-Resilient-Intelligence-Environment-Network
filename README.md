# FRiEND — Flood-Resilient Intelligence Environment Network

Operations dashboard, AI flood prediction pipeline, and firmware for the FRiEND mesh network (SIH 2026).

---

## Architecture Overview

- **`PROJECT/HARDWARE/`**: 
  - `SIH_Gateway_Firmware_FIXED.ino`: Gateway firmware (ESP32-CAM)
  - `SIH_Mesh_Node_Firmware_FIXED.ino`: Mesh node firmware
  - `SIH_Source_Node_Firmware_FIXED.ino`: Sensor source node firmware
  - `nc1.py`: Core mesh network controller, telemetry parser, routing, and WebSocket server
  - `flood_ai.py`: Live flood inference service bridge (GRU model integration)
  - `simulate_hardware.py`: Field simulator for testing without hardware
- **`PROJECT/frontend/`**: Modern command-centre dashboard built with React, Vite, and TailwindCSS
- **`PROJECT/models/`**: Pretrained GRU flood prediction models and calibrated thresholds
- **`PROJECT/flood_dataset/`**: River station metadata and preprocessing parameters
- **`PROJECT/`**: Data pipeline and model training scripts (`train_gru.py`, `evaluate_onset.py`, `build_sequences.py`, etc.)

---

## Quick Start

### 1. Network Controller (Backend)

```bash
cd PROJECT/HARDWARE

# With virtual environment activated:
python simulate_hardware.py    # Field simulation
# or
python nc1.py                  # Live hardware gateway connection
```

### 2. Operations Dashboard (Frontend)

```bash
cd PROJECT/frontend
npm install
npm run dev
```

Visit `http://localhost:5173` to view the command centre.

---

For detailed integration notes and backend diffs, refer to [`PROJECT/INTEGRATION.md`](PROJECT/INTEGRATION.md).
