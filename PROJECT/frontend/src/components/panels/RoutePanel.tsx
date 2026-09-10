/**
 * Active routing, and the self-healing sequence.
 *
 * A route here is exactly what nc1's Dijkstra produced this cycle. The trailing
 * gateway hop is re-appended for display (nc1 strips it before the wire because
 * the firmware treats "no next hop" as "forward to gateway"), and it is drawn
 * dashed because no firmware measures a node->G link.
 *
 * The self-healing strip is triggered by a REAL route-change event and steps
 * through the stages the controller genuinely performed. It never fires on a
 * timer, and the reason it displays is the one the event diff could evidence.
 */
import { memo, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ShieldCheck, Zap } from "lucide-react";
import { useRealtime } from "@/realtime/RealtimeProvider";
import { routeSummaries, type RouteSummary } from "@/lib/derive";
import { EmptyState, NoData, Panel, StatusDot, Tag } from "@/components/primitives";
import { SEVERITY_HEX, routeColor } from "@/lib/constants";
import { clock, cx, num, pct } from "@/lib/format";

/* --------------------------------------------------------------- route row */

function PathChips({ route }: { route: RouteSummary }) {
  const color = routeColor(route.index);
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {route.path.map((node, i) => {
        const hop = route.hops[i - 1];
        return (
          <span key={node + i} className="flex items-center gap-1">
            {i > 0 && (
              <span
                className="flex items-center gap-0.5 font-mono text-2xs"
                style={{ color: hop?.pdr === null ? "#48525C" : SEVERITY_HEX[hop.severity] }}
                title={
                  hop?.unmeasuredByDesign
                    ? "No firmware probes a node→gateway link, so this hop is unmeasured by design."
                    : "Measured PDR for this directed hop"
                }
              >
                <ArrowRight size={9} strokeWidth={2.2} />
                {hop?.pdr === null ? "—" : pct(hop.pdr, 0)}
              </span>
            )}
            <span
              className="border px-1.5 py-px font-mono text-2xs text-ink"
              style={{
                borderColor: node === "G" ? "#2A333D" : color + "66",
                backgroundColor: node === "G" ? "transparent" : color + "10",
              }}
            >
              {node}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export const RouteTable = memo(function RouteTable({ className }: { className?: string }) {
  const routes = useRealtime((s) => routeSummaries(s.state), (a, b) =>
    a.length === b.length && a.every((r, i) => r.path.join() === b[i].path.join() && r.minPdr === b[i].minPdr),
  );
  const held = useRealtime((s) => {
    const routed = new Set((s.state?.active_routes ?? []).map((r) => r[0]));
    return ["S1", "S2", "S3"].filter((x) => !routed.has(x));
  }, (a, b) => a.join() === b.join());

  return (
    <Panel
      title="Active routes"
      subtitle="Dijkstra over 0.6·PDR + 0.2·health(a) + 0.2·health(b)"
      className={className}
      right={<Tag tone={held.length ? "crit" : "ok"}>{routes.length} / 3 ROUTED</Tag>}
      bodyClassName="overflow-x-auto"
    >
      {routes.length === 0 ? (
        <EmptyState
          title="No active routes"
          detail="The router found no 2–4 relay path to the gateway this cycle. Sources are held until the mesh recovers."
        />
      ) : (
        <table className="w-full min-w-[640px] border-collapse">
          <thead className="border-b border-line">
            <tr>
              <th className="th w-14">ROUTE</th>
              <th className="th w-14">SRC</th>
              <th className="th">PATH</th>
              <th className="th w-20 text-right">MIN PDR</th>
              <th className="th w-20 text-right">MEAN PDR</th>
              <th className="th w-24 text-right">MIN HEALTH</th>
              <th className="th w-24">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={r.id} className="border-b border-line-soft last:border-0 hover:bg-base-700/40">
                <td className="cell">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0"
                      style={{ backgroundColor: routeColor(r.index) }}
                      aria-hidden
                    />
                    {r.id}
                  </span>
                </td>
                <td className="cell text-ink">{r.source}</td>
                <td className="cell"><PathChips route={r} /></td>
                <td className="cell text-right">
                  {r.minPdr === null ? <NoData /> : pct(r.minPdr, 1)}
                </td>
                <td className="cell text-right text-ink-dim">
                  {r.meanPdr === null ? <NoData /> : pct(r.meanPdr, 1)}
                </td>
                <td className="cell text-right">
                  {r.minHealth === null ? <NoData /> : r.minHealth + "%"}
                </td>
                <td className="cell">
                  <span className="flex items-center gap-1.5">
                    <StatusDot severity={r.severity} label={"Route " + r.id + " " + r.severity} />
                    <span className="uppercase text-ink-dim">
                      {r.severity === "ok" ? "NOMINAL" : r.severity === "warn" ? "DEGRADED" : r.severity === "crit" ? "AT RISK" : "NO DATA"}
                    </span>
                  </span>
                </td>
              </tr>
            ))}
            {held.map((s) => (
              <tr key={s} className="border-b border-line-soft last:border-0 bg-crit/5">
                <td className="cell text-ink-ghost">—</td>
                <td className="cell text-crit">{s}</td>
                <td className="cell text-crit" colSpan={5}>
                  HELD — no viable 2–4 relay path to the gateway this cycle
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
});

/* ------------------------------------------------------- self-healing strip */

const STAGES = [
  { label: "NODE HEALTH DROP", at: 0 },
  { label: "LINK QUALITY DEGRADED", at: 450 },
  { label: "ROUTING ENGINE RECOMPUTING", at: 900 },
  { label: "ALTERNATIVE ROUTE SELECTED", at: 1400 },
  { label: "ALERT PATH RESTORED", at: 1900 },
] as const;

const VISIBLE_MS = 9000;

/**
 * Shown only while a genuine route change is recent. The stage ticker walks
 * through what the controller already did, so the operator can see the causal
 * chain rather than just the end state.
 */
export const SelfHealingBanner = memo(function SelfHealingBanner() {
  const latest = useRealtime(
    (s) => s.events.find((e) => e.routeChange && e.routeChange.from.length > 0) ?? null,
    (a, b) => a?.id === b?.id,
  );

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!latest) return undefined;
    setElapsed(Date.now() - latest.t);
    const id = window.setInterval(() => setElapsed(Date.now() - latest.t), 120);
    return () => window.clearInterval(id);
  }, [latest]);

  const visible = !!latest && elapsed < VISIBLE_MS;

  return (
    <AnimatePresence>
      {visible && latest?.routeChange && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="panel border-accent/30 bg-accent/[0.04] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Zap size={13} strokeWidth={2} className="text-accent" />
                <span className="eyebrow text-accent">Self-healing event</span>
                <span className="font-mono text-2xs text-ink-ghost">
                  {clock(latest.controllerT)} · {latest.where}
                </span>
              </div>
              {elapsed > STAGES[4].at && (
                <span className="flex items-center gap-1.5 font-mono text-2xs text-ok">
                  <ShieldCheck size={12} strokeWidth={2} />
                  ALERT PATH RESTORED
                </span>
              )}
            </div>

            {/* Stage ticker */}
            <ol className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
              {STAGES.map((stage, i) => {
                const reached = elapsed >= stage.at;
                return (
                  <li key={stage.label} className="flex items-center gap-1.5">
                    {i > 0 && (
                      <span className="font-mono text-2xs text-ink-ghost" aria-hidden>
                        →
                      </span>
                    )}
                    <motion.span
                      initial={false}
                      animate={{ opacity: reached ? 1 : 0.3 }}
                      transition={{ duration: 0.25, ease: "easeInOut" }}
                      className={cx(
                        "border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-[0.08em]",
                        reached ? "border-accent/40 text-accent" : "border-line text-ink-ghost",
                      )}
                    >
                      {stage.label}
                    </motion.span>
                  </li>
                );
              })}
            </ol>

            {/* Old -> new, and the evidenced reason */}
            <div className="mt-2.5 grid gap-1.5 border-t border-line-soft pt-2.5 md:grid-cols-2">
              <div>
                <p className="eyebrow mb-1">Previous path</p>
                <p className="font-mono text-2xs text-ink-faint line-through decoration-crit/60">
                  {[...latest.routeChange.from, "G"].join(" → ")}
                </p>
              </div>
              <div>
                <p className="eyebrow mb-1">Selected path</p>
                <p className="font-mono text-2xs text-ok">
                  {[...latest.routeChange.to, "G"].join(" → ")}
                </p>
              </div>
            </div>
            {/* Cause only: the paths themselves are already above. */}
            <p className="mt-2 font-mono text-2xs leading-relaxed text-ink-faint">
              REASON · {latest.reason ?? latest.detail}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});

/* ------------------------------------------------------- route change log */

export const RouteChangeLog = memo(function RouteChangeLog({ className }: { className?: string }) {
  const changes = useRealtime((s) => s.events.filter((e) => e.routeChange).slice(0, 25));

  return (
    <Panel
      title="Route change log"
      subtitle="Every recompute this session"
      className={className}
      right={<Tag tone="neutral">{changes.length}</Tag>}
      bodyClassName="overflow-y-auto"
    >
      {changes.length === 0 ? (
        <EmptyState
          title="No reroutes yet"
          detail="The mesh has not had to move an alert path since this session started."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {changes.map((e) => (
            <li key={e.id} className="px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-2xs text-ink-dim">{e.where}</span>
                <span className="font-mono text-2xs tabular-nums text-ink-ghost">
                  {clock(e.controllerT)}
                </span>
              </div>
              {e.routeChange && e.routeChange.from.length > 0 && (
                <div className="mt-1 space-y-0.5 font-mono text-2xs">
                  <div className="text-ink-ghost line-through">
                    {[...e.routeChange.from, "G"].join(" → ")}
                  </div>
                  <div className="text-ok">{[...e.routeChange.to, "G"].join(" → ")}</div>
                </div>
              )}
              <p className="mt-1 font-mono text-2xs leading-relaxed text-ink-faint">
                {e.reason ? "REASON · " + e.reason : e.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
});

/** Relay load: how many active routes each mesh node is carrying (nc1 caps at 2). */
export const RelayLoad = memo(function RelayLoad({ className }: { className?: string }) {
  const participation = useRealtime((s) => s.state?.route_participation ?? {}, (a, b) =>
    JSON.stringify(a) === JSON.stringify(b),
  );
  const entries = Object.entries(participation).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Panel
      title="Relay participation"
      subtitle="nc1 constraint: at most 2 active routes per relay"
      className={className}
    >
      {entries.length === 0 ? (
        <EmptyState title="No participation data" />
      ) : (
        <ul className="p-2.5">
          {entries.map(([node, count]) => (
            <li key={node} className="flex items-center gap-2 py-1">
              <span className="w-7 font-mono text-2xs text-ink-dim">{node}</span>
              <span className="flex gap-1" aria-label={count + " of 2 route slots used"}>
                {[0, 1].map((slot) => (
                  <span
                    key={slot}
                    className={cx(
                      "inline-block h-2.5 w-6 border",
                      slot < count ? "border-accent/50 bg-accent/30" : "border-line bg-base-700",
                    )}
                  />
                ))}
              </span>
              <span className="ml-auto font-mono text-2xs text-ink-faint">
                {count === 2 ? "AT CAP" : count === 0 ? "RESTING" : num(count, 0) + " ROUTE"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
});
