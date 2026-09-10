/**
 * SENSOR MONITORING.
 *
 * A dense telemetry table over a per-node chart context. Selecting a row or a
 * chip changes what the charts below are showing; nothing else moves.
 */
import { useState } from "react";
import {
  SensorTable,
  SensorSelector,
  SensorVitals,
  CalibrationNote,
} from "@/components/panels/SensorPanels";
import { WaterLevelChart } from "@/components/charts/WaterLevelChart";
import { LiveChart } from "@/components/charts/LiveChart";
import { Panel, Tag } from "@/components/primitives";
import { CHART } from "@/components/charts/chartTheme";
import { SOURCE_NODES } from "@/lib/constants";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";
import type { NodeId } from "@/types/friend";

export default function Sensors() {
  const win = useTimeWindow();
  const [node, setNode] = useState<NodeId>(SOURCE_NODES[0]);

  return (
    <ConnectionGate>
      <PageHeader
        title="Sensor monitoring"
        subtitle="Water level, rain, temperature and humidity from S1–S3"
        right={
          <>
            <SensorSelector value={node} onChange={setNode} />
            <TimeWindowControl value={win.label} onChange={win.setLabel} />
          </>
        }
      />

      <div className="space-y-2">
        <SensorTable selected={node} onSelect={setNode} />

        <div className="grid gap-2 xl:grid-cols-[1.4fr_1fr]">
          <Panel
            title={"Water level · " + node}
            subtitle="Calibrated level with the model's forecast band"
            right={<Tag tone="accent">LIVE TELEMETRY</Tag>}
          >
            <div className="p-3">
              <WaterLevelChart node={node} windowMs={win.ms} height={250} />
            </div>
          </Panel>

          <div className="space-y-2">
            <Panel title={"Current conditions · " + node}>
              <SensorVitals node={node} />
            </Panel>

            <Panel title="Raw water sensor" subtitle="All sources · 0–100 % of sensor span">
              <div className="p-2.5">
                <LiveChart
                  windowMs={win.ms}
                  height={130}
                  domain={[0, 100]}
                  digits={1}
                  unit="%"
                  emptyTitle="No water readings yet"
                  series={SOURCE_NODES.map((id, i) => ({
                    key: id + "-w",
                    label: id,
                    color: [CHART.accent, CHART.ok, "#B07FD9"][i],
                    accessor: (h) => h.water[id] ?? null,
                  }))}
                />
              </div>
            </Panel>
          </div>
        </div>

        <CalibrationNote node={node} />

        <div className="grid gap-2 xl:grid-cols-2">
          <Panel title="Temperature" subtitle="All source nodes · °C">
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={150}
                digits={1}
                unit=" °C"
                emptyTitle="No temperature readings"
                emptyDetail="The firmware omits this key when the DHT read fails, and it stays absent here."
                series={SOURCE_NODES.map((id, i) => ({
                  key: id + "-t",
                  label: id,
                  color: [CHART.accent, CHART.ok, "#B07FD9"][i],
                  accessor: (h) => h.temp[id] ?? null,
                }))}
              />
            </div>
          </Panel>

          <Panel title="Relative humidity" subtitle="All source nodes · %">
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={150}
                domain={[0, 100]}
                digits={1}
                unit=" %"
                emptyTitle="No humidity readings"
                series={SOURCE_NODES.map((id, i) => ({
                  key: id + "-h",
                  label: id,
                  color: [CHART.accent, CHART.ok, "#B07FD9"][i],
                  accessor: (h) => h.humidity[id] ?? null,
                }))}
              />
            </div>
          </Panel>
        </div>
      </div>
    </ConnectionGate>
  );
}
