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
  // Explicit selections and shared/Bot execution keep their existing admission rules.
  if (input.executionRoot || record.chat.ownerScope.type !== "personal" || record.chat.collaboration?.mode === "shared") return input;
  const active = record.activeRun;
  const run = active ? detail.runs.find(candidate => candidate.id === active.runId) : detail.runs.at(-1);
  if ((active && (!run || run.turnId !== active.turnId)) || (run && run.chatId !== selectedChatId)) {
    throw new AppError("server");
  }
  const root = run?.executionRoot;
  if (root?.kind !== "worktree") return input;
  // A project move must not silently execute at the project root or an old worktree.
  if (root.projectId !== record.projectId) throw new AppError("server");
  // The gateway revalidates current ownership, existence and worktree availability.
  return { ...input, executionRoot: root };
}
