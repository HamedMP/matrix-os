import { SlackPrivateThreadContextResponseSchema, type SlackChannelMetadata, type SlackPrivateThreadContextRequest, type SlackPrivateThreadContextResponse } from "@matrix-os/contracts/slack-bridge";
import { decryptSlackToken } from "./security.js";
import type { SlackAppRouteOptions } from "./routes.js";
import type { SlackThreadContextGrant } from "./thread-context.js";
import type { SlackInstallation, SlackMessagePage, SlackRuntimeIdentity } from "./types.js";

export type SlackPrivateThreadReader = (request: SlackPrivateThreadContextRequest, runtime: SlackRuntimeIdentity, signal: AbortSignal) => Promise<SlackPrivateThreadContextResponse | null>;
type Authority = { installation: SlackInstallation; channel?: SlackChannelMetadata };
const CONTEXT_BYTES = 16 * 1024;

/** Only the existing read grant and signed source proof may choose this root. */
export function createSlackPrivateThreadReader(options: SlackAppRouteOptions, grant: SlackThreadContextGrant,
  authorize: (request: SlackPrivateThreadContextRequest, runtime: SlackRuntimeIdentity, signal: AbortSignal) => Promise<Authority | null>): SlackPrivateThreadReader {
  return async (request, runtime, signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    const authority = await authorize(request, runtime, deadline);
    if (!authority) return null;
    const token = decryptSlackToken(authority.installation.encryptedBotToken, options.config.tokenEncryptionKey, `${grant.appId}:${grant.teamId}`);
    try {
      const messages: SlackMessagePage["messages"] = [];
      let partial = false;
      let cursor: string | undefined;
      const cursors: string[] = [];
      outer: for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        deadline.throwIfAborted();
        if (pageIndex > 0 && !await authorize(request, runtime, deadline)) return null;
        const page = await options.api.replies({ token, channelId: grant.channelId, ts: request.summary.threadTs, ...(cursor ? { cursor } : {}), signal: deadline });
        partial ||= page.messages.length > 15;
        for (const message of page.messages.slice(0, 15)) {
          if ((message.ts !== request.summary.threadTs && message.thread_ts !== request.summary.threadTs)
            || (message.thread_ts !== undefined && message.thread_ts !== request.summary.threadTs)) { partial = true; continue; }
          const normalized = { ...(message.user ? { user: message.user } : {}), ts: message.ts,
            ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}), ...(message.text !== undefined ? { text: message.text } : {}) };
          const candidate = { available: true, untrusted: true, partial: true, recipientUserId: grant.ownerSlackId,
            ...(authority.channel ? { channel: authority.channel } : {}), messages: [...messages, normalized] };
          if (Buffer.byteLength(JSON.stringify(candidate)) > CONTEXT_BYTES) { partial = true; break outer; }
          messages.push(normalized);
        }
        if (!page.hasMore && !page.nextCursor) break;
        if (pageIndex === 2 || !page.nextCursor || cursors.includes(page.nextCursor)) { partial = true; break; }
        cursor = page.nextCursor;
        cursors.push(cursor);
      }
      // Revocation or a changed source/recipient must fence data leaving the broker.
      if (!await authorize(request, runtime, deadline)) return null;
      partial ||= !messages.some(message => message.ts === request.summary.threadTs);
      return SlackPrivateThreadContextResponseSchema.parse({ available: true, untrusted: true, partial,
        recipientUserId: grant.ownerSlackId,
        ...(authority.channel ? { channel: authority.channel } : {}), messages });
    } catch (error) {
      console.warn("[slack] private thread context unavailable", error instanceof Error ? error.name : "UnknownError");
      return { available: false, untrusted: true };
    }
  };
}
