import { markChatNavigation } from "./metrics.js";
import { CanonicalChatNavigationItemSchema, type CanonicalChatRecord, type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../chat-agents/client.js";
import { botSummaryReads } from "../chat-agents/bots/bot-summary-reads.js";
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
      console.warn("[chat-navigation] Legacy agent discovery unavailable:", error instanceof Error ? error.name : "UnknownError");
    }
    let agentIndex = 0;
    await Promise.all(Array.from({ length: Math.min(4, agents.length) }, async () => {
      while (agentIndex < agents.length) {
        const agent = agents[agentIndex++]!;
        const id = await reads.directChat(agent.id);
        if (id) {
          bindings.set(id, agent.id);
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
      const agentId = bindings.get(record.chat.id) ?? (reads ? await reads.directBot(record.chat.id) : null);
      const { id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt } = record.chat;
      const readState = record.readState ?? { version: 0, unread: record.latestSuccessfulCompletion?.unacknowledged ?? false, markedUnread: false, latestIncomingSeq: 0, readThroughSeq: 0 };
      items.push(CanonicalChatNavigationItemSchema.parse({ chat: { id, title, titleVersion, activityAt, lifecycle, attention, revision, messageCount, userState, createdAt, updatedAt },
        projectId: record.projectId, providerBinding: record.providerBinding ? { driverKind: record.providerBinding.driverKind } : undefined, activeRun: record.activeRun,
        latestSuccessfulCompletion: record.latestSuccessfulCompletion, readState, classification: agentId ? { kind: "bot", agentId } : { kind: "ordinary" },
        // Old servers do not expose a reliable membership projection: keep legacy cache memory-only.
        persistence: "membership" }));
    }
  }));
  const byId = new Map(items.map(item => [item.chat.id, item]));
  return { version: 1, items: records.flatMap(record => byId.has(record.chat.id) ? [byId.get(record.chat.id)!] : []), truncated: records.length >= 1000 };
}
