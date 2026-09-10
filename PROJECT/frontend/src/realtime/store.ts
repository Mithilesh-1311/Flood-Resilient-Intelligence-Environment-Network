/**
 * The one and only live-data layer.
 *
 * ONE WebSocket for the whole application. Components never open their own -
 * they subscribe to this store with a selector and re-render only when the
 * slice they asked for actually changes. The store is a plain class rather
 * than React state because a 2 s frame carrying an 11x11 matrix should not
 * walk the component tree unless something visible moved.
 *
 * Responsibilities (all of them, in one place):
 *   - connect to /ws, and fall back to GET /state for the first paint
 *   - reconnect with backoff, and say so while it is happening
 *   - detect staleness (frames stopped arriving) without hiding it
 *   - maintain the capped rolling history every chart reads from
 *   - derive events by diffing consecutive frames
 *   - expose POST /reset_health as an operator action
 */
import type { ControllerState, LinkState } from "@/types/friend";
import { STALE_AFTER_MS } from "@/lib/constants";
import { createHistory, sampleFromState, type HistorySample, type RingBuffer } from "./history";
import { deriveEvents, type AlertEvent } from "./events";

const MAX_EVENTS = 250;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

export interface RealtimeSnapshot {
  state: ControllerState | null;
  link: LinkState;
  /** Client ms of the last frame received. 0 before the first one. */
  lastFrameAt: number;
  /** Frames received this session. */
  frames: number;
  /** Bumped on every frame so chart consumers can cheaply detect new data. */
  version: number;
  events: AlertEvent[];
  /** Set while a reset_health request is in flight. */
  resetting: boolean;
  /** Client ms of the last successful health reset, or 0. */
  lastResetAt: number;
  connectError: string | null;
}

type Listener = () => void;

export class RealtimeStore {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private staleTimer: number | null = null;
  private disposed = false;

  /** Shared rolling buffer. Charts read it directly; it is never re-created. */
  readonly history: RingBuffer<HistorySample> = createHistory();

  private snap: RealtimeSnapshot = {
    state: null,
    link: "connecting",
    lastFrameAt: 0,
    frames: 0,
    version: 0,
    events: [],
    resetting: false,
    lastResetAt: 0,
    connectError: null,
  };

  constructor(private readonly origin: string = "") {}

  /* ---------------- subscription ---------------------------------------- */

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): RealtimeSnapshot => this.snap;

  private emit(patch: Partial<RealtimeSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /* ---------------- lifecycle ------------------------------------------- */

  start(): void {
    this.disposed = false;
    void this.primeFromHttp();
    this.connect();
  }

  stop(): void {
    this.disposed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.staleTimer) window.clearInterval(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
    this.ws?.close();
    this.ws = null;
  }

  /**
   * First paint without waiting for the socket handshake. If the socket wins
   * the race this is simply ignored, because ingest() is idempotent on frames.
   */
  private async primeFromHttp(): Promise<void> {
    try {
      const res = await fetch(this.origin + "/state", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as ControllerState;
      if (!this.snap.state) this.ingest(body);
    } catch {
      // The socket path reports connection problems; nothing to add here.
    }
  }

  private wsUrl(): string {
    if (this.origin) {
      return this.origin.replace(/^http/, "ws") + "/ws";
    }
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + window.location.host + "/ws";
  }

  private connect(): void {
    if (this.disposed) return;
    this.emit({ link: this.snap.frames ? "reconnecting" : "connecting" });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch (err) {
      this.scheduleReconnect(String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emit({ link: "live", connectError: null });
      this.startStaleWatch();
    };

    ws.onmessage = (ev) => {
      try {
        this.ingest(JSON.parse(ev.data as string) as ControllerState);
      } catch (err) {
        // A malformed frame must not tear down a working session.
        console.warn("FRiEND: unparseable frame", err);
      }
    };

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };

    ws.onclose = (ev) => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect(ev.reason || "socket closed");
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed) return;
    this.emit({ link: "reconnecting", connectError: reason });
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  /**
   * Staleness is a separate condition from disconnection: the socket can stay
   * open while the controller stops producing frames (a wedged control loop,
   * a suspended laptop). Both are surfaced; neither is hidden.
   */
  private startStaleWatch(): void {
    if (this.staleTimer) window.clearInterval(this.staleTimer);
    this.staleTimer = window.setInterval(() => {
      const { lastFrameAt, link } = this.snap;
      if (!lastFrameAt || link === "reconnecting" || link === "connecting") return;
      const age = Date.now() - lastFrameAt;
      if (age > STALE_AFTER_MS && link !== "stale") this.emit({ link: "stale" });
      else if (age <= STALE_AFTER_MS && link === "stale") this.emit({ link: "live" });
    }, 1000);
  }

  /* ---------------- frame ingest ---------------------------------------- */

  private ingest(state: ControllerState): void {
    const now = Date.now();
    const prev = this.snap.state;

    // Ignore a replayed/duplicate frame (the HTTP prime racing the socket).
    if (prev && state.timestamp === prev.timestamp && this.snap.frames > 0) return;

    this.history.push(sampleFromState(state, now));

    const fresh = deriveEvents(prev, state, now);
    const events = fresh.length
      ? [...fresh.reverse(), ...this.snap.events].slice(0, MAX_EVENTS)
      : this.snap.events;

    this.emit({
      state,
      events,
      link: "live",
      lastFrameAt: now,
      frames: this.snap.frames + 1,
      version: this.snap.version + 1,
    });
  }

  /* ---------------- operator actions ------------------------------------ */

  /** POST /reset_health - restores M1..M7 to 100 in the running controller. */
  async resetHealth(): Promise<boolean> {
    this.emit({ resetting: true });
    try {
      const res = await fetch(this.origin + "/reset_health", { method: "POST" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      await res.json();
      this.emit({ resetting: false, lastResetAt: Date.now() });
      return true;
    } catch (err) {
      console.warn("FRiEND: reset_health failed", err);
      this.emit({ resetting: false });
      return false;
    }
  }
}
