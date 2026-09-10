/**
 * Formatting helpers.
 *
 * House rule, enforced here rather than at each call site: a value that the
 * controller did not send renders as an em dash, never as 0. `num()` returns
 * the dash for null/undefined/NaN, so a missing PDR can never be mistaken for
 * a measured 0 %.
 */
export const DASH = "—";

export function num(
  v: number | null | undefined,
  digits = 1,
  suffix = "",
): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  return v.toFixed(digits) + suffix;
}

export function pct(v: number | null | undefined, digits = 1): string {
  return num(v, digits, "%");
}

/** 0..1 probability -> percentage string. */
export function prob(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  return (v * 100).toFixed(digits) + "%";
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return DASH;
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/** Wall-clock HH:MM:SS from unix seconds — the timeline's time base. */
export function clock(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return DASH;
  const d = new Date(unixSeconds * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** Elapsed seconds -> HH:MM:SS, for uptime. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return DASH;
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h, m, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "1.8s" / "12.4s" — how long since a value last changed. */
export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return DASH;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Render a controller route (trailing G stripped) the way an operator reads it. */
export function routePath(route: string[]): string {
  return [...route, "G"].join(" → ");
}

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");
