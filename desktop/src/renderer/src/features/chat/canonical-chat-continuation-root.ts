import type { CanonicalChatDetailResponse, CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { AppError } from "../../../../shared/app-error";

/** Bind a normal follow-up before admission snapshots/hashes its request. */
export function withChatContinuationRoot<T extends Pick<CanonicalCreateChatTurnRequest, "executionRoot">>(
  input: T,
  detail: CanonicalChatDetailResponse | null,
  selectedChatId: string | null,
): T {
  if (selectedChatId === null) return input;
  if (!detail || detail.record.chat.id !== selectedChatId) throw new AppError("server");
  const { record } = detail;
  // Shared and Bot Chats keep their existing admission rules.
  if (record.chat.ownerScope.type !== "personal" || record.chat.collaboration?.mode === "shared") return input;
  if (input.executionRoot) {
    if (input.executionRoot.kind === "worktree" && input.executionRoot.projectId !== record.projectId) {
      throw new AppError("server");
    }
    return input;
  }
  const active = record.activeRun;
  const run = active ? detail.runs.find(candidate => candidate.id === active.runId) : detail.runs.at(-1);
  if ((active && (!run || run.turnId !== active.turnId)) || (run && run.chatId !== selectedChatId)) {
    throw new AppError("server");
  }
  const root = run?.executionRoot;
  if (root?.kind !== "worktree") return input;
  if (root.projectId !== record.projectId) {
    if (active) throw new AppError("server");
    // An idle Chat can retain run history after a project move. Let the
    // gateway resolve an ordinary reply from the Chat's current assignment.
    return input;
  }
  // The gateway revalidates current ownership, existence and worktree availability.
  return { ...input, executionRoot: root };
}
