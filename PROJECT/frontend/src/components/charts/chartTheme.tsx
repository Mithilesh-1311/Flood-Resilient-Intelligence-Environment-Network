/**
 * Shared chart language.
 *
 * Every chart in the app draws its axes, grid, tooltip and line weights from
 * here, so the Overview sparkline and the full Flood AI panel read as parts of
 * one instrument rather than as three different libraries' defaults.
 */
import type { ReactNode } from "react";
import { clock, cx } from "@/lib/format";

export const CHART = {
  grid: "#161D24",
  axis: "#2A333D",
  tick: "#6B7784",
  accent: "#3FA7D6",
  ok: "#3FB27F",
  warn: "#D9A441",
  crit: "#D9534F",
  muted: "#5A6472",
  band: "rgba(63,167,214,0.12)",
  fontSize: 10,
} as const;

/** Axis props shared by every chart. Spread, never re-specified per chart. */
export const axisProps = {
  stroke: CHART.axis,
  tick: { fill: CHART.tick, fontSize: CHART.fontSize, fontFamily: "JetBrains Mono, monospace" },
  tickLine: false,
  axisLine: { stroke: CHART.axis },
} as const;

export const gridProps = {
  stroke: CHART.grid,
  strokeDasharray: "0",
  vertical: false,
} as const;

/** X tick formatter for the millisecond time base the history buffer uses. */
export const timeTick = (ms: number) => clock(ms / 1000);

export interface TooltipRow {
  label: string;
  value: ReactNode;
  color?: string;
  /** Rendered dimmer, for context lines like the flood line. */
  muted?: boolean;
}

/**
 * The one tooltip shell. Monospace values, exact numbers, no rounding beyond
 * what the caller asks for - this is telemetry, not a marketing chart.
 */
export function TelemetryTooltip({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle?: string;
  rows: TooltipRow[];
}) {
  return (
    <div className="border border-line-strong bg-base-900/95 px-2.5 py-2 shadow-lg backdrop-blur-sm">
      <div className="mb-1.5 border-b border-line-soft pb-1">
        <div className="font-mono text-2xs tabular-nums text-ink">{title}</div>
        {subtitle && <div className="text-2xs text-ink-ghost">{subtitle}</div>}
      </div>
      <dl className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-2xs uppercase tracking-[0.08em] text-ink-faint">
              {r.color && (
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0"
                  style={{ backgroundColor: r.color }}
                  aria-hidden
                />
              )}
              {r.label}
            </dt>
            <dd
              className={cx(
                "font-mono text-2xs tabular-nums",
                r.muted ? "text-ink-faint" : "text-ink",
              )}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Small keyed legend, used instead of Recharts' default. */
export function ChartLegend({
  items,
}: {
  items: Array<{ label: string; color: string; dashed?: boolean; area?: boolean }>;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0 w-3.5 shrink-0"
            style={{
              borderTop: (i.area ? 6 : 2) + "px " + (i.dashed ? "dashed" : "solid") + " " + i.color,
              opacity: i.area ? 0.5 : 1,
            }}
            aria-hidden
          />
          <span className="text-2xs uppercase tracking-[0.08em] text-ink-faint">{i.label}</span>
        </li>
      ))}
    </ul>
  );
}
