/**
 * Pure derivations over a controller frame.
 *
 * Kept out of components so the same numbers back every view: the route health
 * on the Overview strip, in the topology tooltip and in Routing Analytics are
 * literally the same function. Nothing here invents data - a link the
 * controller never measured stays `null` all the way to the pixel.
 */
import type { ControllerState, NodeId, NodeRole, SensorReading } from "@/types/friend";
import {
  GATEWAY_NODE,
  MESH_NODES,
  NODE_ORDER,
  healthSeverity,
  pdrSeverity,
  roleOf,
  type Severity,
} from "./constants";

export interface NodeSummary {
  id: NodeId;
  index: number;
  role: NodeRole;
  health: number | null;
  healthSeverity: Severity;
  /** How many active routes this relay participates in (0-2, per nc1 constraint). */
  participation: number;
  /** Route ids (R1/R2/...) this node appears in, including as a source. */
  routes: string[];
  /** Mean of measured outgoing PDR; null when this node measured nothing. */
  pdrOut: number | null;
  /** Mean of measured incoming PDR. */
  pdrIn: number | null;
  measuredLinks: number;
  sensor: SensorReading | null;
}

export interface RouteHop {
  from: NodeId;
  to: NodeId;
  pdr: number | null;
  severity: Severity;
  /** True for the final hop into G, which no firmware measures. */
  unmeasuredByDesign: boolean;
}

export interface RouteSummary {
  index: number;
  /** R1/R2/R3 - matches nc1's route naming and the physical LED slots. */
  id: string;
  source: NodeId;
  relays: NodeId[];
  /** Full path including the implicit gateway hop. */
  path: NodeId[];
  hops: RouteHop[];
  /** Worst measured hop PDR on the path; null if no hop was measured. */
  minPdr: number | null;
  meanPdr: number | null;
  /** Lowest relay health on the path - the path is only as good as this. */
  minHealth: number | null;
  severity: Severity;
}

const val = (v: unknown): number | null =>
  typeof v === "number" && !Number.isNaN(v) ? v : null;

export function nodeSummaries(state: ControllerState | null): NodeSummary[] {
  const routes = state?.active_routes ?? [];

  return NODE_ORDER.map((id, index) => {
    const role = roleOf(id);
    const health = val(state?.node_health?.[index]);

    const routeIds: string[] = [];
    routes.forEach((r, i) => {
      if (r.includes(id)) routeIds.push("R" + (i + 1));
    });
    // Every active route terminates at the gateway, even though nc1 strips the
    // trailing "G" before putting the route on the wire.
    if (id === GATEWAY_NODE) routes.forEach((_, i) => routeIds.push("R" + (i + 1)));

    let outSum = 0;
    let outN = 0;
    let inSum = 0;
    let inN = 0;
    for (let j = 0; j < NODE_ORDER.length; j += 1) {
      const out = val(state?.pdr_matrix?.[index]?.[j]);
      if (out !== null) {
        outSum += out;
        outN += 1;
      }
      const inc = val(state?.pdr_matrix?.[j]?.[index]);
      if (inc !== null) {
        inSum += inc;
        inN += 1;
      }
    }

    return {
      id,
      index,
      role,
      health,
      healthSeverity: healthSeverity(health),
      participation: state?.route_participation?.[id] ?? 0,
      routes: routeIds,
      pdrOut: outN ? outSum / outN : null,
      pdrIn: inN ? inSum / inN : null,
      measuredLinks: outN + inN,
      sensor: state?.sensor_data?.[id] ?? null,
    };
  });
}

export function routeSummaries(state: ControllerState | null): RouteSummary[] {
  const routes = state?.active_routes ?? [];

  return routes.map((relaysAndSource, index) => {
    const source = relaysAndSource[0];
    const relays = relaysAndSource.slice(1);
    const path = [...relaysAndSource, GATEWAY_NODE];

    const hops: RouteHop[] = [];
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      const pdr = val(
        state?.pdr_matrix?.[NODE_ORDER.indexOf(from)]?.[NODE_ORDER.indexOf(to)],
      );
      hops.push({
        from,
        to,
        pdr,
        severity: pdrSeverity(pdr),
        // No firmware probes a node->G link, so this is honestly unmeasured
        // rather than missing data (see nc1's GATEWAY_LINK_PDR_FALLBACK note).
        unmeasuredByDesign: to === GATEWAY_NODE,
      });
    }

    const measured = hops.map((h) => h.pdr).filter((p): p is number => p !== null);
    const healths = relaysAndSource
      .map((n) => val(state?.node_health?.[NODE_ORDER.indexOf(n)]))
      .filter((h): h is number => h !== null);

    const minPdr = measured.length ? Math.min(...measured) : null;
    const minHealth = healths.length ? Math.min(...healths) : null;

    // The route is graded by its weakest element, since one bad hop drops the
    // alert regardless of how good the rest of the path is.
    const sev: Severity[] = [pdrSeverity(minPdr), healthSeverity(minHealth)];
    const rank: Severity[] = ["crit", "warn", "off", "ok"];
    const severity = rank.find((r) => sev.includes(r)) ?? "ok";

    return {
      index,
      id: "R" + (index + 1),
      source,
      relays,
      path,
      hops,
      minPdr,
      meanPdr: measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null,
      minHealth,
      severity,
    };
  });
}

export interface NetworkSummary {
  meanMeshHealth: number | null;
  minMeshHealth: number | null;
  /** Mean over measured PDR entries only. */
  meanPdr: number | null;
  measuredLinks: number;
  degradedLinks: number;
  activeRoutes: number;
  /** Sources that currently have no path to the gateway. */
  heldSources: NodeId[];
  relaysInUse: number;
  overusedRelays: NodeId[];
}

export function networkSummary(state: ControllerState | null): NetworkSummary {
  const routes = state?.active_routes ?? [];
  const routed = new Set(routes.map((r) => r[0]));
  const heldSources = ["S1", "S2", "S3"].filter((s) => !routed.has(s));

  const meshHealth = MESH_NODES
    .map((m) => val(state?.node_health?.[NODE_ORDER.indexOf(m)]))
    .filter((h): h is number => h !== null);

  let sum = 0;
  let n = 0;
  let degraded = 0;
  for (const row of state?.pdr_matrix ?? []) {
    for (const v of row ?? []) {
      if (typeof v !== "number") continue;
      sum += v;
      n += 1;
      if (v < 60) degraded += 1;
    }
  }

  const participation = state?.route_participation ?? {};
  const relaysInUse = MESH_NODES.filter((m) => (participation[m] ?? 0) > 0).length;

  return {
    meanMeshHealth: meshHealth.length ? meshHealth.reduce((a, b) => a + b, 0) / meshHealth.length : null,
    minMeshHealth: meshHealth.length ? Math.min(...meshHealth) : null,
    meanPdr: n ? sum / n : null,
    measuredLinks: n,
    degradedLinks: degraded,
    activeRoutes: routes.length,
    heldSources,
    // nc1 caps a relay at 2 routes; at the cap it is carrying all it may.
    overusedRelays: MESH_NODES.filter((m) => (participation[m] ?? 0) >= 2),
    relaysInUse,
  };
}

/** Directed links that currently carry an active route, as "A>B" keys. */
export function activeLinkSet(state: ControllerState | null): Set<string> {
  const set = new Set<string>();
  for (const r of state?.active_routes ?? []) {
    const path = [...r, GATEWAY_NODE];
    for (let i = 0; i < path.length - 1; i += 1) set.add(path[i] + ">" + path[i + 1]);
  }
  return set;
}
