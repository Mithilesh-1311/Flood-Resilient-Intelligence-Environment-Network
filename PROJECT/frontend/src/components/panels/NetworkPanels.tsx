/**
 * Network diagnostics: node health, the directional PDR matrix, and the
 * inspector that backs topology selection.
 *
 * The matrix is the place where the "never fake a zero" rule matters most.
 * nc1 emits `null` for any directed link it did not measure this interval, and
 * a null cell renders as a dash with a "no data" tooltip - never as 0 %. The
 * row/column asymmetry (M1→M4 is not M4→M1) is preserved and called out,
 * because that asymmetry is the physical reality the router acts on.
 */
import { memo, useMemo, useState } from "react";
import { useRealtime } from "@/realtime/RealtimeProvider";
import { EmptyState, KeyValue, NoData, Panel, StatusDot, Tag, Bar } from "@/components/primitives";
import {
  GATEWAY_NODE,
  NODE_ORDER,
  ROLE_LABEL,
  SEVERITY_HEX,
  pdrSeverity,
  routeColor,
} from "@/lib/constants";
import { nodeSummaries, routeSummaries } from "@/lib/derive";
import { isScored, type NodeId } from "@/types/friend";
import { clock, cx, num, pct } from "@/lib/format";

/* ------------------------------------------------------------ health table */

