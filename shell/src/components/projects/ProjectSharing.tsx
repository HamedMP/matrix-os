"use client";

import { ProjectSharingButton } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";

export function ProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const platformHost = useBrowserOrigin();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const api = platformHost ? createShellCollaborationApi(platformHost) : null;
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the owner runtime identity is client-local gateway state; the bounded request is canceled logically on unmount and does not belong to a user event.
  useEffect(() => {
    let active = true;
    void fetch(`${getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Runtime unavailable");
      if (active) setRuntimeId(collaborationRuntimeFromSystemInfo(await response.json()).runtimeId);
    }).catch((error: unknown) => {
      console.warn("[project-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, []);
  return api ? <ProjectSharingButton api={api} runtimeId={runtimeId} projectId={projectId} projectName={projectName} /> : null;
}
