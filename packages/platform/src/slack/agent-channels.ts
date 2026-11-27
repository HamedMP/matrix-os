import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { SlackAgentChannelSchema, RoutedSlackEventSchema, type RoutedSlackEvent, type SlackAgentChannel } from "@matrix-os/contracts/slack-bridge";
import type { SlackDevAcceptance } from "./home-resolver.js";
import type { SlackAppRouteOptions } from "./routes.js";
import type { SlackInstallation } from "./types.js";
import { decryptSlackToken } from "./security.js";

const Channel = SlackAgentChannelSchema.pick({ channelId: true, name: true, senderId: true, channelSummary: true });
const Config = z.strictObject({
  teamId: SlackAgentChannelSchema.shape.teamId,
  ownerSlackId: SlackAgentChannelSchema.shape.senderId,
  channels: z.array(Channel).min(1).max(2),
}).refine(v => new Set(v.channels.map(c => c.channelId)).size === v.channels.length
  && new Set(v.channels.map(c => c.name)).size === v.channels.length);
export type SlackDevAgentChannels = z.infer<typeof Config>;

export function loadSlackDevAgentChannels(raw: string | undefined, dev?: SlackDevAcceptance) {
  if (raw === undefined) return undefined;
  if (!dev || raw.length > 2048) throw new Error("Dev Slack channel selection unavailable");
  const value = Config.parse(JSON.parse(raw));
  if (value.teamId === dev.teamId && (value.ownerSlackId !== dev.ownerSlackId
    || value.channels.some(c => c.channelId === dev.channelId))) throw new Error("Dev Slack channel overlaps the pilot");
  return value;
}

export function createSlackAgentChannels(options: SlackAppRouteOptions) {
  const config = options.agentChannels;
  const dev = options.readOnlyDev;
  if (!config || !dev || !options.dispatchRouted) return null;
  const { teamId, ownerSlackId, channels } = config;
  const { ownerId, organizationId, machineId: runtimeId } = dev;
  const { appId } = options.config;

  async function identity(installation: SlackInstallation | null, channel: z.infer<typeof Channel>): Promise<SlackAgentChannel | null> {
    if (!installation || installation.state !== "active" || installation.appId !== appId || installation.teamId !== teamId
      || installation.organizationId !== organizationId || ownerId !== installation.installedBy) return null;
    const linked = await options.repository.getOwnerLinkCreation({ appId, teamId, ownerSlackId, organizationId, ownerId });
    if (!linked || !await options.isCurrentMember({ actorId: ownerId, organizationId })) return null;
    const sourceId = createHash("sha256").update(JSON.stringify([ownerId, runtimeId, appId, teamId,
      installation.generation, organizationId, ownerSlackId, linked, channel.channelId, channel.name, channel.senderId,
      ...(channel.channelSummary ? ["channel-summary"] : [])])).digest("hex");
    return { ownerId, runtimeId, appId, teamId, ...channel, sourceId, installationGeneration: installation.generation };
  }

  const routes = new Hono();
  routes.post("/internal/slack/agent-channels", bodyLimit({ maxSize: 1024, onError: c => c.json({error:"Request too large"},413) }), async c => {
    c.header("Cache-Control", "no-store");
    const runtime = await options.authenticateRuntime?.(c);
    if (runtime?.ownerId !== ownerId || runtime.runtimeId !== runtimeId) return c.json({error:"Unauthorized"},401);
    let raw: unknown;
    try { raw = await c.req.json(); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return c.json({error:"Invalid request"},400); }
    const request = z.strictObject({channelId: Channel.shape.channelId.optional()}).safeParse(raw);
    if (!request.success) return c.json({error:"Invalid request"},400);
    const selected = channels.filter(ch => !request.data.channelId || ch.channelId === request.data.channelId);
    if (!options.api.hasChannelMember || !selected.length) return c.json({channels: []});
    const installed = await options.repository.getInstallation(appId, teamId);
    if (!installed) return c.json({channels: []});
    const approved: SlackAgentChannel[] = [];
    const signal = AbortSignal.timeout(6500);
    for (const channel of selected) {
      const match = await identity(installed, channel);
      if (!match) continue;
      const token = decryptSlackToken(installed.encryptedBotToken, options.config.tokenEncryptionKey, appId + ":" + teamId);
      const resource = {token, channelId: channel.channelId, signal};
      const info = await options.api.conversationInfo(resource);
      if (!info.canAccess || info.isExternalShared || info.channelMetadata?.id !== channel.channelId || info.channelMetadata?.name !== channel.name
        || !await options.api.hasChannelMember({ ...resource, userId: ownerSlackId })
        || channel.senderId !== ownerSlackId && !await options.api.hasChannelMember({ ...resource, userId: channel.senderId })) continue;
      const latest = await identity(await options.repository.getInstallation(appId, teamId), channel);
      if (latest?.sourceId === match.sourceId) approved.push(latest);
    }
    return c.json({ channels: approved });
  });

  return { routes, async receive(input: { eventId: string; channelId: string; userId?: string; botId?: string; ts: string; threadTs?: string; text: string },
    installed: SlackInstallation, body: string, signal: AbortSignal): Promise<200 | 409 | 503> {
    const channel = channels.find(c => c.channelId === input.channelId);
    if (!channel || (!channel.channelSummary && (input.botId || channel.senderId !== input.userId))) return 200;
    const source = await identity(installed, channel);
    if (!source) return 200;
    const parsed = RoutedSlackEventSchema.safeParse({ ownerId, runtimeId, appId, teamId, installationGeneration: source.installationGeneration,
      sourceId: source.sourceId, ...input, threadTs: input.threadTs ?? input.ts });
    if (!parsed.success) return 200;
    const key = { appId, teamId, eventId: input.eventId };
    const digest = createHash("sha256").update(source.sourceId).update(body).digest("hex");
    const claim = await options.repository.claimEvent(key, digest);
    if (claim.outcome === "completed") return 200;
    if (claim.outcome === "conflict") return 409;
    if (claim.outcome !== "claimed") return 503;
    try {
      const current = await identity(await options.repository.getInstallation(appId, teamId), channel);
      signal.throwIfAborted();
      if (current?.sourceId === source.sourceId) await options.dispatchRouted!(parsed.data, signal);
      await options.repository.settleEvent(key, claim.leaseToken, true);
      return 200;
    } catch (error) {
      console.warn("[slack] Agent channel delivery unavailable", error instanceof Error ? error.name : "UnknownError");
      await options.repository.settleEvent(key, claim.leaseToken, false);
      return 503;
    }
  } };
}

export type SlackAgentChannelsOptions = {
  agentChannels?: SlackDevAgentChannels;
  dispatchRouted?(event: RoutedSlackEvent, signal: AbortSignal): Promise<void>;
};
