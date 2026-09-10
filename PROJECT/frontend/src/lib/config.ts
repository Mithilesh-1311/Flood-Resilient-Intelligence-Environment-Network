/**
 * Where the controller lives.
 *
 * Local dev: leave VITE_CONTROLLER_URL unset. The app talks to its own origin
 * and Vite proxies /state, /reset_health and /ws to 127.0.0.1:8000.
 *
 * Deployed (Vercel): a static host cannot proxy WebSockets, so the browser has
 * to reach the controller directly. Set VITE_CONTROLLER_URL to the
 * controller's public HTTPS origin, e.g.
 *
 *   VITE_CONTROLLER_URL=https://<user>-friend-controller.hf.space
 *
 * Vite inlines this at BUILD time, so changing it needs a redeploy, not just a
 * settings change.
 */

const raw = (import.meta.env.VITE_CONTROLLER_URL ?? "").trim();

/** Empty string means same-origin (the dev proxy). Never has a trailing slash. */
export const CONTROLLER_ORIGIN = raw.replace(/\/+$/, "");

/** Short name for the controller, for status text. */
export const CONTROLLER_LABEL = (() => {
  if (!CONTROLLER_ORIGIN) return "local controller";
  try {
    return new URL(CONTROLLER_ORIGIN).host;
  } catch {
    return CONTROLLER_ORIGIN;
  }
})();

// An HTTPS page cannot open ws:// or fetch http:// from a public host, and the
// browser blocks it without a useful error. Say so at startup instead.
if (
  typeof window !== "undefined" &&
  window.location.protocol === "https:" &&
  CONTROLLER_ORIGIN.startsWith("http://")
) {
  console.error(
    "FRiEND: this page is served over HTTPS but VITE_CONTROLLER_URL is " +
      CONTROLLER_ORIGIN +
      ". Browsers block that as mixed content; the controller must be served over https://.",
  );
}
