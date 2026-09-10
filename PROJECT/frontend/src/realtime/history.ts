/**
 * Client-side rolling time-series.
 *
 * The controller is stateless about history: every /ws frame is a full
 * snapshot of *now*. Any trend the operator sees therefore has to be
 * accumulated here. One append-only ring buffer, capped, shared by every
 * chart — charts read a window out of it instead of keeping their own copies,
 * so nothing resets when a component mounts or a route changes.
 */
import type { ControllerState, NodeId } from "@/types/friend";
import { isScored } from "@/types/friend";
import { HISTORY_CAPACITY, MESH_NODES, NODE_ORDER, SOURCE_NODES } from "@/lib/constants";

/** One frame's worth of derived series values. `null` == not measured. */
export interface HistorySample {
  /** Client receipt time in ms — monotonic for charting even if clocks differ. */
  t: number;
  /** Controller's own timestamp (unix seconds), kept for tooltips. */
  controllerT: number;
  water: Record<NodeId, number | null>;
  levelM: Record<NodeId, number | null>;
  temp: Record<NodeId, number | null>;
  humidity: Record<NodeId, number | null>;
  rain: Record<NodeId, boolean | null>;
  floodP: Record<NodeId, number | null>;
  uncertainty: Record<NodeId, number | null>;
  q10: Record<NodeId, number | null>;
  q50: Record<NodeId, number | null>;
  q90: Record<NodeId, number | null>;
  hCrit: Record<NodeId, number | null>;
  /** Mean of every measured PDR entry this frame (null if nothing measured). */
  meanPdr: number | null;
  /** Mean health across M1..M7 — the mesh's battery headroom. */
  meanMeshHealth: number;
  activeRoutes: number;
  worstFloodP: number | null;
}

export class RingBuffer<T> {
  private items: T[] = [];
  constructor(readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      // Drop the oldest in one splice rather than shift()-per-frame.
      this.items.splice(0, this.items.length - this.capacity);
    }
  }

  /** Live view — callers must not mutate. */
  all(): readonly T[] {
    return this.items;
  }

  get length(): number {
    return this.items.length;
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  clear(): void {
    this.items = [];
  }
}

const pickNumber = (v: unknown): number | null =>
  typeof v === "number" && !Number.isNaN(v) ? v : null;

/** Build one sample from a controller frame. Pure — no I/O, no clocks beyond `now`. */
export function sampleFromState(state: ControllerState, now: number): HistorySample {
  const water: Record<NodeId, number | null> = {};
  const levelM: Record<NodeId, number | null> = {};
  const temp: Record<NodeId, number | null> = {};
  const humidity: Record<NodeId, number | null> = {};
  const rain: Record<NodeId, boolean | null> = {};
  const floodP: Record<NodeId, number | null> = {};
  const uncertainty: Record<NodeId, number | null> = {};
  const q10: Record<NodeId, number | null> = {};
  const q50: Record<NodeId, number | null> = {};
  const q90: Record<NodeId, number | null> = {};
  const hCrit: Record<NodeId, number | null> = {};

  for (const id of SOURCE_NODES) {
    const s = state.sensor_data?.[id];
    water[id] = pickNumber(s?.water_level);
    temp[id] = pickNumber(s?.temperature);
    humidity[id] = pickNumber(s?.humidity);
    rain[id] = typeof s?.rain === "boolean" ? s.rain : null;

    const ai = state.flood_ai?.nodes?.[id];
    if (isScored(ai)) {
      levelM[id] = ai.level_m;
      floodP[id] = ai.flood_probability;
      uncertainty[id] = ai.uncertainty;
      q10[id] = ai.forecast.q10_m;
      q50[id] = ai.forecast.q50_m;
      q90[id] = ai.forecast.q90_m;
      hCrit[id] = ai.h_crit_m;
    } else {
      levelM[id] = null;
      floodP[id] = null;
      uncertainty[id] = null;
      q10[id] = null;
      q50[id] = null;
      q90[id] = null;
      hCrit[id] = null;
    }
  }

  // Mean PDR over measured entries only — unmeasured links must not drag the
  // average toward zero, so they are excluded rather than counted as 0.
  let pdrSum = 0;
  let pdrCount = 0;
  const matrix = state.pdr_matrix ?? [];
  for (const row of matrix) {
    for (const v of row ?? []) {
      if (typeof v === "number") {
        pdrSum += v;
        pdrCount += 1;
      }
    }
  }

  const meshHealth = MESH_NODES.map((m) => state.node_health?.[NODE_ORDER.indexOf(m)] ?? 0);
  const meanMeshHealth = meshHealth.length
    ? meshHealth.reduce((a, b) => a + b, 0) / meshHealth.length
    : 0;

  return {
    t: now,
    controllerT: state.timestamp,
    water,
    levelM,
    temp,
    humidity,
    rain,
    floodP,
    uncertainty,
    q10,
    q50,
    q90,
    hCrit,
    meanPdr: pdrCount ? pdrSum / pdrCount : null,
    meanMeshHealth,
    activeRoutes: state.active_routes?.length ?? 0,
    worstFloodP: pickNumber(state.flood_ai?.worst?.flood_probability),
  };
}

export const createHistory = () => new RingBuffer<HistorySample>(HISTORY_CAPACITY);

/** Slice the buffer to a trailing time window (ms). */
export function windowed(
  samples: readonly HistorySample[],
  windowMs: number,
): HistorySample[] {
  if (!samples.length) return [];
  const cutoff = samples[samples.length - 1].t - windowMs;
  // Buffer is time-ordered, so walk back from the end rather than filtering all.
  let start = samples.length - 1;
  while (start > 0 && samples[start - 1].t >= cutoff) start -= 1;
  return samples.slice(start);
}
