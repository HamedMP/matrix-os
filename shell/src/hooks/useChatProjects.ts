"use client";

import { useCallback, useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import {
  fetchWebChatProjects,
  mutateWebChatProject,
  type WebChatProject,
} from "@/lib/chat-projects";

const GATEWAY_URL = getGatewayUrl();

export function useChatProjects() {
  const [projects, setProjects] = useState<WebChatProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await fetchWebChatProjects(fetch, GATEWAY_URL));
      setError(null);
    } catch (err: unknown) {
      console.warn("[chat] Failed to load projects:", err instanceof Error ? err.name : "UnknownError");
      setError("Projects could not be loaded. Try again.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const renameProject = useCallback(async (project: WebChatProject, name: string) => {
    setPendingSlug(project.slug);
    setError(null);
    try {
      await mutateWebChatProject(fetch, GATEWAY_URL, project.slug, { type: "rename", name });
      await refresh();
      return true;
    } catch (err: unknown) {
      console.warn("[chat] Failed to rename project:", err instanceof Error ? err.name : "UnknownError");
      setError("The project could not be renamed. Try again.");
      return false;
    } finally {
      setPendingSlug(null);
    }
  }, [refresh]);

  const deleteProject = useCallback(async (project: WebChatProject, confirmation: string) => {
    setPendingSlug(project.slug);
    setError(null);
    try {
      await mutateWebChatProject(fetch, GATEWAY_URL, project.slug, { type: "delete", confirmation });
      await refresh();
      return true;
    } catch (err: unknown) {
      console.warn("[chat] Failed to delete project:", err instanceof Error ? err.name : "UnknownError");
      setError("The project could not be deleted. Stop active work and try again.");
      return false;
    } finally {
      setPendingSlug(null);
    }
  }, [refresh]);

  return { projects, error, pendingSlug, refresh, renameProject, deleteProject };
}
