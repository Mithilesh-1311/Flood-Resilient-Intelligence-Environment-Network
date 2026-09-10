/**
 * Real-data replay surfaces.
 *
 * When the controller is replaying the project's labelled dataset
 * (replay_hardware.py), the river readings are real and every prediction has a
 * known outcome. These components make both of those facts visible:
 *
 *   ProvenanceTags   what is real and what is simulated, in the header
 *   ReplayStrip      which gauge, which real timestamp, which flood window
 *   TruthReadout     the model's forecast next to what the river actually did
 *   ReplayScorecard  hits / misses / false alarms over this replay session
 *
 * Outside replay mode each of them renders nothing, so the pages that use
 * them are unchanged for simulated or field telemetry.
 */
import { memo } from "react";
import { Check, X } from "lucide-react";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { isScored, type NodeId, type ReplayScore } from "@/types/friend";
import { EmptyState, KeyValue, Panel, Tag } from "@/components/primitives";
import {
  SPLIT_LABEL,
  TELEMETRY_LABEL,
  obsTime,
  provenance,
  stationName,
} from "@/lib/provenance";
import { SOURCE_NODES } from "@/lib/constants";
import { cx, num, prob } from "@/lib/format";

/* ------------------------------------------------------------ provenance */

export const ProvenanceTags = memo(function ProvenanceTags() {
  const p = useRealtime((s) => provenance(s.state), shallowEqual);
  if (!p.network) return null;

  if (p.network === "LIVE_HARDWARE") return <Tag tone="accent">LIVE HARDWARE</Tag>;
  if (p.telemetry === "REPLAY") {
    return (
      <span className="flex items-center gap-1.5">
        <Tag tone="ok">{TELEMETRY_LABEL.REPLAY}</Tag>
        <Tag tone="warn">SIMULATED MESH</Tag>
      </span>
    );
  }
  return <Tag tone="warn">SIMULATION</Tag>;
});

/** "LIVE TELEMETRY" normally; "REAL GAUGE REPLAY" when the rivers are replayed. */
export const TelemetryTag = memo(function TelemetryTag() {
  const replay = useRealtime((s) => s.state?.flood_ai?.source === "replay");
  return replay ? <Tag tone="ok">REAL GAUGE REPLAY</Tag> : <Tag tone="accent">LIVE TELEMETRY</Tag>;
});

/* ----------------------------------------------------------- replay strip */