export const NodeHealthTable = memo(function NodeHealthTable({
  selected,
  onSelect,
  className,
}: {
  selected?: NodeId | null;
  onSelect?: (id: NodeId) => void;
  className?: string;
}) {
  const rows = useRealtime((s) => nodeSummaries(s.state), (a, b) =>
    a.length === b.length &&
    a.every(
      (r, i) =>
        r.health === b[i].health &&
        r.participation === b[i].participation &&
        r.pdrIn === b[i].pdrIn &&
        r.pdrOut === b[i].pdrOut &&
        r.routes.join() === b[i].routes.join(),
    ),
  );
  const updated = useRealtime((s) => s.state?.timestamp ?? null);

  return (
    <Panel
      title="Node health"
      subtitle="All 11 nodes in the routing graph · S1–S3 and G are constant by design"
      className={className}
      right={<span className="font-mono text-2xs text-ink-ghost">UPDATED {clock(updated)}</span>}
      bodyClassName="overflow-x-auto"
    >
      <table className="w-full min-w-[720px] border-collapse">
        <thead className="border-b border-line">
          <tr>
            <th className="th w-14">NODE</th>
            <th className="th w-32">ROLE</th>
            <th className="th w-40">HEALTH</th>
            <th className="th w-24 text-right">PDR OUT</th>
            <th className="th w-24 text-right">PDR IN</th>
            <th className="th w-20 text-right">LINKS</th>
            <th className="th w-24">ROUTES</th>
            <th className="th w-24">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSel = selected === r.id;
            const constant = r.role !== "mesh";
            return (
              <tr
                key={r.id}
                onClick={() => onSelect?.(r.id)}
                tabIndex={onSelect ? 0 : undefined}
                onKeyDown={(e) => {
                  if (onSelect && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onSelect(r.id);
                  }
                }}
                className={cx(
                  "border-b border-line-soft last:border-0",
                  onSelect && "cursor-pointer",
                  isSel ? "bg-accent/[0.07]" : "hover:bg-base-700/40",
                )}
              >
                <td className="cell">
                  <span className="flex items-center gap-1.5">
                    {isSel && <span className="inline-block h-3 w-0.5 bg-accent" aria-hidden />}
                    <span className="font-semibold text-ink">{r.id}</span>
                  </span>
                </td>
                <td className="cell text-2xs uppercase tracking-[0.08em] text-ink-faint">
                  {ROLE_LABEL[r.role]}
                </td>
                <td className="cell">
                  {r.health === null ? (
                    <NoData />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="w-10 shrink-0 tabular-nums" style={{ color: SEVERITY_HEX[r.healthSeverity] }}>
                        {r.health}%
                      </span>
                      <Bar value={r.health} severity={r.healthSeverity} className="w-20" />
                    </div>
                  )}
                </td>
                <td className="cell text-right">
                  {r.pdrOut === null ? <NoData reason="No outgoing links measured" /> : pct(r.pdrOut, 1)}
                </td>
                <td className="cell text-right">
                  {r.pdrIn === null ? <NoData reason="No incoming links measured" /> : pct(r.pdrIn, 1)}
                </td>
                <td className="cell text-right text-ink-faint">{r.measuredLinks || <NoData />}</td>
                <td className="cell">
                  {r.routes.length === 0 ? (
                    <span className="text-ink-ghost">—</span>
                  ) : (
                    <span className="flex gap-1">
                      {r.routes.map((rt) => (
                        <span
                          key={rt}
                          className="border px-1 text-2xs"
                          style={{
                            borderColor: routeColor(Number(rt.slice(1)) - 1) + "66",
                            color: routeColor(Number(rt.slice(1)) - 1),
                          }}
                        >
                          {rt}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="cell">
                  <span className="flex items-center gap-1.5">
                    <StatusDot severity={r.healthSeverity} label={r.id + " health"} />
                    <span className="uppercase text-ink-dim">
                      {constant
                        ? "CONSTANT"
                        : r.healthSeverity === "ok"
                          ? "NOMINAL"
                          : r.healthSeverity === "warn"
                            ? "DEGRADED"
                            : "CRITICAL"}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-ink-ghost">
        Mesh relays M1–M7 drain while relaying and recover while resting, so health moves every
        cycle. Sources and the gateway are held constant by the controller. PDR OUT / IN are means
        over <em>measured</em> links only — unmeasured links are excluded, never counted as 0 %.
      </p>
    </Panel>
  );
});

/* ------------------------------------------------------------- PDR matrix */

export const PDRMatrix = memo(function PDRMatrix({ className }: { className?: string }) {
  const matrix = useRealtime((s) => s.state?.pdr_matrix ?? null, (a, b) => a === b);
  const active = useRealtime(
    (s) => {
      const set = new Set<string>();
      for (const r of s.state?.active_routes ?? []) {
        const path = [...r, GATEWAY_NODE];
        for (let i = 0; i < path.length - 1; i += 1) set.add(path[i] + ">" + path[i + 1]);
      }
      return set;
    },
    (a, b) => a.size === b.size && [...a].every((k) => b.has(k)),
  );
  const [hover, setHover] = useState<{ from: NodeId; to: NodeId; v: number | null } | null>(null);

  const stats = useMemo(() => {
    let measured = 0;
    let total = 0;
    for (let a = 0; a < NODE_ORDER.length; a += 1) {
      for (let b = 0; b < NODE_ORDER.length; b += 1) {
        if (a === b) continue;
        total += 1;
        if (typeof matrix?.[a]?.[b] === "number") measured += 1;
      }
    }
    return { measured, total };
  }, [matrix]);

  if (!matrix) {
    return (
      <Panel title="PDR matrix" className={className}>
        <EmptyState title="No matrix" detail="The controller has not published a PDR matrix yet." />
      </Panel>
    );
  }

  return (
    <Panel
      title="Directional PDR matrix"
      subtitle="rows = FROM · columns = TO · 11 × 11"
      className={className}
      right={
        <div className="flex items-center gap-2">
          <Tag tone="neutral">
            {stats.measured} / {stats.total} MEASURED
          </Tag>
        </div>
      }
      bodyClassName="overflow-auto"
    >
      <div className="p-2.5">
        <table className="border-collapse font-mono text-2xs tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-base-800 px-1.5 py-1 text-left text-ink-ghost">
                FROM\TO
              </th>
              {NODE_ORDER.map((n) => (
                <th key={n} className="px-1 py-1 text-center font-medium text-ink-faint">
                  {n}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NODE_ORDER.map((from, a) => (
              <tr key={from}>
                <th className="sticky left-0 z-10 bg-base-800 px-1.5 py-1 text-left font-medium text-ink-faint">
                  {from}
                </th>
                {NODE_ORDER.map((to, b) => {
                  const v = matrix[a]?.[b];
                  const value = typeof v === "number" ? v : null;
                  const self = a === b;
                  const isActive = active.has(from + ">" + to);
                  const sev = pdrSeverity(value);

                  return (
                    <td
                      key={to}
                      onMouseEnter={() => setHover({ from, to, v: value })}
                      onMouseLeave={() => setHover(null)}
                      title={
                        self
                          ? "Self link — not applicable"
                          : value === null
                            ? from + " → " + to + ": NO DATA (never measured this interval)"
                            : from + " → " + to + ": " + pct(value, 1) +
                              (isActive ? " · carrying an active route" : "")
                      }
                      className={cx(
                        "border border-base-900 px-1.5 py-1 text-center",
                        self && "bg-base-900 text-ink-ghost",
                        isActive && "outline outline-1 -outline-offset-1 outline-accent",
                      )}
                      style={
                        !self && value !== null
                          ? {
                              // Opacity carries magnitude; hue carries the band.
                              backgroundColor: SEVERITY_HEX[sev] + "22",
                              color: SEVERITY_HEX[sev],
                            }
                          : undefined
                      }
                    >
                      {self ? "·" : value === null ? <span className="text-ink-ghost">—</span> : value.toFixed(0)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Asymmetry readout for the hovered pair — the point of a directional matrix. */}
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-line pt-2.5">
          {hover && hover.from !== hover.to ? (
            (() => {
              const rev = matrix[NODE_ORDER.indexOf(hover.to)]?.[NODE_ORDER.indexOf(hover.from)];
              const reverse = typeof rev === "number" ? rev : null;
              return (
                <div className="flex flex-wrap items-center gap-4 font-mono text-2xs">
                  <span className="text-ink">
                    {hover.from} → {hover.to}:{" "}
                    <span style={{ color: SEVERITY_HEX[pdrSeverity(hover.v)] }}>
                      {hover.v === null ? "NO DATA" : pct(hover.v, 1)}
                    </span>
                  </span>
                  <span className="text-ink">
                    {hover.to} → {hover.from}:{" "}
                    <span style={{ color: SEVERITY_HEX[pdrSeverity(reverse)] }}>
                      {reverse === null ? "NO DATA" : pct(reverse, 1)}
                    </span>
                  </span>
                  {hover.v !== null && reverse !== null && (
                    <span className="text-ink-faint">
                      ASYMMETRY {num(Math.abs(hover.v - reverse), 1)} pp
                    </span>
                  )}
                </div>
              );
            })()
          ) : (
            <span className="font-mono text-2xs text-ink-ghost">
              Hover a cell to compare both directions.
            </span>
          )}
        </div>

        <p className="mt-2 text-2xs leading-relaxed text-ink-ghost">
          PDR is directional: <span className="font-mono text-ink-faint">M1→M4</span> is a different
          measurement from <span className="font-mono text-ink-faint">M4→M1</span>, and the router
          weights each hop in the direction it will actually use. A dash means the controller
          measured nothing on that link this interval — it is not 0 %. The gateway row and column
          stay empty because no firmware probes a node↔G link; the router substitutes a fallback
          weight internally without ever writing it into this matrix.
        </p>
      </div>
    </Panel>
  );
});

/* ---------------------------------------------------------- node inspector */

export const NodeInspector = memo(function NodeInspector({
  node,
  className,
}: {
  node: NodeId | null;
  className?: string;
}) {
  const data = useRealtime((s) => {
    if (!node) return null;
    const st = s.state;
    const summary = nodeSummaries(st).find((n) => n.id === node) ?? null;
    const routes = routeSummaries(st).filter((r) => r.path.includes(node));
    const ai = st?.flood_ai?.nodes?.[node];
    return {
      summary,
      routes: routes.map((r) => ({ id: r.id, index: r.index, path: r.path.join(" → ") })),
      ai: isScored(ai) ? ai : null,
      timestamp: st?.timestamp ?? null,
    };
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (!node || !data?.summary) {
    return (
      <Panel title="Node inspector" className={className}>
        <EmptyState
          title="No node selected"
          detail="Select a node in the topology or a row in the health table to inspect it."
        />
      </Panel>
    );
  }

  const s = data.summary;

  return (
    <Panel
      title={"Node " + node}
      subtitle={ROLE_LABEL[s.role]}
      className={className}
      right={
        <div className="flex items-center gap-1.5">
          <StatusDot severity={s.healthSeverity} label={node + " health"} />
          <Tag tone={s.healthSeverity}>
            {s.role === "mesh"
              ? s.healthSeverity === "ok"
                ? "NOMINAL"
                : s.healthSeverity === "warn"
                  ? "DEGRADED"
                  : "CRITICAL"
              : "CONSTANT"}
          </Tag>
        </div>
      }
    >
      <div className="p-2.5">
        <dl>
          <KeyValue k="Health">
            {s.health === null ? <NoData /> : <span style={{ color: SEVERITY_HEX[s.healthSeverity] }}>{s.health}%</span>}
          </KeyValue>
          <KeyValue k="Matrix index">{s.index}</KeyValue>
          <KeyValue k="Mean PDR out">{s.pdrOut === null ? <NoData /> : pct(s.pdrOut, 1)}</KeyValue>
          <KeyValue k="Mean PDR in">{s.pdrIn === null ? <NoData /> : pct(s.pdrIn, 1)}</KeyValue>
          <KeyValue k="Measured links">{s.measuredLinks || <NoData />}</KeyValue>
          {s.role === "mesh" && <KeyValue k="Route slots used">{s.participation} / 2</KeyValue>}
          <KeyValue k="Last frame">{clock(data.timestamp)}</KeyValue>
        </dl>

        {/* Recent telemetry, only for source nodes that actually report it. */}
        {s.role === "source" && (
          <div className="mt-3 border-t border-line-soft pt-2">
            <p className="eyebrow mb-1.5">Telemetry</p>
            <dl>
              <KeyValue k="Water (raw)">
                {typeof s.sensor?.water_level === "number" ? num(s.sensor.water_level, 1) + " %" : <NoData />}
              </KeyValue>
              <KeyValue k="Rain">
                {typeof s.sensor?.rain === "boolean" ? (s.sensor.rain ? "WET" : "DRY") : <NoData />}
              </KeyValue>
              <KeyValue k="Temperature">
                {typeof s.sensor?.temperature === "number" ? num(s.sensor.temperature, 1) + " °C" : <NoData />}
              </KeyValue>
              <KeyValue k="Humidity">
                {typeof s.sensor?.humidity === "number" ? num(s.sensor.humidity, 1) + " %" : <NoData />}
              </KeyValue>
              {data.ai && (
                <>
                  <KeyValue k="Level (calibrated)">{num(data.ai.level_m, 3)} m</KeyValue>
                  <KeyValue k="P(flood)">
                    <span className={cx(data.ai.alarm && "text-crit")}>
                      {num(data.ai.flood_probability * 100, 1)}%
                    </span>
                  </KeyValue>
                </>
              )}
            </dl>
          </div>
        )}

        <div className="mt-3 border-t border-line-soft pt-2">
          <p className="eyebrow mb-1.5">Route participation</p>
          {data.routes.length === 0 ? (
            <p className="font-mono text-2xs text-ink-ghost">
              {s.role === "mesh"
                ? "Resting — not carrying an alert path this cycle."
                : "Not on an active path."}
            </p>
          ) : (
            <ul className="space-y-1">
              {data.routes.map((r) => (
                <li key={r.id} className="flex items-baseline gap-2">
                  <span
                    className="inline-block h-2 w-2 shrink-0"
                    style={{ backgroundColor: routeColor(r.index) }}
                    aria-hidden
                  />
                  <span className="font-mono text-2xs text-ink-dim">{r.id}</span>
                  <span className="font-mono text-2xs text-ink-faint">{r.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Per-link detail: only links this node actually measured. */}
        <NodeLinkList node={node} />
      </div>
    </Panel>
  );
});

const NodeLinkList = memo(function NodeLinkList({ node }: { node: NodeId }) {
  const links = useRealtime((s) => {
    const idx = NODE_ORDER.indexOf(node);
    const matrix = s.state?.pdr_matrix ?? [];
    const out: Array<{ to: NodeId; out: number | null; back: number | null }> = [];
    for (let b = 0; b < NODE_ORDER.length; b += 1) {
      if (b === idx) continue;
      const o = matrix[idx]?.[b];
      const r = matrix[b]?.[idx];
      const outV = typeof o === "number" ? o : null;
      const backV = typeof r === "number" ? r : null;
      if (outV === null && backV === null) continue;
      out.push({ to: NODE_ORDER[b], out: outV, back: backV });
    }
    return out;
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (links.length === 0) return null;

  return (
    <div className="mt-3 border-t border-line-soft pt-2">
      <p className="eyebrow mb-1.5">Measured links</p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="th px-0 py-0.5">PEER</th>
            <th className="th px-0 py-0.5 text-right">OUT →</th>
            <th className="th px-0 py-0.5 text-right">← IN</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.to}>
              <td className="py-0.5 font-mono text-2xs text-ink-dim">{l.to}</td>
              <td
                className="py-0.5 text-right font-mono text-2xs tabular-nums"
                style={{ color: SEVERITY_HEX[pdrSeverity(l.out)] }}
              >
                {l.out === null ? "—" : pct(l.out, 0)}
              </td>
              <td
                className="py-0.5 text-right font-mono text-2xs tabular-nums"
                style={{ color: SEVERITY_HEX[pdrSeverity(l.back)] }}
              >
                {l.back === null ? "—" : pct(l.back, 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

/** Role legend for the topology. */
export function TopologyLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-3 py-2">
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="#11161C" stroke="#3FA7D6" />
        </svg>
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">Source</span>
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="#11161C" stroke="#2A333D" />
        </svg>
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">Relay</span>
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden>
          <rect x="1.5" y="1.5" width="11" height="11" fill="#11161C" stroke="#2A333D" />
        </svg>
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">Gateway</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0 w-4 border-t-2 border-dashed border-ink-ghost" aria-hidden />
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">
          Unmeasured hop (node→G)
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_HEX.ok }} aria-hidden />
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_HEX.warn }} aria-hidden />
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: SEVERITY_HEX.crit }} aria-hidden />
        <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">
          Ring = health (≥70 / ≥40 / &lt;40)
        </span>
      </span>
    </div>
  );
}
