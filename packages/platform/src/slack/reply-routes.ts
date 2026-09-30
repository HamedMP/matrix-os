import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { authorizeSlackDestination } from "./destination-authority.js";
import { decryptSlackToken } from "./security.js";
import { ActorIdSchema, SlackTeamIdSchema } from "./types.js";
import type { SlackAppRouteOptions } from "./routes.js";

const RequestSchema = z.object({ teamId: SlackTeamIdSchema, eventId: z.string().regex(/^Ev[A-Za-z0-9]{1,126}$/), text: z.string().min(1).max(35_000) }).strict();

/** This endpoint never accepts a caller-selected channel, thread, organization or actor. */
export function createSlackReplyRoutes(options: SlackAppRouteOptions): Hono {
  const app = new Hono();
  app.post("/internal/slack/replies", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }), async (c) => {
    c.header("Cache-Control", "no-store");
    if (!options.authenticateRuntime || !options.authorizeReply) return c.json({ error: "Slack unavailable" }, 503);
    const runtime = await options.authenticateRuntime(c);
    if (!runtime || !ActorIdSchema.safeParse(runtime.ownerId).success) return c.json({ error: "Unauthorized" }, 401);
    let payload: unknown;
    try { payload = await c.req.json(); } catch (error: unknown) { if (error instanceof Error && error.name === "BodyLimitError") throw error; if (!(error instanceof SyntaxError)) console.warn("[slack] reply parse failed"); return c.json({ error: "Invalid request" }, 422); }
    const parsed = RequestSchema.safeParse(payload); if (!parsed.success) return c.json({ error: "Invalid request" }, 422);
    const key = { appId: options.config.appId, teamId: parsed.data.teamId, eventId: parsed.data.eventId };
    const digest = createHash("sha256").update(parsed.data.text).digest("hex");
    const publication = { textDigest: digest };
    const authorized = await authorizeSlackDestination(options, key, runtime.ownerId, publication);
    if (!authorized) return c.json({ error: "Forbidden" }, 403);
    const { installed, destination } = authorized;
    const token = decryptSlackToken(installed.encryptedBotToken, options.config.tokenEncryptionKey, `${key.appId}:${key.teamId}`);
    const channel = await options.api.conversationInfo({ token, channelId: destination.channelId });
    if (!channel.canAccess || channel.isExternalShared) return c.json({ error: "Forbidden" }, 403);
    const claim = await options.repository.claimReply(key, digest);
    if (claim === "sent") {
      const messageTs = await options.repository.getSentReply(key);
      return messageTs ? c.json({ sent: true, messageTs }) : c.json({ error: "Delivery needs review" }, 503);
    }
    if (claim !== "claimed") return c.json({ error: "Delivery needs review" }, 409);
    try {
      // Channel metadata and intent persistence may take seconds. Do not publish with authority from before that latency.
      if (!await authorizeSlackDestination(options, key, runtime.ownerId, publication)) {
        await options.repository.settleReply(key, null);
        return c.json({ error: "Forbidden" }, 403);
      }
      const response = await options.api.postMessage({ token,
        channelId: destination.channelId, threadTs: destination.threadTs, text: parsed.data.text });
      await options.repository.settleReply(key, response.ts);
      return c.json({ sent: true, messageTs: response.ts });
    } catch (error: unknown) {
      console.warn("[slack] reply outcome unknown", error instanceof Error ? error.name : "UnknownError");
      // A network failure may occur after Slack committed. Never automatically replay an uncertain external effect.
      await options.repository.settleReply(key, null); return c.json({ error: "Delivery needs review" }, 503);
    }
  });
  return app;
}
