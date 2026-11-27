import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z, ZodError } from "zod/v4";
import {
  MESSAGING_BRIDGE_FIELD_VALUE_MAX,
  MatrixRoomIdSchema,
  MessagingBridgeConversationsQuerySchema,
  MessagingBridgeLinkStartRequestSchema,
  MessagingBridgeLinkStepRequestSchema,
  MessagingBridgeMessagesQuerySchema,
  MessagingBridgeNetworkSchema,
  MessagingBridgeSendRequestSchema,
  type MessagingBridgeErrorCode,
} from "@matrix-os/contracts/messaging-bridge";
import {
  InvalidRequestPrincipalError,
  MissingRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
} from "../request-principal.js";
import { MESSAGING_DELETE_BODY_LIMIT, MESSAGING_ROUTE_BODY_LIMIT } from "./constants.js";
import { errorName } from "./bridge-http.js";
import { LINK_ID_PATTERN } from "./bridge-link-sessions.js";
import { MessagingBridgeServiceError, type MessagingBridgeService } from "./bridge-service.js";
import { InvalidBridgeCursorError } from "./bridge-store.js";
import { MessagingAccountIdSchema } from "./schemas.js";

/** Renderer routes for the shared messaging bridge, mounted at `/api/messages/bridge`. */

const SAFE_MESSAGES: Record<MessagingBridgeErrorCode, string> = {
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_enabled: "Chat apps are not available yet",
  not_found: "Not found",
  invalid_request: "Invalid request",
  conflict: "Conflict",
  rate_limited: "Too many requests",
  bridge_unavailable: "Chat apps are temporarily unavailable",
  misconfigured: "Messaging is not configured",
  internal: "Messaging request failed",
};

const STATUS: Record<MessagingBridgeErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  not_enabled: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  rate_limited: 429,
  bridge_unavailable: 503,
  misconfigured: 503,
  internal: 500,
};

const LinkIdSchema = z.string().regex(LINK_ID_PATTERN);
const LINK_STEP_MAX_FIELDS = 12;
// 12 fields of MESSAGING_BRIDGE_FIELD_VALUE_MAX plus their ids and JSON framing, and nothing more.
const LINK_STEP_BODY_LIMIT = LINK_STEP_MAX_FIELDS * (MESSAGING_BRIDGE_FIELD_VALUE_MAX + 160) + 1_024;

export interface MessagingBridgeRouteDeps {
  getOwnerId(c: Context): string;
  /** Null when the platform client, owner database or runtime owner is missing. */
  service: MessagingBridgeService | null;
}

function errorBody(code: MessagingBridgeErrorCode) {
  return { error: { code, message: SAFE_MESSAGES[code] } };
}

function fail(c: Context, code: MessagingBridgeErrorCode, status = STATUS[code]) {
  return c.json(errorBody(code), status);
}

function handleError(c: Context, err: unknown) {
  if (err instanceof MessagingBridgeServiceError) return fail(c, err.code);
  if (err instanceof ZodError || err instanceof SyntaxError || err instanceof InvalidBridgeCursorError) return fail(c, "invalid_request");
  if (err instanceof MissingRequestPrincipalError || err instanceof InvalidRequestPrincipalError) return fail(c, "unauthorized");
  if (err instanceof RequestPrincipalMisconfiguredError) return fail(c, "misconfigured");
  if (err instanceof Error && err.name === "BodyLimitError") return fail(c, "invalid_request", 413);
  console.error("[messages/bridge-routes] request failed", errorName(err));
  return fail(c, "internal");
}

async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  return text.trim() === "" ? {} : JSON.parse(text) as unknown;
}

export function createMessagingBridgeRoutes(deps: MessagingBridgeRouteDeps): Hono {
  const app = new Hono();
  const tooLarge = (c: Context) => fail(c, "invalid_request", 413);
  const routeBodyLimit = bodyLimit({ maxSize: MESSAGING_ROUTE_BODY_LIMIT, onError: tooLarge });
  const deleteBodyLimit = bodyLimit({ maxSize: MESSAGING_DELETE_BODY_LIMIT, onError: tooLarge });
  const stepBodyLimit = bodyLimit({ maxSize: LINK_STEP_BODY_LIMIT, onError: tooLarge });

  /** Resolves the caller and the service; only this runtime's owner may use the bridge. */
  function authorize(c: Context): { ownerId: string; service: MessagingBridgeService } {
    const ownerId = deps.getOwnerId(c);
    if (!ownerId) throw new MessagingBridgeServiceError("unauthorized");
    if (!deps.service) throw new MessagingBridgeServiceError("misconfigured");
    if (ownerId !== deps.service.ownerId) throw new MessagingBridgeServiceError("forbidden");
    return { ownerId, service: deps.service };
  }

  app.get("/status", async (c) => {
    try {
      const ownerId = deps.getOwnerId(c);
      if (!ownerId) return fail(c, "unauthorized");
      if (!deps.service) return c.json({ availability: "unavailable", networks: [] });
      if (ownerId !== deps.service.ownerId) return fail(c, "forbidden");
      return c.json(await deps.service.status(ownerId));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/:network/link", routeBodyLimit, async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const network = MessagingBridgeNetworkSchema.parse(c.req.param("network"));
      const body = MessagingBridgeLinkStartRequestSchema.parse(await jsonBody(c));
      return c.json(await service.startLink(ownerId, network, body));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/:network/link/:linkId/step", stepBodyLimit, async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const network = MessagingBridgeNetworkSchema.parse(c.req.param("network"));
      const linkId = LinkIdSchema.parse(c.req.param("linkId"));
      const body = MessagingBridgeLinkStepRequestSchema.parse(await jsonBody(c));
      if (Object.keys(body.fields ?? {}).length > LINK_STEP_MAX_FIELDS) throw new MessagingBridgeServiceError("invalid_request");
      return c.json(await service.submitLinkStep(ownerId, network, linkId, body));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/:network/link/:linkId/cancel", deleteBodyLimit, async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const network = MessagingBridgeNetworkSchema.parse(c.req.param("network"));
      const linkId = LinkIdSchema.parse(c.req.param("linkId"));
      await service.cancelLink(ownerId, network, linkId);
      return c.json({ ok: true as const });
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.delete("/:network/accounts/:accountId", deleteBodyLimit, async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const network = MessagingBridgeNetworkSchema.parse(c.req.param("network"));
      const accountId = MessagingAccountIdSchema.parse(c.req.param("accountId"));
      await service.unlink(ownerId, network, accountId);
      return c.json({ ok: true as const });
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.get("/conversations", async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const query = MessagingBridgeConversationsQuerySchema.parse({
        network: c.req.query("network"),
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      return c.json(await service.listConversations(ownerId, query));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.get("/conversations/:roomId/messages", async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const roomId = MatrixRoomIdSchema.parse(c.req.param("roomId"));
      const query = MessagingBridgeMessagesQuerySchema.parse({
        cursor: c.req.query("cursor"),
        limit: c.req.query("limit"),
      });
      return c.json(await service.listMessages(ownerId, roomId, query));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  app.post("/conversations/:roomId/send", routeBodyLimit, async (c) => {
    try {
      const { ownerId, service } = authorize(c);
      const roomId = MatrixRoomIdSchema.parse(c.req.param("roomId"));
      const body = MessagingBridgeSendRequestSchema.parse(await jsonBody(c));
      return c.json(await service.send(ownerId, roomId, body));
    } catch (err: unknown) {
      return handleError(c, err);
    }
  });

  return app;
}
