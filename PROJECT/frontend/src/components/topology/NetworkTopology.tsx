/**
 * Live mesh topology.
 *
 * Node positions are fixed constants (NODE_POS): the field does not move, so
 * the only thing that ever changes on this diagram is the state of the links
 * and the paths the alerts are taking. That is what makes a reroute readable.
 *
 * Three layers, back to front:
 *   1. every directed link the controller has actually MEASURED, drawn faintly,
 *      with opacity and colour carrying its PDR
 *   2. the active route paths, drawn solid in their route colour with a slow
 *      dash flow in the direction alerts travel
 *   3. the nodes, with a health arc and role-specific shape
 *
 * An unmeasured link is simply absent. Nothing is drawn at 0 % that was never
 * measured, and the final hop into the gateway is dashed because no firmware
 * probes it (see nc1's GATEWAY_LINK_PDR_FALLBACK note).
 */
import { memo, useMemo } from "react";
import { motion } from "framer-motion";
import { useRealtime } from "@/realtime/RealtimeProvider";
import {
  GATEWAY_NODE,
  NODE_ORDER,
  NODE_POS,
  SEVERITY_HEX,
  TOPOLOGY_VIEWBOX,
  healthSeverity,
  pdrSeverity,
  roleOf,
  routeColor,
} from "@/lib/constants";
import { activeLinkSet, routeSummaries, type RouteSummary } from "@/lib/derive";
import type { ControllerState, NodeId } from "@/types/friend";
import { cx } from "@/lib/format";

interface EdgeSpec {
  from: NodeId;
  to: NodeId;
  pdr: number | null;
}

/** Slightly shortened at both ends so lines meet the node ring, not its centre. */
function endpoints(from: NodeId, to: NodeId, inset = 20) {
  const a = NODE_POS[from];
  const b = NODE_POS[to];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: a.x + ux * inset,
    y1: a.y + uy * inset,
    x2: b.x - ux * inset,
    y2: b.y - uy * inset,
  };
}

const NODE_R = 17;

function BackgroundEdges({
  edges,
  active,
  focus,
}: {
  edges: EdgeSpec[];
  active: Set<string>;
  focus: NodeId | null;
}) {
  return (
    <g>
      {edges.map(({ from, to, pdr }) => {
        const key = from + ">" + to;
        if (active.has(key)) return null; // drawn by the route layer instead
        const { x1, y1, x2, y2 } = endpoints(from, to);
        const touchesFocus = focus === from || focus === to;
        // PDR drives visibility: a reliable link is a firmer line.
        const base = pdr === null ? 0 : Math.max(0.05, Math.min(0.26, pdr / 380));
        return (
          <line
            key={key}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={focus && touchesFocus ? SEVERITY_HEX[pdrSeverity(pdr)] : "#8FA3B5"}
            strokeWidth={focus && touchesFocus ? 1.2 : 0.8}
            opacity={focus ? (touchesFocus ? 0.75 : 0.05) : base}
          />
        );
      })}
    </g>
  );
}

