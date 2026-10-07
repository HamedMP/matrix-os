import { ResourceSharingButton } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization, useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopResourceSharing({ kind, path }: { kind: "file" | "folder" | "app"; path: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const api = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none" ? gatewayApi : null);
  return api ? <DesktopCollaborationOrganization>{(organizationId) => <ResourceSharingButton
    api={api} runtimeId={runtimeId} organizationId={organizationId} kind={kind} path={path} />}</DesktopCollaborationOrganization> : null;
}
