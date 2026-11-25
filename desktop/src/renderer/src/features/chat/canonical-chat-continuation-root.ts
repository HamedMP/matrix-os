import { ProjectIdSchema, WorktreeIdSchema, type CanonicalChatDetailResponse, type CanonicalChatExecutionRootRef, type CanonicalCreateChatTurnRequest } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ApiClient } from "../../lib/api";
import { AppError } from "../../../../shared/app-error";

const ProjectReply = z.object({ project: z.object({ id: ProjectIdSchema, slug: z.string(),
  archivedAt: z.string().optional(), deletingAt: z.string().optional() }) });
const WorktreeReply = z.object({
  worktrees: z.array(z.object({ id: WorktreeIdSchema, projectSlug: z.string() })).max(4_096),
});

export async function isHistoricalWorktreeMissing(
  api: Pick<ApiClient, "get">,
  slug: string,
  worktree: Extract<CanonicalChatExecutionRootRef, { kind: "worktree" }>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const path = `/api/projects/${encodeURIComponent(slug)}`;
  const options = { cache: "no-store", maxBytes: 1024 * 1024, timeoutMs: 5_000 } as const;
  try {
    const inventory = WorktreeReply.safeParse(await api.get(`${path}/worktrees`, options));
    if (!isCurrent() || !inventory.success
      || inventory.data.worktrees.some(row => row.projectSlug !== slug || row.id === worktree.worktreeId)) return false;
    const authority = ProjectReply.safeParse(await api.get(path, options));
    return isCurrent() && authority.success && authority.data.project.id === worktree.projectId && authority.data.project.slug === slug
      && !authority.data.project.archivedAt && !authority.data.project.deletingAt;
  } catch (error: unknown) {
    console.warn("[chat] Could not check worktree availability:", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

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
