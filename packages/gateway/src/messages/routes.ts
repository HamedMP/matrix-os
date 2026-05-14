import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MESSAGING_DELETE_BODY_LIMIT,
  MESSAGING_ROUTE_BODY_LIMIT,
} from "./constants.js";
import {
  AppserviceEventsRequestSchema,
  ApproveDraftRequestSchema,
  AccountSetupRequestSchema,
  CancelDraftRequestSchema,
  CompleteSetupRequestSchema,
  DraftsQuerySchema,
  DisconnectAccountRequestSchema,
  ListQuerySchema,
  MessagingAccountIdSchema,
  MessagingNetworkSlugSchema,
  MessagingReplyIdSchema,
  MessagingSetupIdSchema,
  MatrixRoomIdSchema,
  PermissionUpdateRequestSchema,
  ReplyRequestSchema,
} from "./schemas.js";
import { mapMessagingError, MessagingError, redactMessagingErrorDetail } from "./errors.js";
import type { MessagingRepository } from "./repository.js";
import { HERMES_REPLY_SCOPE, constantTimeEqual, createHermesCapabilityReplayCache, verifyHermesCapabilityToken } from "./hermes-capability.js";
import { MESSAGING_APP_SERVICE_BODY_LIMIT } from "./constants.js";

export interface MessagingRouteDeps {
  repository: MessagingRepository;
  getOwnerId: (c: Context) => string;
  appserviceToken?: string;
  appserviceOwnerId?: string;
  hermesCapabilitySecret?: string;
}

function bodyTooLarge(c: Context) {
  return c.json({ error: { code: "body_too_large", message: "Request body too large" } }, 413);
}

function getOwnerIdOrThrow(deps: MessagingRouteDeps, c: Context): string {
  const ownerId = deps.getOwnerId(c);
  if (!ownerId) throw new MessagingError("unauthorized", "missing owner", 401);
  return ownerId;
}

function getAppserviceOwnerIdOrThrow(deps: MessagingRouteDeps): string {
  if (!deps.appserviceOwnerId) throw new MessagingError("misconfigured", "missing appservice owner", 503);
  return deps.appserviceOwnerId;
}

function handleMessagingRouteError(c: Context, err: unknown) {
  const mapped = mapMessagingError(err);
  if (mapped.log) {
    console.error("[messages/routes] request failed", redactMessagingErrorDetail(err));
  }
  return c.json(mapped.body, mapped.status);
}

