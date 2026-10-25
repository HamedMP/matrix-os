import { useCallback } from "react";
import type { CanonicalChatDetailResponse, CanonicalChatExecutionRootRef } from "@matrix-os/contracts";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useFilesNavigation } from "../../stores/files-navigation";
import { useTabs, FILES_WORKSPACE_TAB_SPEC } from "../../stores/tabs";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";
import { invoke } from "../../lib/operator";
import type { useChatFileNavigation } from "../work/ChatFileNavigation";
import { resolveChatInspectorTargetForRun, resolveWorkFilesScope } from "../work/work-files-scope";
import type { InspectorFileTarget } from "../panels/InspectorFilesPanel";

export function fullPathForInspectorTarget(target: InspectorFileTarget, projectRoot?: string): string | null {
  if (target.kind === "home") return `/home/matrix/home/${target.path}`;
  if (!projectRoot?.startsWith("/") || projectRoot.includes("\0")) return null;
  return `${projectRoot.replace(/\/+$/, "")}/${target.path}`;
}

export function useChatCopyFullPath(
  detail: CanonicalChatDetailResponse | null,
  projects: readonly Project[],
  copyText: (text: string) => Promise<void>,
) {
  return useCallback(async (rawPath: string, executionRoot?: CanonicalChatExecutionRootRef) => {
    if (!detail) throw new Error("PathUnavailable");
    const scope = resolveWorkFilesScope(detail, projects);
    const target = resolveChatInspectorTargetForRun(rawPath, scope, executionRoot, detail.record.projectId);
    if (!target) throw new Error("PathUnavailable");
    const connection = useConnection.getState();
    const generation = captureRuntimeGeneration();
    let root: string | undefined;
    if (target.kind === "project") {
      if (target.worktreeId) {
        if (!connection.api) throw new Error("PathUnavailable");
        const response = await connection.api.forRuntime(connection.runtimeSlot).get<{ worktrees: Array<{ id: string; path?: string }> }>(
          `/api/projects/${encodeURIComponent(target.projectId)}/worktrees`,
        );
        root = response.worktrees.find((worktree) => worktree.id === target.worktreeId)?.path;
      } else {
        root = projects.find((project) => project.slug === target.projectId)?.localPath;
      }
    }
    if (!isCurrentRuntimeGeneration(generation)
      || useConnection.getState().runtimeSlot !== connection.runtimeSlot
      || useConnection.getState().authGeneration !== connection.authGeneration) throw new Error("PathUnavailable");
    const fullPath = fullPathForInspectorTarget(target, root);
    if (!fullPath) throw new Error("PathUnavailable");
    await copyText(fullPath);
  }, [detail, projects, copyText]);
}

export function useChatFilePathNavigation(
  detail: CanonicalChatDetailResponse | null,
  projects: readonly Project[],
  fileNavigation: ReturnType<typeof useChatFileNavigation>,
  onError: (message: string) => void,
) {
  return useCallback((rawPath: string, executionRoot?: CanonicalChatExecutionRootRef) => {
    if (!fileNavigation || !detail) return false;
    const scope = resolveWorkFilesScope(detail, projects);
    const target = resolveChatInspectorTargetForRun(rawPath, scope, executionRoot, detail.record.projectId);
    if (!target) return false;
    const connection = useConnection.getState();
    const generation = captureRuntimeGeneration();
    const current = () => isCurrentRuntimeGeneration(generation)
      && useConnection.getState().runtimeSlot === connection.runtimeSlot
      && useConnection.getState().authGeneration === connection.authGeneration;
    void (async () => {
      try {
        if (target.kind === "home") {
          const stat = await connection.api?.forRuntime(connection.runtimeSlot).get<{ type: "file" | "directory" }>(
            `/api/files/stat?path=${encodeURIComponent(target.path)}`,
          );
          if (!current()) return;
          if (!stat) throw new Error("FilesUnavailable");
          if (stat.type === "directory") {
            useFilesNavigation.getState().navigate(target.path);
            useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
          } else {
            fileNavigation.open({ chatId: scope.chatId, target });
          }
        } else {
          let directory = false;
          try {
            await invoke("runtime:browse-files", {
              projectId: target.projectId,
              ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
              path: target.path,
              limit: 1,
            });
            directory = true;
          } catch (error: unknown) {
            // Files are not browsable. Preview still enforces file admission.
            console.debug("[chat-files] directory lookup unavailable", error instanceof Error ? error.name : "UnknownError");
          }
          if (current()) fileNavigation.open({ chatId: scope.chatId, target, directory });
        }
      } catch (error: unknown) {
        if (current()) onError("This file or folder is unavailable. Check its path and permissions.");
        console.warn("[chat-files] path lookup failed", error instanceof Error ? error.name : "UnknownError");
      }
    })();
    return true;
  }, [detail, projects, fileNavigation, onError]);
}
