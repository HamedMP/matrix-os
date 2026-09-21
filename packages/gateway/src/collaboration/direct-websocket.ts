/**
 * Direct WebSocket routes on the home (S05 / T027, T028).
 *
 * Browsers cannot set headers on an upgrade, so the client presents a
 * one-use, short-lived purpose ticket in the query (redacted from logs) and
 * proves possession of its session key in the first bounded frame before
 * any output is sent. Every later frame is schema-checked. A five-second
 * watchdog closes the stream when the session ends, evidence lapses or the
 * authority generation moves; a reconnect never extends a lease.
 */
import {
  COLLABORATION_DIRECT_LIMITS,
  CollaborationClientFrameSchema,
  CollaborationDirectHandshakeFrameSchema,
  CollaborationIdSchema,
  CollaborationRevisionSchema,
  CollaborationTerminalActionSchema,
  type CollaborationConnectionTicket,
} from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v4";
import type { CollaborationAuthority } from "./authority.js";
import type { DirectTicketVerifier } from "./direct-auth.js";
import type { DirectSessionService } from "./direct-sessions.js";
import type { CollaborationEventRegistry } from "./events.js";
import type { TerminalControlCoordinator } from "./terminal-control.js";
import type { CollaborationTerminalDispatcher } from "./terminal-dispatcher.js";
import type { CollaborationTerminalEventRegistry } from "./terminal-events.js";

export const DIRECT_WS_PATH_PATTERN = /^\/ws\/collaboration\/direct\/scopes\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:events|terminal)$/;
const MAX_FRAME_BYTES = COLLABORATION_DIRECT_LIMITS.wsFrameBytes;
const WATCHDOG_MS = COLLABORATION_DIRECT_LIMITS.streamWatchdogSeconds * 1_000;
const HANDSHAKE_TIMEOUT_MS = COLLABORATION_DIRECT_LIMITS.streamWatchdogSeconds * 1_000;
const MAX_TICKET_PARAM = 4_096;
const QuerySchema = z.object({ ticket: z.string().min(1).max(MAX_TICKET_PARAM).regex(/^[A-Za-z0-9_-]+$/), after: CollaborationRevisionSchema.default("0") }).strict();

interface SocketLike { send(value: string): void; close(code?: number, reason?: string): void; raw?: unknown }

