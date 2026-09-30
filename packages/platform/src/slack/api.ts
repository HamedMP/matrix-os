import { z } from "zod/v4";
import { escapeSlackText } from "./security.js";
import { SlackAppIdSchema, SlackTeamIdSchema, SlackUserIdSchema, SlackTimestampSchema, SlackChannelIdSchema, type SlackApi, type SlackMessagePage } from "./types.js";

export const SLACK_BOT_SCOPES = ["app_mentions:read", "channels:history", "groups:history", "im:history", "im:read", "channels:read", "groups:read", "chat:write", "reactions:write"] as const;
const MessagePageSchema = z.object({ messages: z.array(z.object({ user: SlackUserIdSchema.optional(), text: z.string().max(65_536).optional(), ts: SlackTimestampSchema, thread_ts: SlackTimestampSchema.optional() }).passthrough()).max(100),
  has_more: z.boolean().optional(), response_metadata: z.object({ next_cursor: z.string().max(1_024).optional() }).optional() }).passthrough();
const MAX_RESPONSE_BYTES = 256 * 1024;

export class SlackApiError extends Error { constructor() { super("Slack unavailable"); this.name = "SlackApiError"; } }

export function createSlackApi(options: { clientId: string; clientSecret: string; fetchImpl?: typeof fetch }): SlackApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  async function call(method: string, params: Record<string, string | number | boolean>, token?: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])),
      });
      if (!response.ok) { await response.body?.cancel(); throw new SlackApiError(); }
      const reader = response.body?.getReader();
      if (!reader) throw new SlackApiError();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          size += item.value.byteLength; if (size > MAX_RESPONSE_BYTES) throw new SlackApiError(); chunks.push(item.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      // Slack defines this as the same item/user/reaction combination already existing, so this effect is complete.
      if (method === "reactions.add" && z.object({ ok: z.literal(false), error: z.literal("already_reacted") }).passthrough().safeParse(data).success) return data;
      if (!z.object({ ok: z.literal(true) }).passthrough().safeParse(data).success) throw new SlackApiError();
      return data;
    } catch (error: unknown) {
      console.warn("[slack] API request failed", error instanceof Error ? error.name : "UnknownError");
      throw new SlackApiError();
    }
  }
  async function messagePage(method: "conversations.replies" | "conversations.history", input: { token: string; channelId: string; cursor?: string; ts?: string; signal?: AbortSignal }): Promise<SlackMessagePage> {
    const parsed = MessagePageSchema.parse(await call(method, { channel: SlackChannelIdSchema.parse(input.channelId), limit: 15,
      ...(input.ts ? { ts: SlackTimestampSchema.parse(input.ts) } : {}), ...(input.cursor ? { cursor: z.string().max(1_024).parse(input.cursor) } : {}) }, input.token, input.signal));
    return { messages: parsed.messages.map(({ user, text, ts, thread_ts }) => ({ ...(user ? { user } : {}), ...(text !== undefined ? { text } : {}), ts, ...(thread_ts ? { thread_ts } : {}) })),
      hasMore: parsed.has_more ?? false, ...(parsed.response_metadata?.next_cursor ? { nextCursor: parsed.response_metadata.next_cursor } : {}) };
  }
  return {
    async exchangeCode(input) {
      const result = z.object({ app_id: SlackAppIdSchema, team: z.object({ id: SlackTeamIdSchema }), bot_user_id: SlackUserIdSchema,
        access_token: z.string().min(10).max(4_096), token_type: z.literal("bot"), scope: z.string().max(4_096),
        is_enterprise_install: z.literal(false).optional(), expires_in: z.number().optional() }).passthrough().parse(await call("oauth.v2.access", {
          client_id: options.clientId, client_secret: options.clientSecret, code: input.code, redirect_uri: input.redirectUri,
        }));
      // Rotation requires a durable refresh flow. Never store a short-lived token as if it were permanent.
      if (result.expires_in !== undefined || SLACK_BOT_SCOPES.some((scope) => !result.scope.split(",").includes(scope))) throw new SlackApiError();
      return { appId: result.app_id, teamId: result.team.id, botUserId: result.bot_user_id, botToken: result.access_token };
    },
    async postMessage(input) {
      const text = z.string().min(1).max(35_000).parse(input.text);
      const result = z.object({ ts: SlackTimestampSchema }).passthrough().parse(await call("chat.postMessage", {
        channel: SlackChannelIdSchema.parse(input.channelId), text: escapeSlackText(text), mrkdwn: false, parse: "none", link_names: false,
        unfurl_links: false, unfurl_media: false, ...(input.threadTs ? { thread_ts: SlackTimestampSchema.parse(input.threadTs) } : {}),
      }, input.token, input.signal));
      return { ts: result.ts };
    },
    replies: (input) => messagePage("conversations.replies", input),
    history: (input) => messagePage("conversations.history", input),
    async conversationInfo(input) {
      const channelId = SlackChannelIdSchema.parse(input.channelId);
      const result = z.object({ channel: z.object({ is_ext_shared: z.boolean().optional(), is_pending_ext_shared: z.boolean().optional(),
        is_member: z.boolean().optional(), pending_connected_team_ids: z.array(z.string().max(64)).max(100).optional() }).passthrough() }).passthrough()
        .parse(await call("conversations.info", { channel: channelId }, input.token, input.signal));
      return { isExternalShared: result.channel.is_ext_shared === true || result.channel.is_pending_ext_shared === true || (result.channel.pending_connected_team_ids?.length ?? 0) > 0,
        canAccess: channelId.startsWith("D") || (result.channel.is_member === true && result.channel.is_ext_shared === false) };
    },
    async addReaction(input) {
      await call("reactions.add", { channel: SlackChannelIdSchema.parse(input.channelId), timestamp: SlackTimestampSchema.parse(input.ts),
        name: z.string().regex(/^[a-z0-9_+-]{1,64}$/).parse(input.name) }, input.token, input.signal);
    },
  };
}
