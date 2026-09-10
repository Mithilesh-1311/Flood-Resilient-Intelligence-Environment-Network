/**
 * Generic rolling line chart over the shared history buffer.
 *
 * Every secondary trend in the app (flood probability, mesh health, mean PDR,
 * temperature, humidity) is this component with a different accessor, so they
 * all share one axis treatment, one tooltip and one update path. Like the
 * primary chart it appends rather than redraws: the window slides, nothing
 * resets.
 */
import { memo, useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useFrameVersion, useHistory } from "@/realtime/RealtimeProvider";
import { windowed, type HistorySample } from "@/realtime/history";
import { CHART, ChartLegend, TelemetryTooltip, axisProps, gridProps, timeTick } from "./chartTheme";
import { EmptyState } from "@/components/primitives";

export interface SeriesSpec {
  key: string;
  label: string;
  color: string;
  /** Pull this series' value out of one history sample. null = gap, not zero. */
  accessor: (s: HistorySample) => number | null;
  dashed?: boolean;
  width?: number;
}

export interface ReferenceMark {
  y: number;
  label: string;
  color: string;
}

export const LiveChart = memo(function LiveChart({
  series,
  windowMs,
  height = 150,
  domain,
  unit = "",
  digits = 1,
  references = [],
  showLegend = true,
  emptyTitle = "No data yet",
  emptyDetail,
}: {
  series: SeriesSpec[];
  windowMs: number;
  height?: number;
  /** Fixed domain (e.g. [0,100] for percentages); omit to auto-fit. */
  domain?: [number, number];
  unit?: string;
  digits?: number;
  references?: ReferenceMark[];
  showLegend?: boolean;
  emptyTitle?: string;
  emptyDetail?: string;
}) {
  const history = useHistory();
  const version = useFrameVersion();

  const { rows, computed } = useMemo(() => {
    const samples = windowed(history.all(), windowMs);
    const out = samples.map((s) => {
      const row: Record<string, number | null> = { t: s.t };
      for (const spec of series) row[spec.key] = spec.accessor(s);
      return row;
    });

    // Auto-fit only over values that exist; a gap must not pull the axis to 0.
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of out) {
      for (const spec of series) {
        const v = row[spec.key];
        if (typeof v === "number") {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    for (const r of references) {
      lo = Math.min(lo, r.y);
      hi = Math.max(hi, r.y);
    }
    if (!Number.isFinite(lo)) return { rows: out, computed: [0, 1] as [number, number] };
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.02, 0.01);
    return {
      rows: out,
      computed: [lo - pad, hi + pad] as [number, number],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, windowMs, history, series, references]);

  const hasAny = rows.some((r) => series.some((s) => typeof r[s.key] === "number"));
  if (!hasAny) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Right margin keeps the final x-axis tick from being clipped. */}
          <LineChart data={rows} margin={{ top: 6, right: 18, bottom: 2, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={timeTick}
              minTickGap={52}
              {...axisProps}
            />
            <YAxis
              domain={domain ?? computed}
              width={40}
              tickFormatter={(v: number) => v.toFixed(digits === 0 ? 0 : Math.min(digits, 2))}
              {...axisProps}
            />
            {references.map((r) => (
              <ReferenceLine
                key={r.label}
                y={r.y}
                stroke={r.color}
                strokeDasharray="4 3"
                strokeWidth={1}
                label={{
                  value: r.label,
                  position: "insideTopRight",
                  fill: r.color,
                  fontSize: 9,
                  fontFamily: "JetBrains Mono, monospace",
                }}
              />
            ))}
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={s.width ?? 1.5}
                strokeDasharray={s.dashed ? "4 3" : undefined}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
                name={s.label}
              />
            ))}
            <Tooltip
              cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
              isAnimationActive={false}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload as Record<string, number | null>;
                return (
                  <TelemetryTooltip
                    title={timeTick(Number(label))}
                    rows={series.map((s) => ({
                      label: s.label,
                      color: s.color,
                      value:
                        typeof row[s.key] === "number"
                          ? (row[s.key] as number).toFixed(digits) + unit
                          : "—",
                    }))}
                  />
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {showLegend && series.length > 1 && (
        <div className="mt-1.5 border-t border-line-soft pt-1.5">
          <ChartLegend
            items={series.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))}
          />
        </div>
      )}
    </div>
  );
});
