/**
 * Persistent link state.
 *
 * Connectivity problems are never hidden or smoothed over: LIVE, STALE,
 * RECONNECTING and OFFLINE are four distinct, visibly different states, each
 * carrying the age of the last frame so an operator can tell a quiet network
 * from a dead one.
 */
import { useEffect, useState } from "react";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { StatusDot } from "@/components/primitives";
import { cx } from "@/lib/format";
import type { LinkState } from "@/types/friend";
import type { Severity } from "@/lib/constants";

const PRESENTATION: Record<
  LinkState,
  { label: string; severity: Severity; pulse: boolean; help: string }
> = {
  connecting: {
    label: "CONNECTING",
    severity: "off",
    pulse: true,
    help: "Opening the WebSocket to the controller.",
  },
  live: {
    label: "LIVE",
    severity: "ok",
    pulse: true,
    help: "Receiving state frames from the controller.",
  },
  stale: {
    label: "STALE",
    severity: "warn",
    pulse: false,
    help: "The socket is open but the controller has stopped sending frames.",
  },
  reconnecting: {
    label: "RECONNECTING",
    severity: "warn",
    pulse: true,
    help: "The socket dropped. Retrying with backoff.",
  },
  offline: {
    label: "OFFLINE",
    severity: "crit",
    pulse: false,
    help: "No connection to the controller.",
  },
};

export function ConnectionIndicator({ compact = false }: { compact?: boolean }) {
  const { link, lastFrameAt, frames } = useRealtime(
    (s) => ({ link: s.link, lastFrameAt: s.lastFrameAt, frames: s.frames }),
    shallowEqual,
  );

  // Ticks locally so "last update" keeps counting up between frames - a frozen
  // age reading is exactly what a stalled feed must not look like.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const p = PRESENTATION[link];
  const ageS = lastFrameAt ? (now - lastFrameAt) / 1000 : null;

  return (
    <div
      className="flex items-center gap-2"
      title={p.help}
      role="status"
      aria-live="polite"
      aria-label={"Controller link " + p.label + (ageS ? ", last update " + ageS.toFixed(1) + " seconds ago" : "")}
    >
      <StatusDot severity={p.severity} pulse={p.pulse} size={7} />
      <div className="leading-none">
        <div
          className={cx(
            "font-mono text-2xs font-semibold uppercase tracking-[0.14em]",
            p.severity === "ok" && "text-ok",
            p.severity === "warn" && "text-warn",
            p.severity === "crit" && "text-crit",
            p.severity === "off" && "text-off",
          )}
        >
          {p.label}
        </div>
        {!compact && (
          <div className="mt-0.5 font-mono text-2xs text-ink-ghost">
            {"WEBSOCKET · "}
            {ageS === null ? "NO FRAMES YET" : "LAST " + ageS.toFixed(1) + "s"}
            {frames > 0 && " · " + frames + " FRAMES"}
          </div>
        )}
      </div>
    </div>
  );
}
