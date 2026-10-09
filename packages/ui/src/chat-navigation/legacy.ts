import { markChatNavigation } from "./metrics.js";
import { CanonicalChatNavigationItemSchema, type CanonicalChatRecord, type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../chat-agents/client.js";
import { botSummaryReads } from "../chat-agents/bots/bot-summary-reads.js";
import { ChatNavigationAuthorityRevoked } from "./store.js";

function unavailable(kind: string, error: unknown) {
  // Desktop and Web Bot clients preserve the HTTP status; library transports
  // may also expose the Desktop unauthorized category. Never turn revocation
  // into a partial successful list (or keep its cached rows visible).
  if (error instanceof ChatNavigationAuthorityRevoked
    || (typeof error === "object" && error !== null
      && (("status" in error && (error.status === 401 || error.status === 403))
        || ("category" in error && error.category === "unauthorized")))) {
    throw new ChatNavigationAuthorityRevoked();
  }
  console.warn(`[chat-navigation] Legacy ${kind} unavailable:`, error instanceof Error ? error.name : "UnknownError");
}
/** Compatibility only: callers enter this path on a confirmed unsupported endpoint. */
export async function legacyChatNavigation(records: readonly CanonicalChatRecord[], client?: ChatAgentClient): Promise<CanonicalChatNavigationResponse> {
  const bindings = new Map<string, string>();
  const reads = client?.bots ? botSummaryReads(client) : undefined;
  if (!reads && records.length) {
    throw new Error("NavigationClassificationUnavailable");
  }
  if (reads) {
    let agents: Awaited<ReturnType<ChatAgentClient["list"]>>["agents"] = [];
    try {
      agents = (await reads.library()).agents.filter(agent => !agent.archived).slice(0, 100);
    }
    catch (error: unknown) {
      unavailable("agent discovery", error);
    }
    let agentIndex = 0;
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, async () => {
      while (agentIndex < agents.length) {
        const agent = agents[agentIndex++]!;
        try {
          const id = await reads.directChat(agent.id);
          if (id) {
            bindings.set(id, agent.id);
          }
        }
        catch (error: unknown) {
          unavailable("agent binding", error);
        }
      }
    }));
  }
  const items: CanonicalChatNavigationResponse["items"] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
    while (index < records.length) {
      const record = records[index++]!;
      if (reads && !bindings.has(record.chat.id)) {
        markChatNavigation("identity-request");
      }
      let agentId: string | null;
      try {
        agentId = bindings.get(record.chat.id) ?? (reads ? await reads.directBot(record.chat.id) : null);
      }
      catch (error: unknown) {
        unavailable("Chat binding", error);
        // Unknown is never ordinary. Continue the bounded worker so one failed
        // binding cannot withhold unrelated, successfully classified rows.
        continue;
      }
      const { id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt } = record.chat;
      const readState = record.readState ?? { version: 0, unread: record.latestSuccessfulCompletion?.unacknowledged ?? false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 };
      items.push(CanonicalChatNavigationItemSchema.parse({ chat: { id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt },
        importSource: record.importSource, projectId: record.projectId, providerBinding: record.providerBinding ? { driverKind: record.providerBinding.driverKind } : undefined, activeRun: record.activeRun,
        latestSuccessfulCompletion: record.latestSuccessfulCompletion, readState, classification: agentId ? { kind: "bot", agentId } : { kind: "ordinary" },
        // Old servers do not expose a reliable membership projection: keep legacy cache memory-only.
        persistence: "membership" }));
    }
  }));
  const byId = new Map(items.map(item => [item.chat.id, item]));
  return { version: 1, items: records.flatMap(record => byId.has(record.chat.id) ? [byId.get(record.chat.id)!] : []), truncated: records.length >= 1000 };
}
