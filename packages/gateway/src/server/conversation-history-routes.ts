import {
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
  KernelConversationToolDisplaySchema,
  type KernelConversationToolDisplay,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ConversationLifecycle } from "../conversation-lifecycle.js";
import type { ConversationStore } from "../conversations.js";

const MAX_HISTORY_CONTENT_CHARS = 32_000;
const MAX_DELETE_BODY_BYTES = 512;
const MAX_TOOL_DISPLAY_CHARS = 160;
const AUTHORIZATION_HEADER_VALUE = /(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:(?:"(?:bearer|basic)?\s*[^"]*"|'(?:bearer|basic)?\s*[^']*')|(?:(?:bearer|basic)\s+(?:"[^"]*"|'[^']*'|[^\s'"]+))|(?:"[^"]*"|'[^']*'|[^\s'"]+))/gi;
const deleteBodyLimit = bodyLimit({
  maxSize: MAX_DELETE_BODY_BYTES,
  onError: () => new Response("Payload Too Large", { status: 413 }),
});

function boundedToolText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(/([?&](?:api[-_]?key|access[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|credential|id[-_]?token|refresh[-_]?token|token|password|passwd|secret)=)([^&#\s'"]+)/gi, "$1[redacted]")
    .replace(/(?<![?&])\b([A-Za-z_][A-Za-z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*=)(?:'[^']*'|"[^"]*"|[^\s]+)/gi, "$1[redacted]")
    // Cookie headers are opaque credential containers and may contain several
    // space-separated attributes. Fail closed through the shell quote (or the
    // rest of an unquoted command) instead of leaking later cookie pairs.
    .replace(/(\b(?:cookie|set[-_]?cookie)\s*:\s*)[^'"\r\n]+/gi, "$1[redacted]")
    .replace(AUTHORIZATION_HEADER_VALUE, "$1[redacted]")
    .replace(/(\b(?:x[-_])?(?:api[-_]?key|access[-_]?key|auth[-_]?token|access[-_]?token|client[-_]?secret|credential|token|password|passwd|secret)\s*:\s*)(?:'[^']*'|"[^"]*"|[^'"\s]+)/gi, "$1[redacted]")
    .replace(/(^|\s)((?:--?)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret)(?:=|\s+))(?:'[^']*'|"[^"]*"|[^\s]+)/gi, "$1$2[redacted]")
    .replace(/(^|\s)(-u|--user)(=|\s+)(?:'[^']*'|"[^"]*"|[^\s]+)/gi, "$1$2$3[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]+|sk_(?:live|test)_[A-Za-z0-9]+|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[redacted]")
    .replace(/(^|[\s=(])\/(?:Users|home|tmp|var|opt|etc|root|private)(?:\/[^\s'";|&)]*)?/g, "$1[path]")
    .replace(/(^|[\s=(])[A-Za-z]:\\[^\s'";|&)]*/g, "$1[path]");
  return redacted.length > MAX_TOOL_DISPLAY_CHARS
    ? `${redacted.slice(0, MAX_TOOL_DISPLAY_CHARS - 1)}…`
    : redacted;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function safeToolDisplay(
  kind: KernelConversationToolDisplay["kind"],
  preview: string | undefined,
): KernelConversationToolDisplay | undefined {
  if (!preview) return undefined;
  const parsed = KernelConversationToolDisplaySchema.safeParse({ kind, preview });
  return parsed.success ? parsed.data : undefined;
}

function toolDisplay(
  tool: string | undefined,
  input: Record<string, unknown> | undefined,
): KernelConversationToolDisplay | undefined {
  if (!tool || !input) return undefined;
  const normalizedTool = tool.toLowerCase();
  const command = boundedToolText(input.command);
  const rawPath = typeof input.file_path === "string"
    ? input.file_path
    : typeof input.path === "string" ? input.path : undefined;
  const path = rawPath ? boundedToolText(basename(rawPath)) : undefined;
  const query = boundedToolText(input.query ?? input.pattern);
  const description = boundedToolText(input.description);

  if (/bash|shell|command|terminal|exec|run/.test(normalizedTool)) {
    return safeToolDisplay("command", command ?? description);
  }
  if (/read|view|open|write|edit|apply|patch|create/.test(normalizedTool)) {
    return safeToolDisplay("file", path ?? description);
  }
  if (/toolsearch|tool_search|grep|glob|search|find/.test(normalizedTool)) {
    return safeToolDisplay("search", query ?? path ?? description);
  }
  return safeToolDisplay("text", description ?? query ?? path ?? command);
}

export interface ConversationHistoryRouteDeps {
  conversations: ConversationStore;
  conversationLifecycle: Pick<ConversationLifecycle, "deleteIfIdle" | "getActiveHistoryStart">;
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

      const activeHistoryStart = deps.conversationLifecycle.getActiveHistoryStart(id.data);
      // The active run registry replays the current turn over the WebSocket.
      // Keep the REST snapshot deliberately disjoint: settled history plus
      // the already-persisted user prompt, but never the assistant/tool rows
      // represented by that active buffer.
      const activePromptCount = activeHistoryStart !== null
        && conversation.messages[activeHistoryStart]?.role === "user" ? 1 : 0;
      const visibleMessages = activeHistoryStart === null
        ? conversation.messages
        : conversation.messages.slice(0, activeHistoryStart + activePromptCount);
      const totalCount = visibleMessages.length;
      const end = Math.min(query.data.cursor ?? totalCount, totalCount);
      const start = Math.max(0, end - query.data.limit);
      const messages = visibleMessages.slice(start, end).map((message, offset) => {
        const display = toolDisplay(message.tool, message.toolInput);
        return {
          index: start + offset,
          role: message.role,
          content: message.content.slice(0, MAX_HISTORY_CONTENT_CHARS),
          contentTruncated: message.content.length > MAX_HISTORY_CONTENT_CHARS,
          timestamp: message.timestamp,
          ...(message.tool ? { tool: message.tool.slice(0, 128) } : {}),
          ...(display ? { toolDisplay: display } : {}),
        };
      });

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
