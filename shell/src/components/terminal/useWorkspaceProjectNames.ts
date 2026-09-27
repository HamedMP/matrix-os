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

/**
 * Display names by canonical project id, fetched once while `enabled`. Unknown
 * ids (or a failed lookup) fall back to the id itself.
 */
export function useWorkspaceProjectNames(enabled: boolean): (projectId: string) => string {
  const [names, setNames] = useState<Record<string, string>>({});
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- project names are client-local gateway state for display only; the bounded request is aborted on unmount and does not belong to a user event.
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
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
    });
    return () => controller.abort();
  }, [enabled]);
  return (projectId) => (Object.hasOwn(names, projectId) ? names[projectId]! : projectId);
}
