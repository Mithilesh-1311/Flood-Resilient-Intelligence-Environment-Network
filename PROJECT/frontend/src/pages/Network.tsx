/**
 * NETWORK TOPOLOGY.
 *
 * The full-size mesh diagram with an inspector alongside. Selecting a node
 * focuses its links in the diagram and fills the inspector; the route table
 * below stays visible so a reroute can be read on the map and in text at once.
 */
import { useState } from "react";
import { NetworkTopology } from "@/components/topology/NetworkTopology";
import { NodeInspector, TopologyLegend } from "@/components/panels/NetworkPanels";
import { RouteTable, SelfHealingBanner, RelayLoad } from "@/components/panels/RoutePanel";
import { EventTimeline } from "@/components/panels/AlertRail";
import { Panel } from "@/components/primitives";
import { ConnectionGate, PageHeader } from "./shared";
import type { NodeId } from "@/types/friend";

export default function Network() {
  const [selected, setSelected] = useState<NodeId | null>(null);

  return (
    <ConnectionGate>
      <PageHeader
        title="Network topology"
        subtitle="3 source nodes · 7 mesh relays · 1 gateway — measured links only"
      />

      <div className="space-y-2">
        <SelfHealingBanner />

        <div className="grid gap-2 xl:grid-cols-[1fr_300px]">
          <Panel
            title="Field topology"
            subtitle="Click a node to focus its links and inspect it"
            bodyClassName="flex flex-col"
          >
            <NetworkTopology
              selected={selected}
              onSelect={(n) => setSelected((cur) => (cur === n ? null : n))}
              className="min-h-[420px] flex-1 p-3"
            />
            <TopologyLegend />
          </Panel>

          <div className="space-y-2">
            <NodeInspector node={selected} />
            <RelayLoad />
          </div>
        </div>

        <div className="grid gap-2 xl:grid-cols-[1.4fr_1fr]">
          <RouteTable />
          <EventTimeline className="max-h-[380px]" />
        </div>
      </div>
    </ConnectionGate>
  );
}
