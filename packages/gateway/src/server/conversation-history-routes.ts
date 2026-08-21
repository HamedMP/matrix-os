import {
  KernelConversationContextProjectionSchema,
  KernelConversationContextUpdateSchema,
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
  KernelConversationSummarySchema,
  ProjectIdSchema,
  type KernelConversationContextProjection,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ConversationContextResolver } from "../conversation-context.js";
import type { ConversationLifecycle } from "../conversation-lifecycle.js";
import type { ConversationRunRegistry } from "../conversation-run-registry.js";
import type { ConversationStore } from "../conversations.js";
import type { OwnerScope } from "../state-ops.js";

const MAX_HISTORY_CONTENT_CHARS = 32_000;
const MAX_DELETE_BODY_BYTES = 512;
const MAX_CONTEXT_BODY_BYTES = 4096;
const CONTEXT_PROJECTION_CONCURRENCY = 8;
const deleteBodyLimit = bodyLimit({
  maxSize: MAX_DELETE_BODY_BYTES,
  onError: () => new Response("Payload Too Large", { status: 413 }),
});
const contextBodyLimit = bodyLimit({
  maxSize: MAX_CONTEXT_BODY_BYTES,
  onError: () => new Response("Payload Too Large", { status: 413 }),
});

export interface ConversationHistoryRouteDeps {
  conversations: ConversationStore;
  conversationLifecycle: Pick<ConversationLifecycle, "deleteIfIdle">;
  conversationRuns: Pick<ConversationRunRegistry, "isActive">;
  contextResolver: ConversationContextResolver;
  getOwnerScope: (context: Context) => OwnerScope;
}

function unavailableContextProjection(projectId: string): KernelConversationContextProjection {
  const safeProjectId = ProjectIdSchema.safeParse(projectId).success
    ? projectId
    : "unavailable-project";
  return KernelConversationContextProjectionSchema.parse({
    projectId: safeProjectId,
    projectName: safeProjectId,
    projectKind: "folder",
    status: "unavailable",
  });
}

async function resolveStoredContext(
  deps: ConversationHistoryRouteDeps,
  projectId: string,
  ownerScope: OwnerScope,
): Promise<KernelConversationContextProjection> {
  try {
    const resolved = await deps.contextResolver.resolve(projectId, ownerScope);
    return resolved?.projection ?? unavailableContextProjection(projectId);
  } catch (error: unknown) {
    console.error("[gateway] Failed to resolve conversation context:", error);
    return unavailableContextProjection(projectId);
  }
}

