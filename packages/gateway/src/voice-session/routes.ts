/**
 * Voice session HTTP + WebSocket routes (Layer 4).
 *
 * - `GET    /api/chats/:chatId/voice/capabilities`
 * - `POST   /api/chats/:chatId/voice/sessions`             (idempotent create)
 * - `DELETE /api/chats/:chatId/voice/sessions/:sessionId`  (idempotent end)
 * - `POST   /api/chats/:chatId/voice/sessions/:sessionId/reconnect`
 * - `GET    /ws/chats/:chatId/voice/:sessionId`            (ticket-owned upgrade)
 *
 * Principal comes from the injected resolver — the orchestrator binds real
 * gateway auth; this module never invents one. The WS path is NOT part of the
 * generic query-token allowlist: it verifies+consumes the one-time ticket in
 * constant time, checks Origin policy, and revalidates the exact
 * chat/session/epoch binding before any session mutation.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { UpgradeWebSocket, WSEvents, WSContext } from "hono/ws";
import { z } from "zod/v4";
import { CanonicalChatModelSelectionSchema } from "@matrix-os/contracts";
import {
  VoiceCanonicalChatIdSchema,
  VoiceCapabilitySchema,
  VoiceClientFrameSchema,
  VoiceSessionIdSchema,
  VoiceTurnModeSchema,
} from "@matrix-os/contracts/voice-session";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  type RequestPrincipal,
} from "../request-principal.js";
import { VoiceSessionError, type VoiceSessionEngine, type VoiceSessionTransportHandle } from "./engine.js";
import type { VoiceCapabilityPort, VoiceChatAccessPort } from "./ports.js";
import { VoiceTicketError, type VoiceTicketAuthority } from "./ticket-auth.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const CREATE_BODY_BYTES = 4 * 1024;
const RECONNECT_BODY_BYTES = 2 * 1024;
const DELETE_BODY_BYTES = 1024;
const DEFAULT_MAX_FRAME_BYTES = 96 * 1024;
const MAX_OUTBOUND_BUFFERED_BYTES = 512 * 1024;
const MAX_TICKET_PARAM = 256;

export const CreateVoiceSessionRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(160).regex(SAFE_ID),
  turnMode: VoiceTurnModeSchema,
  memoryMode: z.enum(["ordinary", "session_only"]),
  requestedTransport: z.enum(["relayed_websocket", "direct_webrtc"]).optional(),
  selection: CanonicalChatModelSelectionSchema,
  interactionMode: z.string().min(1).max(80).regex(SAFE_ID),
  permissionMode: z.string().min(1).max(80).regex(SAFE_ID),
  locale: z.string().min(2).max(35).regex(SAFE_ID).optional(),
}).strict();

export const ReconnectVoiceSessionRequestSchema = z.object({
  clientRequestId: z.string().min(1).max(160).regex(SAFE_ID).optional(),
}).strict();

const SurfaceQuerySchema = z.enum([
  "web_canvas",
  "web_desktop",
  "electron_desktop",
  "native_mobile",
]);

/** Exact WS path a minted ticket binds to — must equal the mounted route. */
export function voiceTransportPath(chatId: string, sessionId: string): string {
  return `/ws/chats/${chatId}/voice/${sessionId}`;
}

type Logger = (event: string, fields: Record<string, unknown>) => void;

function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.warn(`[voice-session] ${event}`, fields);
}

export interface VoiceSessionRoutesDeps {
  engine: VoiceSessionEngine;
  /** Orchestrator-bound auth; returns the trusted principal or throws. */
  resolvePrincipal(c: Context): RequestPrincipal;
  chatAccess: VoiceChatAccessPort;
  capabilities: VoiceCapabilityPort;
  /** Runs before expensive session/provider work. False → 429. */
  checkRateLimit?: (input: {
    principal: RequestPrincipal;
    action: "capabilities" | "create" | "delete" | "reconnect";
  }) => boolean | Promise<boolean>;
  log?: Logger;
}

function parseParam<T>(schema: { parse(value: unknown): T }, value: string): T {
  return schema.parse(value);
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (error: unknown) {
    // bodyLimit throws BodyLimitError mid-read when Content-Length is absent
    // or understated; surface it as 413 rather than a generic parse failure.
    if (error instanceof Error && error.name === "BodyLimitError") {
      throw new VoiceSessionError("payload_too_large", "Request body too large", 413);
    }
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new VoiceSessionError("invalid_request", "Request body must be valid JSON", 400);
  }
}

function routeError(c: Context, error: unknown, log: Logger): Response {
  if (error instanceof VoiceSessionError) {
    return c.json({ error: error.code }, error.status as 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return c.json({ error: "invalid_request" }, 400);
  }
  log("voice.route.unhandled_error", {
    error: error instanceof Error ? error.name : "UnknownError",
  });
  return c.json({ error: "internal_failure" }, 500);
}

function requirePrincipal(c: Context, deps: VoiceSessionRoutesDeps): RequestPrincipal {
  try {
    return deps.resolvePrincipal(c);
  } catch (error: unknown) {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      throw new VoiceSessionError(
        mapped.status === 401 ? "unauthorized" : "internal_failure",
        mapped.status === 401 ? "Unauthorized" : "Request failed",
        mapped.status,
      );
    }
    throw new VoiceSessionError("unauthorized", "Unauthorized", 401);
  }
}

