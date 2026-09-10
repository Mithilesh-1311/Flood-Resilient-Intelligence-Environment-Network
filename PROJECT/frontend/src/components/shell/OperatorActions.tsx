/**
 * Operator controls.
 *
 * The only write this dashboard can perform is POST /reset_health, which
 * restores M1..M7 to 100 in the running controller. It is presented as a
 * deliberate operational action - armed, confirmed, then acknowledged with a
 * timestamp - rather than as a casual button, because it changes the state of
 * the field network the demo is being judged on.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RotateCcw, Check, AlertTriangle } from "lucide-react";
import { useRealtime, useStore, shallowEqual } from "@/realtime/RealtimeProvider";
import { clock, cx } from "@/lib/format";

export function OperatorActions() {
  const store = useStore();
  const { resetting, lastResetAt } = useRealtime(
    (s) => ({ resetting: s.resetting, lastResetAt: s.lastResetAt }),
    shallowEqual,
  );
  const [armed, setArmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus to the confirm control so the action is completable by keyboard.
  useEffect(() => {
    if (armed) confirmRef.current?.focus();
  }, [armed]);

  // Disarm on Escape, the conventional way out of a staged action.
  useEffect(() => {
    if (!armed) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  const run = async () => {
    setFailed(false);
    const ok = await store.resetHealth();
    setArmed(false);
    if (!ok) setFailed(true);
  };

  return (
    <div>
      <p className="eyebrow mb-2">Operator</p>

      <AnimatePresence mode="wait" initial={false}>
        {!armed ? (
          <motion.button
            key="arm"
            type="button"
            onClick={() => setArmed(true)}
            disabled={resetting}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeInOut" }}
            className={cx(
              "flex w-full items-center gap-2 border border-line-strong px-2 py-1.5",
              "font-mono text-2xs uppercase tracking-[0.1em] text-ink-dim",
              "transition-colors duration-150 hover:border-warn/50 hover:text-warn",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <RotateCcw size={12} strokeWidth={1.75} />
            <span>{resetting ? "RESETTING…" : "RESET MESH HEALTH"}</span>
          </motion.button>
        ) : (
          <motion.div
            key="confirm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: "easeInOut" }}
            className="border border-warn/40 bg-warn/5 p-2"
          >
            <p className="mb-2 flex items-start gap-1.5 text-2xs leading-relaxed text-warn">
              <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0" />
              <span>
                This will restore mesh-node health state. M1–M7 return to 100% in the
                running controller.
              </span>
            </p>
            <div className="flex gap-1">
              <button
                ref={confirmRef}
                type="button"
                onClick={run}
                className="flex-1 border border-warn/60 bg-warn/10 px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] text-warn transition-colors duration-150 hover:bg-warn/20"
              >
                CONFIRM
              </button>
              <button
                type="button"
                onClick={() => setArmed(false)}
                className="flex-1 border border-line-strong px-2 py-1 font-mono text-2xs uppercase tracking-[0.1em] text-ink-faint transition-colors duration-150 hover:text-ink-dim"
              >
                CANCEL
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {lastResetAt > 0 && !armed && (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-2xs text-ok">
          <Check size={11} strokeWidth={2} />
          HEALTH RESET {clock(lastResetAt / 1000)}
        </p>
      )}
      {failed && !armed && (
        <p className="mt-1.5 font-mono text-2xs text-crit">RESET FAILED — CONTROLLER UNREACHABLE</p>
      )}
    </div>
  );
}
