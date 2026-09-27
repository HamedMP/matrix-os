"use client";

import { ProjectSharingButton } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";
import { CollaborationOrganization } from "@/lib/collaboration-organization";

export function ProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const runtimeId = useShellCollaborationRuntimeId();
  return <ProjectSharingControl projectId={projectId} projectName={projectName} runtimeId={runtimeId} />;
}

/**
 * Owner runtime identity for Share controls, or null while it is loading or
 * this computer does not offer collaboration. A list of project headings
 * resolves it once and passes it to each `ProjectSharingControl`.
 */
export function useShellCollaborationRuntimeId(enabled = true): string | null {
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the owner runtime identity is client-local gateway state; the bounded request is canceled logically on unmount and does not belong to a user event.
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void fetch(`${getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).then((response) => {
      if (!response.ok) throw new Error("Runtime unavailable");
      return response.json() as Promise<unknown>;
    }).then((value) => {
      if (active) setRuntimeId(collaborationRuntimeFromSystemInfo(value).runtimeId);
    }).catch((error: unknown) => {
      console.warn("[project-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [enabled]);
  return enabled ? runtimeId : null;
}

export function ProjectSharingControl({ projectId, projectName, runtimeId }: {
  projectId: string;
  projectName: string;
  runtimeId: string | null;
}) {
  const platformHost = useBrowserOrigin();
  const api = platformHost ? createShellCollaborationApi(platformHost) : null;
  return api && runtimeId
    ? <CollaborationOrganization>{(organizationId) => <ProjectSharingButton api={api} runtimeId={runtimeId}
      organizationId={organizationId} projectId={projectId} projectName={projectName} />}</CollaborationOrganization>
    : null;
}
