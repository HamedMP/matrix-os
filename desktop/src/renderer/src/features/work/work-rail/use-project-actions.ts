import { useEffect, useRef, useState } from "react";
import { parseProject, useBoard, type Project } from "../../../stores/board";
import { useConnection } from "../../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";
import { useTabs } from "../../../stores/tabs";

export function useProjectActions(project: Project) {
  const api = useConnection(state => state.api);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const [dialog, setDialog] = useState<"edit" | "files" | null>(null);
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
      if (current()) setError("The project could not be updated. Try again.");
      return false;
    } finally {
      if (current()) { busy.current = false; setPending(false); }
    }
  };
  return { dialog, setDialog, pending, error, available: Boolean(api), update };
}