export function createVoiceSessionRoutes(deps: VoiceSessionRoutesDeps): Hono {
  const app = new Hono();
  const log = deps.log ?? defaultLog;

  const rateLimited = async (
    principal: RequestPrincipal,
    action: "capabilities" | "create" | "delete" | "reconnect",
  ): Promise<void> => {
    if (!deps.checkRateLimit) return;
    const allowed = await deps.checkRateLimit({ principal, action });
    if (!allowed) {
      throw new VoiceSessionError("rate_limited", "Rate limited", 429);
    }
  };

  app.get("/api/chats/:chatId/voice/capabilities", async (c) => {
    try {
      const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
      const surface = c.req.query("surface");
      const parsedSurface = surface === undefined ? undefined : SurfaceQuerySchema.parse(surface);
      const principal = requirePrincipal(c, deps);
      await rateLimited(principal, "capabilities");
      await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "read" });
      const capability = await deps.capabilities.capabilities({
        principalId: principal.userId,
        chatId,
        ...(parsedSurface !== undefined ? { surface: parsedSurface } : {}),
      });
      // Defense in depth: a malformed/provider-shaped capability never serializes.
      return c.json(VoiceCapabilitySchema.parse(capability));
    } catch (error: unknown) {
      return routeError(c, error, log);
    }
  });

  app.post(
    "/api/chats/:chatId/voice/sessions",
    bodyLimit({ maxSize: CREATE_BODY_BYTES, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const request = CreateVoiceSessionRequestSchema.parse(await readJson(c));
        const principal = requirePrincipal(c, deps);
        await rateLimited(principal, "create");
        await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "write" });
        const result = deps.engine.createSession({ principal, chatId, request });
        if (result.outcome === "existing_consumed") {
          // Credential-less branch: transport/ticket/ephemeralCredential can
          // never serialize here (contract-asserted).
          return c.json({
            sessionId: result.session.sessionId,
            chatId: result.session.chatId,
            limits: result.session.limits,
            outcome: "existing_consumed",
            status: result.session.status,
            reconnectRequired: true,
          });
        }
        return c.json({
          sessionId: result.session.sessionId,
          chatId: result.session.chatId,
          limits: result.session.limits,
          outcome: result.outcome,
          status: "connecting",
          transport: {
            kind: result.lease.kind,
            url: result.lease.path,
            ticket: result.lease.ticket,
            expiresAt: result.lease.expiresAt,
            epoch: result.lease.epoch,
          },
        }, result.outcome === "created" ? 201 : 200);
      } catch (error: unknown) {
        return routeError(c, error, log);
      }
    },
  );

  app.delete(
    "/api/chats/:chatId/voice/sessions/:sessionId",
    bodyLimit({ maxSize: DELETE_BODY_BYTES, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const sessionId = parseParam(VoiceSessionIdSchema, c.req.param("sessionId"));
        const principal = requirePrincipal(c, deps);
        await rateLimited(principal, "delete");
        await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "write" });
        const result = await deps.engine.endSession({ principal, chatId, sessionId, kind: "user" });
        return c.json({
          sessionId: result.session.sessionId,
          chatId: result.session.chatId,
          status: result.session.status,
          ended: true,
          alreadyTerminal: result.alreadyTerminal,
        });
      } catch (error: unknown) {
        return routeError(c, error, log);
      }
    },
  );

  app.post(
    "/api/chats/:chatId/voice/sessions/:sessionId/reconnect",
    bodyLimit({ maxSize: RECONNECT_BODY_BYTES, onError: (c) => c.json({ error: "payload_too_large" }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const sessionId = parseParam(VoiceSessionIdSchema, c.req.param("sessionId"));
        // Reconnect body is optional; malformed JSON is still a 400, not a {}.
        const raw = await c.req.text().catch((error: unknown) => {
          if (!(error instanceof Error)) throw error;
          return "";
        });
        const request = ReconnectVoiceSessionRequestSchema.parse(
          raw.trim().length === 0 ? {} : JSON.parse(raw),
        );
        const principal = requirePrincipal(c, deps);
        await rateLimited(principal, "reconnect");
        await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "write" });
        const result = deps.engine.reconnectSession({
          principal,
          chatId,
          sessionId,
          ...(request.clientRequestId !== undefined ? { clientRequestId: request.clientRequestId } : {}),
        });
        return c.json({
          sessionId: result.session.sessionId,
          chatId: result.session.chatId,
          status: result.session.status,
          reconnectAttempts: result.session.reconnectAttempts,
          transport: {
            kind: result.lease.kind,
            url: result.lease.path,
            ticket: result.lease.ticket,
            expiresAt: result.lease.expiresAt,
            epoch: result.lease.epoch,
          },
        });
      } catch (error: unknown) {
        return routeError(c, error, log);
      }
    },
  );

  return app;
}

