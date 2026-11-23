import { canonicalExecutionRootProjectId, resolveChatMessageLink } from "@matrix-os/contracts";
import type { InspectorFileTarget } from "../panels/InspectorFilesPanel";
import type { CanonicalChatDetailResponse, CanonicalChatExecutionRootRef } from "@matrix-os/contracts";
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
  if (run?.executionRoot && canonicalExecutionRootProjectId(run.executionRoot) !== record.projectId) {
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

export function resolveChatInspectorTarget(rawPath: string, scope: WorkFilesScope): InspectorFileTarget | null {
  const link = resolveChatMessageLink(rawPath);
  if (link?.kind !== "file") return null;
  const decoded = decodeURIComponent(rawPath.trim()).replace(/^file:\/\//i, "");
  const ownerPath = decoded.startsWith("/home/matrix/home/") || decoded.startsWith("~/") || decoded.startsWith("/files/");
  const label = link.path.split("/").at(-1) ?? link.path;
  if (ownerPath) return { kind: "home", path: link.path, label };
  if (scope.kind === "unavailable") return null;
  return scope.kind === "home"
    ? { kind: "home", path: link.path, label }
    : { kind: "project", projectId: scope.projectId, worktreeId: scope.worktreeId, path: link.path, label };
}

export function resolveChatInspectorTargetForRun(
  rawPath: string,
  scope: WorkFilesScope,
  runRoot: CanonicalChatExecutionRootRef | undefined,
  projects: readonly Project[],
): InspectorFileTarget | null {
  // A Chat move changes grouping; historical runs retain their original root.
  // Explicit owner paths do not depend on either Project being available.
  const ownerTarget = resolveChatInspectorTarget(rawPath, { kind: "unavailable", chatId: scope.chatId });
  if (ownerTarget) return ownerTarget;
  if (runRoot && runRoot.kind !== "bot_workspace") {
    const original = projects.find((project) => project.id === runRoot.projectId);
    if (!original) return null;
    return resolveChatInspectorTarget(rawPath, {
      kind: "project", chatId: scope.chatId, projectId: original.slug, label: original.name,
      ...(runRoot.kind === "worktree" ? { worktreeId: runRoot.worktreeId } : {}),
    });
  }
  return resolveChatInspectorTarget(rawPath, scope);
}
