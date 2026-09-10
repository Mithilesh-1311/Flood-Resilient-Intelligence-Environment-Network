import type { NodeId, NodeRole } from "@/types/friend";

/** Controller order — must match nc1.NODE_ORDER exactly (index == matrix index). */
export const NODE_ORDER: NodeId[] = [
  "S1", "S2", "S3", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "G",
];

export const SOURCE_NODES: NodeId[] = ["S1", "S2", "S3"];
export const MESH_NODES: NodeId[] = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"];
export const GATEWAY_NODE: NodeId = "G";

export function roleOf(id: NodeId): NodeRole {
  if (id === GATEWAY_NODE) return "gateway";
  return id.startsWith("S") ? "source" : "mesh";
}

export const ROLE_LABEL: Record<NodeRole, string> = {
  source: "SOURCE / SENSOR",
  mesh: "MESH RELAY",
  gateway: "GATEWAY",
};

/**
 * Fixed schematic coordinates for the topology view. Deliberately constant:
 * node positions never move, so a route change is the only thing that
 * animates and the operator's spatial memory of the field stays intact.
 * Laid out left-to-right in the direction alerts travel: sources -> mesh -> gateway.
 */
export const TOPOLOGY_VIEWBOX = { w: 980, h: 540 };

export const NODE_POS: Record<NodeId, { x: number; y: number }> = {
  S1: { x: 78, y: 120 },
  S2: { x: 78, y: 270 },
  S3: { x: 78, y: 420 },
  M1: { x: 340, y: 70 },
  M2: { x: 340, y: 205 },
  M3: { x: 340, y: 340 },
  M4: { x: 340, y: 475 },
  M5: { x: 590, y: 140 },
  M6: { x: 590, y: 285 },
  M7: { x: 590, y: 430 },
  G: { x: 862, y: 275 },
};

/**
 * Route accent colours. These mirror nc1.ROUTE_COLORS by *position* (R1/R2/R3
 * -> index 0/1/2) so the dashboard and the physical RGB LEDs on the mesh nodes
 * agree about which route is which, rendered in this UI's restrained palette.
 */
export const ROUTE_COLORS = ["#3FA7D6", "#3FB27F", "#B07FD9", "#D9A441", "#C9737F", "#57B6B2"];
export const routeColor = (i: number) => ROUTE_COLORS[i % ROUTE_COLORS.length];

/** Health / PDR banding, shared by every view so thresholds never disagree. */
export const HEALTH_BANDS = { good: 70, warn: 40 } as const;
export const PDR_BANDS = { good: 85, warn: 60 } as const;

export type Severity = "ok" | "warn" | "crit" | "off";

export function healthSeverity(h: number | null | undefined): Severity {
  if (h === null || h === undefined) return "off";
  if (h >= HEALTH_BANDS.good) return "ok";
  if (h >= HEALTH_BANDS.warn) return "warn";
  return "crit";
}

export function pdrSeverity(p: number | null | undefined): Severity {
  if (p === null || p === undefined) return "off";
  if (p >= PDR_BANDS.good) return "ok";
  if (p >= PDR_BANDS.warn) return "warn";
  return "crit";
}

export const SEVERITY_HEX: Record<Severity, string> = {
  ok: "#3FB27F",
  warn: "#D9A441",
  crit: "#D9534F",
  off: "#5A6472",
};

export const SEVERITY_TEXT: Record<Severity, string> = {
  ok: "text-ok",
  warn: "text-warn",
  crit: "text-crit",
  off: "text-off",
};

/**
 * Rolling history capacity, in frames. The controller emits one frame every
 * 2 s, so 1800 frames is a full hour - enough to back the longest time window
 * offered below without ever promising a window the buffer cannot fill.
 * Each frame is a handful of small numbers per node, so the whole buffer is a
 * couple of megabytes at most.
 */
export const HISTORY_CAPACITY = 1800;

export const TIME_WINDOWS = [
  { label: "5 MIN", ms: 5 * 60_000 },
  { label: "15 MIN", ms: 15 * 60_000 },
  { label: "30 MIN", ms: 30 * 60_000 },
  { label: "1 HR", ms: 60 * 60_000 },
] as const;

/** A frame older than this means the controller stopped talking to us. */
export const STALE_AFTER_MS = 8_000;
