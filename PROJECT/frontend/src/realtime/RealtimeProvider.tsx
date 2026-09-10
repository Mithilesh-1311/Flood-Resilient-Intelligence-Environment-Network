/**
 * React binding for the single RealtimeStore.
 *
 * `useRealtime(selector)` re-renders a component only when its selected slice
 * changes, so the 11x11 PDR matrix arriving every 2 s does not repaint the
 * whole dashboard. Selectors that build objects should pass `shallowEqual`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RealtimeStore, type RealtimeSnapshot } from "./store";

const StoreContext = createContext<RealtimeStore | null>(null);

export function RealtimeProvider({
  children,
  origin = "",
}: {
  children: ReactNode;
  /** Empty string = same origin (Vite proxies /ws and /state to the controller). */
  origin?: string;
}) {
  const store = useMemo(() => new RealtimeStore(origin), [origin]);

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): RealtimeStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used inside <RealtimeProvider>");
  return store;
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a) as Array<keyof T>;
  const kb = Object.keys(b) as Array<keyof T>;
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/**
 * Subscribe to a slice of the live snapshot.
 *
 * Written by hand rather than with useSyncExternalStore so that a selector may
 * return a freshly-built object each frame without looping: the equality check
 * happens before setState, not after.
 */
export function useRealtime<T>(
  selector: (snap: RealtimeSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useStore();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;

  const [value, setValue] = useState<T>(() => selector(store.getSnapshot()));
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const check = () => {
      const next = selectorRef.current(store.getSnapshot());
      if (!equalRef.current(valueRef.current, next)) {
        valueRef.current = next;
        setValue(next);
      }
    };
    check(); // catch anything that landed between render and subscribe
    return store.subscribe(check);
  }, [store]);

  return value;
}

/** The shared rolling history buffer. Stable identity - safe as a dep. */
export function useHistory() {
  return useStore().history;
}

/**
 * Frame counter. Charts depend on this instead of on the whole state object,
 * so they redraw exactly once per frame and never on unrelated updates.
 */
export const useFrameVersion = () => useRealtime((s) => s.version);
