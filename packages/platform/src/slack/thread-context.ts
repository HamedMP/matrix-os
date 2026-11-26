import { createSlackEnrolledContextReader } from "./enrolled-context.js";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  SlackThreadContextEnrollmentRequestSchema, SlackThreadContextEnrollmentResponseSchema,
  SlackThreadContextAccessSchema, SlackThreadContextAccessRequestSchema, SlackChannelMetadataSchema, SlackThreadContextEnvelopeSchema, type SlackThreadContextEnvelope,
  SlackMentionSummaryRuleSchema, type SlackMentionSummaryRule,
} from "@matrix-os/contracts/slack-bridge";
import { decryptSlackToken } from "./security.js";
import type { SlackDevAcceptance } from "./home-resolver.js";
import type { SlackAppRouteOptions } from "./routes.js";
import { OrganizationIdSchema, SlackUserIdSchema, type SlackInstallation } from "./types.js";
import { hasActiveSlackUserMention } from "./owner-mention.js";
import { mentionSourceEligible, slackMentionSourceProof, validSlackMentionSource } from "./mention-summary.js";
import { createSlackPrivateThreadReader } from "./private-thread-context.js";
import { attestSlackEnrolledEvent, validSlackEnrolledSource } from "./enrolled-source.js";

const Event = SlackThreadContextEnvelopeSchema.shape.event.shape;
const ThreadGrantSchema = SlackThreadContextAccessSchema.omit({ grantId: true }).extend({
  appId: Event.appId, teamId: Event.teamId, channelId: Event.channelId, threadTs: Event.threadTs,
  organizationId: OrganizationIdSchema, ownerSlackId: SlackUserIdSchema,
  installationGeneration: z.number().int().positive(), linkCreatedAt: z.iso.datetime(),
  scope: z.literal("thread").optional(),
}).strict();
const GrantSchema = z.union([
  ThreadGrantSchema,
  ThreadGrantSchema.omit({ threadTs: true, scope: true }).extend({ scope: z.literal("channel") }).strict(),
]);
export type SlackThreadContextGrant = z.infer<typeof GrantSchema>;

export function loadSlackThreadContextGrant(env: NodeJS.ProcessEnv, previewHandle?: string) {
  if (!env.SLACK_PREVIEW_THREAD_CONTEXT_GRANT) return undefined;
  if (!previewHandle) throw new Error("Slack thread context requires preview runtime");
  return GrantSchema.parse(JSON.parse(env.SLACK_PREVIEW_THREAD_CONTEXT_GRANT));
}

export function loadSlackDevThreadContextGrant(env: NodeJS.ProcessEnv, target: SlackDevAcceptance, appId: string) {
  if (env.SLACK_DEV_THREAD_CONTEXT_GRANT === undefined) return undefined;
  const grant = GrantSchema.parse(JSON.parse(env.SLACK_DEV_THREAD_CONTEXT_GRANT));
  if (grant.scope !== "channel" || grant.appId !== appId || grant.runtimeId !== target.machineId
    || grant.ownerId !== target.ownerId || grant.ownerSlackId !== target.ownerSlackId
    || grant.organizationId !== target.organizationId || grant.teamId !== target.teamId || grant.channelId !== target.channelId) {
    throw new Error("Slack Dev context scope mismatch");
  }
  return grant;
}

export type SlackThreadContextOptions = {
  contextGrant?: SlackThreadContextGrant;
  mentionSummaryRule?: SlackMentionSummaryRule;
  dispatchContext?(envelope: SlackThreadContextEnvelope, signal: AbortSignal): Promise<void>;
};

