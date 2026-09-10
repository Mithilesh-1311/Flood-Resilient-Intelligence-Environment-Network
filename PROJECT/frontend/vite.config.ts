import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The FRiEND controller (nc1.py / simulate_hardware.py) serves FastAPI on :8000.
// Proxying keeps the frontend origin-relative, so the same build works whether
// it is served by Vite in dev or from any host during the demo.
const CONTROLLER = process.env.FRIEND_CONTROLLER ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: {
      "/state": { target: CONTROLLER, changeOrigin: true },
      "/reset_health": { target: CONTROLLER, changeOrigin: true },
      "/ws": { target: CONTROLLER, ws: true, changeOrigin: true },
    },
  },
});
