import { createHash, createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { SLACK_DEV_OAUTH_BROWSER_ORIGIN, SLACK_DEV_OAUTH_FINISH_PATH, SLACK_OAUTH_COMPLETION_PATH,
  SlackDevOAuthTicketSchema, SlackOAuthCallbackQuerySchema, slackDevOAuthCompletionPath } from '@matrix-os/contracts/slack-bridge';
import { createSlackAgentChannels, type SlackAgentChannelsOptions } from "./agent-channels.js";
import { createSlackContextRoutes } from "./context-routes.js";
import { createSlackThreadContext, type SlackThreadContextOptions } from "./thread-context.js";
import { createSlackLinkPage } from "./link-page.js";
import { createSlackReplyRoutes } from "./reply-routes.js";
import { createSlackReactionRoutes } from "./reaction-routes.js";
import { SLACK_BOT_SCOPES, SLACK_DEV_BOT_SCOPES } from "./api.js";
import type { SlackDevAcceptance } from "./home-resolver.js";
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
const newMessageSubtypes = ["bot_message", "file_share", "me_message", "reply_broadcast", "thread_broadcast"];

export type SlackAppRouteOptions = SlackAuthorityDependencies & SlackThreadContextOptions & SlackAgentChannelsOptions & {
  config: SlackAppConfig; repository: SlackRepository; api: SlackApi; now?: () => Date; readOnlyDev?: SlackDevAcceptance;
  devBrowserOAuth?: boolean;
};

export function createSlackAppRoutes(options: SlackAppRouteOptions): Hono & { shutdownSlack(): Promise<void> } {
  const app = new Hono();
  const dev = options.readOnlyDev;
  const now = options.now ?? (() => new Date());
  const threadContext = createSlackThreadContext(options);
  const agentLane = createSlackAgentChannels(options);
  if (agentLane) app.route("/", agentLane.routes);
  const publicUrl = new URL(options.config.publicBaseUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") throw new Error("Slack public origin unavailable");
  const callbackUrl = `${publicUrl.origin}/api/slack/oauth/callback`;
  const browserHandoff = dev && options.devBrowserOAuth ? {
    returnUrl: SLACK_DEV_OAUTH_BROWSER_ORIGIN + slackDevOAuthCompletionPath(dev.handle),
    encryptionContext: `matrix-slack-dev-oauth-ticket:v1:${options.config.appId}:${dev.machineId}`,
  } : undefined;
  const activeEvents = new Set<Promise<Response>>();
  let closed = false;
  const limit = bodyLimit({ maxSize: 256 * 1024, onError: (c) => fail(c, "Request too large", 413) });
  app.onError((error, c) => {
    console.warn("[slack] request failed", error.name);
    return fail(c, "Slack unavailable", 503);
  });
  if (browserHandoff) {
    app.on("OPTIONS", ["/api/slack/install", SLACK_DEV_OAUTH_FINISH_PATH], c => {
      const headers = c.req.header("access-control-request-headers")?.toLowerCase().split(",").map(name => name.trim());
      if (c.req.header("origin") !== SLACK_DEV_OAUTH_BROWSER_ORIGIN || c.req.header("cookie")
        || c.req.header("access-control-request-method") !== "POST" || new URL(c.req.url).search
        || !headers || headers.length !== 2 || !headers.includes("authorization") || !headers.includes("content-type")) {
        return fail(c, "Forbidden", 403);
      }
      devBrowserHeaders(c);
      c.header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
      c.header("Access-Control-Allow-Methods", "POST");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return c.body(null, 204);
    });
  }
  app.use("/api/slack/*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const bearer = hasCookieLessBearer(c);
      if (browserHandoff && c.req.method === "POST"
        && (c.req.path === "/api/slack/install" || c.req.path === SLACK_DEV_OAUTH_FINISH_PATH)
        && origin === SLACK_DEV_OAUTH_BROWSER_ORIGIN) {
        devBrowserHeaders(c);
        if (!bearer || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(c.req.header("content-type") ?? "")
          || new URL(c.req.url).search) return fail(c, "Forbidden", 403);
        await next();
        return;
      }
      // Cookie-bearing requests never inherit a Bearer bypass; the auth resolver must authenticate the Bearer for native callers.
      if (origin !== publicUrl.origin && !(origin === undefined && bearer)) return fail(c, "Forbidden", 403);
    }
    await next();
  });
  async function actor(c: Context) {
    const parsed = ActorIdSchema.safeParse(await options.resolveActor(c));
    return parsed.success ? parsed.data : null;
  }

  const isDevInstaller = (actorId: string, organizationId: string) => !dev || (actorId === dev.ownerId && organizationId === dev.organizationId);

  app.post("/api/slack/install", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const request = await parse(c, z.object({ organizationId: OrganizationIdSchema }).strict());
    if (!request) return fail(c, "Invalid request", 422);
    if (!isDevInstaller(actorId, request.organizationId) || !await options.requireOrgAdmin({ actorId, organizationId: request.organizationId })) return fail(c, "Forbidden", 403);
    const token = randomBytes(32).toString("base64url");
    await options.repository.createOAuthState({ hash: digest(token), appId: options.config.appId, actorId, organizationId: request.organizationId });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    const scopes = dev ? SLACK_DEV_BOT_SCOPES : SLACK_BOT_SCOPES;
    url.search = new URLSearchParams({ client_id: options.config.clientId, scope: scopes.join(","),
      redirect_uri: callbackUrl, state: token, ...(dev ? { team: dev.teamId } : {}) }).toString();
    c.header("Cache-Control", "no-store"); return c.json({ url: url.toString() });
  });

  app.get("/api/slack/oauth/callback", limit, async (c) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    const actorId = browserHandoff && !hasCookieLessBearer(c) ? null : await actor(c);
    if (!actorId) {
      const query = CallbackQuerySchema.safeParse(c.req.query());
      if (c.req.header('accept')?.includes('text/html') && !c.req.header('authorization')) {
        if (browserHandoff && c.req.query("error") === "access_denied") return c.redirect(browserHandoff.returnUrl + "#error=access_denied", 303);
        // The browser refreshes its own Clerk session. State never supplies identity.
        if (query.success) {
          if (browserHandoff) {
            const ticket = encryptSlackToken(JSON.stringify(query.data), options.config.tokenEncryptionKey, browserHandoff.encryptionContext);
            return c.redirect(browserHandoff.returnUrl + "#ticket=" + ticket, 303);
          }
          return c.redirect(SLACK_OAUTH_COMPLETION_PATH + "?" + new URLSearchParams(query.data).toString(), 303);
        }
      }
      return fail(c, "Unauthorized", 401);
    }
    const parsed = CallbackQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return fail(c, "Invalid request", 422);
    return finishInstallation(c, actorId, parsed.data);
  });

  if (browserHandoff) {
    app.post(SLACK_DEV_OAUTH_FINISH_PATH, bodyLimit({ maxSize: 8 * 1024, onError: c => fail(c, "Request too large", 413) }), async c => {
      if (c.req.header("origin") !== SLACK_DEV_OAUTH_BROWSER_ORIGIN || !hasCookieLessBearer(c)) return fail(c, "Forbidden", 403);
      const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
      if (actorId !== dev?.ownerId) return fail(c, "Forbidden", 403);
      const request = await parse(c, SlackDevOAuthTicketSchema); if (!request) return fail(c, "Invalid request", 422);
      try {
        const plaintext = decryptSlackToken(request.ticket, options.config.tokenEncryptionKey, browserHandoff.encryptionContext);
        const query = CallbackQuerySchema.safeParse(JSON.parse(plaintext));
        if (query.success) return finishInstallation(c, actorId, query.data);
      } catch (error: unknown) {
        // The token helper records decryption errors without credential values.
        if (!(error instanceof Error)) throw error;
      }
      return fail(c, "Invalid request", 422);
    });
  }

  async function finishInstallation(c: Context, actorId: string, query: z.infer<typeof CallbackQuerySchema>) {
    const hash = digest(query.state);
    const state = await options.repository.getOAuthState(hash);
    if (!state) return fail(c, "Request expired", 409);
    if (state.appId !== options.config.appId || state.actorId !== actorId || !isDevInstaller(actorId, state.organizationId) || !await options.requireOrgAdmin({ actorId, organizationId: state.organizationId })) return fail(c, "Forbidden", 403);
    try { await options.repository.consumeOAuthState(hash, actorId); } catch (error: unknown) { return repositoryFailure(c, error); }
    const installed = await options.api.exchangeCode({ code: query.code, redirectUri: callbackUrl });
    if (installed.appId !== options.config.appId || (dev && (installed.teamId !== dev.teamId || installed.slackUserId !== dev.ownerSlackId))) {
      return fail(c, "Forbidden", 403);
    }
    // Provider latency must not let an expired administrator privilege commit installation.
    if (!await options.requireOrgAdmin({ actorId, organizationId: state.organizationId })) return fail(c, "Forbidden", 403);
    try {
      const ownerBinding = await options.repository.saveInstallation({ ...installed, organizationId: state.organizationId, installedBy: actorId,
        encryptedBotToken: encryptSlackToken(installed.botToken, options.config.tokenEncryptionKey, `${installed.appId}:${installed.teamId}`) },
      dev ? { oauthStateHash: hash, ownerSlackUserId: dev.ownerSlackId } : { oauthStateHash: hash });
      return c.json({ connected: true, teamId: installed.teamId, ...(ownerBinding ? { ownerBinding } : {}) });
    } catch (error: unknown) { return repositoryFailure(c, error); }
  }

  app.post("/api/slack/link/complete", limit, async (c) => {
    if (dev) return fail(c, "Forbidden", 403);
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
    if (dev && (actorId !== dev.ownerId || teamId.data !== dev.teamId)) return fail(c, "Forbidden", 403);
    await options.repository.removeLink(options.config.appId, teamId.data, actorId); return c.body(null, 204);
  });
  app.delete("/api/slack/workspaces/:teamId", limit, async (c) => {
    const actorId = await actor(c); if (!actorId) return fail(c, "Unauthorized", 401);
    const teamId = SlackTeamIdSchema.safeParse(c.req.param("teamId")); if (!teamId.success) return fail(c, "Invalid request", 422);
    if (dev && (actorId !== dev.ownerId || teamId.data !== dev.teamId)) return fail(c, "Forbidden", 403);
    const installed = await options.repository.getInstallation(options.config.appId, teamId.data);
    if (!installed || !await options.requireOrgAdmin({ actorId, organizationId: installed.organizationId })) return fail(c, "Forbidden", 403);
    await options.repository.revokeInstallation(options.config.appId, teamId.data, { source: "administrator" }); return c.body(null, 204);
  });
  app.put("/api/slack/workspaces/:teamId/channels/:channelId", limit, async (c) => {
    if (dev) return fail(c, "Forbidden", 403);
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
    const routeWorkspace = Boolean(agentLane && teamId === options.agentChannels?.teamId);
    if (appId !== options.config.appId || (dev && teamId !== dev.teamId && !routeWorkspace)) return fail(c, "Forbidden", 403);
    const revocation = event.type === "app_uninstalled" || event.type === "tokens_revoked";
    const installed = await options.repository.getInstallation(appId, teamId);
    if ((!installed || installed.state !== "active") && !revocation) return fail(c, "Forbidden", 403);
    if (envelope.data.is_ext_shared_channel || event.is_ext_shared || (event.user_team && event.user_team !== teamId)) return c.json({ received: true });
    const routedChannel = routeWorkspace && options.agentChannels?.channels.find(ch => ch.channelId === event.channel);
    const routedPublicMessage = event.channel_type === "channel"
      || (routedChannel && routedChannel.channelSummary && event.channel_type === undefined && event.channel?.startsWith("C"));
    if (agentLane && routedChannel && event.type === "message" && routedPublicMessage && installed && event.channel
      && event.ts && event.text && event.user !== installed.botUserId) {
      const profile = event.bot_profile;
      const profileAppId = profile && typeof profile === "object" && "app_id" in profile ? profile.app_id : undefined;
      const newSummaryPost = (event.user || event.bot_id)
        && (!event.subtype || newMessageSubtypes.includes(event.subtype))
        && event.app_id !== appId && profileAppId !== appId;
      const ordinaryHumanPost = !event.bot_id && !event.subtype && event.app_id === undefined && event.user;
      if (routedChannel.channelSummary ? newSummaryPost : ordinaryHumanPost) {
        const status = await agentLane.receive({ eventId, channelId: event.channel, userId: event.user, botId: event.bot_id,
          ts: event.ts, threadTs: event.thread_ts, text: event.text }, installed, body, signal);
        return status === 200 ? c.json({ received: true }) : fail(c, status === 409 ? "Conflicting delivery" : "Slack unavailable", status);
      }
    }
    if (dev && !revocation && (event.type !== "message" || teamId !== dev.teamId || event.channel !== dev.channelId)) return c.json({ received: true });
    if (threadContext.receive && installed && event.type === "message" && event.channel_type === "channel"
      && !event.bot_id && !event.subtype && event.app_id === undefined && event.user !== installed.botUserId) {
      const status = await threadContext.receive({ appId, teamId, eventId, userId: event.user, channelId: event.channel,
        threadTs: event.thread_ts, ts: event.ts, text: event.text,
        ...(Object.hasOwn(event, "blocks") ? { blocks: event.blocks } : {}) }, body, installed, signal);
      return status === 200 ? c.json({ received: true }) : fail(c, status === 409 ? "Conflicting delivery" : "Slack unavailable", status);
    }
    if (dev && !revocation) return c.json({ received: true });
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
        const pinned = await options.repository.getEventDestination(key);
        if (pinned && (!pinned.runtimeId || pinned.actorId !== link.actorId || pinned.organizationId !== activeInstallation.organizationId
          || pinned.scopeId !== (binding?.scopeId ?? null) || pinned.installationGeneration !== activeInstallation.generation)) return;
        let destination = pinned;
        if (!destination) {
          const resolved = await options.resolveDestination({ installation: activeInstallation, link, binding, event: inbound });
          const ownerId = ActorIdSchema.parse(resolved.ownerId);
          if (inbound.kind === "direct_message" && ownerId !== link.actorId) throw new Error("Slack personal destination mismatch");
          if (!/^[A-Za-z0-9:_-]{1,160}$/.test(resolved.runtimeId)) throw new Error("Slack destination unavailable");
          destination = { ...key, ownerId, runtimeId: resolved.runtimeId, actorId: link.actorId, slackUserId: inbound.userId,
            organizationId: activeInstallation.organizationId, channelId: inbound.channelId, threadTs: inbound.threadTs ?? inbound.ts, eventTs: inbound.ts,
            scopeId: binding?.scopeId ?? null, installationGeneration: activeInstallation.generation };
          await options.repository.recordDestination(key, claim.leaseToken, destination);
        }
        // Membership, route discovery and receipt persistence can all wait. Fence
        // local Slack authority after those waits, immediately before the home RPC.
        if (!await options.isCurrentMember({ actorId: link.actorId, organizationId: activeInstallation.organizationId })) return;
        const [currentInstallation, currentLink, currentBinding] = await Promise.all([
          options.repository.getInstallation(appId, teamId),
          options.repository.getLink(appId, teamId, inbound.userId),
          inbound.kind === "mention" ? options.repository.getChannelBinding(appId, teamId, inbound.channelId) : Promise.resolve(null),
        ]);
        if (!currentInstallation || currentInstallation.state !== "active" || currentInstallation.generation !== activeInstallation.generation
          || currentInstallation.organizationId !== activeInstallation.organizationId || !currentLink || currentLink.actorId !== link.actorId
          || currentLink.organizationId !== link.organizationId || (inbound.kind === "mention" && (!currentBinding || !currentBinding.approvedOutput
            || currentBinding.organizationId !== binding?.organizationId || currentBinding.scopeId !== binding?.scopeId))) return;
        signal.throwIfAborted();
        const dispatched = await options.dispatch({ installation: activeInstallation, link, binding, event: inbound, destination, signal });
        if (dispatched.ownerId !== destination.ownerId) throw new Error("Slack destination changed");
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
  if (dev) {
    app.post("/internal/slack/replies", limit, c => fail(c, "Not found", 404));
    app.post("/internal/slack/reactions", limit, c => fail(c, "Not found", 404));
    app.get("/slack/link", c => fail(c, "Not found", 404));
  } else {
    app.route("/", createSlackReplyRoutes(options));
    app.route("/", createSlackReactionRoutes(options));
    app.route("/", createSlackLinkPage(options));
  }
  app.route("/", createSlackContextRoutes(options, threadContext.readPrivateThread, threadContext.readEnrolledContext));
  app.route("/", threadContext.routes);
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
function fail(c: Context, error: string, status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503) { c.header("Cache-Control", "no-store"); return c.json({ error }, status); }

function hasCookieLessBearer(c: Context): boolean {
  return !c.req.header("cookie") && /^Bearer [A-Za-z0-9._~-]{1,4096}$/i.test(c.req.header("authorization") ?? "");
}

function devBrowserHeaders(c: Context): void {
  c.header("Access-Control-Allow-Origin", SLACK_DEV_OAUTH_BROWSER_ORIGIN);
  c.header("Vary", "Origin");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}
