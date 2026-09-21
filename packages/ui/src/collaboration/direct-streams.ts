/**
 * Direct event and terminal streams (S06 / T031).
 *
 * A stream opens with a one-use purpose ticket in the socket query, proves
 * possession of the scope session's key in its first frame, validates every
 * later frame against the frozen contract, and reconnects from scratch with
 * a fresh ticket: no reconnect ever extends a lease.
 */
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationEventFrameSchema,
  CollaborationIdSchema,
  CollaborationTerminalFrameSchema,
  type CollaborationSignedConnectionTicket,
  type CollaborationTerminalFrame,
} from "@matrix-os/contracts";
import { encodeBase64UrlJson, possessionPayload, signPayload, type ProofKeyPair } from "./direct-crypto.js";
import type { DirectConnected } from "./direct-client.js";
import { CollaborationDirectError } from "./direct-client.js";

const MAX_SOCKET_FRAME_CHARS = 512 * 1024;
const MAX_RECONNECT_DELAY_MS = 10_000;
const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * The home heartbeats every event stream every 10s, so a socket that has been
 * silent this long lost its peer without a close frame (network partition).
 * The same window bounds how long a socket may leave sends undrained.
 *
 * A terminal socket is legitimately silent while the shared terminal is idle:
 * the home pushes terminal frames only on output or a state change, so silence
 * on its own is not evidence of a partition. The event stream of the same scope
 * reaches the same home over the same connection, so its last frame is the
 * peer's liveness for every stream on that scope; when nothing on the scope has
 * been heard from inside the window, the terminal socket lost that peer too and
 * is re-dialed with a fresh ticket. A scope with no event stream keeps the
 * undrained-send rule as its only silence signal.
 */
const STALE_STREAM_TTL_MS = 45_000;
const STALE_SWEEP_INTERVAL_MS = 15_000;

export interface DirectEventHandlers {
  onEvent(): void | Promise<void>;
  onUnavailable(): void;
  onConnectionChange?(state: "connected" | "reconnecting"): void;
}

export interface DirectTerminalHandlers {
  onReady(frame: Extract<CollaborationTerminalFrame, { type: "terminal.ready" }>): void;
  onOutput(frame: Extract<CollaborationTerminalFrame, { type: "terminal.output" }>): void;
  onState(frame: Extract<CollaborationTerminalFrame, { type: "terminal.state" }>): void;
  onRefreshRequired(): void | Promise<void>;
  onUnavailable(): void;
  onDisconnected(): void;
}

type Purpose = "events" | "terminal";

interface StreamHandle {
  stop(): void;
  purpose: Purpose;
  /** Last successful open or inbound frame (ms since epoch); drives cap eviction. */
  lastTouched(): number;
  /**
   * Drops a socket that lost its peer without a close frame so it reconnects with a
   * fresh ticket. `peerTouchedAt` is the scope's newest event-stream frame, or null
   * when the scope has no event stream to speak for the peer.
   */
  sweep(now: number, peerTouchedAt: number | null): void;
}

