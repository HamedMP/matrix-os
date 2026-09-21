/**
 * File-based conversation routes (extracted from server.ts, Phase 1-A1.1).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns the legacy `$MATRIX_HOME/conversations/*.json` surface; the
 * history sub-routes stay in `server/conversation-history-routes.ts`.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ConversationStore } from "../domains/sessions/conversations.js";
import type { ConversationLifecycle } from "../domains/sessions/conversation-lifecycle.js";
import type { ConversationContextResolver } from "../domains/sessions/conversation-context.js";
import { type ConversationRunRegistry } from "../domains/sessions/conversation-run-registry.js";
import {
  registerConversationHistoryRoutes,
  type ConversationHistoryRouteDeps,
} from "../server/conversation-history-routes.js";
import { requireRequestPrincipal } from "../domains/identity/request-principal.js";

const CONVERSATION_BODY_LIMIT = 4096; // 4 KiB

export interface ConversationRouteDeps {
  conversations: ConversationStore;
  conversationLifecycle: ConversationLifecycle;
  conversationRuns: ConversationRunRegistry;
  conversationContextResolver: ConversationContextResolver;
}

export function createConversationRoutes(deps: ConversationRouteDeps): Hono {
  const app = new Hono();
  const conversationBodyLimit = bodyLimit({ maxSize: CONVERSATION_BODY_LIMIT });

  const historyDeps: ConversationHistoryRouteDeps = {
    conversations: deps.conversations,
    conversationLifecycle: deps.conversationLifecycle,
    conversationRuns: deps.conversationRuns,
    contextResolver: deps.conversationContextResolver,
    getOwnerScope: (c) => ({ type: "user", id: requireRequestPrincipal(c).userId }),
  };
  registerConversationHistoryRoutes(app, historyDeps);

  app.post("/api/conversations", conversationBodyLimit, async (c) => {
    let body: { channel?: string } = {};
    try {
      body = await c.req.json<{ channel?: string }>();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.error("[gateway] Failed to read conversation create body:", err);
      }
    }
    const id = deps.conversations.create(body.channel);
    return c.json({ id }, 201);
  });

  app.get("/api/conversations/:id/search", (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter required" }, 400);
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const results = deps.conversations.search(query, { limit });
    return c.json(results);
  });

  return app;
}
