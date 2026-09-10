/**
 * Shared UI primitives.
 *
 * Deliberately small and unstyled-by-default: the visual language lives here
 * once, so no page invents its own panel chrome, its own status colour or its
 * own idea of what "no data" looks like.
 */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { cx, DASH } from "@/lib/format";
import { SEVERITY_HEX, type Severity } from "@/lib/constants";

/* ------------------------------------------------------------------ Panel */

export function Panel({
  title,
  subtitle,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("panel flex min-h-0 flex-col", className)}>
      {(title || right) && (
        <header className="panel-head shrink-0">
          <div className="min-w-0">
            {title && <h2 className="eyebrow truncate">{title}</h2>}
            {subtitle && (
              <p className="mt-0.5 truncate text-2xs text-ink-ghost">{subtitle}</p>
            )}
          </div>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={cx("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/* -------------------------------------------------------------- StatusDot */

export function StatusDot({
  severity,
  pulse = false,
  size = 7,
  label,
}: {
  severity: Severity;
  pulse?: boolean;
  size?: number;
  /** Screen-reader text, so state is never conveyed by colour alone. */
  label?: string;
}) {
  return (
    <span
      className={cx("inline-block shrink-0 rounded-full", pulse && "animate-pulse-dot")}
      style={{ width: size, height: size, backgroundColor: SEVERITY_HEX[severity] }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/* ------------------------------------------------------------------- Tag */

const TAG_STYLES: Record<Severity | "neutral" | "accent", string> = {
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  crit: "border-crit/40 text-crit",
  off: "border-off/40 text-off",
  neutral: "border-line-strong text-ink-dim",
  accent: "border-accent/40 text-accent",
};

export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Severity | "neutral" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 border px-1.5 py-px font-mono text-2xs uppercase tracking-[0.1em]",
        TAG_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- NoData */

/**
 * The single approved way to render an absent value. Nothing in this app is
 * allowed to substitute 0 for "not measured", so every such case routes here.
 */
export function NoData({ reason, className }: { reason?: string; className?: string }) {
  return (
    <span
      className={cx("font-mono text-ink-ghost", className)}
      title={reason ?? "No data reported by the controller"}
    >
      {DASH}
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  icon,
}: {
  title: string;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="text-ink-ghost">{icon}</div>}
      <p className="eyebrow text-ink-faint">{title}</p>
      {detail && <p className="max-w-sm text-xs leading-relaxed text-ink-ghost">{detail}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- Readout */

/**
 * A large instrument value that tints briefly when it changes.
 *
 * The flash is the only motion: the digits themselves never slide or scale,
 * because a number that moves while you are reading it is harder to read.
 */
export const Readout = memo(function Readout({
  value,
  unit,
  tone,
  size = "lg",
  className,
}: {
  value: string;
  unit?: string;
  tone?: Severity;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setFlash(true);
      const id = window.setTimeout(() => setFlash(false), 900);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [value]);

  const sizes = {
    sm: "text-base",
    md: "text-xl",
    lg: "text-[28px] leading-8",
    xl: "text-[38px] leading-10",
  } as const;

  return (
    <div
      className={cx("readout inline-flex items-baseline gap-1", flash && "animate-tick", className)}
      style={tone ? { color: SEVERITY_HEX[tone] } : undefined}
    >
      <span className={cx(sizes[size], "font-semibold")}>{value}</span>
      {unit && <span className="text-xs font-medium text-ink-faint">{unit}</span>}
    </div>
  );
});

/* ------------------------------------------------------------------ Bar */

/** A thin proportional bar. Always paired with the number it depicts. */
export function Bar({
  value,
  max = 100,
  severity = "ok",
  className,
}: {
  value: number | null;
  max?: number;
  severity?: Severity;
  className?: string;
}) {
  const pctWidth = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cx("h-1 w-full bg-base-600", className)}>
      <div
        className="h-full transition-[width] duration-500 ease-op"
        style={{ width: pctWidth + "%", backgroundColor: SEVERITY_HEX[severity] }}
      />
    </div>
  );
}

/* ------------------------------------------------------------ SegmentedControl */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex border border-line">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cx(
              "px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] transition-colors duration-150",
              active
                ? "bg-accent/15 text-accent"
                : "text-ink-faint hover:bg-base-700 hover:text-ink-dim",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ KeyValue */

export function KeyValue({
  k,
  children,
  mono = true,
}: {
  k: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1 last:border-0">
      <dt className="text-2xs uppercase tracking-[0.1em] text-ink-faint">{k}</dt>
      <dd className={cx("text-right text-xs text-ink", mono && "font-mono tabular-nums")}>
        {children}
      </dd>
    </div>
  );
}
