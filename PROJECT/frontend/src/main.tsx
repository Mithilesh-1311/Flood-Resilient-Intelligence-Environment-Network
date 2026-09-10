import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import { CONTROLLER_ORIGIN } from "./lib/config";
import "./index.css";

/**
 * One RealtimeProvider, mounted above the router, so navigating between
 * modules never tears down the WebSocket or discards the rolling history.
 * CONTROLLER_ORIGIN is empty in local dev (same origin, Vite proxy) and the
 * controller's public URL in a deployed build.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RealtimeProvider origin={CONTROLLER_ORIGIN}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RealtimeProvider>
  </StrictMode>,
);
