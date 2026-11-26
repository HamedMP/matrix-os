import { SlackEnrolledContextResponseSchema, type SlackEnrolledContextRequest, type SlackEnrolledContextResponse, type SlackChannelMetadata } from "@matrix-os/contracts/slack-bridge";
import type { SlackThreadContextGrant } from "./thread-context.js";
import type { SlackAppRouteOptions } from "./routes.js";
import type { SlackInstallation, SlackRuntimeIdentity, SlackMessagePage } from "./types.js";
import { decryptSlackToken } from "./security.js";
export type SlackEnrolledContextReader = (request: SlackEnrolledContextRequest, runtime: SlackRuntimeIdentity, signal: AbortSignal) => Promise<SlackEnrolledContextResponse | null>;
type Authority = {
  installation: SlackInstallation;
  channel?: SlackChannelMetadata;
};
/** Native reads use the same grant; no arbitrary method, channel, token or cursor is accepted. */
export function createSlackEnrolledContextReader(options: SlackAppRouteOptions, grant: SlackThreadContextGrant, authorize: (request: SlackEnrolledContextRequest, runtime: SlackRuntimeIdentity, signal: AbortSignal) => Promise<Authority | null>): SlackEnrolledContextReader {
  return async (request, runtime, signal) => {
    if (request.manual.operation === "recent" && grant.scope !== "channel" || request.manual.operation === "thread" && grant.scope !== "channel" && request.manual.threadTs !== grant.threadTs)
      return null;
    const threadTs = request.manual.operation === "thread" ? request.manual.threadTs : undefined;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const authority = await authorize(request, runtime, deadline);
    if (!authority)
      return null;
    const token = decryptSlackToken(authority.installation.encryptedBotToken, options.config.tokenEncryptionKey, `${grant.appId}:${grant.teamId}`);
    const source = { appId: grant.appId, teamId: grant.teamId, channelId: grant.channelId, ...(authority.channel ? { channelName: authority.channel.name } : {}) };
    const fetchedAt = new Date().toISOString();
    const messages: Extract<SlackEnrolledContextResponse, {
      available: true;
    }>["messages"] = [];
    let partial = false;
    let cursor: string | undefined;
    const cursors: string[] = [];
    const limit = request.manual.limit ?? 30;
    const response = () => ({ available: true as const, untrusted: true as const, partial, recipientUserId: grant.ownerSlackId, source, operation: request.manual.operation, fetchedAt, messages });
    try {
      outer: for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        deadline.throwIfAborted();
        if (pageIndex > 0 && !await authorize(request, runtime, deadline))
          return null;
        const input = { token, channelId: grant.channelId, ...(cursor ? { cursor } : {}), signal: deadline };
        const page: SlackMessagePage = request.manual.operation === "recent" ? await options.api.history(input) : await options.api.replies({ ...input, ts: request.manual.threadTs });
        if (page.messages.length > 15)
          partial = true;
        for (const message of page.messages.slice(0, 15)) {
          if (request.manual.operation === "thread" && ((message.ts !== request.manual.threadTs && message.thread_ts !== request.manual.threadTs) || (message.thread_ts !== undefined && message.thread_ts !== request.manual.threadTs))) {
            throw new Error("Slack thread unavailable");
          }
          const root = message.thread_ts ?? message.ts;
          const normalized = { ...(message.user ? { user: message.user } : {}), ts: message.ts, ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}), ...(message.text !== undefined ? { text: message.text } : {}),
            ...(message.reply_count !== undefined ? { reply_count: message.reply_count } : {}), ...(message.latest_reply ? { latest_reply: message.latest_reply } : {}),
            url: `https://app.slack.com/client/${grant.teamId}/${grant.channelId}?message_ts=${message.ts}&thread_ts=${root}` };
          const parsed = SlackEnrolledContextResponseSchema.safeParse({ ...response(), partial: false, messages: [...messages, normalized] });
          if (!parsed.success)
            throw new Error("Slack read unavailable");
          if (Buffer.byteLength(JSON.stringify(parsed.data)) > 16 * 1024) {
            partial = true;
            break outer;
          }
          messages.push(normalized);
          if (messages.length >= limit) {
            partial ||= page.hasMore || Boolean(page.nextCursor) || page.messages.indexOf(message) < page.messages.length - 1;
            break outer;
          }
        }
        if (!page.hasMore && !page.nextCursor)
          break;
        if (pageIndex === 2 || !page.nextCursor || cursors.includes(page.nextCursor)) {
          partial = true;
          break;
        }
        cursor = page.nextCursor;
        cursors.push(cursor);
      }
      if (threadTs && !messages.some(message => message.ts === threadTs))
        partial = true;
      if (!await authorize(request, runtime, deadline))
        return null;
      return SlackEnrolledContextResponseSchema.parse(response());
    }
    catch (error) {
      console.warn("[slack] enrolled read unavailable", error instanceof Error ? error.name : "UnknownError");
      return { available: false, untrusted: true };
    }
  };
}
