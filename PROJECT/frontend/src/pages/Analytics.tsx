/**
 * ANALYTICS / DIAGNOSTICS.
 *
 * The engineering view: the full directional PDR matrix, packet counters, and
 * the controller's own self-description. This is where an operator goes to
 * establish what the system actually measured, as opposed to what it concluded.
 */
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { PDRMatrix } from "@/components/panels/NetworkPanels";
import { EventTimeline } from "@/components/panels/AlertRail";
import { LiveChart } from "@/components/charts/LiveChart";
import { KeyValue, NoData, Panel, Readout, Tag } from "@/components/primitives";
import { CHART } from "@/components/charts/chartTheme";
import { NODE_ORDER } from "@/lib/constants";
import { networkSummary } from "@/lib/derive";
import { clock, duration, num, pct } from "@/lib/format";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";
import { provenance } from "@/lib/provenance";

function PacketTotals() {
  const totals = useRealtime((s) => {
    const stats = s.state?.packet_stats_summary;
    if (!stats?.total_tx) return null;
    let tx = 0;
    let rx = 0;
    const perNode: Array<{ id: string; tx: number; rx: number }> = [];
    for (let a = 0; a < NODE_ORDER.length; a += 1) {
      let nodeTx = 0;
      let nodeRx = 0;
      for (let b = 0; b < NODE_ORDER.length; b += 1) {
        nodeTx += stats.total_tx?.[a]?.[b] ?? 0;
        nodeRx += stats.total_rx?.[a]?.[b] ?? 0;
      }
      tx += nodeTx;
      rx += nodeRx;
      if (nodeTx || nodeRx) perNode.push({ id: NODE_ORDER[a], tx: nodeTx, rx: nodeRx });
    }
    return { tx, rx, perNode };
  }, (a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (!totals || totals.tx === 0) {
    return (
      <Panel title="Packet counters" subtitle="Cumulative since controller start">
        <div className="p-3">
          <p className="font-mono text-2xs text-ink-ghost">
            No packet statistics received yet. Counters populate once the gateway forwards
            packet_stat messages.
          </p>
        </div>
      </Panel>
    );
  }

  const delivered = totals.tx ? (totals.rx / totals.tx) * 100 : null;

  return (
    <Panel
      title="Packet counters"
      subtitle="Cumulative since controller start · never reset"
      right={<Tag tone="neutral">{totals.perNode.length} TRANSMITTING NODES</Tag>}
      bodyClassName="overflow-y-auto"
    >
      <div className="grid grid-cols-3 gap-px border-b border-line bg-line">
        <div className="bg-base-800 px-2.5 py-2">
          <span className="eyebrow">Transmitted</span>
          <div className="mt-1">
            <Readout size="sm" value={totals.tx.toLocaleString()} />
          </div>
        </div>
        <div className="bg-base-800 px-2.5 py-2">
          <span className="eyebrow">Received</span>
          <div className="mt-1">
            <Readout size="sm" value={totals.rx.toLocaleString()} />
          </div>
        </div>
        <div className="bg-base-800 px-2.5 py-2">
          <span className="eyebrow">Delivered</span>
          <div className="mt-1">
            {delivered === null ? <NoData /> : <Readout size="sm" value={pct(delivered, 2)} />}
          </div>
        </div>
      </div>

      <table className="w-full border-collapse">
        <thead className="border-b border-line">
          <tr>
            <th className="th w-16">NODE</th>
            <th className="th text-right">TX</th>
            <th className="th text-right">RX</th>
            <th className="th w-20 text-right">RATIO</th>
          </tr>
        </thead>
        <tbody>
          {totals.perNode.map((n) => (
            <tr key={n.id} className="border-b border-line-soft last:border-0">
              <td className="cell text-ink">{n.id}</td>
              <td className="cell text-right text-ink-dim">{n.tx.toLocaleString()}</td>
              <td className="cell text-right text-ink-dim">{n.rx.toLocaleString()}</td>
              <td className="cell text-right">{n.tx ? pct((n.rx / n.tx) * 100, 1) : <NoData />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function ControllerPanel() {
  const sys = useRealtime((s) => s.state?.system ?? null, shallowEqual);
  const telemetry = useRealtime((s) => provenance(s.state).telemetry);
  const meta = useRealtime(
    (s) => ({
      nodes: s.state?.nodes?.length ?? 0,
      frames: s.frames,
      timestamp: s.state?.timestamp ?? null,
      historyLen: 0,
    }),
    shallowEqual,
  );

  return (
    <Panel title="Controller" subtitle="Self-reported by nc1.py">
      <dl className="p-2.5">
        <KeyValue k="Data source">
          {sys ? (
            <Tag tone={sys.data_source === "SIMULATION" ? "warn" : "accent"}>{sys.data_source}</Tag>
          ) : (
            <NoData />
          )}
        </KeyValue>
        <KeyValue k="Gateway bridge">
          {sys ? (
            <span className={sys.gateway_connected ? "text-ok" : "text-crit"}>
              {sys.gateway_connected ? "CONNECTED" : "DISCONNECTED"}
            </span>
          ) : (
            <NoData />
          )}
        </KeyValue>
        <KeyValue k="Gateway endpoint">
          {sys ? sys.gateway_host + ":" + sys.gateway_port : <NoData />}
        </KeyValue>
        <KeyValue k="Control loop">
          {sys ? num(sys.loop_interval_seconds, 1) + " s" : <NoData />}
        </KeyValue>
        <KeyValue k="PDR stale after">
          {sys ? num(sys.pdr_stale_after_seconds, 1) + " s" : <NoData />}
        </KeyValue>
        <KeyValue k="Uptime">{sys ? duration(sys.uptime_seconds) : <NoData />}</KeyValue>
        <KeyValue k="Cycles">{sys?.cycle ?? <NoData />}</KeyValue>
        <KeyValue k="Dashboard clients">{sys?.ws_clients ?? <NoData />}</KeyValue>
        <KeyValue k="Nodes in graph">{meta.nodes || <NoData />}</KeyValue>
        <KeyValue k="Frames received">{meta.frames}</KeyValue>
        <KeyValue k="Last frame">{clock(meta.timestamp)}</KeyValue>
      </dl>

      {sys?.data_source === "SIMULATION" && (
        <div className="border-t border-line bg-warn/[0.04] px-2.5 py-2">
          <Tag tone="warn">SIMULATION</Tag>
          <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
            {telemetry === "REPLAY" ? (
              <>
                The controller's TCP client is pointed at loopback: it is talking to
                replay_hardware.py, not the ESP32-CAM gateway. The <strong>river readings are real</strong>{" "}
                — held-out gauge rows from the project's labelled dataset — but the mesh is simulated,
                so every packet counter and PDR value here is generated. The routing, health and
                inference logic is the real thing; nc1.py runs unmodified.
              </>
            ) : (
              <>
                The controller's TCP client is pointed at loopback, which means it is talking to
                simulate_hardware.py rather than the ESP32-CAM gateway. Every sensor reading and packet
                counter on this dashboard is generated, not measured. The routing, health and inference
                logic acting on them is the real thing — simulate_hardware.py imports nc1.py unmodified.
              </>
            )}
          </p>
        </div>
      )}
    </Panel>
  );
}

export default function Analytics() {
  const win = useTimeWindow("30 MIN");
  const summary = useRealtime((s) => networkSummary(s.state), shallowEqual);

  return (
    <ConnectionGate>
      <PageHeader
        title="Analytics & diagnostics"
        subtitle="Directional PDR, packet counters and controller state"
        right={<TimeWindowControl value={win.label} onChange={win.setLabel} />}
      />

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="panel p-2.5">
            <span className="eyebrow">Measured links</span>
            <div className="mt-1">
              <Readout size="md" value={String(summary.measuredLinks)} />
            </div>
            <p className="mt-1 font-mono text-2xs text-ink-ghost">OF 110 DIRECTED PAIRS</p>
          </div>
          <div className="panel p-2.5">
            <span className="eyebrow">Degraded links</span>
            <div className="mt-1">
              <Readout
                size="md"
                value={String(summary.degradedLinks)}
                tone={summary.degradedLinks ? "warn" : "ok"}
              />
            </div>
            <p className="mt-1 font-mono text-2xs text-ink-ghost">BELOW 60 % PDR</p>
          </div>
          <div className="panel p-2.5">
            <span className="eyebrow">Mean PDR</span>
            <div className="mt-1">
              {summary.meanPdr === null ? (
                <NoData />
              ) : (
                <Readout size="md" value={pct(summary.meanPdr, 1)} />
              )}
            </div>
            <p className="mt-1 font-mono text-2xs text-ink-ghost">MEASURED ONLY</p>
          </div>
          <div className="panel p-2.5">
            <span className="eyebrow">Weakest relay</span>
            <div className="mt-1">
              {summary.minMeshHealth === null ? (
                <NoData />
              ) : (
                <Readout size="md" value={summary.minMeshHealth + "%"} />
              )}
            </div>
            <p className="mt-1 font-mono text-2xs text-ink-ghost">MESH HEALTH FLOOR</p>
          </div>
        </div>

        <div className="grid items-start gap-2 xl:grid-cols-[1fr_320px]">
          <PDRMatrix />
          <ControllerPanel />
        </div>

        <div className="grid gap-2 xl:grid-cols-[1fr_1fr]">
          <Panel title="Network quality trend" subtitle="Mean PDR and mesh health">
            <div className="p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={180}
                domain={[0, 100]}
                digits={1}
                unit=" %"
                series={[
                  { key: "pdr", label: "Mean PDR", color: CHART.accent, accessor: (h) => h.meanPdr },
                  {
                    key: "health",
                    label: "Mean mesh health",
                    color: CHART.ok,
                    accessor: (h) => h.meanMeshHealth,
                    dashed: true,
                  },
                ]}
              />
            </div>
          </Panel>
          <PacketTotals />
        </div>

        <EventTimeline className="max-h-[320px]" limit={60} />
      </div>
    </ConnectionGate>
  );
}
