import {
  CanonicalAcknowledgeChatCompletionRequestSchema,
  CanonicalCancelChatRunRequestSchema,
  CanonicalCancelQueuedChatTurnRequestSchema,
  CanonicalChatApiCursorSchema,
  CanonicalChatEventCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunSteeringResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatQueueAdmissionResponseSchema,
  CanonicalChatQueueCancellationResponseSchema,
  CanonicalChatQueueReorderResponseSchema,
  CanonicalChatQueueUpdateResponseSchema,
  CanonicalChatQueuedTurnIdSchema,
  CanonicalChatTurnIdSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalQueueChatTurnRequestSchema,
  CanonicalReorderQueuedChatTurnsRequestSchema,
  CanonicalUpdateQueuedChatTurnRequestSchema,
  CanonicalSteerQueuedChatTurnRequestSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalSteerChatRunRequestSchema,
  CanonicalUpdateChatProjectRequestSchema,
  CanonicalUpdateChatUserStateRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatApprovalSubmissionResponse,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunSteeringResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatQueueAdmissionResponse,
  type CanonicalChatQueueCancellationResponse,
  type CanonicalChatQueueReorderResponse,
  type CanonicalChatQueueUpdateResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCancelQueuedChatTurnRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalQueueChatTurnRequest,
  type CanonicalReorderQueuedChatTurnsRequest,
  type CanonicalUpdateQueuedChatTurnRequest,
  type CanonicalSteerQueuedChatTurnRequest,
  type CanonicalSubmitChatApprovalRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalSteerChatRunRequest,
  type CanonicalUpdateChatProjectRequest,
  type CanonicalUpdateChatUserStateRequest,
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
import { CanonicalChatOrchestrationError, mapRepositoryError } from "./orchestrator.js";
import {
  createCanonicalChatEventStream,
  type CanonicalChatEventStreamSession,
  type CanonicalChatEventStreamSocket,
} from "./event-stream.js";

export { createCanonicalChatEventStream } from "./event-stream.js";

const CHAT_CREATE_BODY_LIMIT = 96 * 1024;
const CHAT_TURN_BODY_LIMIT = 128 * 1024;
const CHAT_CANCEL_BODY_LIMIT = 4 * 1024;
const CHAT_UPDATE_BODY_LIMIT = 4 * 1024;
const CHAT_ACKNOWLEDGEMENT_BODY_LIMIT = 4 * 1024;

const ChatListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  lifecycle: z.enum(["active", "archived"]).optional(),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId.optional(),
  scope: z.enum(["global"]).optional(),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict().refine((input) => input.scope === undefined || input.projectId === undefined, {
  message: "Global scope cannot include a Project",
});

const ChatSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId.optional(),
  scope: z.enum(["global"]).optional(),
}).strict().refine((input) => input.scope === undefined || input.projectId === undefined, {
  message: "Global scope cannot include a Project",
});

const ChatDetailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

export interface CanonicalChatRouteService {
  create(owner: ChatOwner, input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  updateProject(
    owner: ChatOwner,
    chatId: string,
    input: CanonicalUpdateChatProjectRequest,
  ): Promise<CanonicalChatRecord>;
  updateUserState(
    owner: ChatOwner,
    chatId: string,
    input: CanonicalUpdateChatUserStateRequest,
  ): Promise<CanonicalChatRecord>;
  acknowledgeCompletion(
    owner: ChatOwner,
    chatId: string,
    runId: string,
  ): Promise<CanonicalChatRecord>;
  delete(owner: ChatOwner, chatId: string, clientRequestId: string): Promise<{ chatId: string; deletedAt: string }>;
  list(owner: ChatOwner, input: {
    limit: number;
    lifecycle?: "active" | "archived";
    projectId?: string | null;
    cursor?: string;
  }): Promise<CanonicalChatListResponse>;
  search(owner: ChatOwner, input: {
    query: string;
    limit: number;
    projectId?: string | null;
  }): Promise<CanonicalChatListResponse>;
  getDetail(owner: ChatOwner, chatId: string, input: {
    limit: number;
    cursor?: string;
  }): Promise<CanonicalChatDetailResponse | null>;
  admitTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    input: CanonicalCreateChatTurnRequest,
  ): Promise<CanonicalChatTurnAdmissionResponse>;
  enqueueQueuedTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    input: CanonicalQueueChatTurnRequest,
  ): Promise<CanonicalChatQueueAdmissionResponse>;
  cancelQueuedTurn(
    owner: ChatOwner,
    chatId: string,
    queuedTurnId: string,
    input: CanonicalCancelQueuedChatTurnRequest,
  ): Promise<CanonicalChatQueueCancellationResponse>;
  reorderQueuedTurns(
    owner: ChatOwner,
    chatId: string,
    input: CanonicalReorderQueuedChatTurnsRequest,
  ): Promise<CanonicalChatQueueReorderResponse>;
  updateQueuedTurn(
    owner: ChatOwner,
    chatId: string,
    queuedTurnId: string,
    input: CanonicalUpdateQueuedChatTurnRequest,
  ): Promise<CanonicalChatQueueUpdateResponse>;
  steerQueuedTurn(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    queuedTurnId: string,
    input: CanonicalSteerQueuedChatTurnRequest,
  ): Promise<CanonicalChatRunSteeringResponse>;
  steerRun(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    input: CanonicalSteerChatRunRequest,
  ): Promise<CanonicalChatRunSteeringResponse>;
  cancelRun(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    input: CanonicalCancelChatRunRequest,
  ): Promise<CanonicalChatRunCancellationResponse>;
  submitApproval(
    owner: ChatOwner,
    chatId: string,
    runId: string,
    approvalId: string,
    input: CanonicalSubmitChatApprovalRequest,
  ): Promise<CanonicalChatApprovalSubmissionResponse>;
  retryTurn(
    principal: RequestPrincipal,
    owner: ChatOwner,
    chatId: string,
    turnId: string,
    input: CanonicalRetryChatTurnRequest,
  ): Promise<CanonicalChatRunAdmissionResponse>;
}

