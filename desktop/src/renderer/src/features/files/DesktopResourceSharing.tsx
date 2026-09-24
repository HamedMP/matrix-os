import { ResourceSharingButton } from "@matrix-os/ui";
import { useMemo } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopResourceSharing({ kind, path }: { kind: "file" | "folder" | "app"; path: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(gatewayApi);
  return api ? <DesktopCollaborationOrganization>{(organizationId) => <ResourceSharingButton
    api={api} runtimeId={runtimeId} organizationId={organizationId} kind={kind} path={path} />}</DesktopCollaborationOrganization> : null;
}
