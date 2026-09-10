/**
 * Incident rail and event timeline.
 *
 * Both read the same event list, which is produced only by diffing consecutive
 * controller frames (see realtime/events.ts). If the network is quiet, this
 * panel is quiet - there is no filler traffic.
 *
 * Every entry answers WHAT (title), WHERE (the node or link), WHY and the
 * resulting state (detail).
 */
import { memo, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Bell, CheckCircle2, GitBranch, Info, Radio, BrainCircuit } from "lucide-react";
import { useRealtime } from "@/realtime/RealtimeProvider";
import type { AlertEvent, EventCategory, EventSeverity } from "@/realtime/events";
import { EmptyState, Panel, Segmented, Tag } from "@/components/primitives";
import { clock, cx } from "@/lib/format";

const SEVERITY_STYLE: Record<EventSeverity, { text: string; border: string; tone: "ok" | "warn" | "crit" | "neutral" }> = {
  info: { text: "text-ink-dim", border: "border-l-off", tone: "neutral" },
  warning: { text: "text-warn", border: "border-l-warn", tone: "warn" },
  critical: { text: "text-crit", border: "border-l-crit", tone: "crit" },
  recovery: { text: "text-ok", border: "border-l-ok", tone: "ok" },
};

const CATEGORY_ICON: Record<EventCategory, typeof Info> = {
  SYSTEM: Info,
  NETWORK: Radio,
  ROUTING: GitBranch,
  AI: BrainCircuit,
  SENSOR: Bell,
  RECOVERY: CheckCircle2,
};

function EventRow({ event, dense = false }: { event: AlertEvent; dense?: boolean }) {
  const style = SEVERITY_STYLE[event.severity];
  const Icon = event.severity === "critical" ? AlertTriangle : CATEGORY_ICON[event.category];

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className={cx("border-l-2 border-b border-b-line-soft bg-base-800/40 px-2.5 py-2", style.border)}
    >
      <div className="flex items-start gap-2">
        <Icon size={12} strokeWidth={1.9} className={cx("mt-0.5 shrink-0", style.text)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cx("truncate text-xs font-medium", style.text)}>{event.title}</span>
            <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-ghost">
              {clock(event.controllerT)}
            </span>
          </div>
          {!dense && (
            <p className="mt-0.5 break-words font-mono text-2xs leading-relaxed text-ink-faint">
              {event.detail}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Tag tone={style.tone}>{event.category}</Tag>
            {event.where && (
              <span className="font-mono text-2xs text-ink-ghost">{event.where}</span>
            )}
          </div>
        </div>
      </div>
    </motion.li>
  );
}

type Filter = "ALL" | "CRITICAL" | "NETWORK" | "AI";

export const AlertRail = memo(function AlertRail({ className }: { className?: string }) {
  const events = useRealtime((s) => s.events);
  const [filter, setFilter] = useState<Filter>("ALL");

  const shown = useMemo(() => {
    const list =
      filter === "ALL"
        ? events
        : filter === "CRITICAL"
          ? events.filter((e) => e.severity === "critical")
          : filter === "NETWORK"
            ? events.filter((e) => e.category === "NETWORK" || e.category === "ROUTING")
            : events.filter((e) => e.category === "AI");
    return list.slice(0, 60);
  }, [events, filter]);

  const criticalCount = events.filter((e) => e.severity === "critical").length;

  return (
    <Panel
      title="Alert centre"
      subtitle="Derived from controller state transitions"
      className={className}
      right={
        <div className="flex items-center gap-2">
          {criticalCount > 0 && <Tag tone="crit">{criticalCount} CRITICAL</Tag>}
          <Segmented
            ariaLabel="Filter events"
            value={filter}
            onChange={setFilter}
            options={[
              { label: "ALL", value: "ALL" },
              { label: "CRIT", value: "CRITICAL" },
              { label: "NET", value: "NETWORK" },
              { label: "AI", value: "AI" },
            ]}
          />
        </div>
      }
      bodyClassName="overflow-y-auto"
    >
      {shown.length === 0 ? (
        <EmptyState
          title="No events"
          detail={
            events.length === 0
              ? "Events appear when the controller's state actually changes — a reroute, a health crossing, a link degrading, a flood-probability move."
              : "No events match this filter."
          }
        />
      ) : (
        <ul>
          <AnimatePresence initial={false}>
            {shown.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </AnimatePresence>
        </ul>
      )}
    </Panel>
  );
});

/** Compact chronological strip - the same events, read as a sequence. */
export const EventTimeline = memo(function EventTimeline({
  limit = 40,
  className,
}: {
  limit?: number;
  className?: string;
}) {
  const events = useRealtime((s) => s.events);
  const shown = events.slice(0, limit);

  return (
    <Panel
      title="Live event timeline"
      subtitle="Newest first · controller clock"
      className={className}
      bodyClassName="overflow-y-auto"
    >
      {shown.length === 0 ? (
        <EmptyState title="Timeline empty" detail="Waiting for the first state change." />
      ) : (
        <ol className="p-2">
          <AnimatePresence initial={false}>
            {shown.map((e) => {
              const style = SEVERITY_STYLE[e.severity];
              return (
                <motion.li
                  key={e.id}
                  layout="position"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="relative flex gap-2.5 pb-2.5 pl-3"
                >
                  {/* Spine + node marker */}
                  <span className="absolute left-0 top-1.5 h-full w-px bg-line" aria-hidden />
                  <span
                    className={cx(
                      "absolute left-[-2.5px] top-1.5 h-1.5 w-1.5 rounded-full",
                      e.severity === "critical"
                        ? "bg-crit"
                        : e.severity === "warning"
                          ? "bg-warn"
                          : e.severity === "recovery"
                            ? "bg-ok"
                            : "bg-off",
                    )}
                    aria-hidden
                  />
                  <time className="shrink-0 font-mono text-2xs tabular-nums text-ink-ghost">
                    {clock(e.controllerT)}
                  </time>
                  <span className={cx("min-w-0 flex-1 text-2xs leading-relaxed", style.text)}>
                    {e.title}
                    {e.where && <span className="text-ink-ghost"> · {e.where}</span>}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      )}
    </Panel>
  );
});
