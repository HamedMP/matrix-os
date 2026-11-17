import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalShellChatClient } from "./canonical-chat-client";

/** Row actions remain owner/runtime scoped even for chats outside the loaded rail. */
export function createCanonicalChatRowActions({
  client,
  isCurrent,
  records,
  publish,
  reportFailure,
}: {
  client: CanonicalShellChatClient;
  isCurrent(): boolean;
  records(): readonly ChatNavigationRecord[];
  publish(record: CanonicalChatRecord): void;
  reportFailure(): void;
}) {
  const apply = async (id: string, update: (record: ChatNavigationRecord) => Promise<CanonicalChatRecord>) => {
    if (!isCurrent()) return false;
    try {
      const current = records().find((record) => record.chat.id === id) ?? (await client.detail(id)).record;
      if (!isCurrent()) return false;
      const updated = await update(current);
      if (!isCurrent()) return false;
      publish(updated);
      return true;
    } catch (cause: unknown) {
      console.warn("[chat-row] Update failed:", cause instanceof Error ? cause.name : "UnknownError");
      if (isCurrent()) reportFailure();
      return false;
    }
  };
  return {
    pin: (id: string, pinned: boolean) => apply(id, () => client.updateUserState(id, { pinned })),
    move: (id: string, projectId: string | null) =>
      apply(id, (record) =>
        client.updateProject(id, {
          baseRevision: record.chat.revision,
          projectId,
        }),
      ),
  };
}
