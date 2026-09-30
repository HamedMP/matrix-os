"use client";

import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { getGatewayUrl } from "@/lib/gateway";

// Terminal workspaces name their project by canonical id only; headings and the
// Share dialog show the project's name instead.
const WorkspaceProjectsSchema = z.looseObject({
  projects: z.array(z.looseObject({
    id: z.string().min(1).max(160).optional(),
    name: z.string().min(1).max(256),
  })).max(1_000),
});

/** Display names for canonical ids. Refresh on focus and at a bounded interval:
 * a rename does not change the ids or the terminal session list. */
export function useWorkspaceProjectNames(projectIds: readonly string[], suspended = false): (projectId: string) => string {
  const [names, setNames] = useState<Record<string, string>>({});
  const projectSetKey = [...new Set(projectIds)].sort().join("\n");
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- project names are client-local gateway state for display only; each bounded request is aborted on unmount and does not belong to a user event.
  useEffect(() => {
    if (!projectSetKey || suspended) return undefined;
    let pending: AbortController | null = null;
    const refresh = () => {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      void fetch(`${getGatewayUrl()}/api/workspace/projects`, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      }).then((response) => {
        if (!response.ok) throw new Error("Projects unavailable");
        return response.json() as Promise<unknown>;
      }).then((value) => {
        if (controller.signal.aborted) return;
        const { projects } = WorkspaceProjectsSchema.parse(value);
        setNames(Object.fromEntries(projects.flatMap((project) => project.id ? [[project.id, project.name]] : [])));
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("[terminal-projects] project names unavailable", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => {
        if (pending === controller) pending = null;
      });
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(interval);
      pending?.abort();
    };
  }, [projectSetKey, suspended]);
  return (projectId) => (Object.hasOwn(names, projectId) ? names[projectId]! : projectId);
}