export function registerCollaborationDirectWebSocketRoutes(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  verifier: DirectTicketVerifier;
  sessions: DirectSessionService;
  authority: CollaborationAuthority;
  events: CollaborationEventRegistry;
  terminal?: { dispatcher: CollaborationTerminalDispatcher; registry: CollaborationTerminalEventRegistry; control: TerminalControlCoordinator };
  createConnectionId?: () => string;
}): void {
  const createConnectionId = options.createConnectionId ?? (() => `connection_${randomUUID().replaceAll("-", "")}`);

  const register = (purpose: "events" | "terminal") => {
    options.app.get(`/ws/collaboration/direct/scopes/:scopeId/${purpose}`, options.upgradeWebSocket((context) => {
      const scopeId = CollaborationIdSchema.parse(context.req.param("scopeId"));
      const query = parseQuery(context);
      let ticket: CollaborationConnectionTicket | null = null;
      let stream: { close(): void; touch(): void; resume?(sequence: number, generation: number): Promise<void> } | null = null;
      let release: (() => void) | null = null;
      let sessionId: string | null = null;
      let actorId: string | null = null;
      let connectionId: string | null = null;
      let generation = 0;
      let socketClosed = false;
      let processing = Promise.resolve();
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let unsubscribeEnded: (() => void) | null = null;

      const shutdownStream = (ws: SocketLike, code: number, reason: string) => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        if (watchdog) clearInterval(watchdog);
        handshakeTimer = null;
        watchdog = null;
        unsubscribeEnded?.();
        unsubscribeEnded = null;
        stream?.close();
        stream = null;
        release?.();
        release = null;
        if (connectionId && purpose === "terminal") options.terminal?.control.markDisconnected(scopeId, connectionId);
        if (!socketClosed) {
          sendError(ws);
          ws.close(code, reason);
        }
      };

      const admit = async (raw: string, ws: SocketLike) => {
        const frame = CollaborationDirectHandshakeFrameSchema.parse(JSON.parse(raw) as unknown);
        if (!ticket) throw new Error("ticket missing");
        const opened = await options.sessions.openStream({ ticket, handshake: frame });
        release = opened.release;
        const authorized = await options.authority.authorize({ scopeId, actorId: opened.session.actorId, action: "read" });
        if (authorized.authorityGeneration !== opened.session.authorityGeneration) throw new Error("generation mismatch");
        if (purpose === "terminal" && authorized.resourceKind !== "terminal") throw new Error("not a terminal scope");
        sessionId = opened.session.id;
        actorId = opened.session.actorId;
        generation = authorized.authorityGeneration;
        const nextConnectionId = createConnectionId();
        const socket = { send: (value: string) => { ws.send(value); }, close: (code?: number, reason?: string) => { ws.close(code, reason); }, get bufferedAmount() { return rawBufferedAmount(ws.raw); } };
        if (purpose === "events") {
          stream = await options.events.open({ connectionId: nextConnectionId, scopeId, actorId: opened.session.actorId, authorityGeneration: generation, afterSequence: Number(query.after), socket });
        } else {
          if (!options.terminal) throw new Error("terminal unavailable");
          stream = await options.terminal.registry.open({ connectionId: nextConnectionId, scopeId, actorId: opened.session.actorId, authorityGeneration: generation, afterSequence: Number(query.after), socket });
        }
        connectionId = nextConnectionId;
        if (socketClosed) {
          shutdownStream(ws, 1001, "Closed");
          return;
        }
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        // A denial, expiry or exhaustion closes this socket at once; the watchdog is the backstop.
        unsubscribeEnded = options.sessions.subscribeEnded((ended) => {
          if (ended.id === sessionId) shutdownStream(ws, 1008, "Session ended");
        });
        watchdog = setInterval(() => {
          const live = sessionId ? options.sessions.describe(sessionId) : null;
          if (!live || live.authorityGeneration !== generation || Date.parse(live.evidenceExpiresAt) <= Date.now()) {
            // Evidence is refreshed only by signed requests; a silent stream past its deadline ends here.
            if (live && live.authorityGeneration === generation && Date.parse(live.expiresAt) > Date.now() && Date.parse(live.evidenceExpiresAt) > Date.now() - WATCHDOG_MS) return;
            shutdownStream(ws, 1008, "Lease expired");
          }
        }, WATCHDOG_MS);
        watchdog.unref?.();
      };

      const processFrame = (raw: string, ws: SocketLike) => {
        processing = processing.then(async () => {
          if (!stream) {
            await admit(raw, ws);
            return;
          }
          const parsed = JSON.parse(raw) as unknown;
          const lifecycle = CollaborationClientFrameSchema.safeParse(parsed);
          if (lifecycle.success && lifecycle.data.type === "heartbeat") {
            stream.touch();
            return;
          }
          if (purpose === "events") {
            const frame = CollaborationClientFrameSchema.parse(parsed);
            if (frame.type !== "heartbeat") {
              if (frame.scopeId !== scopeId) throw new Error("scope mismatch");
              options.sessions.spendStreamInput(sessionId!);
              await stream.resume?.(Number(frame.sequence), Number(frame.authorityGeneration));
            }
            return;
          }
          const action = CollaborationTerminalActionSchema.parse(parsed);
          options.sessions.spendStreamInput(sessionId!);
          await options.terminal!.dispatcher.dispatch({ scopeId, actorId: actorId!, connectionId: connectionId!, action });
          await options.terminal!.registry.publishState(scopeId);
          stream.touch();
        }).catch((error: unknown) => {
          console.warn(`[collaboration-direct-ws:${purpose}] frame rejected`, error instanceof Error ? error.name : "UnknownError");
          shutdownStream(ws, 1008, "Invalid frame");
        });
      };

      return {
        onOpen(_event, ws) {
          try {
            const parsedTicket = options.verifier.verifyTicket(decodeTicket(query.ticket));
            if (parsedTicket.purpose !== purpose || parsedTicket.resource.scopeId !== scopeId) throw new Error("ticket mismatch");
            ticket = parsedTicket;
          } catch (error: unknown) {
            console.warn(`[collaboration-direct-ws:${purpose}] ticket rejected`, error instanceof Error ? error.name : "UnknownError");
            shutdownStream(ws as SocketLike, 1008, "Unavailable");
            return;
          }
          handshakeTimer = setTimeout(() => shutdownStream(ws as SocketLike, 1008, "Handshake timeout"), HANDSHAKE_TIMEOUT_MS);
          handshakeTimer.unref?.();
        },
        onMessage(event, ws) {
          const raw = frameText(event.data);
          if (raw === null || !ticket) {
            shutdownStream(ws as SocketLike, 1008, "Invalid frame");
            return;
          }
          processFrame(raw, ws as SocketLike);
        },
        onClose() {
          socketClosed = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          if (watchdog) clearInterval(watchdog);
          unsubscribeEnded?.();
          unsubscribeEnded = null;
          stream?.close();
          stream = null;
          release?.();
          release = null;
          if (connectionId && purpose === "terminal") options.terminal?.control.markDisconnected(scopeId, connectionId);
        },
      };
    }));
  };

  register("events");
  if (options.terminal) register("terminal");
}

function parseQuery(context: Context): z.infer<typeof QuerySchema> {
  const params = new URL(context.req.url).searchParams;
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "ticket" && key !== "after") || keys.filter((key) => key === "ticket").length !== 1 || keys.filter((key) => key === "after").length > 1) {
    throw new SyntaxError("Invalid direct stream query");
  }
  return QuerySchema.parse(Object.fromEntries(params.entries()));
}

/** The ticket parameter is the base64url JSON of the signed ticket; it is never logged. */
function decodeTicket(encoded: string): unknown {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
}

function frameText(value: unknown): string | null {
  if (typeof value === "string") return Buffer.byteLength(value) <= MAX_FRAME_BYTES ? value : null;
  if (value instanceof ArrayBuffer) return value.byteLength <= MAX_FRAME_BYTES ? new TextDecoder().decode(value) : null;
  if (ArrayBuffer.isView(value)) {
    return value.byteLength <= MAX_FRAME_BYTES ? new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) : null;
  }
  return null;
}

function rawBufferedAmount(raw: unknown): number {
  const amount = (raw as { bufferedAmount?: unknown } | undefined)?.bufferedAmount;
  return typeof amount === "number" ? amount : 0;
}

function sendError(ws: SocketLike): void {
  try {
    ws.send(JSON.stringify({ version: 1, type: "collaboration.error", code: "unavailable" }));
  } catch (error: unknown) {
    console.warn("[collaboration-direct-ws] error send failed", error instanceof Error ? error.name : "UnknownError");
  }
}
