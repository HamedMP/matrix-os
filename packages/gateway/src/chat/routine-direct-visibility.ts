import type { Hono } from "hono";
import { sql, type RawBuilder } from "kysely";
import { isRoutineDirectBotId, isRoutineDirectChatId, ROUTINE_DIRECT_CHAT_ID_PATTERN } from "../bots/routine-direct-chat-identity.js";

/** Filter before applying limits so hidden rows cannot consume a public page or replay window. */
export function publicChatIdPredicate(column: RawBuilder<string>) {
  return sql<boolean>`${column} !~ ${ROUTINE_DIRECT_CHAT_ID_PATTERN.source}`;
}

export function isRoutineDirectResourcePath(path: string): boolean {
  const resource = /^\/api\/(chats|chat-context|chat-agents)\/([^/]+)(?:\/|$)/.exec(path);
  if (!resource) return false;
  const [, kind, id] = resource;
  return kind === "chat-agents" ? isRoutineDirectBotId(id) : isRoutineDirectChatId(id);
}

/** Register before any public Chat/Bot route, including shares and interaction decisions. */
export function registerRoutineDirectResourceFence(app: Hono): void {
  app.use("*", async (c, next) => {
    if (isRoutineDirectResourcePath(c.req.path)) return c.json({ error: "Not found" }, 404);
    await next();
  });
}
