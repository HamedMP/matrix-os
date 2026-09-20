import { ProjectSharingButton } from "@matrix-os/ui";
import { useMemo } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(gatewayApi);
  return collaborationApi && runtimeId
    ? <DesktopCollaborationOrganization>{(organizationId) => <ProjectSharingButton api={collaborationApi}
      runtimeId={runtimeId} organizationId={organizationId} projectId={projectId} projectName={projectName} />}</DesktopCollaborationOrganization>
    : null;
}
