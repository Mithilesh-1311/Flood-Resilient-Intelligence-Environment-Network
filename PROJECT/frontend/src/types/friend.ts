/**
 * Wire types for the FRiEND controller (HARDWARE/nc1.py).
 *
 * Every field here exists in NetworkState.as_dict(). Nothing is invented:
 * if the controller does not send it, it is not in this file. Optional /
 * nullable fields are optional here too, because "missing" is a real state
 * the UI must render as "NO DATA" rather than as zero.
 *
 * Endpoints:  GET /state   POST /reset_health   WS /ws
 */

/** Node ids in controller order: index 0..10 == S1,S2,S3,M1..M7,G. */
export type NodeId = string;

export type NodeRole = "source" | "mesh" | "gateway";

/** nc1.py forwards only the keys the firmware actually sent. */
export interface SensorReading {
  /** 0-100 % of the analog water sensor's span (firmware `map(raw,0,ADC_MAX,0,100)`). */
  water_level?: number;
  rain?: boolean;
  temperature?: number;
  humidity?: number;
  rain_analog?: number;
}

export type LedSlot = "OFF" | { route: string; color: string };

export interface RouteSlots {
  led1: LedSlot;
  led2: LedSlot;
}

export interface PacketStatsSummary {
  total_tx: number[][];
  total_rx: number[][];
}

/* ---------------------------------------------------------------------- *
 * Flood-Risk AI (HARDWARE/flood_ai.py)
 * ---------------------------------------------------------------------- */

export interface FloodForecast {
  q10_norm: number;
  q50_norm: number;
  q90_norm: number;
  q10_m: number;
  q50_m: number;
  q90_m: number;
}

export interface FloodNodeOk {
  status: "ok";
  station: string;
  h_crit_m: number;
  calibration: { level_min_m: number; level_max_m: number; source: string };
  level_m: number;
  level_norm: number;
  flood_probability: number;
  /** MC-Dropout standard deviation of P across the 20 stochastic passes. */
  uncertainty: number;
  alarm: boolean;
  forecast: FloodForecast;
  model_steps: number;
  last_reading_at: number;
}

export interface FloodNodePending {
  status: "warming_up" | "no_data";
  station: string;
  model_steps: number;
  steps_required: number;
  last_reading_at: number;
}

export type FloodNode = FloodNodeOk | FloodNodePending;

export const isScored = (n: FloodNode | null | undefined): n is FloodNodeOk =>
  !!n && n.status === "ok";

/** models/metrics.json + models/onset_metrics.json, passed through verbatim. */
export interface SplitMetrics {
  threshold: number;
  hits: number;
  misses: number;
  false_alarms: number;
  POD: number;
  FAR: number;
  CSI: number;
  band_coverage?: number;
  mean_uncertainty?: number;
  onset_rows?: SplitMetrics & { rows?: number; positives?: number };
}

export interface FloodEvaluation {
  metrics?: {
    validation?: SplitMetrics;
    test?: SplitMetrics;
    test_per_station?: Record<string, SplitMetrics>;
  };
  onset?: {
    split: string;
    threshold: number;
    onset_rows: SplitMetrics & { rows: number; positives: number };
    onset_rows_per_station?: Record<string, SplitMetrics & { rows: number; positives: number }>;
    events: {
      events: number;
      caught: number;
      missed: number;
      event_POD: number;
      false_alarm_episodes: number;
      lead_time_median_min: number;
      lead_time_mean_min: number;
      lead_time_max_min: number;
      lookback_hours: number;
    };
  };
}

export interface FloodAIBlock {
  available: boolean;
  status: "not_loaded" | "loading" | "ready" | "unavailable";
  reason?: string | null;
  error?: string | null;
  model?: {
    file: string;
    architecture: string;
    horizon_minutes: number;
    quantiles: number[];
    mc_samples: number;
    threshold: number;
    threshold_tuned_on?: string | null;
    lag_steps: number;
    step_minutes: number;
    inference_ms: number;
  };
  cadence?: {
    live_seconds_per_model_step: number;
    model_step_minutes: number;
    time_compressed: boolean;
    compression_ratio: number;
  };
  nodes: Record<NodeId, FloodNode>;
  worst: {
    node: NodeId;
    flood_probability: number;
    uncertainty: number;
    level_m: number;
    level_norm: number;
    alarm: boolean;
    forecast: FloodForecast;
    h_crit_m: number;
  } | null;
  evaluation: FloodEvaluation;
  updated?: number;
}

/* ---------------------------------------------------------------------- *
 * Controller self-description
 * ---------------------------------------------------------------------- */

export interface SystemBlock {
  gateway_connected: boolean;
  gateway_host: string;
  gateway_port: number;
  /** Derived from the controller's own TCP target - never a guess in the UI. */
  data_source: "SIMULATION" | "LIVE_HARDWARE";
  loop_interval_seconds: number;
  pdr_stale_after_seconds: number;
  started_at: number;
  uptime_seconds: number;
  cycle: number;
  ws_clients: number;
}

/** The complete /ws frame and /state body. */
export interface ControllerState {
  nodes: NodeId[];
  /** 11x11, rows = from, cols = to. `null` means genuinely unmeasured. */
  pdr_matrix: (number | null)[][];
  node_health: number[];
  sensor_data: Record<NodeId, SensorReading>;
  /** Trailing "G" is stripped by nc1.get_routes_from_ai(); the UI re-appends it. */
  active_routes: NodeId[][];
  route_slots: Record<NodeId, RouteSlots>;
  route_participation: Record<NodeId, number>;
  packet_stats_summary: PacketStatsSummary;
  flood_ai: FloodAIBlock;
  system: SystemBlock;
  /** Unix seconds (float) from the controller. */
  timestamp: number;
}

/** Frontend-side link/connection status, not sent by the backend. */
export type LinkState = "connecting" | "live" | "stale" | "reconnecting" | "offline";
