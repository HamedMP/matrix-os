import { useConnection } from "../../../stores/connection";
import { useUi } from "../../../stores/ui";
import { createCanonicalChatClient } from "../../../lib/canonical-chat-client";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { openWorkProject } from "../work-navigation";
import type { Project } from "../../../stores/board";

export function projectMoveAuthorityKey() {
  const connection = useConnection.getState();
  return JSON.stringify([connection.userId, connection.platformHost, connection.runtimeSlot, connection.authGeneration]);
}
// Weak workflow keys keep predicates out of serializable UI state and release
// the captured navigation store when the pending creation request is discarded.
type PendingMove = NonNullable<ReturnType<typeof useUi.getState>["pendingProjectChatMove"]>;
const navigationAuthority = new WeakMap<PendingMove, () => boolean>();
export function createProjectForChat(record: ChatNavigationRecord, isCurrent?: () => boolean) {
  if (isCurrent && !isCurrent()) return;
  const pending = {chatId:record.chat.id, baseRevision:record.chat.revision, authorityKey:projectMoveAuthorityKey()};
  if (isCurrent) navigationAuthority.set(pending, isCurrent);
  useUi.getState().openCreateProjectForChat(pending);
}
/** Completes the existing creation dialog's optional move without changing its engine. */
export async function moveChatToCreatedProject(project: Project) {
  const pending = useUi.getState().pendingProjectChatMove;
  if (!pending) return;
  const connection = useConnection.getState();
  const isCurrent = () => pending.authorityKey === projectMoveAuthorityKey()
    && useConnection.getState().api === connection.api && (navigationAuthority.get(pending)?.() ?? true);
  if (!connection.api || !isCurrent()) {
    useUi.getState().clearPendingProjectChatMove();
    return;
  }
  try {
    const updated = await createCanonicalChatClient(connection.api).updateProject(pending.chatId, {baseRevision:pending.baseRevision, projectId:project.id ?? project.slug});
    if (!isCurrent() || useUi.getState().pendingProjectChatMove !== pending) {
      if (useUi.getState().pendingProjectChatMove === pending) useUi.getState().clearPendingProjectChatMove();
      return;
    }
    useUi.getState().clearPendingProjectChatMove();
    useUi.getState().requestProjectChatMoveRefresh();
    // The creation helper opens its normal Project tab first, then this
    // completion focuses the moved Chat using the authenticated returned record.
    return () => {
      if (isCurrent()) openWorkProject(project,updated.chat.id,updated.chat.title);
    };
  } catch (error: unknown) {
    console.warn("[chat] New Project move failed:", error instanceof Error ? error.name : "UnknownError");
    if (useUi.getState().pendingProjectChatMove !== pending) return;
    if (!isCurrent()) { useUi.getState().clearPendingProjectChatMove(); return; }
    useUi.getState().clearPendingProjectChatMove("The Project was created, but the Chat could not be moved. Its original project is preserved. Try Move to project again.");
  }
}