function RouteEdges({ routes, focus }: { routes: RouteSummary[]; focus: NodeId | null }) {
  return (
    <g>
      {routes.map((route) =>
        route.hops.map((hop, i) => {
          const { x1, y1, x2, y2 } = endpoints(hop.from, hop.to);
          const color = routeColor(route.index);
          const dim = focus ? !route.path.includes(focus) : false;
          return (
            <g key={route.id + "-" + i} opacity={dim ? 0.18 : 1}>
              {/* A soft underlay so route lines stay legible over the mesh. */}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#080A0D" strokeWidth={4.5} />
              <motion.line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={color}
                strokeWidth={hop.severity === "crit" ? 1.2 : 1.9}
                // The gateway hop is dashed because it is unmeasured by design.
                strokeDasharray={hop.unmeasuredByDesign ? "3 3" : undefined}
                initial={{ opacity: 0 }}
                animate={{ opacity: hop.severity === "crit" ? 0.55 : 1 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              />
              {!hop.unmeasuredByDesign && (
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={color}
                  strokeWidth={2.4}
                  strokeDasharray="2 22"
                  strokeLinecap="round"
                  className="animate-flow"
                  opacity={0.9}
                />
              )}
            </g>
          );
        }),
      )}
    </g>
  );
}

function TopologyNode({
  id,
  health,
  routes,
  selected,
  onSelect,
}: {
  id: NodeId;
  health: number | null;
  routes: string[];
  selected: boolean;
  onSelect: (id: NodeId) => void;
}) {
  const pos = NODE_POS[id];
  const role = roleOf(id);
  const sev = healthSeverity(health);
  const color = SEVERITY_HEX[sev];

  // Health arc: circumference fraction, so the ring itself reads as a gauge.
  const circumference = 2 * Math.PI * (NODE_R + 4);
  const filled = health === null ? 0 : (health / 100) * circumference;

  return (
    <g
      transform={"translate(" + pos.x + "," + pos.y + ")"}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(id);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={
        id + ", " + role + ", health " + (health === null ? "unknown" : health + " percent") +
        (routes.length ? ", on routes " + routes.join(" and ") : ", not routing")
      }
      className="cursor-pointer outline-none focus-visible:opacity-80"
    >
      {selected && (
        <circle r={NODE_R + 11} fill="none" stroke="#3FA7D6" strokeWidth={1} opacity={0.7} />
      )}

      {/* Health ring */}
      <circle r={NODE_R + 4} fill="none" stroke="#1F262E" strokeWidth={2.5} />
      <circle
        r={NODE_R + 4}
        fill="none"
        stroke={color}
        strokeWidth={2.5}
        strokeDasharray={filled + " " + circumference}
        strokeLinecap="butt"
        transform="rotate(-90)"
        style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.22,1,0.36,1)" }}
      />

      {/* Body: gateway is a square, sources are rounded, relays are circles —
          role is legible without relying on colour. */}
      {role === "gateway" ? (
        <rect
          x={-NODE_R}
          y={-NODE_R}
          width={NODE_R * 2}
          height={NODE_R * 2}
          fill="#11161C"
          stroke="#2A333D"
          strokeWidth={1}
        />
      ) : (
        <circle
          r={NODE_R}
          fill="#11161C"
          stroke={role === "source" ? "#3FA7D6" : "#2A333D"}
          strokeWidth={1}
        />
      )}

      <text
        textAnchor="middle"
        dy={4}
        fill="#E6EDF3"
        fontSize={11}
        fontWeight={600}
        fontFamily="JetBrains Mono, monospace"
        pointerEvents="none"
      >
        {id}
      </text>

      {/* Route participation pips: one dot per route this relay carries. */}
      {routes.length > 0 && (
        <g transform={"translate(0," + (NODE_R + 15) + ")"} pointerEvents="none">
          {routes.map((r, i) => (
            <circle
              key={r}
              cx={(i - (routes.length - 1) / 2) * 7}
              cy={0}
              r={2.4}
              fill={routeColor(Number(r.slice(1)) - 1)}
            />
          ))}
        </g>
      )}

      <text
        textAnchor="middle"
        dy={-NODE_R - 12}
        fill="#6B7784"
        fontSize={8.5}
        fontFamily="JetBrains Mono, monospace"
        pointerEvents="none"
      >
        {health === null ? "—" : health + "%"}
      </text>
    </g>
  );
}

export const NetworkTopology = memo(function NetworkTopology({
  selected,
  onSelect,
  className,
}: {
  selected: NodeId | null;
  onSelect: (id: NodeId) => void;
  className?: string;
}) {
  const state = useRealtime((s) => s.state);

  const { edges, routes, active, healthById, routesById } = useMemo(() => {
    const st: ControllerState | null = state;
    const edgeList: EdgeSpec[] = [];
    const matrix = st?.pdr_matrix ?? [];

    for (let a = 0; a < NODE_ORDER.length; a += 1) {
      for (let b = 0; b < NODE_ORDER.length; b += 1) {
        if (a === b) continue;
        const v = matrix[a]?.[b];
        // Only MEASURED links exist on this diagram.
        if (typeof v !== "number") continue;
        edgeList.push({ from: NODE_ORDER[a], to: NODE_ORDER[b], pdr: v });
      }
    }

    const summaries = routeSummaries(st);
    const health: Record<NodeId, number | null> = {};
    const rby: Record<NodeId, string[]> = {};
    NODE_ORDER.forEach((id, i) => {
      const h = st?.node_health?.[i];
      health[id] = typeof h === "number" ? h : null;
      rby[id] = [];
    });
    summaries.forEach((r) => {
      for (const n of r.path) if (!rby[n].includes(r.id)) rby[n].push(r.id);
    });

    return {
      edges: edgeList,
      routes: summaries,
      active: activeLinkSet(st),
      healthById: health,
      routesById: rby,
    };
  }, [state]);

  return (
    <div className={cx("relative", className)}>
      <svg
        viewBox={"0 0 " + TOPOLOGY_VIEWBOX.w + " " + TOPOLOGY_VIEWBOX.h}
        className="h-full w-full"
        role="img"
        aria-label="Mesh network topology: three source nodes, seven relays and the gateway, showing measured links and active alert routes."
      >
        {/* Column captions - the direction alerts flow is left to right. */}
        <g fontFamily="JetBrains Mono, monospace" fontSize={9} fill="#48525C">
          <text x={78} y={26} textAnchor="middle">SOURCE</text>
          <text x={465} y={26} textAnchor="middle">MESH RELAYS</text>
          <text x={862} y={26} textAnchor="middle">GATEWAY</text>
        </g>

        <BackgroundEdges edges={edges} active={active} focus={selected} />
        <RouteEdges routes={routes} focus={selected} />

        {NODE_ORDER.map((id) => (
          <TopologyNode
            key={id}
            id={id}
            health={id === GATEWAY_NODE ? healthById[id] : healthById[id]}
            routes={routesById[id] ?? []}
            selected={selected === id}
            onSelect={onSelect}
          />
        ))}
      </svg>
    </div>
  );
});
