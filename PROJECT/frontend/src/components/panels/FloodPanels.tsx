/**
 * Flood-Risk AI.
 *
 * Two panels that must never be confused with one another:
 *
 *   FloodRiskPanel   LIVE TELEMETRY - what the model is saying right now about
 *                    the actual field nodes. Changes every cycle.
 *   ModelEvaluation  MODEL EVALUATION - POD/FAR/CSI/lead time measured offline
 *                    on held-out data (models/metrics.json, onset_metrics.json).
 *                    These are fixed properties of the trained model and say
 *                    nothing about the health of the running system.
 *
 * They are visually distinct and explicitly captioned, because presenting an
 * offline CSI as a live gauge would be a lie about what the system knows.
 */
import { memo } from "react";
import { BrainCircuit, FlaskConical, TriangleAlert } from "lucide-react";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { isScored, type NodeId, type SplitMetrics } from "@/types/friend";
import { EmptyState, KeyValue, NoData, Panel, Readout, StatusDot, Tag, Bar } from "@/components/primitives";
import { SOURCE_NODES } from "@/lib/constants";
import { cx, num, prob } from "@/lib/format";

/* ------------------------------------------------------------- live panel */

export const FloodRiskPanel = memo(function FloodRiskPanel({
  node,
  className,
}: {
  node: NodeId;
  className?: string;
}) {
  const d = useRealtime((s) => {
    const ai = s.state?.flood_ai;
    const n = ai?.nodes?.[node];
    return {
      available: ai?.available ?? false,
      reason: ai?.reason ?? null,
      status: ai?.status ?? "not_loaded",
      threshold: ai?.model?.threshold ?? null,
      horizon: ai?.model?.horizon_minutes ?? 30,
      mc: ai?.model?.mc_samples ?? null,
      quantiles: ai?.model?.quantiles ?? [0.1, 0.5, 0.9],
      inferenceMs: ai?.model?.inference_ms ?? null,
      architecture: ai?.model?.architecture ?? null,
      node: n ?? null,
    };
  }, shallowEqual);

  if (!d.available) {
    return (
      <Panel title="Flood-Risk AI" subtitle="GRU · MC-Dropout" className={className}>
        <EmptyState
          icon={<TriangleAlert size={18} strokeWidth={1.5} />}
          title={d.status === "loading" ? "Model loading" : "Model unavailable"}
          detail={
            d.status === "loading"
              ? "The controller is deserialising flood_gru.keras on a worker thread."
              : d.reason ??
                "The controller reports no flood model. No probability, forecast or confidence is being produced — nothing is substituted in its place."
          }
        />
      </Panel>
    );
  }

  const n = d.node;
  if (!isScored(n)) {
    const pending = n && "steps_required" in n ? n : null;
    return (
      <Panel title={"Flood-Risk AI · " + node} subtitle="GRU · MC-Dropout" className={className}>
        <EmptyState
          title={pending?.status === "no_data" ? "No telemetry from " + node : "Filling model window"}
          detail={
            pending
              ? pending.status === "no_data"
                ? "The controller has received no readings from this source node, so the model has nothing to score."
                : "Collected " + pending.model_steps + " of " + pending.steps_required +
                  " model steps. The GRU reads an 8-step window plus the current step before it will score."
              : undefined
          }
        />
      </Panel>
    );
  }

  const alarm = n.alarm;
  const tone = alarm ? "crit" : d.threshold !== null && n.flood_probability >= d.threshold * 0.6 ? "warn" : "ok";
  const bandWidth = n.forecast.q90_m - n.forecast.q10_m;

  return (
    <Panel
      title={"Flood-Risk AI · " + node}
      subtitle={n.station.replace(/_/g, " ")}
      className={className}
      right={
        <div className="flex items-center gap-1.5">
          <Tag tone="accent">LIVE TELEMETRY</Tag>
          {alarm && <Tag tone="crit">ALARM</Tag>}
        </div>
      }
    >
      <div className="grid gap-3 p-3 lg:grid-cols-[1.1fr_1fr]">
        {/* Probability + confidence */}
        <div>
          <p className="eyebrow mb-1.5">
            P(flood within +{d.horizon} min)
          </p>
          <div className="flex items-end gap-3">
            <Readout size="xl" value={prob(n.flood_probability, 1)} tone={tone} />
            <div className="pb-1.5">
              <div className="font-mono text-2xs text-ink-faint">
                ± {num(n.uncertainty, 4)}
              </div>
              <div className="text-2xs text-ink-ghost">MC-DROPOUT σ</div>
            </div>
          </div>

          <div className="mt-2">
            <Bar value={n.flood_probability * 100} severity={tone} />
            {d.threshold !== null && (
              <div className="relative mt-1 h-3">
                {/* Alarm threshold marker, positioned on the same scale. */}
                <span
                  className="absolute top-0 h-2 w-px bg-crit"
                  style={{ left: d.threshold * 100 + "%" }}
                  aria-hidden
                />
                <span
                  className="absolute top-0 -translate-x-1/2 font-mono text-2xs text-crit"
                  style={{ left: d.threshold * 100 + "%", marginTop: 3 }}
                >
                  ALARM {prob(d.threshold, 0)}
                </span>
              </div>
            )}
          </div>

          <dl className="mt-4">
            <KeyValue k="Observed level">{num(n.level_m, 3)} m</KeyValue>
            <KeyValue k="Flood line (h_crit)">{num(n.h_crit_m, 3)} m</KeyValue>
            <KeyValue k="Level / flood line">
              <span className={cx(n.level_norm >= 1 && "text-crit")}>{num(n.level_norm, 3)}</span>
            </KeyValue>
            <KeyValue k="Model steps collected">{n.model_steps}</KeyValue>
          </dl>
        </div>

        {/* Quantile forecast */}
        <div>
          <p className="eyebrow mb-1.5">Water-level forecast +{d.horizon} min</p>

          <div className="space-y-1.5">
            {[
              { q: d.quantiles[2], label: "q90", v: n.forecast.q90_m, norm: n.forecast.q90_norm, dim: true },
              { q: d.quantiles[1], label: "q50", v: n.forecast.q50_m, norm: n.forecast.q50_norm, dim: false },
              { q: d.quantiles[0], label: "q10", v: n.forecast.q10_m, norm: n.forecast.q10_norm, dim: true },
            ].map((row) => (
              <div
                key={row.label}
                className={cx(
                  "flex items-baseline justify-between border px-2 py-1.5",
                  row.dim ? "border-line bg-base-700/40" : "border-accent/40 bg-accent/[0.06]",
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span
                    className={cx(
                      "font-mono text-2xs uppercase tracking-[0.1em]",
                      row.dim ? "text-ink-faint" : "text-accent",
                    )}
                  >
                    {row.label}
                  </span>
                  <span className="text-2xs text-ink-ghost">
                    {(row.q * 100).toFixed(0)}th pct
                  </span>
                </span>
                <span className="flex items-baseline gap-2">
                  <span
                    className={cx(
                      "font-mono text-sm tabular-nums",
                      row.dim ? "text-ink-dim" : "text-ink",
                    )}
                  >
                    {num(row.v, 3)} m
                  </span>
                  <span className="w-12 text-right font-mono text-2xs text-ink-ghost">
                    ×{num(row.norm, 2)}
                  </span>
                </span>
              </div>
            ))}
          </div>

          <dl className="mt-3">
            <KeyValue k="Band width (q90−q10)">{num(bandWidth, 3)} m</KeyValue>
            <KeyValue k="Inference">{d.inferenceMs === null ? <NoData /> : num(d.inferenceMs, 1) + " ms"}</KeyValue>
            <KeyValue k="MC passes">{d.mc ?? <NoData />}</KeyValue>
          </dl>

          {d.architecture && (
            <p className="mt-3 border-t border-line-soft pt-2 font-mono text-2xs leading-relaxed text-ink-ghost">
              {d.architecture}
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
});

/* --------------------------------------------------------- node summary */

export const FloodNodeGrid = memo(function FloodNodeGrid({
  selected,
  onSelect,
  className,
}: {
  selected: NodeId;
  onSelect: (n: NodeId) => void;
  className?: string;
}) {
  const rows = useRealtime((s) => {
    const ai = s.state?.flood_ai;
    return SOURCE_NODES.map((id) => {
      const n = ai?.nodes?.[id];
      return {
        id,
        scored: isScored(n),
        p: isScored(n) ? n.flood_probability : null,
        u: isScored(n) ? n.uncertainty : null,
        level: isScored(n) ? n.level_m : null,
        alarm: isScored(n) ? n.alarm : false,
        station: n?.station ?? null,
      };
    });
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  return (
    <Panel title="Per-source risk" subtitle="Live model output" className={className}>
      <ul className="divide-y divide-line-soft">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r.id)}
              aria-pressed={selected === r.id}
              className={cx(
                "flex w-full items-center gap-3 px-2.5 py-2 text-left transition-colors duration-150",
                selected === r.id ? "bg-accent/[0.07]" : "hover:bg-base-700/40",
              )}
            >
              <StatusDot severity={!r.scored ? "off" : r.alarm ? "crit" : "ok"} />
              <span className="w-7 font-mono text-xs font-semibold text-ink">{r.id}</span>
              <span className="min-w-0 flex-1 truncate text-2xs text-ink-ghost">
                {r.station ? r.station.replace(/_/g, " ") : "—"}
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={cx(
                    "block font-mono text-sm tabular-nums",
                    r.alarm ? "text-crit" : "text-ink",
                  )}
                >
                  {r.p === null ? "—" : prob(r.p, 1)}
                </span>
                <span className="block font-mono text-2xs text-ink-ghost">
                  {r.u === null ? "NOT SCORED" : "±" + num(r.u, 3)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
});

/* -------------------------------------------------- offline evaluation */

function MetricCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-line bg-base-700/30 px-2.5 py-2" title={hint}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 font-mono text-base tabular-nums text-ink">{value}</div>
    </div>
  );
}

function SplitBlock({ title, m, caption }: { title: string; m?: SplitMetrics; caption?: string }) {
  if (!m) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="eyebrow text-ink-dim">{title}</h3>
        {caption && <span className="text-2xs text-ink-ghost">{caption}</span>}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <MetricCell label="POD" value={num(m.POD, 3)} hint="Probability of detection: hits / (hits + misses)" />
        <MetricCell label="FAR" value={num(m.FAR, 3)} hint="False alarm ratio: false alarms / (hits + false alarms)" />
        <MetricCell label="CSI" value={num(m.CSI, 3)} hint="Critical success index: hits / (hits + misses + false alarms)" />
      </div>
      <dl className="mt-2">
        <KeyValue k="Hits">{m.hits}</KeyValue>
        <KeyValue k="Misses">{m.misses}</KeyValue>
        <KeyValue k="False alarms">{m.false_alarms}</KeyValue>
        {m.band_coverage !== undefined && (
          <KeyValue k="q10–q90 coverage">{num(m.band_coverage, 3)}</KeyValue>
        )}
        {m.mean_uncertainty !== undefined && (
          <KeyValue k="Mean uncertainty">{num(m.mean_uncertainty, 4)}</KeyValue>
        )}
      </dl>
    </div>
  );
}

export const ModelEvaluationPanel = memo(function ModelEvaluationPanel({
  className,
}: {
  className?: string;
}) {
  const evalData = useRealtime((s) => s.state?.flood_ai?.evaluation ?? null, shallowEqual);
  const threshold = useRealtime((s) => s.state?.flood_ai?.model?.threshold ?? null);

  const metrics = evalData?.metrics;
  const onset = evalData?.onset;

  if (!metrics && !onset) {
    return (
      <Panel title="Model evaluation" className={className}>
        <EmptyState
          title="No evaluation data"
          detail="models/metrics.json was not readable by the controller."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Model evaluation"
      subtitle="Offline, on held-out data — NOT live system status"
      className={className}
      right={<Tag tone="warn">MODEL EVALUATION</Tag>}
    >
      <div className="border-b border-line bg-warn/[0.04] px-3 py-2">
        <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-ink-faint">
          <FlaskConical size={12} strokeWidth={1.8} className="mt-px shrink-0 text-warn" />
          <span>
            These figures were measured once, during training, against held-out validation and test
            splits. They describe the trained model's skill — not the current state of the network,
            the sensors or the live inference. Live values live in the panels marked{" "}
            <span className="font-mono text-accent">LIVE TELEMETRY</span>.
          </span>
        </p>
      </div>

      <div className="grid gap-4 p-3 lg:grid-cols-2">
        <SplitBlock title="Test split" m={metrics?.test} caption={"threshold " + num(threshold, 2)} />
        <SplitBlock title="Validation split" m={metrics?.validation} />
      </div>

      {onset && (
        <div className="border-t border-line p-3">
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="eyebrow text-ink-dim">Onset performance</h3>
            <span className="text-2xs text-ink-ghost">
              rows below the flood line that are about to cross — the hard case
            </span>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid grid-cols-3 gap-1.5">
              <MetricCell label="POD" value={num(onset.onset_rows.POD, 3)} />
              <MetricCell label="FAR" value={num(onset.onset_rows.FAR, 3)} />
              <MetricCell label="CSI" value={num(onset.onset_rows.CSI, 3)} />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <MetricCell
                label="Event POD"
                value={num(onset.events.event_POD, 3)}
                hint="Fraction of distinct flood events caught at least once"
              />
              <MetricCell
                label="Lead median"
                value={num(onset.events.lead_time_median_min, 0) + " min"}
                hint="Median warning time before the flood line is crossed"
              />
              <MetricCell
                label="Lead max"
                value={num(onset.events.lead_time_max_min, 0) + " min"}
              />
            </div>
          </div>
          <dl className="mt-2 grid gap-x-6 md:grid-cols-2">
            <KeyValue k="Events">{onset.events.events}</KeyValue>
            <KeyValue k="Caught">{onset.events.caught}</KeyValue>
            <KeyValue k="Missed">{onset.events.missed}</KeyValue>
            <KeyValue k="False alarm episodes">{onset.events.false_alarm_episodes}</KeyValue>
            <KeyValue k="Mean lead time">{num(onset.events.lead_time_mean_min, 1)} min</KeyValue>
            <KeyValue k="Onset rows scored">{onset.onset_rows.rows.toLocaleString()}</KeyValue>
          </dl>
        </div>
      )}

      {metrics?.test_per_station && (
        <div className="border-t border-line p-3">
          <h3 className="eyebrow mb-2 text-ink-dim">Test split, per station</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse">
              <thead className="border-b border-line">
                <tr>
                  <th className="th">STATION</th>
                  <th className="th w-16 text-right">POD</th>
                  <th className="th w-16 text-right">FAR</th>
                  <th className="th w-16 text-right">CSI</th>
                  <th className="th w-20 text-right">HITS</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.test_per_station).map(([station, m]) => (
                  <tr key={station} className="border-b border-line-soft last:border-0">
                    <td className="cell text-ink-dim">{station.replace(/_/g, " ")}</td>
                    <td className="cell text-right">{num(m.POD, 3)}</td>
                    <td className="cell text-right">{num(m.FAR, 3)}</td>
                    <td className="cell text-right">{num(m.CSI, 3)}</td>
                    <td className="cell text-right text-ink-faint">{m.hits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
});

/** Compact model identity card. */
export const ModelIdentity = memo(function ModelIdentity({ className }: { className?: string }) {
  const m = useRealtime((s) => {
    const ai = s.state?.flood_ai;
    return {
      available: ai?.available ?? false,
      file: ai?.model?.file ?? null,
      horizon: ai?.model?.horizon_minutes ?? null,
      lag: ai?.model?.lag_steps ?? null,
      step: ai?.model?.step_minutes ?? null,
      mc: ai?.model?.mc_samples ?? null,
      threshold: ai?.model?.threshold ?? null,
      tunedOn: ai?.model?.threshold_tuned_on ?? null,
      quantiles: ai?.model?.quantiles?.join(" / ") ?? null,
      compressed: ai?.cadence?.time_compressed ?? false,
      ratio: ai?.cadence?.compression_ratio ?? null,
      liveStep: ai?.cadence?.live_seconds_per_model_step ?? null,
    };
  }, shallowEqual);

  return (
    <Panel
      title="Model"
      subtitle="Flood-Risk AI configuration"
      className={className}
      right={
        <span className="flex items-center gap-1.5">
          <BrainCircuit size={12} strokeWidth={1.8} className={m.available ? "text-ok" : "text-off"} />
          <Tag tone={m.available ? "ok" : "off"}>{m.available ? "LOADED" : "OFFLINE"}</Tag>
        </span>
      }
    >
      <dl className="p-2.5">
        <KeyValue k="Artifact">{m.file ?? <NoData />}</KeyValue>
        <KeyValue k="Forecast horizon">{m.horizon === null ? <NoData /> : "+" + m.horizon + " min"}</KeyValue>
        <KeyValue k="Input window">
          {m.lag === null || m.step === null ? <NoData /> : m.lag + " × " + m.step + " min"}
        </KeyValue>
        <KeyValue k="Quantiles">{m.quantiles ?? <NoData />}</KeyValue>
        <KeyValue k="MC-Dropout passes">{m.mc ?? <NoData />}</KeyValue>
        <KeyValue k="Alarm threshold">{m.threshold === null ? <NoData /> : prob(m.threshold, 0)}</KeyValue>
        <KeyValue k="Threshold tuned on">
          <span className="text-ink-faint">{m.tunedOn ?? "—"}</span>
        </KeyValue>
      </dl>

      {m.compressed && (
        <div className="border-t border-line bg-warn/[0.04] px-2.5 py-2">
          <Tag tone="warn">TIME-COMPRESSED</Tag>
          <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
            The GRU steps every {m.step} model-minutes. Live telemetry arrives every ~2 s, so the
            controller commits one model step per {m.liveStep} s of wall clock — a{" "}
            <span className="font-mono text-ink-dim">{m.ratio}×</span> compression, so the window
            fills within a demo rather than over two real hours. Forecasts remain +{m.horizon} model-minutes ahead.
          </p>
        </div>
      )}
    </Panel>
  );
});
