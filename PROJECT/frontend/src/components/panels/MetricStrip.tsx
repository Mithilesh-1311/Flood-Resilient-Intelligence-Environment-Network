/**
 * The top-of-dashboard answer strip.
 *
 * These eight tiles exist to answer, at a glance and in this order: is the
 * system up, is risk rising, how high is the water, what does the AI think,
 * how confident is it, are the nodes healthy, are alerts still routing, and is
 * the feed live. Everything else on the Overview is supporting detail.
 */
import { memo, type ReactNode } from "react";
import { useRealtime, shallowEqual } from "@/realtime/RealtimeProvider";
import { Readout, StatusDot, NoData } from "@/components/primitives";
import { networkSummary } from "@/lib/derive";
import { healthSeverity, type Severity } from "@/lib/constants";
import { cx, num, prob, signed } from "@/lib/format";
import { isScored } from "@/types/friend";
import { useHistory, useFrameVersion } from "@/realtime/RealtimeProvider";

function Tile({
  label,
  children,
  footer,
  severity,
  className,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
  severity?: Severity;
  className?: string;
}) {
  return (
    <div className={cx("panel flex flex-col justify-between p-2.5", className)}>
      <div className="flex items-center gap-1.5">
        {severity && <StatusDot severity={severity} size={6} />}
        <span className="eyebrow truncate">{label}</span>
      </div>
      <div className="mt-1.5">{children}</div>
      <div className="mt-1 min-h-[14px] font-mono text-2xs text-ink-ghost">{footer}</div>
    </div>
  );
}

/** Change in the worst-node water level over the visible history. */
function useLevelDelta(): { level: number | null; delta: number | null; node: string | null } {
  const history = useHistory();
  const version = useFrameVersion();
  const worstNode = useRealtime((s) => s.state?.flood_ai?.worst?.node ?? null);

  void version; // recomputed each frame by design
  const samples = history.all();
  if (!worstNode || samples.length === 0) return { level: null, delta: null, node: worstNode };

  const last = samples[samples.length - 1];
  const level = last.levelM[worstNode] ?? null;

  // Compare against roughly 30 s ago so the arrow reflects a trend, not noise.
  const cutoff = last.t - 30_000;
  let ref: number | null = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].t <= cutoff) {
      ref = samples[i].levelM[worstNode] ?? null;
      break;
    }
  }
  if (ref === null && samples.length > 1) ref = samples[0].levelM[worstNode] ?? null;

  return {
    level,
    delta: level !== null && ref !== null ? level - ref : null,
    node: worstNode,
  };
}

