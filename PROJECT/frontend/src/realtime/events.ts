/**
 * Event derivation.
 *
 * Every entry in the alert rail and the timeline is produced by DIFFING two
 * consecutive controller frames. Nothing is scheduled, randomised or
 * decorative: if the network did not change, no event is emitted. Where an
 * event needs a reason (why did the route move?), that reason is read back out
 * of the same two frames - the health that dropped, the PDR that fell - and is
 * omitted entirely when neither is visible.
 */
import type { ControllerState, NodeId } from "@/types/friend";
import { isScored } from "@/types/friend";
import { HEALTH_BANDS, MESH_NODES, NODE_ORDER, PDR_BANDS, SOURCE_NODES } from "@/lib/constants";
import { num, pct, prob, routePath } from "@/lib/format";

export type EventCategory = "SYSTEM" | "NETWORK" | "ROUTING" | "AI" | "SENSOR" | "RECOVERY";
export type EventSeverity = "info" | "warning" | "critical" | "recovery";

export interface AlertEvent {
  id: string;
  t: number;
  controllerT: number;
  category: EventCategory;
  severity: EventSeverity;
  /** WHAT happened. */
  title: string;
  /** WHY, and the resulting current state. */
  detail: string;
  /** WHERE. */
  where?: string;
  /** Populated only for route changes, so the UI can show old vs new. */
  routeChange?: { index: number; from: NodeId[]; to: NodeId[] };
  /**
   * The evidenced cause of a route change, kept separate from `detail` so a
   * panel that already shows the old and new paths can render the cause alone.
   * Null when neither a PDR drop nor a health drop was visible in the diff.
   */
  reason?: string | null;
}

let seq = 0;
const mkId = () => "ev-" + Date.now().toString(36) + "-" + (seq += 1).toString(36);

const healthOf = (s: ControllerState, id: NodeId): number | undefined =>
  s.node_health?.[NODE_ORDER.indexOf(id)];

const pdrOf = (s: ControllerState, a: NodeId, b: NodeId): number | null => {
  const v = s.pdr_matrix?.[NODE_ORDER.indexOf(a)]?.[NODE_ORDER.indexOf(b)];
  return typeof v === "number" ? v : null;
};

const sig = (route: NodeId[]) => route.join(">");

/** Consecutive hops of a route, including the implicit final hop into G. */
export function hops(route: NodeId[]): Array<[NodeId, NodeId]> {
  const full = [...route, "G"];
  const out: Array<[NodeId, NodeId]> = [];
  for (let i = 0; i < full.length - 1; i += 1) out.push([full[i], full[i + 1]]);
  return out;
}

/**
 * Explain a route change using only measured evidence from the two frames: a
 * hop that was in the old route and whose PDR fell, or a relay that left the
 * route and lost health. Returns null when neither is visible, and the caller
 * then says nothing about cause rather than inventing one.
 */
function explainRouteChange(
  prev: ControllerState,
  next: ControllerState,
  oldRoute: NodeId[],
  newRoute: NodeId[],
): string | null {
  const dropped = oldRoute.filter((n) => !newRoute.includes(n));

  let worstHealth: { node: NodeId; from: number; to: number } | null = null;
  for (const node of dropped) {
    const from = healthOf(prev, node);
    const to = healthOf(next, node);
    if (from === undefined || to === undefined || to >= from) continue;
    if (!worstHealth || from - to > worstHealth.from - worstHealth.to) {
      worstHealth = { node, from, to };
    }
  }

  let worstPdr: { a: NodeId; b: NodeId; from: number; to: number } | null = null;
  for (const [a, b] of hops(oldRoute)) {
    const from = pdrOf(prev, a, b);
    const to = pdrOf(next, a, b);
    if (from === null || to === null || to >= from - 5) continue;
    if (!worstPdr || from - to > worstPdr.from - worstPdr.to) {
      worstPdr = { a, b, from, to };
    }
  }

  if (worstPdr && (!worstHealth || worstPdr.from - worstPdr.to > 15)) {
    return (
      "LINK DEGRADED / " + worstPdr.a + "-" + worstPdr.b +
      " PDR " + pct(worstPdr.from, 0) + " to " + pct(worstPdr.to, 0)
    );
  }
  if (worstHealth) {
    return (
      "NODE HEALTH DROP / " + worstHealth.node +
      " " + worstHealth.from + "% to " + worstHealth.to + "%"
    );
  }
  if (dropped.length) return "RELAY SET CHANGED / dropped " + dropped.join(", ");
  return null;
}

