import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MESSAGING_DELETE_BODY_LIMIT,
  MESSAGING_ROUTE_BODY_LIMIT,
} from "./constants.js";
import {
  AccountSetupRequestSchema,
  CompleteSetupRequestSchema,
  DisconnectAccountRequestSchema,
  ListQuerySchema,
  MessagingAccountIdSchema,
  MessagingSetupIdSchema,
} from "./schemas.js";
import { mapMessagingError, MessagingError, redactMessagingErrorDetail } from "./errors.js";
import type { MessagingRepository } from "./repository.js";

export interface MessagingRouteDeps {
  repository: MessagingRepository;
  getOwnerId: (c: Context) => string;
}

function bodyTooLarge(c: Context) {
  return c.json({ error: { code: "body_too_large", message: "Request body too large" } }, 413);
}

function getOwnerIdOrThrow(deps: MessagingRouteDeps, c: Context): string {
  const ownerId = deps.getOwnerId(c);
  if (!ownerId) throw new MessagingError("unauthorized", "missing owner", 401);
  return ownerId;
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
      return c.json(await deps.repository.listConversations({ ownerId }, parsed));
    } catch (err: unknown) {
      return handleMessagingRouteError(c, err);
    }
  });

  return app;
}
