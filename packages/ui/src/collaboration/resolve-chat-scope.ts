import { CollaborationDiscoveryResponseSchema, CollaborationProjectOverviewSchema } from "@matrix-os/contracts";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

export async function resolveCanonicalChatScope(api: CollaborationApi, chatId: string, projectId?: string): Promise<string | null> {
  let cursor: string | undefined;
  const seenCursors = Object.create(null) as Record<string, true | undefined>;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const page = CollaborationDiscoveryResponseSchema.parse(
      await api.get(`/api/collaboration/shared?limit=100${suffix}`),
    );
    const match = page.items.find((item) => item.status === "accepted"
      && item.resource !== undefined && "chat" in item.resource && item.resource.chat.id === chatId);
    if (match?.status === "accepted") return match.scopeId;
    for (const item of page.items) {
      if (item.status !== "accepted" || !item.resource || !("project" in item.resource)) continue;
      const resource = item.resource;
      // Reuse the already hydrated overview. Only fetch an additional overview
      // for the known owning project; never scan every project on every open.
      const overview = resource.overview ?? (projectId === resource.project.id
        ? CollaborationProjectOverviewSchema.parse(await api.get(
          `/api/collaboration/scopes/${encodeURIComponent(item.scopeId)}/project/overview`,
        )) : undefined);
      if (!overview || overview.scopeId !== item.scopeId || overview.projectId !== resource.project.id) continue;
      const chat = overview.chats.find(chat => chat.chatId === chatId);
      if (chat) return chat.scopeId;
    }
    if (!page.nextCursor) return null;
    if (seenCursors[page.nextCursor]) throw new Error("CollaborationDiscoveryCursorLoop");
    seenCursors[page.nextCursor] = true;
    cursor = page.nextCursor;
  }
  throw new Error("CollaborationDiscoveryPageLimit");
}
