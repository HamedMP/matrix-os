import type { CanonicalChatRouteService } from "./chat/routes.js";
import type { ChatUsageRuntime } from "./chat-usage-routes.js";

/** Normal Chat auth/deletion completes first. FK cascades erase persisted facts;
 * this hook aborts the matching private in-memory work as well. */
export function withChatUsageDeletion(service: CanonicalChatRouteService,
  classifier: Pick<ChatUsageRuntime["classifier"], "deleteChat">): CanonicalChatRouteService {
  return { ...service, async delete(owner, chatId, clientRequestId) {
    const result = await service.delete(owner, chatId, clientRequestId);
    if (owner.type === "personal") await classifier.deleteChat(owner.ownerId, chatId);
    return result;
  } };
}
