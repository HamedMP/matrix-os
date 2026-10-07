"use client";

import { ProjectSharingButton } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo } from "@/lib/collaboration";
import { CollaborationOrganization, useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";

export function ProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const platformHost = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const api = useShellCollaborationApi(platformHost, organizationStatus !== "none");
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the owner runtime identity is client-local gateway state; the bounded request is canceled logically on unmount and does not belong to a user event.
  useEffect(() => {
    if (organizationStatus === "none") return;
    let active = true;
    void fetch(`${getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).then((response) => {
      if (!response.ok) throw new Error("Runtime unavailable");
      return response.json();
    }).then((value: unknown) => {
      if (active) setRuntimeId(collaborationRuntimeFromSystemInfo(value).runtimeId);
    }).catch((error: unknown) => {
      console.warn("[project-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [organizationStatus]);
  return api && runtimeId
    ? <CollaborationOrganization>{(organizationId, organizationName) => <ProjectSharingButton api={api} runtimeId={runtimeId}
      organizationId={organizationId} organizationName={organizationName} projectId={projectId} projectName={projectName} />}</CollaborationOrganization>
    : null;
}
