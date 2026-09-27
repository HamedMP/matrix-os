import { TerminalSharingButton } from "@matrix-os/ui";
import { useMemo } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopTerminalSharing({ terminalId }: { terminalId: string }) {
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(api);
  // Keyed by terminal, matching the shell: a switch must not carry one terminal's
  // pending preflight or open dialog over to another.
  return collaborationApi && runtimeId
    ? <DesktopCollaborationOrganization>{(organizationId) => <TerminalSharingButton key={terminalId} api={collaborationApi}
      runtimeId={runtimeId} organizationId={organizationId} terminalId={terminalId} />}</DesktopCollaborationOrganization>
    : null;
}
