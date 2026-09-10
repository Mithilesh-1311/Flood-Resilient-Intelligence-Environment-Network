/**
 * The command-centre frame: a fixed status bar, a compact nav rail, and one
 * scrolling module region. Chrome stays identical across modules so the only
 * thing that changes when an operator navigates is the data.
 */
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  BrainCircuit,
  GitBranch,
  Share2,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  Waves,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { OperatorActions } from "./OperatorActions";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { StatusDot, Tag } from "@/components/primitives";
import { clock, cx, duration } from "@/lib/format";
import { networkSummary } from "@/lib/derive";
import { healthSeverity } from "@/lib/constants";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  hint: string;
}

const NAV: NavItem[] = [
  { to: "/", label: "OVERVIEW", icon: LayoutDashboard, hint: "Command centre" },
  { to: "/network", label: "NETWORK", icon: Share2, hint: "Mesh topology" },
  { to: "/flood-ai", label: "FLOOD AI", icon: BrainCircuit, hint: "GRU flood intelligence" },
  { to: "/sensors", label: "SENSORS", icon: Waves, hint: "Source node telemetry" },
  { to: "/routing", label: "ROUTING", icon: GitBranch, hint: "Active paths and reroutes" },
  { to: "/health", label: "NODE HEALTH", icon: HeartPulse, hint: "Per-node health and PDR" },
  { to: "/analytics", label: "ANALYTICS", icon: Gauge, hint: "PDR matrix and diagnostics" },
];

function Wordmark() {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-sm font-bold tracking-[0.18em] text-ink">FRiEND</span>
      <span className="hidden text-2xs uppercase tracking-[0.14em] text-ink-ghost lg:inline">
        Environmental Intelligence Control
      </span>
    </div>
  );
}

/** Wall clock, ticking locally - distinct from controller frame timestamps. */
function LocalClock() {
  const [t, setT] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setT(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="font-mono text-xs tabular-nums text-ink-dim">{clock(t)}</span>;
}

function TopStatusBar() {
  const { system, routes, health, aiAvailable } = useRealtime((s) => {
    const st = s.state;
    return {
      system: st?.system ?? null,
      routes: st?.active_routes?.length ?? 0,
      health: networkSummary(st).meanMeshHealth,
      aiAvailable: !!st?.flood_ai?.available,
    };
  }, shallowEqual);

  const source = system?.data_source;

  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-line bg-base-800 px-3">
      <div className="flex min-w-0 items-center gap-4">
        <Wordmark />
        <div className="hidden h-4 w-px bg-line md:block" />
        <ConnectionIndicator />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/* Simulation vs real hardware is stated, never implied. */}
        {source && (
          <Tag tone={source === "SIMULATION" ? "warn" : "accent"}>
            {source === "SIMULATION" ? "SIMULATION" : "LIVE HARDWARE"}
          </Tag>
        )}
        <div className="hidden items-center gap-1.5 xl:flex" title="Gateway TCP bridge">
          <StatusDot
            severity={system?.gateway_connected ? "ok" : "crit"}
            label={system?.gateway_connected ? "Gateway connected" : "Gateway disconnected"}
          />
          <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-faint">
            GATEWAY {system?.gateway_connected ? "ONLINE" : "DOWN"}
          </span>
        </div>
        <div className="hidden items-center gap-1.5 xl:flex" title="Mean mesh relay health">
          <StatusDot severity={healthSeverity(health)} label="Mesh health" />
          <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-faint">
            MESH {health === null ? "—" : health.toFixed(0) + "%"}
          </span>
        </div>
        <div className="hidden items-center gap-1.5 lg:flex" title="Active alert routes">
          <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-faint">
            ROUTES <span className="text-ink">{routes}/3</span>
          </span>
        </div>
        <div className="hidden items-center gap-1.5 lg:flex" title="Flood-Risk AI">
          <StatusDot severity={aiAvailable ? "ok" : "off"} label="Flood AI" />
          <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-faint">
            AI {aiAvailable ? "READY" : "OFFLINE"}
          </span>
        </div>
        <div className="h-4 w-px bg-line" />
        <LocalClock />
      </div>
    </header>
  );
}

function Sidebar() {
  const uptime = useRealtime((s) => s.state?.system?.uptime_seconds ?? null);
  const cycle = useRealtime((s) => s.state?.system?.cycle ?? null);

  return (
    <nav
      aria-label="Modules"
      className="flex w-[168px] shrink-0 flex-col justify-between border-r border-line bg-base-800"
    >
      <ul className="py-1">
        {NAV.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === "/"}
              title={item.hint}
              className={({ isActive }) =>
                cx(
                  "group relative flex items-center gap-2.5 px-3 py-2 text-2xs font-medium uppercase tracking-[0.12em] transition-colors duration-150",
                  isActive
                    ? "bg-base-700 text-ink"
                    : "text-ink-faint hover:bg-base-700/60 hover:text-ink-dim",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* The active marker is a shape, not just a colour. */}
                  <span
                    className={cx(
                      "absolute inset-y-0 left-0 w-0.5 transition-colors duration-150",
                      isActive ? "bg-accent" : "bg-transparent",
                    )}
                    aria-hidden
                  />
                  <item.icon size={13} strokeWidth={1.75} className="shrink-0" />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="border-t border-line p-3">
        <p className="eyebrow mb-2">System</p>
        <dl className="space-y-1">
          <div className="flex justify-between gap-2">
            <dt className="text-2xs text-ink-ghost">UPTIME</dt>
            <dd className="font-mono text-2xs tabular-nums text-ink-dim">{duration(uptime)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-2xs text-ink-ghost">CYCLE</dt>
            <dd className="font-mono text-2xs tabular-nums text-ink-dim">{cycle ?? "—"}</dd>
          </div>
        </dl>
        <div className="mt-3 border-t border-line-soft pt-3">
          <p className="eyebrow mb-2">Connection</p>
          <ConnectionIndicator />
        </div>
        <div className="mt-3 border-t border-line-soft pt-3">
          <OperatorActions />
        </div>
      </div>
    </nav>
  );
}

export function AppShell() {
  const location = useLocation();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopStatusBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {/* Module swap is a short cross-fade: it marks the transition without
              making the operator wait for it. */}
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeInOut" }}
              className="p-3"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

export { NAV };
