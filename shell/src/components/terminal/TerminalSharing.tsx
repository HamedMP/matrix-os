"use client";

import { TerminalSharingButton } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo } from "@/lib/collaboration";
import { CollaborationOrganization, useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";

export function TerminalSharing({ terminalId }: { terminalId: string }) {
  const platformHost = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const api = useShellCollaborationApi(platformHost, organizationStatus !== "none");
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the owner runtime identity is client-local gateway state; the bounded request has an unmount guard and cannot be resolved from the platform-rendered shell.
  useEffect(() => {
    if (organizationStatus === "none") return;
    let active = true;
    void fetch(`${getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("RuntimeUnavailable");
      const value = await response.json() as unknown;
      if (active) setRuntimeId(collaborationRuntimeFromSystemInfo(value).runtimeId);
    }).catch((error: unknown) => {
      console.warn("[terminal-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [organizationStatus]);
  return api && runtimeId ? <CollaborationOrganization>{(organizationId) => <TerminalSharingButton api={api} runtimeId={runtimeId}
    organizationId={organizationId} terminalId={terminalId} />}</CollaborationOrganization> : null;
}
