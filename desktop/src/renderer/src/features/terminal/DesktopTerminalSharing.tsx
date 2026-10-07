import { LegacyTerminalAccessButton } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization, useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopTerminalSharing({ terminalId }: { terminalId: string }) {
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const collaborationApi = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none" ? api : null);
  return collaborationApi && runtimeId
    ? <DesktopCollaborationOrganization>{(organizationId) => <LegacyTerminalAccessButton api={collaborationApi}
      runtimeId={runtimeId} organizationId={organizationId} terminalId={terminalId} />}</DesktopCollaborationOrganization>
    : null;
}
