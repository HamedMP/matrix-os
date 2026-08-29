import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { Project } from "../../stores/board";

export type WorkFilesScope =
  | { kind: "home"; chatId: string }
  | { kind: "project"; chatId: string; projectId: string; worktreeId?: string; label: string }
  | { kind: "unavailable"; chatId: string };

export function resolveWorkFilesScope(
  detail: CanonicalChatDetailResponse,
  projects: readonly Project[],
): WorkFilesScope {
  const { record } = detail;
  if (!record.projectId) return { kind: "home", chatId: record.chat.id };

  const project = projects.find((candidate) => candidate.id === record.projectId);
  if (!project) return { kind: "unavailable", chatId: record.chat.id };

  const run = record.activeRun
    ? detail.runs.find((candidate) => candidate.id === record.activeRun?.runId)
    : detail.runs.at(-1);
  if (record.activeRun && !run) {
    return { kind: "unavailable", chatId: record.chat.id };
  }
  if (run?.executionRoot && run.executionRoot.projectId !== record.projectId) {
    return { kind: "unavailable", chatId: record.chat.id };
  }

  return {
    kind: "project",
    chatId: record.chat.id,
    projectId: project.slug,
    label: project.name,
    ...(run?.executionRoot?.kind === "worktree"
      ? { worktreeId: run.executionRoot.worktreeId }
      : {}),
  };
}
