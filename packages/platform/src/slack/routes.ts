import { createHash, createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { SLACK_OAUTH_COMPLETION_PATH, SlackOAuthCallbackQuerySchema } from '@matrix-os/contracts/slack-bridge';
import { createSlackContextRoutes } from "./context-routes.js";
import { createSlackLinkPage } from "./link-page.js";
import { createSlackReplyRoutes } from "./reply-routes.js";
import { createSlackReactionRoutes } from "./reaction-routes.js";
import { SLACK_BOT_SCOPES } from "./api.js";
import { SlackRepositoryError, type SlackRepository } from "./repository.js";
import { decryptSlackToken, encryptSlackToken, verifySlackSignature } from "./security.js";
import { ActorIdSchema, OrganizationIdSchema, SlackAppIdSchema, SlackChannelIdSchema, SlackTeamIdSchema, SlackTokenSchema,
  SlackTimestampSchema, SlackUserIdSchema, type SlackApi, type SlackAppConfig, type SlackAuthorityDependencies, type SlackInboundEvent } from "./types.js";

const EventSchema = z.object({ type: z.string().max(80), user: SlackUserIdSchema.optional(), channel: SlackChannelIdSchema.optional(),
  channel_type: z.string().max(32).optional(), text: z.string().max(40_000).optional(), ts: SlackTimestampSchema.optional(),
  thread_ts: SlackTimestampSchema.optional(), is_ext_shared: z.boolean().optional(), user_team: SlackTeamIdSchema.optional(), bot_id: z.string().max(128).optional(), subtype: z.string().max(80).optional() }).passthrough();
const EnvelopeSchema = z.object({ type: z.literal("event_callback"), api_app_id: SlackAppIdSchema, team_id: SlackTeamIdSchema,
  event_id: z.string().regex(/^Ev[A-Za-z0-9]{1,126}$/), is_ext_shared_channel: z.boolean().optional(), event: EventSchema }).passthrough();
const CallbackQuerySchema = SlackOAuthCallbackQuerySchema;
const ChallengeSchema = z.object({ type: z.literal("url_verification"), challenge: z.string().min(1).max(1_024), api_app_id: SlackAppIdSchema.optional() }).passthrough();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export type SlackAppRouteOptions = SlackAuthorityDependencies & {
  config: SlackAppConfig; repository: SlackRepository; api: SlackApi; now?: () => Date;
};

export function createSlackAppRoutes(options: SlackAppRouteOptions): Hono & { shutdownSlack(): Promise<void> } {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
  const publicUrl = new URL(options.config.publicBaseUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("Slack public origin unavailable");
  const callbackUrl = `${publicUrl.origin}/api/slack/oauth/callback`;
  const activeEvents = new Set<Promise<Response>>();
  let closed = false;
  const limit = bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, "Request too large", 413) });
  app.onError((error, c) => {
    console.warn("[slack] request failed", error.name);
    return fail(c, "Slack unavailable", 503);
  });
  app.use("/api/slack/*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const bearer = /^Bearer [A-Za-z0-9._~-]{1,4096}$/i.test(c.req.header("authorization") ?? "");
      // Cookie-bearing requests never inherit a Bearer bypass; the auth resolver must authenticate the Bearer for native callers.
      if (origin !== publicUrl.origin && !(origin === undefined && bearer && !c.req.header("cookie"))) return fail(c, "Forbidden", 403);
    }
    await next();
  });
  async function actor(c: Context) {
    const parsed = ActorIdSchema.safeParse(await options.resolveActor(c));
    return parsed.success ? parsed.data : null;
  }

  app.post("/api/slack/install", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const request = await parse(c, z.object({ organizationId: OrganizationIdSchema }).strict());
    if (!request) return fail(c, "Invalid request", 422);
    if (!await options.requireOrgAdmin({ actorId, organizationId: request.organizationId })) return fail(c, "Forbidden", 403);
    const token = randomBytes(32).toString("base64url");
    await options.repository.createOAuthState({ hash: digest(token), appId: options.config.appId, actorId, organizationId: request.organizationId });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.search = new URLSearchParams({ client_id: options.config.clientId, scope: SLACK_BOT_SCOPES.join(","), redirect_uri: callbackUrl, state: token }).toString();
    c.header("Cache-Control", "no-store"); return c.json({ url: url.toString() });
  });

  app.get("/api/slack/oauth/callback", async (c) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    const actorId = await actor(c);
    if (!actorId) {
      const query = CallbackQuerySchema.safeParse(c.req.query());
      if (query.success && c.req.header('accept')?.includes('text/html') && !c.req.header('authorization')) {
        // The browser refreshes its own Clerk session. State never supplies identity.
        return c.redirect(SLACK_OAUTH_COMPLETION_PATH + '?' + new URLSearchParams(query.data).toString(), 303);
      }
      return fail(c, "Unauthorized", 401);
    }
    const parsed = CallbackQuerySchema.safeParse(c.req.query()); if (!parsed.success) return fail(c, "Invalid request", 422);
    const hash = digest(parsed.data.state);
    const state = await options.repository.getOAuthState(hash);
    if (!state) return fail(c, "Request expired", 409);
    if (state.appId !== options.config.appId || state.actorId !== actorId || !await options.requireOrgAdmin({ actorId, organizationId: state.organizationId })) return fail(c, "Forbidden", 403);
    try { await options.repository.consumeOAuthState(hash, actorId); } catch (error: unknown) { return repositoryFailure(c, error); }
    const installed = await options.api.exchangeCode({ code: parsed.data.code, redirectUri: callbackUrl });
    if (installed.appId !== options.config.appId) return fail(c, "Forbidden", 403);
    // Provider latency must not let an expired administrator privilege commit installation.
    if (!await options.requireOrgAdmin({ actorId, organizationId: state.organizationId })) return fail(c, "Forbidden", 403);
    try {
      await options.repository.saveInstallation({ ...installed, organizationId: state.organizationId, installedBy: actorId,
        encryptedBotToken: encryptSlackToken(installed.botToken, options.config.tokenEncryptionKey, `${installed.appId}:${installed.teamId}`) }, { oauthStateHash: hash });
    } catch (error: unknown) { return repositoryFailure(c, error); }
    c.header("Cache-Control", "no-store"); return c.json({ connected: true, teamId: installed.teamId });
  });

  app.post("/api/slack/link/complete", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const request = await parse(c, z.object({ token: SlackTokenSchema }).strict()); if (!request) return fail(c, "Invalid request", 422);
    const hash = digest(request.token);
    const challenge = await options.repository.getChallenge(hash); if (!challenge) return fail(c, "Request expired", 409);
    const installed = await options.repository.getInstallation(challenge.appId, challenge.teamId);
    if (!installed || installed.appId !== options.config.appId || installed.state !== "active") return fail(c, "Forbidden", 403);
    if (!await options.isCurrentMember({ actorId, organizationId: installed.organizationId })) return fail(c, "Forbidden", 403);
    try { await options.repository.completeLink({ hash, actorId, organizationId: installed.organizationId }); } catch (error: unknown) { return repositoryFailure(c, error); }
    return c.json({ connected: true });
  });

  app.delete("/api/slack/workspaces/:teamId/link", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const teamId = SlackTeamIdSchema.safeParse(c.req.param("teamId")); if (!teamId.success) return fail(c, "Invalid request", 422);
    await options.repository.removeLink(options.config.appId, teamId.data, actorId); return c.body(null, 204);
  });
  app.delete("/api/slack/workspaces/:teamId", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const teamId = SlackTeamIdSchema.safeParse(c.req.param("teamId")); if (!teamId.success) return fail(c, "Invalid request", 422);
    const installed = await options.repository.getInstallation(options.config.appId, teamId.data);
    if (!installed || !await options.requireOrgAdmin({ actorId, organizationId: installed.organizationId })) return fail(c, "Forbidden", 403);
    await options.repository.revokeInstallation(options.config.appId, teamId.data, { source: "administrator" }); return c.body(null, 204);
  });
  app.put("/api/slack/workspaces/:teamId/channels/:channelId", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const params = z.object({ teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema }).safeParse(c.req.param());
    const request = await parse(c, z.object({ scopeId: z.uuid(), approvedOutput: z.literal(true) }).strict()); if (!params.success || !request || params.data.channelId.startsWith("D")) return fail(c, "Invalid request", 422);
    const installed = await options.repository.getInstallation(options.config.appId, params.data.teamId);
    if (!installed || installed.state !== "active" || !await options.requireOrgAdmin({ actorId, organizationId: installed.organizationId })) return fail(c, "Forbidden", 403);
    const binding = { appId: installed.appId, teamId: installed.teamId, channelId: params.data.channelId, organizationId: installed.organizationId, scopeId: request.scopeId, approvedOutput: request.approvedOutput, configuredBy: actorId };
    if (!await options.authorizeChannelBinding({ ...binding, actorId })) return fail(c, "Forbidden", 403);
    const channel = await options.api.conversationInfo({ token: decryptSlackToken(installed.encryptedBotToken, options.config.tokenEncryptionKey, `${installed.appId}:${installed.teamId}`), channelId: binding.channelId });
    if (!channel.canAccess || channel.isExternalShared) return fail(c, "Forbidden", 403);
    // Metadata is fetched outside Matrix authority. Revalidate after that latency.
    if (!await options.authorizeChannelBinding({ ...binding, actorId })
      || !await options.requireOrgAdmin({ actorId, organizationId: installed.organizationId })) return fail(c, "Forbidden", 403);
    try { await options.repository.saveChannelBinding(binding, { expectedInstallationGeneration: installed.generation }); } catch (error: unknown) { return repositoryFailure(c, error); }
    return c.json({ connected: true });
  });

  async function receiveEvent(c: Context, signal: AbortSignal): Promise<Response> {
    const body = await c.req.text();
    if (!verifySlackSignature({ secret: options.config.signingSecret, body, timestamp: c.req.header("x-slack-request-timestamp"), signature: c.req.header("x-slack-signature"), now: now() })) return fail(c, "Unauthorized", 401);
    let payload: unknown;
    try { payload = JSON.parse(body); } catch (error: unknown) { if (!(error instanceof SyntaxError)) console.warn("[slack] event parse failed"); return fail(c, "Invalid request", 422); }
    const challenge = ChallengeSchema.safeParse(payload);
    if (challenge.success) {
      if (challenge.data.api_app_id && challenge.data.api_app_id !== options.config.appId) return fail(c, "Forbidden", 403);
      return c.json({ challenge: challenge.data.challenge });
    }
    const envelope = EnvelopeSchema.safeParse(payload); if (!envelope.success) return fail(c, "Invalid request", 422);
    const { api_app_id: appId, team_id: teamId, event_id: eventId, event } = envelope.data;
    if (appId !== options.config.appId) return fail(c, "Forbidden", 403);
    const revocation = event.type === "app_uninstalled" || event.type === "tokens_revoked";
    const installed = await options.repository.getInstallation(appId, teamId);
    if ((!installed || installed.state !== "active") && !revocation) return fail(c, "Forbidden", 403);
    if (envelope.data.is_ext_shared_channel || event.is_ext_shared || (event.user_team && event.user_team !== teamId)) return c.json({ received: true });
    const relevant = event.type === "app_mention" || (event.type === "message" && event.channel_type === "im");
    if (event.bot_id || event.subtype || (event.user && event.user === installed?.botUserId) || (!relevant && !revocation)) return c.json({ received: true });
    if (relevant && !event.text?.trim()) return c.json({ received: true });
    if (relevant && (!event.user || !event.channel || !event.ts
      || (event.type === "message" && !event.channel.startsWith("D")) || (event.type === "app_mention" && event.channel.startsWith("D")))) return fail(c, "Invalid request", 422);
    const key = { appId, teamId, eventId };
    const claim = await options.repository.claimEvent(key, digest(body));
    if (claim.outcome === "conflict") return fail(c, "Conflicting delivery", 409);
    if (claim.outcome === "busy") return fail(c, "Slack unavailable", 503);
    if (claim.outcome === "completed") return c.json({ received: true });
    try {
      await (async () => {
        if (revocation) { await options.repository.revokeInstallation(appId, teamId); return; }
        const activeInstallation = installed!; // Non-revocation events passed the active-installation guard above.
        const inbound: SlackInboundEvent = { eventId, appId, teamId, userId: event.user!, channelId: event.channel!, ts: event.ts!,
          ...(event.thread_ts ? { threadTs: event.thread_ts } : {}), text: event.text!, kind: event.type === "app_mention" ? "mention" : "direct_message" };
        if (inbound.kind === "direct_message" && /^connect$/i.test(inbound.text.trim())) {
          // Stable per delivery so a lost Slack response can retry the same private challenge. Only its hash persists.
          const token = createHmac("sha256", options.config.signingSecret).update(`matrix-slack-link-v1:${appId}:${teamId}:${eventId}:${inbound.userId}`).digest("base64url");
          await options.repository.createChallenge({ hash: digest(token), appId, teamId, slackUserId: inbound.userId });
          const url = new URL("/slack/link", publicUrl.origin); url.searchParams.set("token", token);
          await options.api.postMessage({ token: decryptSlackToken(activeInstallation.encryptedBotToken, options.config.tokenEncryptionKey, `${appId}:${teamId}`),
            channelId: inbound.channelId, text: `Connect your Matrix account privately: ${url.toString()}`, signal });
          return;
        }
        const link = await options.repository.getLink(appId, teamId, inbound.userId);
        if (!link || link.organizationId !== activeInstallation.organizationId || !await options.isCurrentMember({ actorId: link.actorId, organizationId: activeInstallation.organizationId })) return;
        const binding = inbound.kind === "mention" ? await options.repository.getChannelBinding(appId, teamId, inbound.channelId) : null;
        if (inbound.kind === "mention" && (!binding || !binding.approvedOutput || binding.organizationId !== activeInstallation.organizationId)) return;
        signal.throwIfAborted();
        const destination = await options.dispatch({ installation: activeInstallation, link, binding, event: inbound, signal });
        const ownerId = ActorIdSchema.parse(destination.ownerId);
        if (inbound.kind === "direct_message" && ownerId !== link.actorId) throw new Error("Slack personal destination mismatch");
        await options.repository.recordDestination(key, claim.leaseToken, { ownerId, actorId: link.actorId, slackUserId: inbound.userId,
          organizationId: activeInstallation.organizationId, channelId: inbound.channelId, threadTs: inbound.threadTs ?? inbound.ts, eventTs: inbound.ts,
          scopeId: binding?.scopeId ?? null, installationGeneration: activeInstallation.generation });
      })();
      await options.repository.settleEvent(key, claim.leaseToken, true);
      return c.json({ received: true });
    } catch (error: unknown) {
      console.warn("[slack] event enqueue failed", error instanceof Error ? error.name : "UnknownError");
      await options.repository.settleEvent(key, claim.leaseToken, false); return fail(c, "Slack unavailable", 503);
    }
  }
  app.post("/webhooks/slack/events", limit, async (c) => {
    if (closed || activeEvents.size >= 256) return fail(c, "Slack unavailable", 503);
    try { return await deadline((signal) => {
      const operation = receiveEvent(c, signal);
      activeEvents.add(operation);
      void operation.then(() => { activeEvents.delete(operation); }, () => { activeEvents.delete(operation); });
      return operation;
    }); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[slack] ingress deadline failed", error instanceof Error ? error.name : "UnknownError");
      return fail(c, "Slack unavailable", 503);
    }
  });
  app.route("/", createSlackReplyRoutes(options));
  app.route("/", createSlackReactionRoutes(options));
  app.route("/", createSlackContextRoutes(options));
  app.route("/", createSlackLinkPage(options));
  return Object.assign(app, { async shutdownSlack() { closed = true; await Promise.allSettled([...activeEvents]); } });
}

async function deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Slack enqueue timeout")); }, 1_800); });
  try { return await Promise.race([operation(controller.signal), timeout]); } finally { if (timer) clearTimeout(timer); }
}
async function parse<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try { const parsed = schema.safeParse(await c.req.json()); return parsed.success ? parsed.data : null; }
  catch (error: unknown) { if (error instanceof Error && error.name === "BodyLimitError") throw error; if (!(error instanceof SyntaxError)) console.warn("[slack] body parse failed", error instanceof Error ? error.name : "UnknownError"); return null; }
}
function repositoryFailure(c: Context, error: unknown) {
  if (error instanceof SlackRepositoryError) return fail(c, "Request unavailable", error.code === "forbidden" ? 403 : error.code === "capacity" ? 429 : 409);
  console.warn("[slack] database request failed", error instanceof Error ? error.name : "UnknownError"); return fail(c, "Slack unavailable", 503);
}
function fail(c: Context, error: string, status: 401 | 403 | 409 | 413 | 422 | 429 | 503) { c.header("Cache-Control", "no-store"); return c.json({ error }, status); }