async function mapWithFixedConcurrency<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(CONTEXT_PROJECTION_CONCURRENCY, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function registerConversationHistoryRoutes(
  app: Hono,
  deps: ConversationHistoryRouteDeps,
): void {
  app.patch("/api/conversations/:id/context", contextBodyLimit, async (c) => {
    const id = KernelConversationIdSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: { code: "invalid_conversation_id" } }, 400);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") {
        return c.body("Payload Too Large", 413);
      }
      if (!(error instanceof SyntaxError)) {
        console.error("[gateway] Failed to read conversation context body:", error);
      }
      return c.json({ error: { code: "invalid_conversation_context" } }, 400);
    }
    const body = KernelConversationContextUpdateSchema.safeParse(rawBody);
    if (!body.success) {
      return c.json({ error: { code: "invalid_conversation_context" } }, 400);
    }

    try {
      if (!deps.conversations.get(id.data)) {
        return c.json({ error: { code: "conversation_not_found" } }, 404);
      }
      if (deps.conversationRuns.isActive(id.data)) {
        return c.json({ error: { code: "conversation_busy" } }, 409);
      }

      const ownerScope = deps.getOwnerScope(c);
      const resolved = body.data.projectId
        ? await deps.contextResolver.resolve(body.data.projectId, ownerScope)
        : null;
      if (body.data.projectId && !resolved) {
        return c.json({ error: { code: "project_unavailable" } }, 404);
      }

      const result = await deps.conversations.updateContext(
        id.data,
        body.data.projectId,
        () => deps.conversationRuns.isActive(id.data),
      );
      if (result === "busy") {
        return c.json({ error: { code: "conversation_busy" } }, 409);
      }
      if (result === "not_found") {
        return c.json({ error: { code: "conversation_not_found" } }, 404);
      }
      return c.json({ context: resolved?.projection ?? null }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (error: unknown) {
      console.error("[gateway] Failed to update conversation context:", error);
      return c.json({ error: { code: "conversation_context_unavailable" } }, 503);
    }
  });

  app.get("/api/conversations", async (c) => {
    try {
      const ownerScope = deps.getOwnerScope(c);
      const summaries = deps.conversations.list();
      const response = await mapWithFixedConcurrency(summaries, async (summary) =>
        KernelConversationSummarySchema.parse({
          ...summary,
          preview: summary.preview.slice(0, 32_000),
          ...(summary.context
            ? { context: await resolveStoredContext(deps, summary.context.projectId, ownerScope) }
            : {}),
        }));
      return c.json(response, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      console.error("[gateway] Failed to list conversations:", error);
      return c.json({ error: "Conversations are temporarily unavailable. Try again." }, 503);
    }
  });

  app.get("/api/conversations/:id", async (c) => {
    const id = KernelConversationIdSchema.safeParse(c.req.param("id"));
    const query = KernelConversationHistoryQuerySchema.safeParse(c.req.query());
    if (!id.success || !query.success) {
      return c.json({ error: "Invalid conversation history request." }, 400);
    }

    try {
      const conversation = deps.conversations.get(id.data);
      if (!conversation) {
        return c.json({ error: "Conversation unavailable. Refresh and try again." }, 404);
      }

      const totalCount = conversation.messages.length;
      const end = Math.min(query.data.cursor ?? totalCount, totalCount);
      const start = Math.max(0, end - query.data.limit);
      const messages = conversation.messages.slice(start, end).map((message, offset) => ({
        index: start + offset,
        role: message.role,
        content: message.content.slice(0, MAX_HISTORY_CONTENT_CHARS),
        contentTruncated: message.content.length > MAX_HISTORY_CONTENT_CHARS,
        timestamp: message.timestamp,
        ...(message.tool ? { tool: message.tool.slice(0, 128) } : {}),
      }));

      const response = KernelConversationHistoryResponseSchema.parse({
        id: conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        ...(conversation.context
          ? {
              context: await resolveStoredContext(
                deps,
                conversation.context.projectId,
                deps.getOwnerScope(c),
              ),
            }
          : {}),
        totalCount,
        messages,
        hasMore: start > 0,
        ...(start > 0 ? { nextCursor: String(start) } : {}),
        limit: query.data.limit,
      });
      return c.json(response, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      console.error("[gateway] Failed to load conversation history:", error);
      return c.json({
        error: "Conversation history is temporarily unavailable. Try again.",
      }, 503);
    }
  });

  app.delete("/api/conversations/:id", deleteBodyLimit, async (c) => {
    try {
      await c.req.arrayBuffer();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") {
        return c.body("Payload Too Large", 413);
      }
      throw error;
    }
    const id = KernelConversationIdSchema.safeParse(c.req.param("id"));
    if (!id.success) {
      return c.json({ error: { code: "invalid_conversation_id" } }, 400);
    }

    try {
      const result = await deps.conversationLifecycle.deleteIfIdle(id.data);
      if (result === "busy") {
        return c.json({ error: { code: "conversation_busy" } }, 409);
      }
      if (result === "not_found") {
        return c.json({ error: { code: "conversation_not_found" } }, 404);
      }
      return c.json(KernelConversationDeleteResponseSchema.parse({ ok: true }));
    } catch (error: unknown) {
      console.error("[gateway] Failed to delete conversation:", error);
      return c.json({ error: { code: "conversation_delete_unavailable" } }, 503);
    }
  });
}
