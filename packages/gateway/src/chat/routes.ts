import {
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalCreateChatRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalCreateChatRequest,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  type RequestPrincipal,
} from "../request-principal.js";
import type { ChatOwner } from "./records.js";

const CHAT_CREATE_BODY_LIMIT = 96 * 1024;

const ChatListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  lifecycle: z.enum(["active", "archived"]).optional(),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId.optional(),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

const ChatDetailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

export interface CanonicalChatRouteService {
  create(owner: ChatOwner, input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  list(owner: ChatOwner, input: {
    limit: number;
    lifecycle?: "active" | "archived";
    projectId?: string;
    cursor?: string;
  }): Promise<CanonicalChatListResponse>;
  getDetail(owner: ChatOwner, chatId: string, input: {
    limit: number;
    cursor?: string;
  }): Promise<CanonicalChatDetailResponse | null>;
}

function ownerFromPrincipal(principal: RequestPrincipal): ChatOwner {
  return { type: "personal", ownerId: principal.userId };
}

function bodyTooLarge(c: Context) {
  return c.json({ error: "Request body too large" }, 413);
}

function validationError(c: Context) {
  return c.json({ error: "Invalid request" }, 400);
}

function notFound(c: Context) {
  return c.json({
    error: CanonicalChatSafeErrorSchema.parse({
      code: "chat_not_found",
      safeMessage: "Chat not found.",
      retryable: false,
    }),
  }, 404);
}

function handleError(c: Context, error: unknown) {
  if (error instanceof Error && error.name === "BodyLimitError") {
    return bodyTooLarge(c);
  }
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Chat request failed");
    if (mapped.log) console.error("[chat/routes] Request principal misconfigured:", error.name);
    return c.json(mapped.body, mapped.status);
  }
  if (typeof error === "object" && error !== null && "issues" in error) {
    return validationError(c);
  }
  console.error(
    "[chat/routes] Canonical Chat request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return c.json({
    error: CanonicalChatSafeErrorSchema.parse({
      code: "service_unavailable",
      safeMessage: "Chat is temporarily unavailable.",
      retryable: true,
      recoveryActions: ["retry"],
    }),
  }, 503);
}

export function createCanonicalChatRoutes(options: {
  service: CanonicalChatRouteService;
  getPrincipal: (context: Context) => RequestPrincipal;
}): Hono {
  const routes = new Hono();
  const createBodyLimit = bodyLimit({ maxSize: CHAT_CREATE_BODY_LIMIT, onError: bodyTooLarge });

  routes.post("/api/chats", createBodyLimit, async (context) => {
    try {
      const parsed = CanonicalCreateChatRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.create(
        ownerFromPrincipal(options.getPrincipal(context)),
        parsed.data,
      );
      return context.json(CanonicalChatRecordSchema.parse(result), 201);
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.get("/api/chats", async (context) => {
    try {
      const parsed = ChatListQuerySchema.safeParse({
        limit: context.req.query("limit"),
        lifecycle: context.req.query("lifecycle"),
        projectId: context.req.query("projectId"),
        cursor: context.req.query("cursor"),
      });
      if (!parsed.success) return validationError(context);
      const result = await options.service.list(
        ownerFromPrincipal(options.getPrincipal(context)),
        parsed.data,
      );
      return context.json(CanonicalChatListResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.get("/api/chats/:chatId", async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = ChatDetailQuerySchema.safeParse({
        limit: context.req.query("limit"),
        cursor: context.req.query("cursor"),
      });
      if (!parsed.success) return validationError(context);
      const result = await options.service.getDetail(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        parsed.data,
      );
      if (!result) return notFound(context);
      return context.json(CanonicalChatDetailResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  return routes;
}
