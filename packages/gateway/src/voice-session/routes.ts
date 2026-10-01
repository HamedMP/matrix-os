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
  SafeVoiceErrorCodeSchema,
  type SafeVoiceError,
  type VoiceCapability,
} from "@matrix-os/contracts/voice-session";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  type RequestPrincipal,
} from "../request-principal.js";
import { VoiceSessionError, type VoiceSessionEngine, type VoiceSessionTransportHandle } from "./engine.js";
import type { VoiceCanonicalDecision, VoiceCapabilityPort, VoiceChatAccessPort } from "./ports.js";
import { VOICE_ERROR_RECOVERY } from "./adapter.js";
import { canonicalJsonStringify } from "../chat/argument-digest.js";
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
  /** Server-injected canonical catalog/tool/scope/account policy decision.
   * Speech actionMode is deliberately not action authority. Production composition
   * must supply this; absent decision can advertise conversation-only, never tools. */
  canonicalDecision?: (input: { principal: RequestPrincipal; chatId: string; surface?: string }) => Promise<VoiceCanonicalDecision | undefined> | VoiceCanonicalDecision | undefined;
  /** Canonical provider-catalog voice eligibility; shared by advertise and create. */
  routeEligibility?: (input: {
    principal: RequestPrincipal;
    chatId: string;
    selection?: z.infer<typeof CanonicalChatModelSelectionSchema>;
  }) => boolean | Promise<boolean>;
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

export function safeVoiceRestError(code: string): SafeVoiceError {
  if (code === "unauthorized") return { code: "permission_denied", retryable: false, recovery: "none" };
  if (code === "invalid_request" || code === "payload_too_large") return { code: "session_conflict", retryable: false, recovery: "none" };
  if (code === "rate_limited") return { code: "session_limit_reached", retryable: true, recovery: "retry_connection" };
  if (code === "not_found") return { code: "chat_unavailable", retryable: false, recovery: "start_new_session" };
  if (code === "unavailable") return { code: "provider_unavailable", retryable: true, recovery: "retry_connection" };
  const parsed = SafeVoiceErrorCodeSchema.safeParse(code);
  const safe = parsed.success ? parsed.data : "internal_failure";
  return { code: safe, retryable: ["connection_failed", "connection_lost", "provider_unavailable"].includes(safe),
    recovery: VOICE_ERROR_RECOVERY[safe] };
}

export function projectVoiceCapability(speech: VoiceCapability, decision?: VoiceCanonicalDecision): VoiceCapability {
  const canonical = decision?.capability;
  const modes = ["conversation_only", "safe_reads", "canonical_actions"] as const;
  const actionMode = decision?.executionPolicy.tools.length && canonical
    ? modes[Math.min(modes.indexOf(decision.executionPolicy.actionMode), modes.indexOf(canonical.actionMode))]
    : "conversation_only";
  const projected = VoiceCapabilitySchema.safeParse({ ...speech,
    ...(canonical ? {
      status: speech.status === "unavailable" || canonical.status === "unavailable" ? "unavailable"
        : speech.status === "degraded" || canonical.status === "degraded" ? "degraded" : "available",
      transportModes: speech.transportModes.filter((mode) => canonical.transportModes.includes(mode)),
      turnModes: speech.turnModes.filter((mode) => canonical.turnModes.includes(mode)),
      supportsInterruption: speech.supportsInterruption && canonical.supportsInterruption,
      resume: canonical.resume === "unsupported" || speech.resume === "unsupported" ? "unsupported"
        : canonical.resume === "delivery_aware" && speech.resume === "delivery_aware" ? "delivery_aware" : "rebuild_only",
      ...(canonical.reason ? { reason: canonical.reason } : {}),
    } : {}),
    sessionOnly: "unsupported",
    actionMode,
    actionCancellation: canonical?.actionCancellation ?? "none",
  });
  if (!projected.success) throw new VoiceSessionError("internal_failure", "Voice capability unavailable", 503);
  return projected.data;
}

