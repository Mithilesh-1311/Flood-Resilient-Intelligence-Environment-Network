/**
 * Small page-level helpers shared by every module: the header rule, the
 * time-window control, and the initialising gate every module shows before the
 * first controller frame arrives.
 */
import { useState, type ReactNode } from "react";
import { Segmented } from "@/components/primitives";
import { TIME_WINDOWS } from "@/lib/constants";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { EmptyState } from "@/components/primitives";
import { CONTROLLER_LABEL, CONTROLLER_ORIGIN } from "@/lib/config";

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
      <div>
        <h1 className="text-sm font-semibold uppercase tracking-[0.14em] text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-2xs text-ink-ghost">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** Window labels come from TIME_WINDOWS; widened so any of them is a valid initial value. */
export type TimeWindowLabel = (typeof TIME_WINDOWS)[number]["label"];

export function useTimeWindow(initial: TimeWindowLabel = TIME_WINDOWS[0].label) {
  const [label, setLabel] = useState<string>(initial);
  const ms = TIME_WINDOWS.find((w) => w.label === label)?.ms ?? TIME_WINDOWS[0].ms;
  return { label, setLabel, ms };
}

export function TimeWindowControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Segmented
      ariaLabel="Chart time window"
      value={value}
      onChange={onChange}
      options={TIME_WINDOWS.map((w) => ({ label: w.label, value: w.label }))}
    />
  );
}

/**
 * Gate shown until the first frame lands. Distinguishes "still connecting"
 * from "the controller is not reachable", because those need different fixes.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const { hasState, link, error } = useRealtime(
    (s) => ({ hasState: !!s.state, link: s.link, error: s.connectError }),
    shallowEqual,
  );

  if (hasState) return <>{children}</>;

  const reconnecting = link === "reconnecting" || link === "offline";

  // A hosted controller and a local one fail for different reasons, so they get
  // different advice: the hosted one is usually waking from free-tier sleep.
  const unreachable = CONTROLLER_ORIGIN
    ? "No response from the FRiEND controller at " + CONTROLLER_LABEL + ". A free-tier host " +
      "sleeps when idle and can take a minute or two to wake. This view keeps retrying and " +
      "will populate on its own."
    : "No response from the FRiEND controller. Start it with `python simulate_hardware.py` " +
      "(simulated field) or `python nc1.py` (real gateway), then this view will populate on " +
      "its own — the dashboard keeps retrying.";

  return (
    <div className="panel">
      <EmptyState
        title={reconnecting ? "Controller unreachable" : "Initialising"}
        detail={
          reconnecting
            ? unreachable + (error ? "  Last socket error: " + error : "")
            : "Opening the WebSocket and requesting the first state snapshot from " +
              CONTROLLER_LABEL + "."
        }
      />
    </div>
  );
}
