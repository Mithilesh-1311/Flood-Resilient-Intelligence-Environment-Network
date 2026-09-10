/**
 * WATER LEVEL + FLOOD FORECAST — the primary environmental intelligence graph.
 *
 * What is drawn, and where each series genuinely comes from:
 *
 *   observed level    the rolling client-side history of flood_ai.nodes[N].level_m
 *                     (the calibrated metre value the GRU was actually fed)
 *   flood line        station h_crit_m from flood_dataset/station_params.json
 *   alert reference   90 % of that flood line — a UI-side operational marker,
 *                     labelled as derived, never presented as a model output
 *   forecast median   the model's q50 for +horizon, projected forward
 *   forecast band     the model's q10..q90 for the same point
 *   peak              the highest observed sample inside the visible window
 *
 * The chart never resets. New frames append to the shared ring buffer and the
 * window slides; old points roll off the left edge. Under time compression the
 * forecast marker is placed at the wall-clock instant the model horizon
 * corresponds to, and the axis label says so.
 */
import { memo, useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useFrameVersion, useHistory, useRealtime } from "@/realtime/RealtimeProvider";
import { windowed, type HistorySample } from "@/realtime/history";
import { isScored, type NodeId } from "@/types/friend";
import { num, prob } from "@/lib/format";
import { CHART, ChartLegend, TelemetryTooltip, axisProps, gridProps, timeTick } from "./chartTheme";
import { EmptyState } from "@/components/primitives";

interface Row {
  t: number;
  level: number | null;
  /** Only populated on the two bridge/forecast rows, so the dashed line is short. */
  forecast: number | null;
  band: [number, number] | null;
  floodP: number | null;
}