export function createMessagingRoutes(deps: MessagingRouteDeps): Hono {
  const app = new Hono();
  const routeBodyLimit = bodyLimit({ maxSize: MESSAGING_ROUTE_BODY_LIMIT, onError: bodyTooLarge });
  const deleteBodyLimit = bodyLimit({ maxSize: MESSAGING_DELETE_BODY_LIMIT, onError: bodyTooLarge });
  const appserviceBodyLimit = bodyLimit({ maxSize: MESSAGING_APP_SERVICE_BODY_LIMIT, onError: bodyTooLarge });
  const hermesReplayCache = createHermesCapabilityReplayCache();

  app.get("/", (c) => c.json({ ok: true, module: "messages" }));

  app.get("/networks", async (c) => {
    try {
      return c.json({ networks: await deps.repository.listNetworks() });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.get("/accounts", async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      return c.json({ accounts: await deps.repository.listAccounts({ ownerId }) });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/accounts/setup", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const parsed = AccountSetupRequestSchema.parse(await c.req.json());
      return c.json(await deps.repository.createSetupSession({ ownerId, ...parsed }), 201);
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/accounts/setup/:setupId/complete", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const setupId = MessagingSetupIdSchema.parse(c.req.param("setupId"));
      const parsed = CompleteSetupRequestSchema.parse(await c.req.json());
      return c.json(await deps.repository.completeSetupSession({ ownerId, setupId, ...parsed }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.delete("/accounts/:accountId", deleteBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const accountId = MessagingAccountIdSchema.parse(c.req.param("accountId"));
      const hasBody = c.req.header("content-length") !== "0" && Boolean(c.req.header("content-type"));
      const parsed = hasBody ? DisconnectAccountRequestSchema.parse(await c.req.json()) : DisconnectAccountRequestSchema.parse(undefined);
      return c.json(await deps.repository.disconnectAccount({ ownerId, accountId, ...parsed }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.get("/conversations", async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const parsed = ListQuerySchema.parse({
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      const result = await deps.repository.listConversations({ ownerId }, parsed);
      const permissions = await deps.repository.getPermissions({ ownerId }, result.items.map((conversation) => conversation.roomId));
      return c.json({
        ...result,
        items: result.items.map((conversation) => ({
          ...conversation,
          permissions: permissions[conversation.roomId] ?? null,
        })),
      });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.patch("/conversations/:roomId/permissions", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const roomId = MatrixRoomIdSchema.parse(c.req.param("roomId"));
      const parsed = PermissionUpdateRequestSchema.parse(await c.req.json());
      const permissions = await deps.repository.updatePermission({
        ownerId,
        roomId,
        ...parsed,
        grantedBy: ownerId,
      });
      return c.json({ roomId, permissions });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/appservice/:network/events", appserviceBodyLimit, async (c) => {
    try {
      const expectedToken = deps.appserviceToken;
      const candidateToken = c.req.header("X-Matrix-OS-Appservice-Token") ?? "";
      if (!expectedToken || !constantTimeEqual(candidateToken, expectedToken)) {
        throw new MessagingError("unauthorized", "invalid appservice token", 401);
      }
      const networkSlug = MessagingNetworkSlugSchema.parse(c.req.param("network"));
      const ownerId = getAppserviceOwnerIdOrThrow(deps);
      const parsed = AppserviceEventsRequestSchema.parse(await c.req.json());
      let accepted = 0;
      let ignored = 0;
      for (const event of parsed.events) {
        const result = await deps.repository.ingestBridgeEvent({
          ownerId,
          networkSlug,
          accountId: event.accountId,
          roomId: event.roomId,
          eventId: event.eventId,
          externalEventId: event.externalEventId,
          content: event.content,
          occurredAt: event.occurredAt,
        });
        if (result.accepted) accepted += 1;
        else ignored += 1;
      }
      return c.json({ accepted, ignored }, 202);
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/conversations/:roomId/reply", routeBodyLimit, async (c) => {
    try {
      const roomId = MatrixRoomIdSchema.parse(c.req.param("roomId"));
      const parsed = ReplyRequestSchema.parse(await c.req.json());
      let ownerId: string;
      if (parsed.source === "user") {
        ownerId = getOwnerIdOrThrow(deps, c);
      } else {
        const token = c.req.header("X-Matrix-OS-Hermes-Capability") ?? c.req.header("x-matrix-os-hermes-capability") ?? "";
        const secret = deps.hermesCapabilitySecret;
        const claims = secret ? verifyHermesCapabilityToken({
          token,
          secret,
          roomId,
          scope: HERMES_REPLY_SCOPE,
        }) : null;
        if (!claims || !hermesReplayCache.consume(claims)) {
          throw new MessagingError("forbidden", "reply capability missing", 403);
        }
        ownerId = claims.ownerId;
      }
      const result = await deps.repository.createReplyAfterPermissionCheck({
        ownerId,
        roomId,
        source: parsed.source,
        body: parsed.body,
        mode: parsed.mode,
        clientTxnId: parsed.clientTxnId ?? `txn_${randomUUID().replaceAll("-", "")}`,
      });
      return c.json(result, 202);
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.get("/drafts", async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const parsed = DraftsQuerySchema.parse({
        roomId: c.req.query("roomId"),
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      const result = await deps.repository.listDrafts({ ownerId }, parsed);
      return c.json({
        drafts: result.items.map((reply) => ({
          replyId: reply.id,
          roomId: reply.roomId,
          source: reply.source,
          bodyPreview: reply.body.slice(0, 240),
          status: reply.status,
          createdAt: reply.createdAt,
        })),
        nextCursor: result.nextCursor,
      });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/drafts/:replyId/approve", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const replyId = MessagingReplyIdSchema.parse(c.req.param("replyId"));
      const parsed = ApproveDraftRequestSchema.parse(await c.req.json());
      return c.json(await deps.repository.approveReply({ ownerId, replyId, ...parsed }), 202);
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/drafts/:replyId/cancel", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const replyId = MessagingReplyIdSchema.parse(c.req.param("replyId"));
      const parsed = CancelDraftRequestSchema.parse(await c.req.json());
      return c.json(await deps.repository.cancelReply({ ownerId, replyId, ...parsed }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  return app;
}
