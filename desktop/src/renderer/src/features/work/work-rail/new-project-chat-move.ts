import { useConnection } from "../../../stores/connection";
import { useUi } from "../../../stores/ui";
import { createCanonicalChatClient } from "../../../lib/canonical-chat-client";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { openWorkProject } from "../work-navigation";
import type { Project } from "../../../stores/board";

export function projectMoveAuthorityKey() {
  const connection = useConnection.getState();
  return JSON.stringify([connection.userId, connection.platformHost, connection.runtimeSlot, connection.authGeneration]);
}
export function createProjectForChat(record: CanonicalChatRecord) {
  useUi.getState().openCreateProjectForChat({chatId:record.chat.id, baseRevision:record.chat.revision, authorityKey:projectMoveAuthorityKey()});
}
/** Completes the existing creation dialog's optional move without changing its engine. */
export async function moveChatToCreatedProject(project: Project) {
  const pending = useUi.getState().pendingProjectChatMove;
  if (!pending) return;
  const connection = useConnection.getState();
  if (!connection.api || pending.authorityKey !== projectMoveAuthorityKey()) {
    useUi.getState().clearPendingProjectChatMove();
    return;
  }
  try {
    const updated = await createCanonicalChatClient(connection.api).updateProject(pending.chatId, {baseRevision:pending.baseRevision, projectId:project.id ?? project.slug});
    if (pending.authorityKey !== projectMoveAuthorityKey() || useConnection.getState().api !== connection.api || useUi.getState().pendingProjectChatMove !== pending) return;
    useUi.getState().clearPendingProjectChatMove();
    useUi.getState().requestProjectChatMoveRefresh();
    // The creation helper opens its normal Project tab first, then this
    // completion focuses the moved Chat using the authenticated returned record.
    return () => {
      if (pending.authorityKey === projectMoveAuthorityKey() && useConnection.getState().api === connection.api) openWorkProject(project,updated.chat.id,updated.chat.title);
    };
  } catch (error: unknown) {
    console.warn("[chat] New Project move failed:", error instanceof Error ? error.name : "UnknownError");
    if (pending.authorityKey === projectMoveAuthorityKey() && useConnection.getState().api === connection.api && useUi.getState().pendingProjectChatMove === pending) useUi.getState().clearPendingProjectChatMove("The Project was created, but the Chat could not be moved. Its original project is preserved. Try Move to project again.");
  }
}