function routeError(c: Context, error: unknown, log: Logger): Response {
  if (error instanceof VoiceSessionError) {
    return c.json({ error: safeVoiceRestError(error.code) }, error.status as 400 | 401 | 404 | 409 | 413 | 422 | 429 | 500 | 503);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return c.json({ error: safeVoiceRestError("invalid_request") }, 400);
  }
  log("voice.route.unhandled_error", {
    error: error instanceof Error ? error.name : "UnknownError",
  });
  return c.json({ error: safeVoiceRestError("internal_failure") }, 500);
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
  // Independent cleanup budget: bounded owner registry + fixed-window expiry.
  // Ordinary create exhaustion must never strand owned media.
  const cleanupBudgets = new Map<string, { until: number; used: number }>();
  const cleanupAllowed = (ownerId: string): boolean => {
    const now = deps.engine.clock.now();
    for (const [id, budget] of cleanupBudgets) if (budget.until <= now) cleanupBudgets.delete(id);
    let budget = cleanupBudgets.get(ownerId);
    if (!budget) {
      if (cleanupBudgets.size >= 256) return false;
      budget = { until: now + 60_000, used: 0 };
      cleanupBudgets.set(ownerId, budget);
    }
    budget.used += 1;
    return budget.used <= 12;
  };

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
      if (deps.routeEligibility && !await deps.routeEligibility({ principal, chatId })) {
        const capability = await deps.capabilities.capabilities({
          principalId: principal.userId,
          chatId,
          ...(parsedSurface !== undefined ? { surface: parsedSurface } : {}),
        });
        return c.json(VoiceCapabilitySchema.parse({
          ...capability,
          status: "unavailable",
          transportModes: [],
          turnModes: [],
          reason: "provider_unavailable",
          actionMode: "conversation_only", actionCancellation: "none", sessionOnly: "unsupported",
        }));
      }
      const capability = await deps.capabilities.capabilities({
        principalId: principal.userId,
        chatId,
        ...(parsedSurface !== undefined ? { surface: parsedSurface } : {}),
      });
      const decision = await deps.canonicalDecision?.({ principal, chatId,
        ...(parsedSurface ? { surface: parsedSurface } : {}) });
      return c.json(projectVoiceCapability(capability, decision));
    } catch (error: unknown) {
      return routeError(c, error, log);
    }
  });

  app.post(
    "/api/chats/:chatId/voice/sessions",
    bodyLimit({ maxSize: CREATE_BODY_BYTES, onError: (c) => c.json({ error: safeVoiceRestError("payload_too_large") }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const request = CreateVoiceSessionRequestSchema.parse(await readJson(c));
        const principal = requirePrincipal(c, deps);
        await rateLimited(principal, "create");
        await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "write" });
        if (deps.routeEligibility && !await deps.routeEligibility({
          principal,
          chatId,
          selection: request.selection,
        })) {
          throw new VoiceSessionError(
            "unsupported_surface",
            "The selected Provider is not eligible for a voice conversation",
            422,
          );
        }
        // Session create rides the server-owned canonical decision only. A
        // Chat without a persisted canonical selection yields no decision —
        // `request.selection` is never trusted as a substitute.
        const decision = await deps.canonicalDecision?.({ principal, chatId });
        if (!decision) {
          throw new VoiceSessionError("provider_unavailable", "Voice unavailable", 503);
        }
        const capability = projectVoiceCapability(await deps.capabilities.capabilities({ principalId: principal.userId, chatId }), decision);
        if (capability.status === "unavailable") throw new VoiceSessionError("provider_unavailable", "Voice unavailable", 503);
        if (request.memoryMode === "session_only" || !capability.turnModes.includes(request.turnMode)
          || !capability.transportModes.includes(request.requestedTransport ?? "relayed_websocket")) {
          throw new VoiceSessionError("unsupported_surface", "Voice mode unavailable", 422);
        }
        if (canonicalJsonStringify(decision.selection) !== canonicalJsonStringify(request.selection)) {
          throw new VoiceSessionError("session_conflict", "Canonical selection changed", 409);
        }
        const result = deps.engine.createSession({ principal, chatId,
          request: { ...request, selection: decision.selection,
            permissionMode: decision.permissionMode, interactionMode: decision.interactionMode },
          executionPolicy: decision.executionPolicy,
        });
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
    bodyLimit({ maxSize: DELETE_BODY_BYTES, onError: (c) => c.json({ error: safeVoiceRestError("payload_too_large") }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const sessionId = parseParam(VoiceSessionIdSchema, c.req.param("sessionId"));
        const principal = requirePrincipal(c, deps);
        // Exact owner/session binding first. Cleanup remains authorized after
        // backing Chat deletion/access loss; it never admits canonical work.
        if (!deps.engine.describeSession({ principal, chatId, sessionId })) {
          throw new VoiceSessionError("not_found", "Session unavailable", 404);
        }
        if (!cleanupAllowed(principal.userId)) throw new VoiceSessionError("rate_limited", "Cleanup rate limited", 429);
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
    bodyLimit({ maxSize: RECONNECT_BODY_BYTES, onError: (c) => c.json({ error: safeVoiceRestError("payload_too_large") }, 413) }),
    async (c) => {
      try {
        const chatId = parseParam(VoiceCanonicalChatIdSchema, c.req.param("chatId"));
        const sessionId = parseParam(VoiceSessionIdSchema, c.req.param("sessionId"));
        // Reconnect body is optional; malformed JSON is still a 400, not a {}.
        const raw = await c.req.text().catch((error: unknown) => {
          if (error instanceof Error && error.name === "BodyLimitError") {
            throw new VoiceSessionError("payload_too_large", "Request body too large", 413);
          }
          throw error;
        });
        const request = ReconnectVoiceSessionRequestSchema.parse(
          raw.trim().length === 0 ? {} : JSON.parse(raw),
        );
        const principal = requirePrincipal(c, deps);
        if (!deps.engine.describeSession({ principal, chatId, sessionId })) {
          throw new VoiceSessionError("not_found", "Session unavailable", 404);
        }
        await rateLimited(principal, "reconnect");
        try {
          await deps.chatAccess.requireAccess({ principalId: principal.userId, chatId, level: "write" });
          const decision = await deps.canonicalDecision?.({ principal, chatId });
          const capability = projectVoiceCapability(await deps.capabilities.capabilities({ principalId: principal.userId, chatId }), decision);
          if (capability.status === "unavailable" || (deps.routeEligibility && !await deps.routeEligibility({ principal, chatId }))) {
            throw new VoiceSessionError("provider_unavailable", "Voice unavailable", 503);
          }
          if (deps.canonicalDecision) {
            // A session created under a canonical decision must still resolve
            // one; a vanished decision means its policy can no longer be
            // re-verified, so reconnect fails closed.
            if (!decision) throw new VoiceSessionError("provider_unavailable", "Voice unavailable", 503);
            deps.engine.assertCanonicalDecision({ principal, chatId, sessionId }, decision);
          }
        } catch (error: unknown) {
          // End the session only on definitive invalidation — the chat is
          // gone or the session's pinned canonical policy no longer resolves.
          // Transient failures (DB, readiness probe, capability outage) keep
          // the session alive so the client can retry the reconnect.
          if (error instanceof VoiceSessionError
            && (error.code === "not_found" || error.code === "session_conflict")) {
            await deps.engine.endSession({ principal, chatId, sessionId, kind: "user" });
          }
          throw error;
        }
        const result = deps.engine.reconnectSession({
          principal,
          chatId,
          sessionId,
          ...(request.clientRequestId !== undefined ? { clientRequestId: request.clientRequestId } : {}),
        });
        return c.json({
          sessionId: result.session.sessionId,
          chatId: result.session.chatId,
          limits: result.session.limits,
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
