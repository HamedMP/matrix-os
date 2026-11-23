import { useEffect, useRef, useState } from "react";
import { PROJECT_FOLDER_OPEN_FAILED, PROJECT_UPDATE_FAILED, parseProjectFilesLocation } from "@matrix-os/ui";
import { projectAgentContextFileLocationRequest } from "@matrix-os/ui/project-agent-context";
import { parseProject, useBoard, type Project } from "../../../stores/board";
import { useConnection } from "../../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";
import { useDesktopSurfaces } from "../../../stores/desktop-surfaces";
import { useFilesNavigation } from "../../../stores/files-navigation";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../../stores/tabs";

export function useProjectActions(project: Project) {
  const api = useConnection(state => state.api);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    busy.current = false;
    setPending(false); setError(null); setDialog(null);
    return () => { generation.current += 1; };
  }, [api, runtimeSlot, authGeneration, project.id, project.slug]);

  const update = async (patch: { name?: string; description?: string; pinned?: boolean }) => {
    if (!api || busy.current) return false;
    const requestGeneration = generation.current;
    const runtimeGeneration = captureRuntimeGeneration();
    const current = () => generation.current === requestGeneration && isCurrentRuntimeGeneration(runtimeGeneration);
    busy.current = true; setPending(true); setError(null);
    try {
      const response = await api.patch<{ project: unknown }>(`/api/projects/${encodeURIComponent(project.slug)}`, patch);
      if (!current()) return false;
      const updated = parseProject(response.project);
      if (!updated || updated.slug !== project.slug || updated.id !== project.id) throw new Error("Invalid project response");
      useBoard.getState().applyProjectMetadata(updated);
      useTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.kind === "project" && tab.projectSlug === updated.slug ? { ...tab, title: updated.name } : tab) }));
      return true;
    } catch (err: unknown) {
      console.warn("[project-actions] Update failed:", err instanceof Error ? err.name : "UnknownError");
      if (current()) setError(PROJECT_UPDATE_FAILED);
      return false;
    } finally {
      if (current()) { busy.current = false; setPending(false); }
    }
  };
  const showInFiles = async (verifyProjectIdentity = false) => {
    if (!api || busy.current) return;
    const requestGeneration = generation.current;
    const runtimeGeneration = captureRuntimeGeneration();
    const current = () => generation.current === requestGeneration && isCurrentRuntimeGeneration(runtimeGeneration);
    busy.current = true; setPending(true); setError(null);
    try {
      const pathRequest = verifyProjectIdentity && project.id
        ? projectAgentContextFileLocationRequest(project.slug, project.id)
        : `/api/projects/${encodeURIComponent(project.slug)}/files-location`;
      const response = await api.get<{ path: unknown }>(pathRequest);
      if (!current()) return;
      const path = parseProjectFilesLocation(response.path);
      if (!path) throw new Error("Invalid folder location");
      useFilesNavigation.getState().navigate(path);
      const tabId = useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);
      useDesktopSurfaces.getState().activateSurface(tabId);
    } catch (err: unknown) {
      console.warn("[project-actions] Locate failed:", err instanceof Error ? err.name : "UnknownError");
      if (current()) setError(PROJECT_FOLDER_OPEN_FAILED);
    } finally {
      if (current()) { busy.current = false; setPending(false); }
    }
  };
  return { showInFiles, dialog, setDialog, pending, error, available: Boolean(api), update };
}
