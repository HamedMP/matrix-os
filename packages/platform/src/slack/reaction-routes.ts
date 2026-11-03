import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { authorizeSlackDestination } from "./destination-authority.js";
import { decryptSlackToken } from "./security.js";
import { ActorIdSchema, SlackTeamIdSchema, SlackTimestampSchema } from "./types.js";
import type { SlackAppRouteOptions } from "./routes.js";

const RequestSchema = z.object({ teamId: SlackTeamIdSchema, eventId: z.string().regex(/^Ev[A-Za-z0-9]{1,126}$/) }).strict();

/** One idempotent progress reaction, always on the invoking message. No caller-selected target or emoji. */
export function createSlackReactionRoutes(options: SlackAppRouteOptions): Hono {
  const app = new Hono();
  app.post("/internal/slack/reactions", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!options.authenticateRuntime || !options.authorizeReply) return c.json({ error: "Slack unavailable" }, 503);
    const runtime = await options.authenticateRuntime(c);
    if (!runtime || !ActorIdSchema.safeParse(runtime.ownerId).success) return c.json({ error: "Unauthorized" }, 401);
    let payload: unknown;
    try { payload = await c.req.json(); } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      if (!(error instanceof SyntaxError)) console.warn("[slack] reaction parse failed");
      return c.json({ error: "Invalid request" }, 422);
    }
    const parsed = RequestSchema.safeParse(payload); if (!parsed.success) return c.json({ error: "Invalid request" }, 422);
    const key = { appId: options.config.appId, teamId: parsed.data.teamId, eventId: parsed.data.eventId };
    const authorized = await authorizeSlackDestination(options, key, runtime.ownerId);
    if (!authorized) return c.json({ error: "Forbidden" }, 403);
    const eventTs = SlackTimestampSchema.safeParse(authorized.destination.eventTs);
    if (!eventTs.success) return c.json({ error: "Forbidden" }, 403);
    const { installed, destination } = authorized;
    const token = decryptSlackToken(installed.encryptedBotToken, options.config.tokenEncryptionKey, `${key.appId}:${key.teamId}`);
    const channel = await options.api.conversationInfo({ token, channelId: destination.channelId });
    if (!channel.canAccess || channel.isExternalShared) return c.json({ error: "Forbidden" }, 403);
    const state = await options.repository.prepareReaction(key);
    // Recheck even a sent replay, so a delayed metadata request cannot bypass a revocation.
    if (!await authorizeSlackDestination(options, key, runtime.ownerId)) {
      if (state === "prepared") await options.repository.settleReaction(key, false);
      return c.json({ error: "Forbidden" }, 403);
    }
    if (state === "sent") return c.json({ reacted: true });
    try {
      await options.api.addReaction({ token, channelId: destination.channelId, ts: eventTs.data, name: "eyes" });
      await options.repository.settleReaction(key, true);
      return c.json({ reacted: true });
    } catch (error: unknown) {
      console.warn("[slack] reaction outcome unknown", error instanceof Error ? error.name : "UnknownError");
      await options.repository.settleReaction(key, false);
      return c.json({ error: "Reaction unavailable" }, 503);
    }
  });
  return app;
}
