import {
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import type { ConversationStore } from "../conversations.js";

const MAX_HISTORY_CONTENT_CHARS = 32_000;

export interface ConversationHistoryRouteDeps {
  conversations: ConversationStore;
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
}
