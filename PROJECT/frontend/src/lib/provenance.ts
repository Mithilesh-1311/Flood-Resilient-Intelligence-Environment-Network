/**
 * Where the numbers on screen come from.
 *
 * Two independent questions, answered from what the controller reports - never
 * guessed in the UI:
 *
 *   network    is the mesh (PDR, routing, health) real hardware or simulated?
 *              -> system.data_source, derived by nc1.py from its gateway target
 *   telemetry  are the river readings real?
 *              -> flood_ai.source === "replay" means real gauge data replayed
 *                 from the project's labelled dataset (replay_hardware.py)
 *
 * In replay the mesh is still simulated but the rivers are real, and every
 * surface that says "simulated" has to say which half it means.
 */
import type { ControllerState } from "@/types/friend";

export type NetworkSource = "SIMULATION" | "LIVE_HARDWARE";
export type TelemetrySource = "REPLAY" | "SIMULATED" | "FIELD";

export interface Provenance {
  network: NetworkSource | null;
  telemetry: TelemetrySource | null;
}

export function provenance(state: ControllerState | null): Provenance {
  if (!state) return { network: null, telemetry: null };
  const network = state.system?.data_source ?? null;
  const telemetry: TelemetrySource | null =
    state.flood_ai?.source === "replay"
      ? "REPLAY"
      : network === "SIMULATION"
        ? "SIMULATED"
        : network
          ? "FIELD"
          : null;
  return { network, telemetry };
}

export const TELEMETRY_LABEL: Record<TelemetrySource, string> = {
  REPLAY: "REAL GAUGE REPLAY",
  SIMULATED: "SIMULATED TELEMETRY",
  FIELD: "FIELD SENSORS",
};

/** "2023-12-05 14:15:00" -> "2023-12-05 14:15" (the dataset's own local stamps). */
export function obsTime(t: string | null | undefined): string {
  if (!t) return "—";
  return t.length >= 16 ? t.slice(0, 16) : t;
}

export function stationName(station: string | null | undefined): string {
  return station ? station.replace(/_/g, " ") : "—";
}

export const SPLIT_LABEL: Record<string, string> = {
  test: "TEST 2023–24 · UNSEEN",
  val: "VALIDATION 2021–22",
  train: "TRAINING DATA · SEEN",
};
