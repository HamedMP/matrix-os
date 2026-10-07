import { useCallback, useEffect } from "react";
import { resolveChatAppReference, type CanonicalChatDetailResponse, type CanonicalChatExecutionRootRef } from "@matrix-os/contracts";
import { filePreviewContentUrl } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import type { Project } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { useNativeDesktopMode } from "../../stores/native-desktop-mode";
import { NATIVE_DESKTOP_LAYOUT } from "../../design/layering";
import { useTabs } from "../../stores/tabs";
import { useAppsQuery, type MatrixApp } from "../apps/apps.api";
import { resolveChatInspectorTargetForRun, resolveWorkFilesScope } from "../work/work-files-scope";

const EMPTY_APPS: readonly MatrixApp[] = [];
export function useChatArtifactActions(api: ApiClient | null | undefined, detail: CanonicalChatDetailResponse | null, projects: readonly Project[]) {
  const { data: apps = EMPTY_APPS, refetch } = useAppsQuery();
  const settledRunId = detail?.runs.findLast((run) => ["completed", "failed", "aborted"].includes(run.status))?.id;
  useEffect(() => {
    if (!settledRunId) return;
    void refetch().catch((error: unknown) => {
      console.warn("[chat-apps] catalog refresh failed", error instanceof Error ? error.name : "UnknownError");
    });
  }, [settledRunId, refetch]);
  const allowRelative = detail ? resolveWorkFilesScope(detail, projects).kind === "home" : false;
  const resolveApp = useCallback((path: string, executionRoot?: CanonicalChatExecutionRootRef) => resolveChatAppReference(path, apps, { allowRelative: !executionRoot && allowRelative }), [apps, allowRelative]);
  const openApp = useCallback((path: string, executionRoot?: CanonicalChatExecutionRootRef) => {
    const app = resolveApp(path, executionRoot);
    if (!app) return false;
    const sourceTabId = useTabs.getState().activeTabId;
    const surfaces = useDesktopSurfaces.getState();
    const retainTabs = useNativeDesktopMode.getState().mode === "desktop"
      && surfaces.workspaceView === "tabs" && sourceTabId
      && surfaces.surfaces[sourceTabId]?.mode === "tab";
    const appTabId = useTabs.getState().openTab({ kind: "app", slug: app.slug, title: app.name, ...(app.appIdentity ? { appIdentity: app.appIdentity } : {}) });
    if (retainTabs) {
      surfaces.reconcileTabs(useTabs.getState().tabs.map((tab) => tab.id), {
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight - NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight - NATIVE_DESKTOP_LAYOUT.tabStripHeight),
      });
      useDesktopSurfaces.getState().maximizeToTab(appTabId);
    }
    return true;
  }, [resolveApp]);
  const loadFileImage = useCallback(async (path: string, executionRoot?: CanonicalChatExecutionRootRef) => {
    if (!api || !detail) throw new Error("ChatFileUnavailable");
    const { runtimeSlot, authGeneration } = useConnection.getState();
    const target = resolveChatInspectorTargetForRun(path, resolveWorkFilesScope(detail, projects), executionRoot, detail.record.projectId);
    if (!target) throw new Error("ChatFileUnavailable");
    const resource = target.kind === "home" ? { kind: "home" as const, path: target.path }
      : { kind: "project" as const, path: target.path, projectId: target.projectId, ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}) };
    const blob = await api.forRuntime(runtimeSlot).getBlob(filePreviewContentUrl(resource), { maxBytes: 50 * 1024 * 1024 });
    const current = useConnection.getState();
    if (current.runtimeSlot !== runtimeSlot || current.authGeneration !== authGeneration) throw new Error("ChatFileUnavailable");
    return blob;
  }, [api, detail, projects]);
  return { resolveApp, openApp, loadFileImage };
}
