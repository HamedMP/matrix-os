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
  const subscriptions = new Map<string, Set<() => void>>();
  const closeScope = (scopeId: string) => {
    for (const stop of [...(subscriptions.get(scopeId) ?? [])]) stop();
  };
  const closeAll = () => {
    for (const scopeId of [...subscriptions.keys()]) closeScope(scopeId);
  };
  const register = (scopeId: string, stop: () => void) => {
    if (!subscriptions.has(scopeId) && subscriptions.size >= MAX_STREAM_SCOPES) closeScope(subscriptions.keys().next().value!);
    let active = subscriptions.get(scopeId);
    if (!active) { active = new Set(); subscriptions.set(scopeId, active); }
    if (active.size >= MAX_STREAMS_PER_SCOPE) active.values().next().value?.();
    const remove = () => {
      stop();
      active!.delete(remove);
      if (active!.size === 0) subscriptions.delete(scopeId);
    };
    active.add(remove);
    return remove;
  };

  /** Opens one stream: purpose ticket → socket → first-frame possession proof. Reconnects always start over with a new ticket. */
  const openStream = (scopeId: string, purpose: Purpose, after: () => string, bind: (socket: WebSocket, connected: DirectConnected, terminate: () => void) => void, onFailure: () => void) => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const stop = () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      socket?.close(1000, "Closed");
      socket = null;
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
        bind(next, connected, stop);
        const previousOpen = next.onopen;
        next.onopen = (event) => {
          attempt = 0;
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
        next.onclose = (event) => {
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
    return stop;
  };

  const subscribeEvents = (scopeId: string, handlers: DirectEventHandlers): (() => void) => {
    const parsedScopeId = CollaborationIdSchema.parse(scopeId);
    let sequence = "0";
    let stopped = false;
    const stop = openStream(parsedScopeId, "events", () => sequence, (socket, _connected, terminate) => {
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
    return register(parsedScopeId, () => { stopped = true; stop(); });
  };

  const subscribeTerminal = (scopeId: string, handlers: DirectTerminalHandlers): (() => void) => {
    const parsedScopeId = CollaborationIdSchema.parse(scopeId);
    let sequence = BigInt(0);
    let stopped = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const clearHeartbeat = () => { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = undefined; };
    const stop = openStream(parsedScopeId, "terminal", () => sequence.toString(), (socket, _connected, terminate) => {
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
    return register(parsedScopeId, () => { stopped = true; clearHeartbeat(); stop(); });
  };

  return { subscribeEvents, subscribeTerminal, closeScope, closeAll };
}

function maxSequence(current: bigint, next: string): bigint {
  const parsed = BigInt(next);
  return parsed > current ? parsed : current;
}
