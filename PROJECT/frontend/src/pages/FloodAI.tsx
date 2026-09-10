/**
 * FLOOD AI.
 *
 * The model's own module. Live inference sits at the top under a LIVE TELEMETRY
 * tag; the offline evaluation sits below under MODEL EVALUATION, on a different
 * ground, with an explicit caption. The separation is the point: POD/FAR/CSI
 * describe the trained model, not the running network.
 */
import { useState } from "react";
import { useRealtime } from "@/realtime/RealtimeProvider";
import {
  FloodRiskPanel,
  FloodNodeGrid,
  ModelEvaluationPanel,
  ModelIdentity,
} from "@/components/panels/FloodPanels";
import { WaterLevelChart } from "@/components/charts/WaterLevelChart";
import { LiveChart } from "@/components/charts/LiveChart";
import { CalibrationNote } from "@/components/panels/SensorPanels";
import { ReplayScorecard, ReplayStrip, TelemetryTag } from "@/components/panels/ReplayPanels";
import { Panel, Tag } from "@/components/primitives";
import { CHART } from "@/components/charts/chartTheme";
import { SOURCE_NODES } from "@/lib/constants";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";
import type { NodeId } from "@/types/friend";

export default function FloodAI() {
  const win = useTimeWindow();
  const worst = useRealtime((s) => s.state?.flood_ai?.worst?.node ?? null);
  const [manual, setManual] = useState<NodeId | null>(null);
  const node = manual ?? worst ?? SOURCE_NODES[0];

  const horizon = useRealtime((s) => s.state?.flood_ai?.model?.horizon_minutes ?? 30);

  return (
    <ConnectionGate>
      <PageHeader
        title="Flood-Risk AI"
        subtitle="Two-head GRU · quantile forecast · MC-Dropout uncertainty"
        right={<TimeWindowControl value={win.label} onChange={win.setLabel} />}
      />

      <div className="space-y-2">
        {/* Replay only: which real gauge rows the model is being scored on. */}
        <ReplayStrip />

        <div className="grid items-start gap-2 xl:grid-cols-[1fr_280px]">
          <FloodRiskPanel node={node} />
          <div className="space-y-2">
            <FloodNodeGrid selected={node} onSelect={setManual} />
            <ModelIdentity />
          </div>
        </div>

        <CalibrationNote node={node} />

        <Panel
          title={"Water level & forecast · " + node}
          subtitle={"Observed level with the +" + horizon + " min quantile forecast"}
          right={<TelemetryTag />}
        >
          <div className="p-3">
            <WaterLevelChart node={node} windowMs={win.ms} height={300} />
          </div>
        </Panel>

        <div className="grid gap-2 xl:grid-cols-2">
          <Panel
            title="Flood probability"
            subtitle="Model output per source node, with the alarm threshold"
            right={<Tag tone="accent">LIVE MODEL OUTPUT</Tag>}
          >
            <div className="p-2.5">
              <FloodProbabilityChart windowMs={win.ms} />
            </div>
          </Panel>

          <Panel
            title="Predictive uncertainty"
            subtitle="MC-Dropout standard deviation across 20 stochastic passes"
            right={<Tag tone="accent">LIVE MODEL OUTPUT</Tag>}
          >
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={170}
                digits={4}
                emptyTitle="No uncertainty yet"
                emptyDetail="Uncertainty appears once the model starts scoring."
                series={SOURCE_NODES.map((id, i) => ({
                  key: id + "-u",
                  label: id,
                  color: [CHART.accent, CHART.ok, "#B07FD9"][i],
                  accessor: (h) => h.uncertainty[id] ?? null,
                }))}
              />
            </div>
          </Panel>
        </div>

        {/* Replay only: live verification against real outcomes. Kept apart from,
            and above, the offline evaluation it must not be confused with. */}
        <ReplayScorecard />

        <ModelEvaluationPanel />
      </div>
    </ConnectionGate>
  );
}

/** Split out so it can read the live alarm threshold for its reference line. */
function FloodProbabilityChart({ windowMs }: { windowMs: number }) {
  const threshold = useRealtime((s) => s.state?.flood_ai?.model?.threshold ?? null);

  return (
    <LiveChart
      windowMs={windowMs}
      height={170}
      domain={[0, 1]}
      digits={3}
      emptyTitle="No inference yet"
      emptyDetail="Probability appears once each node has collected a full model window."
      references={
        threshold === null
          ? []
          : [{ y: threshold, label: "ALARM " + (threshold * 100).toFixed(0) + "%", color: CHART.crit }]
      }
      series={SOURCE_NODES.map((id, i) => ({
        key: id + "-p",
        label: id,
        color: [CHART.accent, CHART.ok, "#B07FD9"][i],
        accessor: (h) => h.floodP[id] ?? null,
      }))}
    />
  );
}
