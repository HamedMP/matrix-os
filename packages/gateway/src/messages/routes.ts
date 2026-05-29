import { createHash, randomUUID } from "node:crypto";
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
  AutomationRuleCreateRequestSchema,
  AutomationRuleIdSchema,
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
  RecoveryRequestSchema,
  ReplyRequestSchema,
} from "./schemas.js";
import { mapMessagingError, MessagingError, redactMessagingErrorDetail } from "./errors.js";
import type { MessagingRepository } from "./repository.js";
import { HERMES_REPLY_SCOPE, constantTimeEqual, createHermesCapabilityReplayCache, verifyHermesCapabilityToken } from "./hermes-capability.js";
import { MESSAGING_APP_SERVICE_BODY_LIMIT } from "./constants.js";
import { createAutomationActionRunner } from "./automation-actions.js";
import { evaluateAutomationRules } from "./automation-evaluator.js";
import { createMessagingBridgeHealthService, type MessagingBridgeHealthService } from "./bridge-health.js";

export interface MessagingRouteDeps {
  repository: MessagingRepository;
  getOwnerId: (c: Context) => string;
  appserviceToken?: string;
  appserviceOwnerId?: string;
  hermesCapabilitySecret?: string;
  getHealth?: MessagingBridgeHealthService["getHealth"];
  startRecovery?: MessagingBridgeHealthService["startRecovery"];
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

function automationDraftClientTxnId(eventId: string, ruleId: string): string {
  return `auto_${createHash("sha256").update(`${eventId}:${ruleId}`).digest("hex")}`;
}

async function optionalJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return undefined;
    if (err instanceof TypeError) return undefined;
    throw err;
  }
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
  const healthService = createMessagingBridgeHealthService(deps.repository);
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

  app.get("/health", async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const getHealth = deps.getHealth ?? healthService.getHealth;
      return c.json(await getHealth({ ownerId }));
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
      const body = await optionalJsonBody(c);
      const parsed = DisconnectAccountRequestSchema.parse(body);
      return c.json(await deps.repository.disconnectAccount({ ownerId, accountId, ...parsed }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/recovery/:accountId", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const accountId = MessagingAccountIdSchema.parse(c.req.param("accountId"));
      const parsed = RecoveryRequestSchema.parse(await c.req.json());
      const startRecovery = deps.startRecovery ?? healthService.startRecovery;
      return c.json(await startRecovery({ ownerId, accountId, action: parsed.action }), 202);
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
        if (result.accepted && result.effect === "automation_queued") {
          const permission = await deps.repository.getPermission({ ownerId }, event.roomId);
          const rules = await deps.repository.listAutomationRules({ ownerId }, { roomId: event.roomId, limit: 100 });
          const permissionRevision = permission?.revision ?? 1;
          const runAction = createAutomationActionRunner({
            createTask: async (task) => {
              const workItem = await deps.repository.enqueueHermesWork({
                ownerId,
                roomId: event.roomId,
                sourceEventId: event.eventId,
                kind: "automation",
                permissionRevision,
                metadata: {
                  action: "create_task",
                  ruleTitle: task.title,
                },
              });
              return workItem.id;
            },
            createDraft: async (draft) => {
              const reply = await deps.repository.createReply({
                ownerId: draft.ownerId,
                roomId: draft.roomId,
                source: "automation",
                status: "approval_required",
                body: draft.body,
                permissionRevision,
                clientTxnId: automationDraftClientTxnId(event.eventId, draft.ruleId),
              });
              return reply.id;
            },
          });
          try {
            await evaluateAutomationRules({
              event: { ownerId, roomId: event.roomId, body: event.content.body },
              permission,
              rules: rules.items,
              runAction,
            });
          } catch (err: unknown) {
            console.error("[messages/routes] automation evaluation failed", redactMessagingErrorDetail(err));
          }
        }
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
      const hermesCapabilityHeader = c.req.header("X-Matrix-OS-Hermes-Capability") ?? c.req.header("x-matrix-os-hermes-capability") ?? "";
      let ownerId: string;
      if (parsed.source === "user") {
        if (hermesCapabilityHeader) {
          throw new MessagingError("forbidden", "mixed reply authentication mode", 403);
        }
        ownerId = getOwnerIdOrThrow(deps, c);
      } else {
        const secret = deps.hermesCapabilitySecret;
        const claims = secret ? verifyHermesCapabilityToken({
          token: hermesCapabilityHeader,
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

  app.get("/automation/rules", async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const parsed = DraftsQuerySchema.parse({
        roomId: c.req.query("roomId"),
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      const result = await deps.repository.listAutomationRules({ ownerId }, parsed);
      return c.json({ rules: result.items, nextCursor: result.nextCursor });
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/automation/rules", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const parsed = AutomationRuleCreateRequestSchema.parse(await c.req.json());
      return c.json(await deps.repository.createAutomationRule({ ownerId, ...parsed }), 201);
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.post("/automation/rules/:ruleId/pause", routeBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const ruleId = AutomationRuleIdSchema.parse(c.req.param("ruleId"));
      return c.json(await deps.repository.pauseAutomationRule({ ownerId, ruleId }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  app.delete("/automation/rules/:ruleId", deleteBodyLimit, async (c) => {
    try {
      const ownerId = getOwnerIdOrThrow(deps, c);
      const ruleId = AutomationRuleIdSchema.parse(c.req.param("ruleId"));
      return c.json(await deps.repository.deleteAutomationRule({ ownerId, ruleId }));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  return app;
}