export const ReplayStrip = memo(function ReplayStrip({ className }: { className?: string }) {
  const r = useRealtime((s) => {
    const rep = s.state?.flood_ai?.replay;
    if (!rep) return null;
    return {
      dataset: rep.dataset,
      parity: rep.parity ?? null,
      nodes: SOURCE_NODES.map((id) => ({ id, info: rep.nodes[id] ?? null })),
    };
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (!r) return null;

  return (
    <div className={cx("panel border-ok/25", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Tag tone="ok">REAL DATA</Tag>
          <span className="text-2xs text-ink-faint">
            River level, rain, temperature and humidity replayed from{" "}
            <span className="font-mono text-ink-dim">{r.dataset}</span>, 15 real minutes per step.
            The mesh network is simulated.
          </span>
        </div>
        {r.parity?.checked && (
          <span
            className={cx("font-mono text-2xs", r.parity.passed ? "text-ok" : "text-crit")}
            title="Every replayed row's model inputs and labels were compared with the arrays the model was trained and tested on."
          >
            {r.parity.passed
              ? "INPUTS VERIFIED = MODEL ARRAYS · " + (r.parity.rows ?? 0).toLocaleString() + " ROWS"
              : "INPUT PARITY FAILED"}
          </span>
        )}
      </div>
      <div className="grid gap-px bg-line md:grid-cols-3">
        {r.nodes.map(({ id, info }) => (
          <div key={id} className="bg-base-800 px-3 py-2">
            {info ? (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">{id}</span>
                  <Tag tone={info.split === "train" ? "warn" : "ok"}>
                    {SPLIT_LABEL[info.split] ?? info.split.toUpperCase()}
                  </Tag>
                </div>
                <div className="mt-1 truncate text-2xs text-ink-faint">{stationName(info.station)}</div>
                <div className="mt-1 font-mono text-sm tabular-nums text-ink">{obsTime(info.time)}</div>
                <div className="mt-0.5 font-mono text-2xs text-ink-ghost">
                  {info.kind === "flood_event" ? "FLOOD WINDOW" : "HIGHEST-WATER WINDOW"}{" "}
                  {info.window + 1}
                  {info.windows ? "/" + info.windows : ""} · ROW {info.position.toLocaleString()}
                  {info.rows ? "/" + info.rows.toLocaleString() : ""}
                </div>
              </>
            ) : (
              <>
                <span className="font-mono text-xs font-semibold text-ink">{id}</span>
                <p className="mt-1 text-2xs text-ink-ghost">Not in the replay file.</p>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

/* ----------------------------------------------------------- truth readout */

export const TruthReadout = memo(function TruthReadout({ node }: { node: NodeId }) {
  const t = useRealtime((s) => {
    const ai = s.state?.flood_ai;
    const n = ai?.nodes?.[node];
    if (!isScored(n) || !n.replay) return null;
    return {
      time: n.replay.truth ? n.replay.time : null,
      split: n.replay.split,
      truth: n.replay.truth,
      q10: n.forecast.q10_m,
      q50: n.forecast.q50_m,
      q90: n.forecast.q90_m,
      alarm: n.alarm,
      p: n.flood_probability,
      threshold: ai?.model?.threshold ?? null,
      horizon: ai?.model?.horizon_minutes ?? 30,
      rainMm: n.replay.rain_mm,
    };
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (!t) return null;

  // Outcome of the alarm decision for this row, in forecast-verification terms.
  const verdict = t.alarm
    ? t.truth.flood
      ? { label: "HIT", tone: "ok" as const }
      : { label: "FALSE ALARM", tone: "warn" as const }
    : t.truth.flood
      ? { label: "MISS", tone: "crit" as const }
      : { label: "CORRECT NEGATIVE", tone: "ok" as const };

  return (
    <div className="border border-ok/25 bg-ok/[0.03] p-2.5">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="eyebrow text-ok">What actually happened · +{t.horizon} min</span>
        <span className="font-mono text-2xs text-ink-ghost">
          GAUGE {obsTime(t.time)} · {SPLIT_LABEL[t.split] ?? t.split}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-6 md:grid-cols-4">
        <KeyValue k="Actual level">{num(t.truth.level_m, 3)} m</KeyValue>
        <KeyValue k="Forecast q50">{num(t.q50, 3)} m</KeyValue>
        <KeyValue k="Actual flood?">
          <span className={t.truth.flood ? "text-crit" : "text-ink"}>
            {t.truth.flood ? "YES" : "NO"}
          </span>
        </KeyValue>
        <KeyValue k="Inside q10–q90">
          <span className={cx("inline-flex items-center gap-1", t.truth.in_band ? "text-ok" : "text-warn")}>
            {t.truth.in_band ? <Check size={11} strokeWidth={2.4} /> : <X size={11} strokeWidth={2.4} />}
            {t.truth.in_band ? "YES" : "NO"}
          </span>
        </KeyValue>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-line-soft pt-1.5">
        <Tag tone={verdict.tone}>{verdict.label}</Tag>
        <span className="font-mono text-2xs text-ink-faint">
          P(flood) {prob(t.p, 1)} {t.alarm ? "≥" : "<"} alarm {prob(t.threshold, 0)} · band{" "}
          {num(t.q10, 3)}–{num(t.q90, 3)} m
          {t.rainMm !== null && " · rain " + num(t.rainMm, 1) + " mm / 15 min"}
        </span>
      </div>
    </div>
  );
});

/* -------------------------------------------------------------- scorecard */

function ScoreRow({ label, s, sub }: { label: string; s: ReplayScore; sub?: string }) {
  return (
    <tr className="border-b border-line-soft last:border-0">
      <td className="cell">
        <span className="font-semibold text-ink">{label}</span>
        {sub && <span className="ml-2 text-2xs text-ink-ghost">{sub}</span>}
      </td>
      <td className="cell text-right text-ink-dim">{s.rows.toLocaleString()}</td>
      <td className="cell text-right text-ok">{s.hits}</td>
      <td className="cell text-right text-crit">{s.misses}</td>
      <td className="cell text-right text-warn">{s.false_alarms}</td>
      <td className="cell text-right text-ink-faint">{s.correct_negatives.toLocaleString()}</td>
      <td className="cell text-right">{num(s.POD, 3)}</td>
      <td className="cell text-right">{num(s.FAR, 3)}</td>
      <td className="cell text-right">{num(s.CSI, 3)}</td>
      <td className="cell text-right">{num(s.band_coverage, 3)}</td>
    </tr>
  );
}

export const ReplayScorecard = memo(function ReplayScorecard({ className }: { className?: string }) {
  const sc = useRealtime((s) => s.state?.flood_ai?.replay?.scorecard ?? null, (a, b) =>
    JSON.stringify(a) === JSON.stringify(b),
  );

  if (!sc) return null;

  const nodes = Object.entries(sc.per_node);
  const excluded = nodes.filter(([, s]) => s.held_out === false).map(([n]) => n);

  return (
    <Panel
      title="Replay scorecard"
      subtitle="The model's alarms on real gauge rows vs what the river did · this session"
      className={className}
      right={<Tag tone="ok">LIVE · REAL OUTCOMES</Tag>}
      bodyClassName="overflow-x-auto"
    >
      {sc.total.rows === 0 && nodes.length === 0 ? (
        <EmptyState
          title="Scoring starts with the first replayed row"
          detail="Each real 15-minute row is scored once, as soon as the model has predicted it."
        />
      ) : (
        <table className="w-full min-w-[720px] border-collapse">
          <thead className="border-b border-line">
            <tr>
              <th className="th">NODE</th>
              <th className="th text-right">ROWS</th>
              <th className="th text-right">HITS</th>
              <th className="th text-right">MISSES</th>
              <th className="th text-right">FALSE AL.</th>
              <th className="th text-right">CORRECT NEG.</th>
              <th className="th text-right">POD</th>
              <th className="th text-right">FAR</th>
              <th className="th text-right">CSI</th>
              <th className="th text-right">IN BAND</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map(([n, s]) => (
              <ScoreRow
                key={n}
                label={n}
                s={s}
                sub={s.split ? (SPLIT_LABEL[s.split] ?? s.split) : undefined}
              />
            ))}
            <tr className="border-t border-line-strong bg-base-700/40">
              <td colSpan={10} className="px-3 pt-1.5 text-2xs uppercase tracking-[0.1em] text-ink-faint">
                Held-out total{sc.total_nodes?.length ? " · " + sc.total_nodes.join(", ") : ""}
              </td>
            </tr>
            <ScoreRow label="TOTAL" s={sc.total} />
          </tbody>
        </table>
      )}
      <div className="space-y-1 border-t border-line px-3 py-2 text-2xs leading-relaxed text-ink-ghost">
        <p>
          A <span className="text-ok">hit</span> is an alarm (P ≥ {prob(sc.threshold, 0)}) on a row
          whose river really reached the flood line within 30 minutes. IN BAND is how often the real
          +30 min level fell inside the model's q10–q90 forecast.
        </p>
        <p>
          The replay plays windows chosen around real floods, so floods are far more frequent here than
          in a real year. These counts show behaviour on real data; they are not a substitute for the
          offline MODEL EVALUATION, which covers the whole test period.
          {excluded.length > 0 &&
            " " + excluded.join(", ") + " replays data the model trained on and is excluded from the total."}
        </p>
      </div>
    </Panel>
  );
});