export const WaterLevelChart = memo(function WaterLevelChart({
  node,
  windowMs,
  height = 300,
}: {
  node: NodeId;
  windowMs: number;
  height?: number;
}) {
  const history = useHistory();
  const version = useFrameVersion();

  const ai = useRealtime((s) => s.state?.flood_ai ?? null);
  const aiNode = ai?.nodes?.[node];
  const scored = isScored(aiNode) ? aiNode : null;

  // Wall-clock distance to the model's horizon. Under demo time compression the
  // +30 min horizon lands only seconds ahead, and the caption says as much.
  const horizonMin = ai?.model?.horizon_minutes ?? 30;
  const ratio = ai?.cadence?.time_compressed ? (ai.cadence.compression_ratio || 1) : 1;
  const horizonMs = (horizonMin * 60_000) / ratio;

  const { rows, hCrit, peak, domain, actual } = useMemo(() => {
    const samples: HistorySample[] = windowed(history.all(), windowMs);
    const observed = samples
      .map((s) => ({ t: s.t, level: s.levelM[node] ?? null, floodP: s.floodP[node] ?? null }))
      .filter((r) => r.level !== null || r.floodP !== null);

    const base: Row[] = observed.map((r) => ({
      t: r.t,
      level: r.level,
      forecast: null,
      band: null,
      floodP: r.floodP,
    }));

    const critical = scored?.h_crit_m ?? null;

    // Peak of the observed window — annotated because operators look for it.
    let peakPoint: { t: number; level: number } | null = null;
    for (const r of observed) {
      if (r.level === null) continue;
      if (!peakPoint || r.level > peakPoint.level) peakPoint = { t: r.t, level: r.level };
    }

    // Replay only: the real level at the forecast horizon, from the dataset's
    // own label, placed where the forecast lands so the two can be compared.
    let actualPoint: { t: number; level: number } | null = null;

    if (scored && base.length) {
      const last = base[base.length - 1];
      // Bridge row: pins the dashed forecast to the end of the observed line
      // so the two read as one continuous story rather than two floating series.
      last.forecast = scored.level_m;
      last.band = [scored.level_m, scored.level_m];
      base.push({
        t: last.t + horizonMs,
        level: null,
        forecast: scored.forecast.q50_m,
        band: [scored.forecast.q10_m, scored.forecast.q90_m],
        floodP: null,
      });
      if (scored.replay) actualPoint = { t: last.t + horizonMs, level: scored.replay.truth.level_m };
    }

    const values: number[] = [];
    for (const r of base) {
      if (r.level !== null) values.push(r.level);
      if (r.forecast !== null) values.push(r.forecast);
      if (r.band) values.push(r.band[0], r.band[1]);
    }
    if (critical !== null) values.push(critical);
    if (actualPoint) values.push(actualPoint.level);

    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 1;
    const pad = Math.max(0.05, (hi - lo) * 0.18);

    return {
      rows: base,
      hCrit: critical,
      peak: peakPoint,
      actual: actualPoint,
      domain: [Number((lo - pad).toFixed(2)), Number((hi + pad).toFixed(2))] as [number, number],
    };
    // `version` is the dependency that matters: it changes once per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, windowMs, node, history, horizonMs, scored?.level_m, scored?.h_crit_m,
      scored?.replay?.truth?.level_m]);

  if (!rows.length) {
    return (
      <EmptyState
        title={ai?.available === false ? "Flood AI offline" : "Awaiting model window"}
        detail={
          ai?.available === false
            ? ai?.reason ?? "The controller reports no flood model, so no level forecast is produced."
            : "The GRU needs " +
              (ai?.model?.lag_steps ? ai.model.lag_steps + 1 : 9) +
              " model steps before it can score. Observed level appears as soon as the window fills."
        }
      />
    );
  }

  const alertLine = hCrit !== null ? hCrit * 0.9 : null;

  return (
    <div>
      <div style={{ height }}>
        {/* The right margin is reserved for the reference-line annotations
            ("FLOOD LINE 1.41m", "ALERT 90%"). They are drawn outside the plot
            area, so too small a margin clips them. */}
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 108, bottom: 4, left: 4 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={timeTick}
              minTickGap={56}
              {...axisProps}
            />
            <YAxis
              domain={domain}
              width={46}
              tickFormatter={(v: number) => v.toFixed(2)}
              {...axisProps}
            />

            {/* Forecast uncertainty first, so lines sit above the band. */}
            <Area
              dataKey="band"
              stroke="none"
              fill={CHART.band}
              isAnimationActive={false}
              connectNulls
              activeDot={false}
            />

            {hCrit !== null && (
              <ReferenceLine
                y={hCrit}
                stroke={CHART.crit}
                strokeDasharray="5 3"
                strokeWidth={1}
                label={{
                  value: "FLOOD LINE " + num(hCrit, 2) + "m",
                  position: "right",
                  fill: CHART.crit,
                  fontSize: 9,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            )}
            {alertLine !== null && (
              <ReferenceLine
                y={alertLine}
                stroke={CHART.warn}
                strokeDasharray="2 4"
                strokeWidth={1}
                label={{
                  value: "ALERT 90%",
                  position: "right",
                  fill: CHART.warn,
                  fontSize: 9,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            )}

            <Line
              dataKey="level"
              stroke={CHART.accent}
              strokeWidth={1.6}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
              name="Observed level"
            />
            <Line
              dataKey="forecast"
              stroke={CHART.accent}
              strokeWidth={1.4}
              strokeDasharray="4 3"
              dot={{ r: 2.5, fill: CHART.accent, stroke: "none" }}
              isAnimationActive={false}
              connectNulls
              name="Forecast median"
            />

            {peak && (
              <ReferenceDot
                x={peak.t}
                y={peak.level}
                r={2.5}
                fill="none"
                stroke={CHART.tick}
                strokeWidth={1}
                label={{
                  value: "PEAK " + num(peak.level, 2),
                  position: "top",
                  fill: CHART.tick,
                  fontSize: 9,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            )}

            {actual && (
              <ReferenceDot
                x={actual.t}
                y={actual.level}
                r={4}
                fill={CHART.ok}
                stroke="#080A0D"
                strokeWidth={1.5}
                label={{
                  value: "ACTUAL " + num(actual.level, 2),
                  position: "left",
                  fill: CHART.ok,
                  fontSize: 9,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            )}

            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Row;
                const isForecast = row.level === null && row.forecast !== null;
                const rowsOut = [];
                if (row.level !== null) {
                  rowsOut.push({
                    label: "Level",
                    value: num(row.level, 3) + " m",
                    color: CHART.accent,
                  });
                }
                if (isForecast && row.band) {
                  rowsOut.push(
                    { label: "q50", value: num(row.forecast, 3) + " m", color: CHART.accent },
                    { label: "q10", value: num(row.band[0], 3) + " m", muted: true },
                    { label: "q90", value: num(row.band[1], 3) + " m", muted: true },
                  );
                  if (actual) {
                    rowsOut.push({ label: "Actual", value: num(actual.level, 3) + " m", color: CHART.ok });
                  }
                }
                if (row.floodP !== null) {
                  rowsOut.push({ label: "P(flood)", value: prob(row.floodP, 2) });
                }
                if (hCrit !== null) {
                  rowsOut.push({ label: "Flood line", value: num(hCrit, 2) + " m", muted: true });
                }
                return (
                  <TelemetryTooltip
                    title={timeTick(Number(label))}
                    subtitle={
                      isForecast
                        ? "FORECAST +" + horizonMin + " MIN (MODEL HORIZON)"
                        : node + " OBSERVED"
                    }
                    rows={rowsOut}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2">
        <ChartLegend
          items={[
            { label: "Observed level", color: CHART.accent },
            { label: "Forecast q50", color: CHART.accent, dashed: true },
            { label: "q10–q90 band", color: CHART.accent, area: true },
            { label: "Flood line", color: CHART.crit, dashed: true },
            { label: "Alert 90%", color: CHART.warn, dashed: true },
            ...(actual ? [{ label: "Actual +" + horizonMin + " min (gauge)", color: CHART.ok }] : []),
          ]}
        />
        {ai?.cadence?.time_compressed && (
          <span
            className="font-mono text-2xs text-ink-ghost"
            title={
              ai.source === "replay"
                ? "Each real " + ai.cadence.model_step_minutes + "-minute gauge row is played for " +
                  ai.cadence.live_seconds_per_model_step + " s of wall clock."
                : "The GRU steps every " + ai.cadence.model_step_minutes +
                  " model-minutes. Live telemetry arrives every ~2 s, so one model step is " +
                  "committed every " + ai.cadence.live_seconds_per_model_step + " s of wall clock."
            }
          >
            {ai.source === "replay" ? "REAL ROWS PLAYED AT " : "TIME-COMPRESSED DEMO CADENCE · "}
            {ai.cadence.compression_ratio.toFixed(0)}× · +{horizonMin} MIN HORIZON PLOTTED AT{" "}
            {(horizonMs / 1000).toFixed(0)}s
          </span>
        )}
      </div>
    </div>
  );
});