// ------------------------------------------------------------------ websocket

export interface VoiceUpgradeDeps {
  engine: VoiceSessionEngine;
  tickets: VoiceTicketAuthority;
  /** Exact Origin/reverse-proxy allowlist hook (no wildcards). */
  isOriginAllowed(origin: string | undefined): boolean;
  maxFrameBytes?: number;
  transportPath?: (chatId: string, sessionId: string) => string;
  log?: Logger;
}

function ticketFromQuery(c: Context): string {
  const params = new URL(c.req.url).searchParams;
  const keys = [...params.keys()];
  // Exactly one `ticket` param: upstream proxy layers (packages/platform
  // ws-upgrade stripWebSocketUpgradeToken) strip `token`/`runtime` before
  // forwarding, so a rejected multi-param request means the strip layer is
  // missing — fix the proxy path rather than relaxing this invariant.
  if (keys.length !== 1 || keys[0] !== "ticket") {
    throw new VoiceSessionError("invalid_request", "Upgrade requires exactly one ticket parameter", 400);
  }
  const ticket = params.get("ticket") ?? "";
  if (ticket.length === 0 || ticket.length > MAX_TICKET_PARAM) {
    throw new VoiceSessionError("invalid_request", "Ticket parameter is malformed", 400);
  }
  return ticket;
}

/**
 * WS upgrade handler factory. Verification order on open: Origin allowlist →
 * constant-time ticket verify + atomic single-use consume → exact
 * chat/session/principal/epoch binding via `engine.attachTransport`. Any
 * failure closes the socket before session mutation.
 */
export function createVoiceUpgradeHandler(deps: VoiceUpgradeDeps) {
  const log = deps.log ?? defaultLog;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const transportPath = deps.transportPath ?? voiceTransportPath;

  return (c: Context): WSEvents => {
    const sessionIdForLog = c.req.param("sessionId") ?? "";
    let handle: VoiceSessionTransportHandle | undefined;

    const fail = (ws: WSContext, reason: string) => {
      try {
        ws.close(1008, reason);
      } catch (error: unknown) {
        log("voice.ws.close_failed", { error: error instanceof Error ? error.name : "UnknownError" });
      }
    };

    return {
      onOpen(_event, ws) {
        try {
          // Origin allowlist first — before any credential/session work.
          if (!deps.isOriginAllowed(c.req.header("origin"))) {
            throw new VoiceSessionError("unauthorized", "Origin is not allowed", 401);
          }
          const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId") ?? "");
          const sessionId = parseParam(VoiceSessionIdSchema, c.req.param("sessionId") ?? "");
          const ticket = ticketFromQuery(c);
          const consumed = deps.tickets.consume(ticket, {
            path: transportPath(chatId, sessionId),
            sessionId,
            chatId,
          });
          const sink = {
            send: (frame: unknown) => {
              const raw = ws.raw as { bufferedAmount?: number } | undefined;
              if ((raw?.bufferedAmount ?? 0) > MAX_OUTBOUND_BUFFERED_BYTES) {
                throw new VoiceSessionError("connection_lost", "Outbound buffer exceeded", 500);
              }
              ws.send(JSON.stringify(frame));
            },
            close: (code: number, reason: string) => {
              try {
                ws.close(code, reason);
              } catch (error: unknown) {
                log("voice.ws.close_failed", { error: error instanceof Error ? error.name : "UnknownError" });
              }
            },
          };
          handle = deps.engine.attachTransport(
            {
              sessionId,
              chatId,
              principalId: consumed.binding.principalId,
              generation: consumed.binding.generation,
            },
            sink,
          );
        } catch (error: unknown) {
          log("voice.ws.upgrade_rejected", {
            sessionId: sessionIdForLog,
            error: error instanceof VoiceTicketError || error instanceof VoiceSessionError
              ? error.code
              : "UnknownError",
          });
          fail(ws, "Unauthorized");
        }
      },
      onMessage(event, ws) {
        try {
          const data = event.data;
          if (typeof data !== "string" || Buffer.byteLength(data) > maxFrameBytes) {
            throw new VoiceSessionError("invalid_request", "Frame is not bounded JSON", 400);
          }
          const frame = VoiceClientFrameSchema.parse(JSON.parse(data));
          void handle?.receive(frame);
        } catch (error: unknown) {
          log("voice.ws.invalid_frame", {
            sessionId: sessionIdForLog,
            error: error instanceof Error ? error.name : "UnknownError",
          });
          fail(ws, "Invalid frame");
        }
      },
      onClose() {
        handle?.transportClosed();
        handle = undefined;
      },
      onError() {
        handle?.transportClosed();
        handle = undefined;
      },
    };
  };
}

/** Convenience registration so `server.ts` only wires the injected upgrader. */
export function registerVoiceSessionWebSocketRoute(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
} & VoiceUpgradeDeps): void {
  const handler = createVoiceUpgradeHandler(options);
  options.app.get(
    "/ws/chats/:chatId/voice/:sessionId",
    options.upgradeWebSocket((c) => handler(c)),
  );
}
