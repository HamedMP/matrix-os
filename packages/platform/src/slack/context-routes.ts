import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { authorizeSlackDestination } from "./destination-authority.js";
import { decryptSlackToken } from "./security.js";
import { ActorIdSchema, SlackTeamIdSchema, type SlackMessagePage } from "./types.js";
import type { SlackAppRouteOptions } from "./routes.js";

const RequestSchema = z.object({ teamId: SlackTeamIdSchema, eventId: z.string().regex(/^Ev[A-Za-z0-9]{1,126}$/) }).strict();
const CONTEXT_BYTES = 16 * 1024;

/** Runtime reads this after Events API acknowledgement. No broad history, client-selected channel or pagination path exists. */
export function createSlackContextRoutes(options: SlackAppRouteOptions): Hono {
  const app = new Hono();
  app.post("/internal/slack/context", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!options.authenticateRuntime || !options.authorizeReply) return c.json({ error: "Slack unavailable" }, 503);
    const runtime = await options.authenticateRuntime(c);
    if (!runtime || !ActorIdSchema.safeParse(runtime.ownerId).success) return c.json({ error: "Unauthorized" }, 401);
    let request: unknown;
    try { request = await c.req.json(); } catch (error: unknown) { if (error instanceof Error && error.name === "BodyLimitError") throw error; if (!(error instanceof SyntaxError)) console.warn("[slack] context parse failed"); return c.json({ error: "Invalid request" }, 422); }
    const parsed = RequestSchema.safeParse(request); if (!parsed.success) return c.json({ error: "Invalid request" }, 422);
    const key = { appId: options.config.appId, teamId: parsed.data.teamId, eventId: parsed.data.eventId };
    const authorized = await authorizeSlackDestination(options, key, runtime.ownerId);
    if (!authorized) return c.json({ error: "Forbidden" }, 403);
    const { installed, destination } = authorized;
    const token = decryptSlackToken(installed.encryptedBotToken, options.config.tokenEncryptionKey, `${key.appId}:${key.teamId}`);
    try {
      const channel = await options.api.conversationInfo({ token, channelId: destination.channelId });
      if (!channel.canAccess || channel.isExternalShared) return c.json({ available: false, untrusted: true });
      const page = await options.api.replies({ token, channelId: destination.channelId, ts: destination.threadTs });
      // Never forward provider cursors or metadata. One bounded context page is explicitly incomplete when capped.
      const messages: SlackMessagePage["messages"] = [];
      let partial = page.hasMore;
      for (const message of page.messages.slice(0, 20)) {
        const normalized = { ...(message.user ? { user: message.user } : {}), ts: message.ts,
          ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}), ...(message.text !== undefined ? { text: message.text } : {}) };
        const candidate = { available: true, untrusted: true, partial, messages: [...messages, normalized] };
        if (Buffer.byteLength(JSON.stringify(candidate)) > CONTEXT_BYTES) { partial = true; break; }
        messages.push(normalized);
      }
      if (messages.length < page.messages.length) partial = true;
      // A revocation during the upstream read must prevent the fetched source from leaving this boundary.
      if (!await authorizeSlackDestination(options, key, runtime.ownerId)) return c.json({ error: "Forbidden" }, 403);
      return c.json({ available: true, untrusted: true, partial, messages });
    } catch (error: unknown) {
      console.warn("[slack] thread context unavailable", error instanceof Error ? error.name : "UnknownError");
      // Rate limits, absent scopes and upstream failures reveal no provider details. The owner can continue with the admitted mention.
      return c.json({ available: false, untrusted: true });
    }
  });
  return app;
}
