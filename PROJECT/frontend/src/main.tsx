import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { RealtimeProvider } from "./realtime/RealtimeProvider";
import "./index.css";

/**
 * One RealtimeProvider, mounted above the router, so navigating between
 * modules never tears down the WebSocket or discards the rolling history.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RealtimeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RealtimeProvider>
  </StrictMode>,
);