export function createSlackThreadContext(options: SlackAppRouteOptions) {
  const routes = new Hono();
  if (!options.contextGrant || options.contextGrant.appId !== options.config.appId) return { routes, receive: undefined, readPrivateThread: undefined, readEnrolledContext: undefined };
  const grant = GrantSchema.parse(options.contextGrant);
  const grantId = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
  const access = { grantId, ownerId: grant.ownerId, botId: grant.botId, chatId: grant.chatId, runtimeId: grant.runtimeId };
  const parsedRule = SlackMentionSummaryRuleSchema.safeParse(options.mentionSummaryRule);
  const rule = parsedRule.success && parsedRule.data.grantId === grantId ? parsedRule.data : undefined;

  function validInstallation(installation: SlackInstallation | null) {
    return installation?.state === "active" && installation.appId === grant.appId && installation.teamId === grant.teamId
      && installation.organizationId === grant.organizationId && installation.generation === grant.installationGeneration;
  }

  async function hasOwnerAuthority() {
    if (!await options.isCurrentMember({ actorId: grant.ownerId, organizationId: grant.organizationId })) return false;
    return await options.repository.hasThreadContextLink(grant)
      && validInstallation(await options.repository.getInstallation(grant.appId, grant.teamId));
  }

  async function readSlackAccess(installation: SlackInstallation, signal: AbortSignal) {
    if (!options.api.hasChannelMember) return null;
    const token = decryptSlackToken(installation.encryptedBotToken, options.config.tokenEncryptionKey, `${grant.appId}:${grant.teamId}`);
    const channel = await options.api.conversationInfo({ token, channelId: grant.channelId, signal });
    if (!channel.canAccess || channel.isExternalShared || (channel.channelMetadata && channel.channelMetadata.id !== grant.channelId)
      || (options.readOnlyDev && channel.channelMetadata?.name !== "tech")) return null;
    if (!await options.api.hasChannelMember({ token, channelId: grant.channelId, userId: grant.ownerSlackId, signal })) return null;
    const metadata = SlackChannelMetadataSchema.safeParse(channel.channelMetadata);
    return { channel: metadata.success ? metadata.data : undefined };
  }

  routes.post("/internal/slack/thread-context/access", bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Request too large" }, 413) }), async c => {
    c.header("Cache-Control", "no-store");
    const runtime = await options.authenticateRuntime?.(c);
    if (!runtime) return c.json({ error: "Unauthorized" }, 401);
    if (runtime.ownerId !== grant.ownerId || runtime.runtimeId !== grant.runtimeId) return c.json({ allowed: false });
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: "Invalid request" }, 400);
    }
    const request = SlackThreadContextAccessRequestSchema.safeParse(value);
    if (!request.success) return c.json({ error: "Invalid request" }, 400);
    if (Object.entries(access).some(([key, expected]) => request.data[key as keyof typeof access] !== expected)) return c.json({ allowed: false });
    if (request.data.summary && !validSlackMentionSource(options.config.signingSecret, grant, rule, request.data.summary)) return c.json({ allowed: false });
    if (request.data.source && !validSlackEnrolledSource(options.config.signingSecret, grant, request.data.source)) return c.json({ allowed: false });
    const installation = await options.repository.getInstallation(grant.appId, grant.teamId);
    if (!installation || !validInstallation(installation) || !await hasOwnerAuthority()) return c.json({ allowed: false });
    const slack = await readSlackAccess(installation, AbortSignal.timeout(1500));
    const allowed = Boolean(slack) && await hasOwnerAuthority();
    return c.json({ allowed, ...(allowed && request.data.includeChannelMetadata && slack?.channel ? { channel: slack.channel } : {}) });
  });

  async function authorizeEnrollment(request: import("@matrix-os/contracts/slack-bridge").SlackThreadContextAccess, runtime: import("./types.js").SlackRuntimeIdentity, signal: AbortSignal) {
    if(runtime.ownerId!==grant.ownerId||runtime.runtimeId!==grant.runtimeId||Object.entries(access).some(([key,expected])=>request[key as keyof typeof access]!==expected))return null;
    const installation=await options.repository.getInstallation(grant.appId,grant.teamId);
    if(!installation||!validInstallation(installation)||!await hasOwnerAuthority())return null;
    const slack=await readSlackAccess(installation,signal);
    return slack&&await hasOwnerAuthority()?{installation,channel:slack.channel}:null;
  }
  routes.post("/internal/slack/thread-context/enrollment", bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Request too large" }, 413) }), async c => {
    c.header("Cache-Control", "no-store");
    const runtime = await options.authenticateRuntime?.(c);
    if (!runtime) return c.json({ error: "Unauthorized" }, 401);
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: "Invalid request" }, 400);
    }
    const request = SlackThreadContextEnrollmentRequestSchema.safeParse(value);
    if (!request.success) return c.json({ error: "Invalid request" }, 400);
    if (Object.entries(request.data).some(([key, expected]) => access[key as keyof typeof access] !== expected)) return c.json({ available: false });
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(1500)]);
    const authority = await authorizeEnrollment(access, runtime, signal);
    signal.throwIfAborted();
    if (!authority?.channel) return c.json({ available: false });
    // Runtime reincarnation and owner authority may change while Slack responds.
    const current = await options.authenticateRuntime?.(c);
    if (!current || current.ownerId !== grant.ownerId || current.runtimeId !== grant.runtimeId || !await hasOwnerAuthority()) return c.json({ available: false });
    signal.throwIfAborted();
    return c.json(SlackThreadContextEnrollmentResponseSchema.parse({ available: true, access, appId: grant.appId, teamId: grant.teamId, channelId: grant.channelId, scope: grant.scope ?? "thread", ...(grant.scope !== "channel" ? { threadTs: grant.threadTs } : {}), channel: authority.channel }));
  });
  return {
    routes,
    readEnrolledContext: createSlackEnrolledContextReader(options,grant,authorizeEnrollment),
    readPrivateThread: createSlackPrivateThreadReader(options, grant, async (request,runtime,signal)=>{
      if (request.source ? !validSlackEnrolledSource(options.config.signingSecret, grant, request.source)
        : !validSlackMentionSource(options.config.signingSecret, grant, rule, request.summary)) return null;
      return authorizeEnrollment(request,runtime,signal);
    }),
    async receive(event: Record<string, unknown>, body: string, installation: SlackInstallation, signal: AbortSignal): Promise<200 | 409 | 503> {
      if (!options.dispatchContext || !validInstallation(installation) || event.channelId !== grant.channelId
        || event.appId !== grant.appId || event.teamId !== grant.teamId) return 200;
      if (grant.scope !== "channel" && (event.threadTs !== grant.threadTs || event.ts === event.threadTs)) return 200;
      // Blocks are needed only to classify the signed source. They must never
      // cross the reference bridge or become durable bot context.
      const { blocks: _blocks, ...normalizedEvent } = event;
      const source = grant.scope === "channel" ? { ...normalizedEvent, threadTs: event.threadTs ?? event.ts } : normalizedEvent;
      const parsed = SlackThreadContextEnvelopeSchema.safeParse({ ...access, event: source });
      if (!parsed.success) return 200;
      const envelope = parsed.data;
      const ownerMention = envelope.event.userId !== grant.ownerSlackId && hasActiveSlackUserMention({
        text: envelope.event.text, ...(Object.hasOwn(event, "blocks") ? { blocks: event.blocks } : {}),
      }, grant.ownerSlackId);
      envelope.source = attestSlackEnrolledEvent(options.config.signingSecret, grant, envelope.event, ownerMention);
      if (rule && mentionSourceEligible(grant, rule, envelope.event) && ownerMention) {
        envelope.summary = { ruleId: rule.ruleId, version: rule.version,
          proof: slackMentionSourceProof(options.config.signingSecret, grant, rule, envelope.event) };
      }
      const { appId, teamId, eventId } = envelope.event;
      const key = { appId, teamId, eventId };
      // This receipt is intentionally never assigned a Slack reply/reaction destination.
      // Including the grant in its digest prevents a pending retry retargeting after reconfiguration.
      const digest = createHash("sha256").update(grantId).update(body).digest("hex");
      const claim = await options.repository.claimEvent(key, digest);
      if (claim.outcome === "completed") return 200;
      if (claim.outcome === "conflict") return 409;
      if (claim.outcome !== "claimed") return 503;
      try {
        if (await hasOwnerAuthority() && await readSlackAccess(installation, signal) && await hasOwnerAuthority()) {
          signal.throwIfAborted();
          await options.dispatchContext(envelope, signal);
        }
        await options.repository.settleEvent(key, claim.leaseToken, true);
        return 200;
      } catch (error) {
        console.warn("[slack] thread context delivery failed", error instanceof Error ? error.name : "UnknownError");
        await options.repository.settleEvent(key, claim.leaseToken, false);
        return 503;
      }
    },
  };
}
