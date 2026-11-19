import { Hono, type Context } from "hono";
import { sql, type Kysely } from "kysely";
import { AgentThreadChatSchema, AgentThreadIdSchema, type AgentThreadChat } from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import type { RequestPrincipal } from "../request-principal.js";

/**
 * The canonical Chat whose coding runs drive a legacy agent thread. The coding
 * provider adapter records the thread id as its `conversationId`; this is the
 * only durable link between the two identities. Owner-scoped, read-only.
 */
export async function findChatForAgentThread(database: Kysely<ChatDatabase>, ownerId: string, threadId: string): Promise<AgentThreadChat | null> {
  return database.transaction().execute(async (trx) => {
    // Unindexed JSON lookup over owner-local rows: bound it rather than let a large history stall the request.
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
    const row = await trx.selectFrom("chats").select(["chats.id", "chats.project_id"])
      .where("chats.owner_type", "=", "personal").where("chats.owner_id", "=", ownerId)
      .where((eb) => eb.exists(eb.selectFrom("chat_run_adapter_state as adapter")
        .innerJoin("chat_runs as run", "run.id", "adapter.run_id").select("run.id")
        .whereRef("run.chat_id", "=", "chats.id")
        .where(sql<string>`adapter.state->>'conversationId'`, "=", threadId)))
      // A fork can carry its parent's runs; the most recently active Chat is the one in use.
      .orderBy("chats.activity_at", "desc").orderBy("chats.id")
      .limit(1).executeTakeFirst();
    if (!row) return null;
    return AgentThreadChatSchema.parse({ chatId: row.id, ...(row.project_id ? { projectId: row.project_id } : {}) });
  });
}

export function createAgentThreadChatRoutes(options: {
  database: Kysely<ChatDatabase> | null;
  getPrincipal(context: Context): RequestPrincipal;
}): Hono {
  const app = new Hono();
  app.get("/api/chats/by-agent-thread/:threadId", async (c) => {
    const threadId = AgentThreadIdSchema.safeParse(c.req.param("threadId"));
    if (!threadId.success) return c.json({ error: "Invalid request" }, 400);
    if (!options.database) return c.json({ error: "Chat is temporarily unavailable" }, 503);
    try {
      const chat = await findChatForAgentThread(options.database, options.getPrincipal(c).userId, threadId.data);
      if (!chat) return c.json({ error: "Not found" }, 404);
      return c.json(chat, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      console.warn("[chat] Agent thread lookup unavailable:", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Chat is temporarily unavailable" }, 503);
    }
  });
  return app;
}
