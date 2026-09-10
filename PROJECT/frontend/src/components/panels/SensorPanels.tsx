/**
 * Source-node telemetry.
 *
 * The firmware reports water_level as 0-100 % of the analog sensor's span, so
 * that is what the WATER column shows. The metres figure beside it is the
 * calibrated value the flood model was actually fed, and it is labelled as
 * calibrated rather than measured - the two are never conflated.
 *
 * A key the firmware did not send (a failed DHT read, say) stays absent all the
 * way to the cell, which renders as an em dash.
 */
import { memo } from "react";
import { CloudRain, Droplets, Sun, Thermometer } from "lucide-react";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { isScored, type NodeId } from "@/types/friend";
import { EmptyState, NoData, Panel, StatusDot, Tag } from "@/components/primitives";
import { SOURCE_NODES, healthSeverity, NODE_ORDER } from "@/lib/constants";
import { clock, cx, num } from "@/lib/format";

/* ------------------------------------------------------------- selector */

export const SensorSelector = memo(function SensorSelector({
  value,
  onChange,
}: {
  value: NodeId;
  onChange: (id: NodeId) => void;
}) {
  const rows = useRealtime((s) => {
    const st = s.state;
    return SOURCE_NODES.map((id) => {
      const ai = st?.flood_ai?.nodes?.[id];
      return {
        id,
        reporting: !!st?.sensor_data?.[id],
        health: st?.node_health?.[NODE_ORDER.indexOf(id)] ?? null,
        scored: isScored(ai),
        station: ai?.station ?? null,
      };
    });
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  return (
    <div role="group" aria-label="Select source node" className="flex flex-wrap gap-1.5">
      {rows.map((r) => {
        const active = r.id === value;
        return (
          <button
            key={r.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(r.id)}
            className={cx(
              "flex items-center gap-2 border px-2.5 py-1.5 transition-colors duration-150",
              active
                ? "border-accent/50 bg-accent/10"
                : "border-line hover:border-line-strong hover:bg-base-700",
            )}
          >
            {/* Decorative here: the button's own text states the status, so
                labelling the dot would only pad the accessible name. */}
            <StatusDot severity={r.reporting ? healthSeverity(r.health) : "off"} />
            <span className={cx("font-mono text-xs font-semibold", active ? "text-accent" : "text-ink-dim")}>
              {r.id}
            </span>
            <span className="font-mono text-2xs uppercase tracking-[0.1em] text-ink-ghost">
              {r.reporting ? (r.scored ? "SCORED" : "WARMING") : "NO DATA"}
            </span>
          </button>
        );
      })}
    </div>
  );
});

/* ---------------------------------------------------------------- table */

export const SensorTable = memo(function SensorTable({
  selected,
  onSelect,
  className,
}: {
  selected?: NodeId;
  onSelect?: (id: NodeId) => void;
  className?: string;
}) {
  const { rows, updated, compressed } = useRealtime((s) => {
    const st = s.state;
    return {
      updated: st?.timestamp ?? null,
      compressed: st?.flood_ai?.cadence?.time_compressed ?? false,
      rows: SOURCE_NODES.map((id) => {
        const sensor = st?.sensor_data?.[id];
        const ai = st?.flood_ai?.nodes?.[id];
        const scored = isScored(ai) ? ai : null;
        return {
          id,
          water: typeof sensor?.water_level === "number" ? sensor.water_level : null,
          rain: typeof sensor?.rain === "boolean" ? sensor.rain : null,
          temp: typeof sensor?.temperature === "number" ? sensor.temperature : null,
          humidity: typeof sensor?.humidity === "number" ? sensor.humidity : null,
          levelM: scored?.level_m ?? null,
          hCrit: scored?.h_crit_m ?? null,
          station: ai?.station ?? null,
          reporting: !!sensor,
          lastReading: ai?.last_reading_at ?? 0,
        };
      }),
    };
  }, shallowEqual);

  const anyReporting = rows.some((r) => r.reporting);

  return (
    <Panel
      title="Source node telemetry"
      subtitle="S1–S3 · values as reported by the field firmware"
      className={className}
      right={
        <span className="font-mono text-2xs text-ink-ghost">
          UPDATED {clock(updated)}
        </span>
      }
      bodyClassName="overflow-x-auto"
    >
      {!anyReporting ? (
        <EmptyState
          title="No source telemetry"
          detail="The controller has not received a telemetry message from S1, S2 or S3 yet."
        />
      ) : (
        <table className="w-full min-w-[680px] border-collapse">
          <thead className="border-b border-line">
            <tr>
              <th className="th w-14">NODE</th>
              <th className="th w-24 text-right">WATER %</th>
              <th className="th w-28 text-right">LEVEL (CAL.)</th>
              <th className="th w-24 text-right">FLOOD LINE</th>
              <th className="th w-16">RAIN</th>
              <th className="th w-20 text-right">TEMP °C</th>
              <th className="th w-20 text-right">RH %</th>
              <th className="th">STATION</th>
              <th className="th w-20">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isSel = selected === r.id;
              const overLine = r.levelM !== null && r.hCrit !== null && r.levelM >= r.hCrit;
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
                  <td className="cell text-right">
                    {r.water === null ? <NoData reason="water_level not reported" /> : num(r.water, 1)}
                  </td>
                  <td className={cx("cell text-right", overLine && "text-crit")}>
                    {r.levelM === null ? (
                      <NoData reason="Model has not produced a calibrated level yet" />
                    ) : (
                      num(r.levelM, 3) + " m"
                    )}
                  </td>
                  <td className="cell text-right text-ink-faint">
                    {r.hCrit === null ? <NoData /> : num(r.hCrit, 2) + " m"}
                  </td>
                  <td className="cell">
                    {r.rain === null ? (
                      <NoData reason="rain flag not reported" />
                    ) : r.rain ? (
                      <span className="flex items-center gap-1 text-accent">
                        <CloudRain size={11} strokeWidth={2} /> WET
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-ink-faint">
                        <Sun size={11} strokeWidth={2} /> DRY
                      </span>
                    )}
                  </td>
                  <td className="cell text-right">{r.temp === null ? <NoData /> : num(r.temp, 1)}</td>
                  <td className="cell text-right">{r.humidity === null ? <NoData /> : num(r.humidity, 1)}</td>
                  <td className="cell text-ink-faint">
                    {r.station ? r.station.replace(/_/g, " ") : <NoData />}
                  </td>
                  <td className="cell">
                    <span className="flex items-center gap-1.5">
                      <StatusDot severity={r.reporting ? "ok" : "off"} />
                      <span className="uppercase text-ink-dim">{r.reporting ? "ACTIVE" : "SILENT"}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-ink-ghost">
        WATER % is the raw firmware reading (0–100 % of the analog sensor span). LEVEL (CAL.) is that
        value mapped onto the station's observed stage range from <span className="font-mono">station_params.json</span> — a
        stated calibration, not a measured depth. It is the number fed to the GRU.
        {compressed && " Model steps are time-compressed for this demo; see the Flood AI module."}
      </p>
    </Panel>
  );
});

/** Compact current-conditions readout for the selected node. */
export const SensorVitals = memo(function SensorVitals({ node }: { node: NodeId }) {
  const v = useRealtime((s) => {
    const sensor = s.state?.sensor_data?.[node];
    return {
      temp: typeof sensor?.temperature === "number" ? sensor.temperature : null,
      humidity: typeof sensor?.humidity === "number" ? sensor.humidity : null,
      rain: typeof sensor?.rain === "boolean" ? sensor.rain : null,
      water: typeof sensor?.water_level === "number" ? sensor.water_level : null,
    };
  }, shallowEqual);

  const items = [
    { icon: Droplets, label: "WATER", value: v.water === null ? null : num(v.water, 1) + " %" },
    { icon: Thermometer, label: "TEMP", value: v.temp === null ? null : num(v.temp, 1) + " °C" },
    { icon: Droplets, label: "HUMIDITY", value: v.humidity === null ? null : num(v.humidity, 1) + " %" },
    { icon: CloudRain, label: "RAIN", value: v.rain === null ? null : v.rain ? "WET" : "DRY" },
  ];

  return (
    <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="bg-base-800 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <i.icon size={11} strokeWidth={1.8} className="text-ink-ghost" />
            <span className="eyebrow">{i.label}</span>
          </div>
          <div className="mt-1 font-mono text-sm tabular-nums text-ink">
            {i.value ?? <NoData reason="Not reported by firmware" />}
          </div>
        </div>
      ))}
    </div>
  );
});

/** Station calibration disclosure for the selected node. */
export const CalibrationNote = memo(function CalibrationNote({ node }: { node: NodeId }) {
  const cal = useRealtime((s) => {
    const ai = s.state?.flood_ai?.nodes?.[node];
    return isScored(ai) ? { ...ai.calibration, station: ai.station, hCrit: ai.h_crit_m } : null;
  }, shallowEqual);

  if (!cal) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border border-line bg-base-800 px-2.5 py-2">
      <Tag tone="warn">STATED CALIBRATION</Tag>
      <span className="font-mono text-2xs text-ink-faint">
        {node} 0–100 % → {num(cal.level_min_m, 2)}–{num(cal.level_max_m, 2)} m ·{" "}
        {cal.station.replace(/_/g, " ")} · flood line {num(cal.hCrit, 2)} m
      </span>
      <span className="text-2xs text-ink-ghost">({cal.source})</span>
    </div>
  );
});
