"use client";

// Pin, Edit, and Show in Files for one web project row, with Electron
// Desktop's copy and states. Local state changes only after the gateway
// confirms; a superseded or unmounted request never touches state.
import { PROJECT_FOLDER_OPEN_FAILED, PROJECT_UPDATE_FAILED } from "@matrix-os/ui";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { createWebProjectClient } from "./web-project-client";
import { WebProjectAgentContextNavigation } from "./WebProjectAgentContext";
import type { WebProject } from "./web-projects";

export function useWebProjectActions({ project, gatewayUrl, filesAuthority, onChanged }: {
  project: WebProject;
  gatewayUrl: string;
  /** The Files app authority for this shell; Show in Files is unavailable without it. */
  filesAuthority: string | null;
  onChanged(): void;
}) {
  const client = useMemo(() => createWebProjectClient(gatewayUrl), [gatewayUrl]);
  const navigation = useContext(WebProjectAgentContextNavigation);
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, []);

  const run = async (work: () => Promise<boolean>, failure: string): Promise<boolean> => {
    if (busy.current) return false;
    const attempt = generation.current;
    busy.current = true;
    setPending(true);
    setError(null);
    const succeeded = await work().catch((cause: unknown) => {
      console.warn("[web-projects] project action failed", cause instanceof Error ? cause.name : "UnknownError");
      return false;
    });
    if (generation.current !== attempt) return false;
    busy.current = false;
    setPending(false);
    if (!succeeded) setError(failure);
    return succeeded;
  };

  const update = (patch: { name?: string; description?: string; pinned?: boolean }) => run(async () => {
    const saved = await client.updateProject(project.slug, patch);
    if (!saved || saved.id !== project.id) return false;
    onChanged();
    return true;
  }, PROJECT_UPDATE_FAILED);

  // Files shows only this shell's computer, so the project must live on the same gateway.
  const filesAvailable = Boolean(navigation && filesAuthority) && gatewayUrl.replace(/\/$/, "") === getGatewayUrl();
  const showInFiles = () => run(async () => {
    const path = await client.filesLocation(project.slug);
    if (!path || !navigation || !filesAuthority) return false;
    useFileBrowser.getState().requestView("files", { path, identity: filesAuthority });
    navigation.openFiles();
    return true;
  }, PROJECT_FOLDER_OPEN_FAILED);

  return { dialog, setDialog, pending, error, update, showInFiles, filesAvailable };
}
