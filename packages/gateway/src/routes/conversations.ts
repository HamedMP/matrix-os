import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { ConversationStore } from "../conversations.js";

const CONVERSATION_BODY_LIMIT_BYTES = 4 * 1024;
const ConversationIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const CreateConversationSchema = z.object({
  channel: z.string().trim().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/).optional(),
}).strict();
const SearchConversationSchema = z.object({
  q: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

function parseConversationId(value: string): string | null {
  const parsed = ConversationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createConversationRoutes(conversations: ConversationStore): Hono {
  const app = new Hono();
  const routeBodyLimit = bodyLimit({ maxSize: CONVERSATION_BODY_LIMIT_BYTES });

  app.get("/", (c) => c.json(conversations.list()));

  app.post("/", routeBodyLimit, async (c) => {
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.error("[conversations] Failed to read create request body", error);
        return c.json({ error: "Invalid request" }, 400);
      }
    }

    const parsed = CreateConversationSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);

    const id = conversations.create(parsed.data.channel);
    return c.json({ id }, 201);
  });

  app.get("/:id", (c) => {
    const id = parseConversationId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid conversation id" }, 400);

    try {
      const conversation = conversations.get(id);
      if (!conversation) return c.json({ error: "conversation_not_found" }, 404);
      return c.json(conversation);
    } catch (error: unknown) {
      console.error("[conversations] Failed to load stored conversation", error);
      return c.json({ error: "Unable to load conversation" }, 500);
    }
  });

  app.delete("/:id", routeBodyLimit, (c) => {
    const id = parseConversationId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid conversation id" }, 400);

    const deleted = conversations.delete(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.get("/:id/search", (c) => {
    const id = parseConversationId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid conversation id" }, 400);

    const parsed = SearchConversationSchema.safeParse({
      q: c.req.query("q"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) return c.json({ error: "Invalid search query" }, 400);

    return c.json(conversations.search(parsed.data.q, {
      limit: parsed.data.limit,
      sessionId: id,
    }));
  });

  return app;
}