/**
 * Diff two frames into events. A null `prev` (the first frame of a session)
 * yields a single session-start event, never a burst of synthetic history.
 */
export function deriveEvents(
  prev: ControllerState | null,
  next: ControllerState,
  now: number,
): AlertEvent[] {
  const out: AlertEvent[] = [];
  const push = (e: Omit<AlertEvent, "id" | "t" | "controllerT">) =>
    out.push({ id: mkId(), t: now, controllerT: next.timestamp, ...e });

  if (!prev) {
    push({
      category: "SYSTEM",
      severity: "info",
      title: "Controller state stream established",
      where: next.system?.gateway_host ?? "controller",
      detail:
        (next.system?.data_source === "SIMULATION" ? "SIMULATION" : "LIVE HARDWARE") +
        " / " + (next.active_routes?.length ?? 0) + " active route(s)" +
        " / " + (next.nodes?.length ?? 0) + " nodes in routing graph",
    });
    return out;
  }

  /* ---- gateway bridge -------------------------------------------------- */
  if (prev.system?.gateway_connected !== next.system?.gateway_connected) {
    const up = next.system.gateway_connected;
    push({
      category: up ? "RECOVERY" : "SYSTEM",
      severity: up ? "recovery" : "critical",
      title: up ? "Gateway link restored" : "Gateway link lost",
      where: next.system.gateway_host + ":" + next.system.gateway_port,
      detail: up
        ? "Controller reconnected to the gateway TCP bridge. Field telemetry resuming."
        : "Controller lost its TCP connection to the gateway. Field telemetry has stopped.",
    });
  }

  /* ---- routing --------------------------------------------------------- */
  const bySource = (routes: NodeId[][]) => {
    const m = new Map<NodeId, { route: NodeId[]; index: number }>();
    routes.forEach((r, index) => {
      if (r.length) m.set(r[0], { route: r, index });
    });
    return m;
  };
  const prevBySource = bySource(prev.active_routes ?? []);
  const nextBySource = bySource(next.active_routes ?? []);

  for (const [source, cur] of nextBySource) {
    const before = prevBySource.get(source);
    if (!before) {
      push({
        category: "RECOVERY",
        severity: "recovery",
        title: "Alert path restored for " + source,
        where: source,
        detail: "Routing engine found a viable path again: " + routePath(cur.route),
        routeChange: { index: cur.index, from: [], to: cur.route },
      });
      continue;
    }
    if (sig(before.route) === sig(cur.route)) continue;

    const reason = explainRouteChange(prev, next, before.route, cur.route);
    push({
      category: "ROUTING",
      severity: "warning",
      title: "Route recomputed for " + source,
      where: source,
      detail:
        routePath(before.route) + "   to   " + routePath(cur.route) +
        (reason ? "  /  " + reason : "  /  Dijkstra selected a lower-cost path"),
      reason: reason ?? "Dijkstra selected a lower-cost path this cycle",
      routeChange: { index: cur.index, from: before.route, to: cur.route },
    });
  }

  for (const [source, before] of prevBySource) {
    if (nextBySource.has(source)) continue;
    push({
      category: "NETWORK",
      severity: "critical",
      title: "No viable path for " + source,
      where: source,
      detail:
        routePath(before.route) + " withdrawn. The router found no 2-4 relay " +
        "path to the gateway this cycle, so " + source + " is held.",
    });
  }

  /* ---- mesh relay health ----------------------------------------------- */
  for (const node of MESH_NODES) {
    const a = healthOf(prev, node);
    const b = healthOf(next, node);
    if (a === undefined || b === undefined) continue;
    const down = (limit: number) => a >= limit && b < limit;
    const up = (limit: number) => a < limit && b >= limit;

    if (down(HEALTH_BANDS.warn)) {
      push({
        category: "NETWORK",
        severity: "critical",
        title: node + " health critical",
        where: node,
        detail:
          "Relay battery health fell to " + b + "% (was " + a + "%). " +
          "The router will avoid this relay while it rests.",
      });
    } else if (down(HEALTH_BANDS.good)) {
      push({
        category: "NETWORK",
        severity: "warning",
        title: node + " health degraded",
        where: node,
        detail: "Relay battery health fell to " + b + "% (was " + a + "%) under relay duty.",
      });
    } else if (up(HEALTH_BANDS.good)) {
      push({
        category: "RECOVERY",
        severity: "recovery",
        title: node + " health recovered",
        where: node,
        detail: "Relay recovered to " + b + "% while resting and is available for routing again.",
      });
    }
  }

  /* ---- link quality on paths that are actually carrying alerts --------- */
  const inUse = new Set<string>();
  for (const r of next.active_routes ?? []) for (const [a, b] of hops(r)) inUse.add(a + ">" + b);
  for (const key of inUse) {
    const [a, b] = key.split(">") as [NodeId, NodeId];
    const before = pdrOf(prev, a, b);
    const after = pdrOf(next, a, b);
    if (before === null || after === null) continue;
    if (before >= PDR_BANDS.warn && after < PDR_BANDS.warn) {
      push({
        category: "NETWORK",
        severity: "warning",
        title: "Link " + a + "-" + b + " reliability degraded",
        where: a + "-" + b,
        detail:
          "Measured PDR " + pct(before, 0) + " to " + pct(after, 0) +
          " on an active alert path.",
      });
    }
  }

  /* ---- flood-risk AI --------------------------------------------------- */
  if (prev.flood_ai?.available !== next.flood_ai?.available) {
    const ok = next.flood_ai?.available;
    push({
      category: "AI",
      severity: ok ? "recovery" : "warning",
      title: ok ? "Flood-Risk AI online" : "Flood-Risk AI offline",
      where: next.flood_ai?.model?.file ?? "flood_gru.keras",
      detail: ok
        ? "GRU loaded / " + (next.flood_ai.model?.mc_samples ?? "?") +
          " MC-Dropout passes / +" + (next.flood_ai.model?.horizon_minutes ?? "?") + " min horizon"
        : next.flood_ai?.reason ?? "Model unavailable. No flood inference is being produced.",
    });
  }

  const threshold = next.flood_ai?.model?.threshold;
  const horizon = next.flood_ai?.model?.horizon_minutes ?? 30;

  for (const node of SOURCE_NODES) {
    const a = prev.flood_ai?.nodes?.[node];
    const b = next.flood_ai?.nodes?.[node];
    if (!isScored(b)) continue;

    if (!isScored(a)) {
      push({
        category: "AI",
        severity: "info",
        title: node + " flood inference started",
        where: node,
        detail:
          "Rolling window filled (" + b.model_steps + " model steps). " +
          "P(flood) " + prob(b.flood_probability) + " +/- " + num(b.uncertainty, 3),
      });
      continue;
    }

    if (threshold !== undefined && !a.alarm && b.alarm) {
      push({
        category: "AI",
        severity: "critical",
        title: "FLOOD ALARM / " + node,
        where: node + " / " + b.station,
        detail:
          "P(flood within +" + horizon + " min) = " + prob(b.flood_probability) +
          ", at or above the " + prob(threshold, 0) + " alarm threshold. Level " +
          num(b.level_m, 2) + " m against a " + num(b.h_crit_m, 2) + " m flood line.",
      });
    } else if (threshold !== undefined && a.alarm && !b.alarm) {
      push({
        category: "RECOVERY",
        severity: "recovery",
        title: "Flood alarm cleared / " + node,
        where: node,
        detail:
          "P(flood) fell to " + prob(b.flood_probability) + ", below the " +
          prob(threshold, 0) + " alarm threshold.",
      });
    } else if (b.flood_probability - a.flood_probability >= 0.15) {
      push({
        category: "AI",
        severity: "warning",
        title: "Flood probability rising / " + node,
        where: node,
        detail:
          "P(flood) " + prob(a.flood_probability) + " to " + prob(b.flood_probability) +
          ". Forecast +" + horizon + " min " + num(b.forecast.q50_m, 2) + " m [" +
          num(b.forecast.q10_m, 2) + "-" + num(b.forecast.q90_m, 2) + "]",
      });
    }
  }

  return out;
}
