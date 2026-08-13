import {
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ConversationRunRegistry } from "../conversation-run-registry.js";
import type { ConversationStore } from "../conversations.js";

const MAX_HISTORY_CONTENT_CHARS = 32_000;
const MAX_DELETE_BODY_BYTES = 512;
const deleteBodyLimit = bodyLimit({
  maxSize: MAX_DELETE_BODY_BYTES,
  onError: () => new Response("Payload Too Large", { status: 413 }),
});

export interface ConversationHistoryRouteDeps {
  conversations: ConversationStore;
  conversationRuns: Pick<ConversationRunRegistry, "isActive">;
}

export function registerConversationHistoryRoutes(
  app: Hono,
  deps: ConversationHistoryRouteDeps,
): void {
  app.get("/api/conversations/:id", (c) => {
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

    if (deps.conversationRuns.isActive(id.data)) {
      return c.json({ error: { code: "conversation_busy" } }, 409);
    }

    try {
      const result = await deps.conversations.delete(id.data);
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