export const MetricStrip = memo(function MetricStrip() {
  const s = useRealtime((snap) => {
    const st = snap.state;
    const net = networkSummary(st);
    const worst = st?.flood_ai?.worst ?? null;
    const worstNode = worst ? st?.flood_ai?.nodes?.[worst.node] : undefined;
    return {
      link: snap.link,
      frames: snap.frames,
      dataSource: st?.system?.data_source ?? null,
      gatewayUp: st?.system?.gateway_connected ?? false,
      aiAvailable: st?.flood_ai?.available ?? false,
      aiStatus: st?.flood_ai?.status ?? "not_loaded",
      aiReason: st?.flood_ai?.reason ?? null,
      threshold: st?.flood_ai?.model?.threshold ?? null,
      horizon: st?.flood_ai?.model?.horizon_minutes ?? 30,
      mcSamples: st?.flood_ai?.model?.mc_samples ?? null,
      floodP: worst?.flood_probability ?? null,
      uncertainty: worst?.uncertainty ?? null,
      alarm: worst?.alarm ?? false,
      worstStation: isScored(worstNode) ? worstNode.station : null,
      hCrit: worst?.h_crit_m ?? null,
      meanHealth: net.meanMeshHealth,
      minHealth: net.minMeshHealth,
      activeRoutes: net.activeRoutes,
      heldSources: net.heldSources,
      meanPdr: net.meanPdr,
      measuredLinks: net.measuredLinks,
      degradedLinks: net.degradedLinks,
    };
  }, shallowEqual);

  const { level, delta, node } = useLevelDelta();

  // Risk severity comes from the model's own alarm threshold, not a taste call.
  const riskSeverity: Severity =
    s.floodP === null
      ? "off"
      : s.alarm
        ? "crit"
        : s.threshold !== null && s.floodP >= s.threshold * 0.6
          ? "warn"
          : "ok";

  const linkSeverity: Severity =
    s.link === "live" ? "ok" : s.link === "stale" ? "warn" : s.link === "offline" ? "crit" : "warn";

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
      <Tile
        label="System status"
        severity={s.gatewayUp ? "ok" : "crit"}
        footer={s.dataSource === "SIMULATION" ? "SIMULATED FIELD" : "FIELD HARDWARE"}
      >
        <Readout
          size="md"
          value={s.gatewayUp ? "ONLINE" : "DEGRADED"}
          tone={s.gatewayUp ? "ok" : "crit"}
        />
      </Tile>

      <Tile
        label="Network"
        severity={s.degradedLinks > 0 ? "warn" : "ok"}
        footer={s.measuredLinks + " LINKS MEASURED"}
      >
        {s.meanPdr === null ? (
          <NoData reason="No packet statistics received yet" />
        ) : (
          <Readout size="md" value={num(s.meanPdr, 1)} unit="% PDR" />
        )}
      </Tile>

      <Tile
        label={"Flood risk +" + s.horizon + " min"}
        severity={riskSeverity}
        footer={
          s.aiAvailable
            ? s.alarm
              ? "ALARM · P ≥ " + prob(s.threshold, 0)
              : node
                ? "PEAK NODE " + node
                : "NO SCORED NODE"
            : "MODEL OFFLINE"
        }
      >
        {s.floodP === null ? (
          <NoData reason={s.aiReason ?? "Model window still filling"} />
        ) : (
          <Readout size="lg" value={prob(s.floodP, 1)} tone={riskSeverity} />
        )}
      </Tile>

      <Tile
        label="Water level"
        severity={
          level !== null && s.hCrit !== null
            ? level >= s.hCrit
              ? "crit"
              : level >= s.hCrit * 0.9
                ? "warn"
                : "ok"
            : "off"
        }
        footer={
          s.hCrit !== null
            ? "FLOOD LINE " + num(s.hCrit, 2) + " m"
            : "AWAITING CALIBRATED LEVEL"
        }
      >
        {level === null ? (
          <NoData reason="Flood AI has not produced a calibrated level yet" />
        ) : (
          <div className="flex items-baseline gap-2">
            <Readout size="lg" value={num(level, 2)} unit="m" />
            {delta !== null && (
              <span
                className={cx(
                  "font-mono text-xs tabular-nums",
                  delta > 0.005 ? "text-warn" : delta < -0.005 ? "text-ok" : "text-ink-faint",
                )}
                title="Change over the last ~30 s of history"
              >
                {delta > 0.005 ? "↑" : delta < -0.005 ? "↓" : "→"} {signed(delta, 2)}
              </span>
            )}
          </div>
        )}
      </Tile>

      <Tile
        label="AI confidence"
        severity={s.aiAvailable ? "ok" : "off"}
        footer={
          s.mcSamples
            ? "MC-DROPOUT ×" + s.mcSamples + (s.worstStation ? " · " + s.worstStation.split("_")[0] : "")
            : "MODEL NOT LOADED"
        }
      >
        {s.uncertainty === null ? (
          <NoData reason="No inference produced yet" />
        ) : (
          <Readout size="md" value={"±" + num(s.uncertainty, 3)} />
        )}
      </Tile>

      <Tile
        label="Node health"
        severity={healthSeverity(s.minHealth)}
        footer={s.minHealth === null ? "NO HEALTH VECTOR" : "WEAKEST RELAY " + s.minHealth + "%"}
      >
        {s.meanHealth === null ? (
          <NoData />
        ) : (
          <Readout size="md" value={num(s.meanHealth, 1)} unit="% MESH" tone={healthSeverity(s.meanHealth)} />
        )}
      </Tile>

      <Tile
        label="Active routes"
        severity={s.heldSources.length ? "crit" : s.activeRoutes === 3 ? "ok" : "warn"}
        footer={
          s.heldSources.length
            ? "HELD: " + s.heldSources.join(", ")
            : "ALL SOURCES REACHING GATEWAY"
        }
      >
        <Readout
          size="md"
          value={s.activeRoutes + " / 3"}
          tone={s.heldSources.length ? "crit" : "ok"}
        />
      </Tile>

      <Tile
        label="Alert path"
        severity={linkSeverity}
        footer={s.frames + " FRAMES RECEIVED"}
      >
        <Readout
          size="md"
          value={s.link === "live" ? "LIVE" : s.link.toUpperCase()}
          tone={linkSeverity}
        />
      </Tile>
    </div>
  );
});
