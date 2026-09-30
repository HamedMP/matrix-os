"use client";

import { TerminalSharingButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";
import { CollaborationOrganization } from "@/lib/collaboration-organization";

export function TerminalSharing({ terminalId }: { terminalId: string }) {
  const platformHost = useBrowserOrigin();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const api = useMemo(() => platformHost ? createShellCollaborationApi(platformHost) : null, [platformHost]);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- owner runtime identity is local gateway state; the bounded request has an unmount guard and matches the project and resource Share adapters.
  useEffect(() => {
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
  }, []);
  // Keyed by terminal: switching the focused terminal must not carry one terminal's
  // pending preflight or open dialog over to another.
  return api && runtimeId ? <CollaborationOrganization>{(organizationId) => <TerminalSharingButton key={terminalId} api={api}
    runtimeId={runtimeId} organizationId={organizationId} terminalId={terminalId} />}</CollaborationOrganization> : null;
}