function ownerFromPrincipal(principal: RequestPrincipal): ChatOwner {
  return { type: "personal", ownerId: principal.userId };
}

export function registerCanonicalChatEventRoute(options: {
  mount(
    path: string,
    open: (input: {
      context: unknown;
      ws: CanonicalChatEventStreamSocket;
      cursor?: string;
    }) => Promise<CanonicalChatEventStreamSession>,
  ): void;
  getPrincipal(context: unknown): RequestPrincipal;
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "open">;
}): void {
  options.mount("/ws/chats/events", async ({ context, ws, cursor }) => {
    const principal = options.getPrincipal(context);
    const parsedCursor = cursor === undefined
      ? undefined
      : CanonicalChatEventCursorSchema.parse(Number(cursor));
    return options.stream.open({
      ws,
      principal,
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  });
}

export async function closeCanonicalChatEventLifecycle(options: {
  stream: Pick<ReturnType<typeof createCanonicalChatEventStream>, "shutdown">;
  releaseRepository(): Promise<void>;
}): Promise<void> {
  options.stream.shutdown();
  await options.releaseRepository();
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
  if (error instanceof CanonicalChatOrchestrationError) {
    return c.json({ error: error.safeError }, error.status);
  }
  try {
    mapRepositoryError(error);
  } catch (mapped: unknown) {
    if (mapped instanceof CanonicalChatOrchestrationError) {
      return c.json({ error: mapped.safeError }, mapped.status);
    }
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
  const turnBodyLimit = bodyLimit({ maxSize: CHAT_TURN_BODY_LIMIT, onError: bodyTooLarge });
  const cancelBodyLimit = bodyLimit({ maxSize: CHAT_CANCEL_BODY_LIMIT, onError: bodyTooLarge });
  const updateBodyLimit = bodyLimit({ maxSize: CHAT_UPDATE_BODY_LIMIT, onError: bodyTooLarge });
  const acknowledgementBodyLimit = bodyLimit({
    maxSize: CHAT_ACKNOWLEDGEMENT_BODY_LIMIT,
    onError: bodyTooLarge,
  });

  routes.delete("/api/chats/:chatId", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const clientRequestId = z.string().trim().min(1).max(128).parse(context.req.query("clientRequestId"));
      return context.json(await options.service.delete(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        clientRequestId,
      ));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

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
        scope: context.req.query("scope"),
        cursor: context.req.query("cursor"),
      });
      if (!parsed.success) return validationError(context);
      const result = await options.service.list(
        ownerFromPrincipal(options.getPrincipal(context)),
        {
          limit: parsed.data.limit,
          ...(parsed.data.lifecycle === undefined ? {} : { lifecycle: parsed.data.lifecycle }),
          ...(parsed.data.scope === "global"
            ? { projectId: null }
            : parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
          ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
        },
      );
      return context.json(CanonicalChatListResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.get("/api/chats/search", async (context) => {
    try {
      const parsed = ChatSearchQuerySchema.safeParse({
        query: context.req.query("query"),
        limit: context.req.query("limit"),
        projectId: context.req.query("projectId"),
        scope: context.req.query("scope"),
      });
      if (!parsed.success) return validationError(context);
      const result = await options.service.search(
        ownerFromPrincipal(options.getPrincipal(context)),
        {
          query: parsed.data.query,
          limit: parsed.data.limit,
          ...(parsed.data.scope === "global"
            ? { projectId: null }
            : parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
        },
      );
      return context.json(CanonicalChatListResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.patch("/api/chats/:chatId/project", updateBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = CanonicalUpdateChatProjectRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.updateProject(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        parsed.data,
      );
      return context.json(CanonicalChatRecordSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.patch("/api/chats/:chatId/user-state", updateBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = CanonicalUpdateChatUserStateRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.updateUserState(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        parsed.data,
      );
      return context.json(CanonicalChatRecordSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post(
    "/api/chats/:chatId/runs/:runId/acknowledge",
    acknowledgementBodyLimit,
    async (context) => {
      try {
        const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
        const runId = CanonicalChatRunIdSchema.parse(context.req.param("runId"));
        const parsed = CanonicalAcknowledgeChatCompletionRequestSchema.safeParse(
          await context.req.json(),
        );
        if (!parsed.success) return validationError(context);
        const result = await options.service.acknowledgeCompletion(
          ownerFromPrincipal(options.getPrincipal(context)),
          chatId,
          runId,
        );
        return context.json(CanonicalChatRecordSchema.parse(result));
      } catch (error: unknown) {
        return handleError(context, error);
      }
    },
  );

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

  routes.post("/api/chats/:chatId/turns", turnBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = CanonicalCreateChatTurnRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const principal = options.getPrincipal(context);
      const result = await options.service.admitTurn(
        principal,
        ownerFromPrincipal(principal),
        chatId,
        parsed.data,
      );
      return context.json(CanonicalChatTurnAdmissionResponseSchema.parse(result), 202);
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post("/api/chats/:chatId/queued-turns", turnBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = CanonicalQueueChatTurnRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const principal = options.getPrincipal(context);
      const result = await options.service.enqueueQueuedTurn(
        principal,
        ownerFromPrincipal(principal),
        chatId,
        parsed.data,
      );
      return context.json(CanonicalChatQueueAdmissionResponseSchema.parse(result), 201);
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.patch("/api/chats/:chatId/queued-turns/order", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const parsed = CanonicalReorderQueuedChatTurnsRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.reorderQueuedTurns(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        parsed.data,
      );
      return context.json(CanonicalChatQueueReorderResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.patch("/api/chats/:chatId/queued-turns/:queuedTurnId", turnBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(context.req.param("queuedTurnId"));
      const parsed = CanonicalUpdateQueuedChatTurnRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.updateQueuedTurn(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        queuedTurnId,
        parsed.data,
      );
      return context.json(CanonicalChatQueueUpdateResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.delete("/api/chats/:chatId/queued-turns/:queuedTurnId", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(context.req.param("queuedTurnId"));
      const parsed = CanonicalCancelQueuedChatTurnRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.cancelQueuedTurn(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        queuedTurnId,
        parsed.data,
      );
      return context.json(CanonicalChatQueueCancellationResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post("/api/chats/:chatId/runs/:runId/steer", turnBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const runId = CanonicalChatRunIdSchema.parse(context.req.param("runId"));
      const parsed = CanonicalSteerChatRunRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.steerRun(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        runId,
        parsed.data,
      );
      return context.json(CanonicalChatRunSteeringResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post(
    "/api/chats/:chatId/runs/:runId/queued-turns/:queuedTurnId/steer",
    cancelBodyLimit,
    async (context) => {
      try {
        const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
        const runId = CanonicalChatRunIdSchema.parse(context.req.param("runId"));
        const queuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(context.req.param("queuedTurnId"));
        const parsed = CanonicalSteerQueuedChatTurnRequestSchema.safeParse(await context.req.json());
        if (!parsed.success) return validationError(context);
        const result = await options.service.steerQueuedTurn(
          ownerFromPrincipal(options.getPrincipal(context)),
          chatId,
          runId,
          queuedTurnId,
          parsed.data,
        );
        return context.json(CanonicalChatRunSteeringResponseSchema.parse(result));
      } catch (error: unknown) {
        return handleError(context, error);
      }
    },
  );

  routes.post("/api/chats/:chatId/runs/:runId/cancel", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const runId = CanonicalChatRunIdSchema.parse(context.req.param("runId"));
      const parsed = CanonicalCancelChatRunRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const principal = options.getPrincipal(context);
      const result = await options.service.cancelRun(
        ownerFromPrincipal(principal),
        chatId,
        runId,
        parsed.data,
      );
      return context.json(CanonicalChatRunCancellationResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post("/api/chats/:chatId/runs/:runId/approvals/:approvalId", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const runId = CanonicalChatRunIdSchema.parse(context.req.param("runId"));
      const approvalId = z.string().trim().min(1).max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
        .parse(context.req.param("approvalId"));
      const parsed = CanonicalSubmitChatApprovalRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const result = await options.service.submitApproval(
        ownerFromPrincipal(options.getPrincipal(context)),
        chatId,
        runId,
        approvalId,
        parsed.data,
      );
      return context.json(CanonicalChatApprovalSubmissionResponseSchema.parse(result));
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  routes.post("/api/chats/:chatId/turns/:turnId/runs", cancelBodyLimit, async (context) => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const turnId = CanonicalChatTurnIdSchema.parse(context.req.param("turnId"));
      const parsed = CanonicalRetryChatTurnRequestSchema.safeParse(await context.req.json());
      if (!parsed.success) return validationError(context);
      const principal = options.getPrincipal(context);
      const result = await options.service.retryTurn(
        principal,
        ownerFromPrincipal(principal),
        chatId,
        turnId,
        parsed.data,
      );
      return context.json(CanonicalChatRunAdmissionResponseSchema.parse(result), 202);
    } catch (error: unknown) {
      return handleError(context, error);
    }
  });

  return routes;
}
