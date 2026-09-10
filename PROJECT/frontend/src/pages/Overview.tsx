/**
 * COMMAND CENTRE.
 *
 * Laid out to answer, top to bottom: is the system up, is risk rising, what is
 * the network doing about it. The metric strip gives the three-second read; the
 * flood graph and topology give the why; the alert rail gives the history.
 */
import { useState } from "react";
import { useRealtime } from "@/realtime/RealtimeProvider";
import { MetricStrip } from "@/components/panels/MetricStrip";
import { AlertRail } from "@/components/panels/AlertRail";
import { SelfHealingBanner, RouteTable } from "@/components/panels/RoutePanel";
import { NetworkTopology } from "@/components/topology/NetworkTopology";
import { TopologyLegend } from "@/components/panels/NetworkPanels";
import { WaterLevelChart } from "@/components/charts/WaterLevelChart";
import { LiveChart } from "@/components/charts/LiveChart";
import { Panel } from "@/components/primitives";
import { ReplayStrip, TelemetryTag } from "@/components/panels/ReplayPanels";
import { CHART } from "@/components/charts/chartTheme";
import { SOURCE_NODES } from "@/lib/constants";
import { SensorSelector } from "@/components/panels/SensorPanels";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";
import type { NodeId } from "@/types/friend";

export default function Overview() {
  const win = useTimeWindow();
  const worstNode = useRealtime((s) => s.state?.flood_ai?.worst?.node ?? null);
  const [manualNode, setManualNode] = useState<NodeId | null>(null);
  const [selectedTopoNode, setSelectedTopoNode] = useState<NodeId | null>(null);

  // Default to whichever source the model currently rates highest, so the
  // primary graph is showing the node that matters without being asked.
  const node = manualNode ?? worstNode ?? SOURCE_NODES[0];

  return (
    <ConnectionGate>
      <PageHeader
        title="Command centre"
        subtitle="Flood-risk intelligence and self-healing mesh status"
        right={<TimeWindowControl value={win.label} onChange={win.setLabel} />}
      />

      <div className="space-y-2">
        <MetricStrip />

        {/* Replay only: which real gauge, which real moment, which flood. */}
        <ReplayStrip />

        <SelfHealingBanner />

        <div className="grid gap-2 xl:grid-cols-[1.35fr_1fr]">
          {/* PRIMARY: water level + flood forecast */}
          <Panel
            title="Water level & flood forecast"
            subtitle={"Observed level, flood line and the model's quantile forecast"}
            right={
              <div className="flex items-center gap-2">
                <TelemetryTag />
                <SensorSelector value={node} onChange={setManualNode} />
              </div>
            }
          >
            <div className="p-3">
              <WaterLevelChart node={node} windowMs={win.ms} height={286} />
            </div>
          </Panel>

          {/* Mesh topology */}
          <Panel
            title="Mesh topology"
            subtitle="Measured links and the paths alerts are taking now"
            bodyClassName="flex flex-col"
          >
            <NetworkTopology
              selected={selectedTopoNode}
              onSelect={(n) => setSelectedTopoNode((cur) => (cur === n ? null : n))}
              className="min-h-[260px] flex-1 p-2"
            />
            <TopologyLegend />
          </Panel>
        </div>

        <div className="grid gap-2 xl:grid-cols-3">
          <Panel
            title="Flood probability"
            subtitle="All source nodes · model output"
          >
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={140}
                domain={[0, 1]}
                digits={2}
                emptyTitle="No inference yet"
                emptyDetail="Flood probability appears once each node's model window has filled."
                series={SOURCE_NODES.map((id, i) => ({
                  key: id,
                  label: id,
                  color: [CHART.accent, CHART.ok, "#B07FD9"][i],
                  accessor: (s) => s.floodP[id] ?? null,
                }))}
              />
            </div>
          </Panel>

          <Panel title="Mesh health" subtitle="Mean relay battery health">
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={140}
                domain={[0, 100]}
                digits={0}
                unit="%"
                showLegend={false}
                emptyTitle="No health vector yet"
                references={[
                  { y: 70, label: "NOMINAL", color: CHART.ok },
                  { y: 40, label: "DEGRADED", color: CHART.warn },
                ]}
                series={[
                  {
                    key: "health",
                    label: "Mean mesh health",
                    color: CHART.ok,
                    accessor: (s) => s.meanMeshHealth,
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel title="Link reliability" subtitle="Mean PDR over measured links">
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={140}
                domain={[0, 100]}
                digits={1}
                unit="%"
                showLegend={false}
                emptyTitle="No packet statistics yet"
                emptyDetail="PDR appears once the gateway forwards packet counters."
                series={[
                  {
                    key: "pdr",
                    label: "Mean PDR",
                    color: CHART.accent,
                    accessor: (s) => s.meanPdr,
                  },
                ]}
              />
            </div>
          </Panel>
        </div>

        <div className="grid gap-2 xl:grid-cols-[1.4fr_1fr]">
          <RouteTable />
          <AlertRail className="max-h-[420px]" />
        </div>
      </div>
    </ConnectionGate>
  );
}
