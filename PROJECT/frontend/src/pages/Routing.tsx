/**
 * ROUTING.
 *
 * Everything about how alerts are currently reaching the gateway, and every
 * time that has changed this session. Built for an operator who has to justify
 * a path, not merely observe one.
 */
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import {
  RouteTable,
  RouteChangeLog,
  RelayLoad,
  SelfHealingBanner,
} from "@/components/panels/RoutePanel";
import { Panel, Readout, NoData, KeyValue, Tag } from "@/components/primitives";
import { LiveChart } from "@/components/charts/LiveChart";
import { CHART } from "@/components/charts/chartTheme";
import { networkSummary, routeSummaries } from "@/lib/derive";
import { pct } from "@/lib/format";
import { ConnectionGate, PageHeader, TimeWindowControl, useTimeWindow } from "./shared";

function Stat({
  label,
  children,
  footer,
}: {
  label: string;
  children: React.ReactNode;
  footer: string;
}) {
  return (
    <div className="panel p-2.5">
      <span className="eyebrow">{label}</span>
      <div className="mt-1">{children}</div>
      <p className="mt-1 font-mono text-2xs text-ink-ghost">{footer}</p>
    </div>
  );
}

export default function Routing() {
  const win = useTimeWindow("15 MIN");

  const s = useRealtime((snap) => {
    const net = networkSummary(snap.state);
    const routes = routeSummaries(snap.state);
    const measured = routes.map((r) => r.meanPdr).filter((v): v is number => v !== null);
    const worst = routes.reduce<{ id: string; v: number } | null>((acc, r) => {
      if (r.minPdr === null) return acc;
      return !acc || r.minPdr < acc.v ? { id: r.id, v: r.minPdr } : acc;
    }, null);
    return {
      activeRoutes: net.activeRoutes,
      heldSources: net.heldSources.join(", "),
      heldCount: net.heldSources.length,
      relaysInUse: net.relaysInUse,
      overused: net.overusedRelays.join(", "),
      overusedCount: net.overusedRelays.length,
      degradedLinks: net.degradedLinks,
      measuredLinks: net.measuredLinks,
      avgRoutePdr: measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null,
      worstId: worst?.id ?? null,
      worstV: worst?.v ?? null,
    };
  }, shallowEqual);

  const changeCount = useRealtime((snap) => snap.events.filter((e) => e.routeChange).length);

  return (
    <ConnectionGate>
      <PageHeader
        title="Routing"
        subtitle="Adaptive path selection and self-healing behaviour"
        right={<TimeWindowControl value={win.label} onChange={win.setLabel} />}
      />

      <div className="space-y-2">
        <SelfHealingBanner />

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Stat
            label="Active routes"
            footer={s.heldCount ? "HELD: " + s.heldSources : "ALL SOURCES ROUTED"}
          >
            <Readout size="md" value={s.activeRoutes + " / 3"} tone={s.heldCount ? "crit" : "ok"} />
          </Stat>

          <Stat label="Route changes" footer="THIS SESSION">
            <Readout size="md" value={String(changeCount)} />
          </Stat>

          <Stat label="Average route PDR" footer="MEASURED HOPS ONLY">
            {s.avgRoutePdr === null ? <NoData /> : <Readout size="md" value={pct(s.avgRoutePdr, 1)} />}
          </Stat>

          <Stat label="Weakest route hop" footer={s.worstId ?? "NO DATA"}>
            {s.worstV === null ? (
              <NoData />
            ) : (
              <Readout
                size="md"
                value={pct(s.worstV, 0)}
                tone={s.worstV < 60 ? "crit" : s.worstV < 85 ? "warn" : "ok"}
              />
            )}
          </Stat>

          <Stat
            label="Relays in use"
            footer={s.overusedCount ? "AT CAP: " + s.overused : "NONE AT CAP"}
          >
            <Readout size="md" value={s.relaysInUse + " / 7"} />
          </Stat>

          <Stat label="Degraded links" footer={"OF " + s.measuredLinks + " MEASURED"}>
            <Readout
              size="md"
              value={String(s.degradedLinks)}
              tone={s.degradedLinks ? "warn" : "ok"}
            />
          </Stat>
        </div>

        <RouteTable />

        <div className="grid gap-2 xl:grid-cols-[1fr_1fr_300px]">
          <Panel title="Routing pressure" subtitle="What the router is working with, and what it achieved">
            {/* Two charts rather than one: a route COUNT and a PERCENTAGE do not
                share an axis honestly - on a 0-100 scale the count flatlines at
                the bottom and stretches the domain for no informational gain. */}
            <div className="space-y-2 p-2.5">
              <LiveChart
                windowMs={win.ms}
                height={128}
                domain={[0, 100]}
                digits={0}
                unit=" %"
                series={[
                  {
                    key: "pdr",
                    label: "Mean PDR",
                    color: CHART.ok,
                    accessor: (h) => h.meanPdr,
                  },
                  {
                    key: "health",
                    label: "Mean mesh health",
                    color: CHART.warn,
                    accessor: (h) => h.meanMeshHealth,
                    dashed: true,
                  },
                ]}
              />
              <div className="border-t border-line-soft pt-2">
                <p className="eyebrow mb-1">Sources reaching the gateway</p>
                <LiveChart
                  windowMs={win.ms}
                  height={72}
                  domain={[0, 3]}
                  digits={0}
                  showLegend={false}
                  series={[
                    {
                      key: "routes",
                      label: "Active routes",
                      color: CHART.accent,
                      accessor: (h) => h.activeRoutes,
                    },
                  ]}
                />
              </div>
            </div>
          </Panel>

          <RouteChangeLog className="max-h-[300px]" />
          <RelayLoad />
        </div>

        <Panel title="How routes are chosen" subtitle="nc1.get_routes_from_ai">
          <div className="grid gap-x-8 gap-y-1 p-3 md:grid-cols-2">
            <KeyValue k="Algorithm">Expanded-state Dijkstra, per source</KeyValue>
            <KeyValue k="Hop score">0.6 · PDR + 0.2 · health(a) + 0.2 · health(b)</KeyValue>
            <KeyValue k="Minimised">sum of (100 − score) over the path</KeyValue>
            <KeyValue k="Mesh hops allowed">2 – 4</KeyValue>
            <KeyValue k="Per-relay cap">2 active routes</KeyValue>
            <KeyValue k="Recompute cadence">every control cycle</KeyValue>
          </div>
          <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-ink-ghost">
            <Tag tone="neutral" className="mr-2">
              NOTE
            </Tag>
            A direct source-to-gateway route is never computed: the source firmware only accepts a
            route carrying at least one relay, so the two-mesh-hop minimum is enforced in the graph
            itself. Relays already carrying two routes are excluded from later sources in the same
            pass, which is what spreads load across the mesh.
          </p>
        </Panel>
      </div>
    </ConnectionGate>
  );
}
