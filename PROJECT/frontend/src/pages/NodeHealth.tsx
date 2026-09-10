/**
 * NODE HEALTH.
 *
 * All eleven nodes in the routing graph, their health, their measured link
 * quality and which routes they carry. Mesh health is the variable that drives
 * the router's load-spreading, so it gets a live trend alongside the table.
 */
import { useState } from "react";
import { NodeHealthTable, NodeInspector } from "@/components/panels/NetworkPanels";
import { RelayLoad } from "@/components/panels/RoutePanel";
import { EventTimeline } from "@/components/panels/AlertRail";
import { LiveChart } from "@/components/charts/LiveChart";
import { Panel, Tag } from "@/components/primitives";
import { CHART } from "@/components/charts/chartTheme";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";
import type { NodeId } from "@/types/friend";

export default function NodeHealth() {
  const win = useTimeWindow("15 MIN");
  const [selected, setSelected] = useState<NodeId | null>(null);

  return (
    <ConnectionGate>
      <PageHeader
        title="Node health"
        subtitle="S1–S3 · M1–M7 · G — health, PDR and route participation"
        right={
          <>
            <Tag tone="neutral">RESET AVAILABLE IN SIDEBAR</Tag>
            <TimeWindowControl value={win.label} onChange={win.setLabel} />
          </>
        }
      />

      <div className="space-y-2">
        <div className="grid gap-2 xl:grid-cols-[1fr_300px]">
          <NodeHealthTable
            selected={selected}
            onSelect={(n) => setSelected((cur) => (cur === n ? null : n))}
          />
          <div className="space-y-2">
            <NodeInspector node={selected} />
            <RelayLoad />
          </div>
        </div>

        <div className="grid gap-2 xl:grid-cols-[1.5fr_1fr]">
          <Panel
            title="Mesh health trend"
            subtitle="Relays drain while relaying and recover while resting — the router's load-spreading feedback loop"
          >
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={190}
                domain={[0, 100]}
                digits={0}
                unit=" %"
                showLegend={false}
                emptyTitle="No health vector yet"
                references={[
                  { y: 70, label: "NOMINAL ≥70", color: CHART.ok },
                  { y: 40, label: "DEGRADED ≥40", color: CHART.warn },
                ]}
                series={[
                  {
                    key: "mesh",
                    label: "Mean mesh health",
                    color: CHART.ok,
                    accessor: (h) => h.meanMeshHealth,
                    width: 1.8,
                  },
                ]}
              />
            </div>
          </Panel>

          <EventTimeline className="max-h-[280px]" limit={30} />
        </div>
      </div>
    </ConnectionGate>
  );
}