export function createDirectStreams(deps: {
  ensure(scopeId: string): Promise<DirectConnected>;
  issueTicket(scopeId: string, purpose: Purpose, key: ProofKeyPair): Promise<{ signedTicket: CollaborationSignedConnectionTicket; origin: string }>;
  subtle?: SubtleCrypto;
  webSocketFactory?: (url: string) => WebSocket;
}) {
  const socketUrl = (origin: string, scopeId: string, purpose: "events" | "terminal", ticket: CollaborationSignedConnectionTicket, after: string) => {
    const url = new URL(`/ws/collaboration/direct/scopes/${scopeId}/${purpose}`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", encodeBase64UrlJson(ticket));
    url.searchParams.set("after", after);
    return url.href;
  };

  const MAX_STREAM_SCOPES = 128;
  const MAX_STREAMS_PER_SCOPE = 8;
  /** Every registered stream, keyed by scope; entries leave on unsubscribe, scope close, eviction or dispose. */
  const subscriptions = new Map<string, Map<() => void, StreamHandle>>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Newest inbound frame across a scope's event streams: the peer's liveness for the whole scope. */
  const peerTouchedAt = (streams: Map<() => void, StreamHandle>) => {
    let newest: number | null = null;
    for (const handle of streams.values()) {
      if (handle.purpose !== "events") continue;
      const touched = handle.lastTouched();
      if (newest === null || touched > newest) newest = touched;
    }
    return newest;
  };
  const sweepStale = () => {
    const now = Date.now();
    for (const streams of subscriptions.values()) {
      // Read the scope's peer liveness before any handle re-dials and resets its own clock.
      const peer = peerTouchedAt(streams);
      for (const handle of streams.values()) handle.sweep(now, peer);
    }
  };
  const syncSweepTimer = () => {
    if (subscriptions.size === 0) {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
    } else if (!sweepTimer) {
      sweepTimer = setInterval(sweepStale, STALE_SWEEP_INTERVAL_MS);
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  };
  const closeScope = (scopeId: string) => {
    for (const remove of [...(subscriptions.get(scopeId)?.keys() ?? [])]) remove();
    subscriptions.delete(scopeId);
    syncSweepTimer();
  };
  const closeAll = () => {
    for (const scopeId of [...subscriptions.keys()]) closeScope(scopeId);
  };
  const scopeTouchedAt = (streams: Map<() => void, StreamHandle>) => Math.max(0, ...[...streams.values()].map((handle) => handle.lastTouched()));
  /** Frees room for a new scope by dropping the scope whose streams have been silent longest (dead peers first). */
  const evictLeastRecentlyActiveScope = () => {
    sweepStale();
    let victim: string | undefined;
    let victimTouched = Number.POSITIVE_INFINITY;
    for (const [scopeId, streams] of subscriptions) {
      const touched = scopeTouchedAt(streams);
      if (touched < victimTouched) { victim = scopeId; victimTouched = touched; }
    }
    if (victim) closeScope(victim);
  };
  const register = (scopeId: string, handle: StreamHandle) => {
    if (!subscriptions.has(scopeId) && subscriptions.size >= MAX_STREAM_SCOPES) evictLeastRecentlyActiveScope();
    let active = subscriptions.get(scopeId);
    if (!active) { active = new Map(); subscriptions.set(scopeId, active); }
    if (active.size >= MAX_STREAMS_PER_SCOPE) active.keys().next().value?.();
    const remove = () => {
      handle.stop();
      active!.delete(remove);
      if (active!.size === 0 && subscriptions.get(scopeId) === active) subscriptions.delete(scopeId);
      syncSweepTimer();
    };
    active.set(remove, handle);
    syncSweepTimer();
    return remove;
  };

  /** Opens one stream: purpose ticket → socket → first-frame possession proof. Reconnects always start over with a new ticket. */
  const openStream = (scopeId: string, purpose: Purpose, after: () => string, bind: (socket: WebSocket, connected: DirectConnected, terminate: () => void) => void, onFailure: () => void): StreamHandle => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let touchedAt = Date.now();
    let stalledSince = 0;
    let lastBuffered = 0;
    const stop = () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      socket?.close(1000, "Closed");
      socket = null;
    };
    /** A partition leaves the socket open with no frames or undrained sends; treat it as closed and dial again. */
    const sweep = (now: number, peerTouchedAt: number | null) => {
      if (closed || !socket) return;
      const buffered = (socket as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered > 0 && buffered >= lastBuffered) stalledSince ||= now;
      else stalledSince = 0;
      lastBuffered = buffered;
      // An event stream speaks for itself; a terminal stream is judged by the scope's
      // event stream, which is the only frame the home is obliged to keep sending.
      const heardFrom = purpose === "events" ? touchedAt : peerTouchedAt;
      const silent = heardFrom !== null && now - heardFrom > STALE_STREAM_TTL_MS;
      const stalled = stalledSince !== 0 && now - stalledSince > STALE_STREAM_TTL_MS;
      if (!silent && !stalled) return;
      console.warn("[collaboration-direct] stale stream dropped", purpose, silent ? "silent" : "stalled");
      const stale = socket;
      stale.onmessage = null;
      stale.close(1001, "Stale");
      stale.onclose?.call(stale, undefined as unknown as CloseEvent);
    };
    const retry = () => {
      if (closed) return;
      const delay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** Math.min(attempt++, 5)));
      retryTimer = setTimeout(() => { void connect(); }, delay);
    };
    const connect = async () => {
      if (closed) return;
      try {
        const connected = await deps.ensure(scopeId);
        if (closed) return;
        const { signedTicket, origin } = await deps.issueTicket(scopeId, purpose, connected.key);
        if (closed) return;
        const next = (deps.webSocketFactory ?? ((url: string) => new WebSocket(url)))(socketUrl(origin, scopeId, purpose, signedTicket, after()));
        socket = next;
        touchedAt = Date.now();
        stalledSince = 0;
        lastBuffered = 0;
        bind(next, connected, stop);
        const boundMessage = next.onmessage;
        next.onmessage = (event) => {
          touchedAt = Date.now();
          (boundMessage as ((event: MessageEvent) => void) | null)?.call(next, event);
        };
        const previousOpen = next.onopen;
        next.onopen = (event) => {
          attempt = 0;
          touchedAt = Date.now();
          void signPayload(connected.key, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose, sessionId: connected.session.id }), deps.subtle)
            .then((possession) => {
              if (closed || socket !== next) return;
              next.send(JSON.stringify({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, type: "handshake", sessionId: connected.session.id, ticketNonce: signedTicket.ticket.nonce, possession }));
              (previousOpen as ((event: Event) => void) | null)?.call(next, event);
            })
            .catch((error: unknown) => {
              console.warn("[collaboration-direct] handshake failed", error instanceof Error ? error.name : "UnknownError");
              next.close(1008, "Handshake failed");
            });
        };
        const previousClose = next.onclose;
        let settled = false;
        next.onclose = (event) => {
          if (settled) return;
          settled = true;
          if (socket === next) socket = null;
          (previousClose as ((event: CloseEvent) => void) | null)?.call(next, event);
          if (closed) return;
          onFailure();
          retry();
        };
        next.onerror = () => next.close();
      } catch (error: unknown) {
        if (error instanceof CollaborationDirectError && error.code === "upgrade_required") {
          closed = true;
          onFailure();
          return;
        }
        console.warn("[collaboration-direct] stream connection failed", error instanceof Error ? error.name : "UnknownError");
        onFailure();
        retry();
      }
    };
    void connect();
    return { stop, purpose, lastTouched: () => touchedAt, sweep };
  };

  const subscribeEvents = (scopeId: string, handlers: DirectEventHandlers): (() => void) => {
    const parsedScopeId = CollaborationIdSchema.parse(scopeId);
    let sequence = "0";
    let stopped = false;
    const stream = openStream(parsedScopeId, "events", () => sequence, (socket, _connected, terminate) => {
      let usable = true;
      let refreshQueue = Promise.resolve();
      const enqueue = (operation: () => void | Promise<void>) => {
        refreshQueue = refreshQueue.then(async () => { if (usable && !stopped) await operation(); }).catch((error: unknown) => {
          console.warn("[collaboration-direct] canonical refresh failed", error instanceof Error ? error.name : "UnknownError");
          if (usable && !stopped) { usable = false; socket.close(1011, "Refresh failed"); }
        });
      };
      socket.onmessage = (event) => {
        if (!usable || stopped) return;
        if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_FRAME_CHARS) { socket.close(1008, "Invalid frame"); return; }
        try {
          const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
          if (frame.scopeId !== parsedScopeId) throw new Error("Scope mismatch");
          if (frame.type === "heartbeat") {
            socket.send(JSON.stringify({ version: 1, type: "heartbeat" }));
            enqueue(() => { sequence = frame.sequence; });
          } else if (frame.type === "ready") {
            handlers.onConnectionChange?.("connected");
            enqueue(() => { sequence = frame.sequence; });
          } else if (frame.type === "unavailable") {
            stopped = true;
            terminate();
            handlers.onUnavailable();
          } else {
            enqueue(async () => { await handlers.onEvent(); if (usable && !stopped) sequence = frame.sequence; });
          }
        } catch (error: unknown) {
          console.warn("[collaboration-direct] event frame rejected", error instanceof Error ? error.name : "UnknownError");
          socket.close(1008, "Invalid frame");
        }
      };
      socket.onclose = () => { usable = false; };
    }, () => { if (!stopped) handlers.onConnectionChange?.("reconnecting"); });
    return register(parsedScopeId, { ...stream, stop: () => { stopped = true; stream.stop(); } });
  };

  const subscribeTerminal = (scopeId: string, handlers: DirectTerminalHandlers): (() => void) => {
    const parsedScopeId = CollaborationIdSchema.parse(scopeId);
    let sequence = BigInt(0);
    let stopped = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const clearHeartbeat = () => { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = undefined; };
    const stream = openStream(parsedScopeId, "terminal", () => sequence.toString(), (socket, _connected, terminate) => {
      socket.onopen = () => {
        clearHeartbeat();
        heartbeatTimer = setInterval(() => { if (!stopped) socket.send(JSON.stringify({ version: 1, type: "heartbeat" })); }, TERMINAL_HEARTBEAT_INTERVAL_MS);
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        if (typeof event.data !== "string" || event.data.length > MAX_SOCKET_FRAME_CHARS) { socket.close(1008, "Invalid frame"); return; }
        try {
          const frame = CollaborationTerminalFrameSchema.parse(JSON.parse(event.data) as unknown);
          if (frame.scopeId !== parsedScopeId) throw new Error("Scope mismatch");
          if (frame.type === "terminal.ready") { sequence = maxSequence(sequence, frame.sequence); handlers.onReady(frame); }
          else if (frame.type === "terminal.output") {
            const next = BigInt(frame.sequence);
            if (next > sequence) { sequence = next; handlers.onOutput(frame); }
          } else if (frame.type === "terminal.state") { sequence = maxSequence(sequence, frame.sequence); handlers.onState(frame); }
          else if (frame.type === "terminal.refresh_required") {
            sequence = maxSequence(sequence, frame.sequence);
            void Promise.resolve(handlers.onRefreshRequired()).catch((error: unknown) => {
              console.warn("[collaboration-direct] terminal refresh failed", error instanceof Error ? error.name : "UnknownError");
              socket.close(1011, "Refresh failed");
            });
          } else { stopped = true; clearHeartbeat(); terminate(); handlers.onUnavailable(); }
        } catch (error: unknown) {
          console.warn("[collaboration-direct] terminal frame rejected", error instanceof Error ? error.name : "UnknownError");
          socket.close(1008, "Invalid frame");
        }
      };
      socket.onclose = () => { clearHeartbeat(); };
    }, () => { if (!stopped) handlers.onDisconnected(); });
    return register(parsedScopeId, { ...stream, stop: () => { stopped = true; clearHeartbeat(); stream.stop(); } });
  };

  return { subscribeEvents, subscribeTerminal, closeScope, closeAll };
}

function maxSequence(current: bigint, next: string): bigint {
  const parsed = BigInt(next);
  return parsed > current ? parsed : current;
}
