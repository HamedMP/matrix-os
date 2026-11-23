"use client";

import { ProjectSharingButton } from "@matrix-os/ui";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useCollaborationRuntimeId } from "@/lib/use-collaboration-runtime-id";
import { CollaborationOrganization, useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const PROJECT_SHARING_LAYERS = { popover: SHELL_Z_INDEX.popover };

export function ProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const platformHost = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const api = useShellCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none");
  return api && runtimeId
    ? <CollaborationOrganization>{(organizationId, organizationName) => <ProjectSharingButton api={api} runtimeId={runtimeId}
      organizationId={organizationId} organizationName={organizationName} projectId={projectId} projectName={projectName}
      layers={PROJECT_SHARING_LAYERS} />}</CollaborationOrganization>
    : null;
}
