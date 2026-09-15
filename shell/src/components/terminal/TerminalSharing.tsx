"use client";

import { TerminalSharingButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";

export function TerminalSharing({ terminalId }: { terminalId: string }) {
  const platformHost = useBrowserOrigin();
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const api = useMemo(() => platformHost ? createShellCollaborationApi(platformHost) : null, [platformHost]);
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
  return api ? <TerminalSharingButton api={api} runtimeId={runtimeId} terminalId={terminalId} /> : null;
}
