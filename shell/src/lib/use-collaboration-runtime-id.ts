"use client";

import { useEffect, useState } from "react";
import { collaborationRuntimeFromSystemInfo } from "@/lib/collaboration";
import { getGatewayUrl } from "@/lib/gateway";

/**
 * The owner runtime's collaboration identity, or null while unknown, disabled, or unavailable.
 * Without a gateway URL it asks this shell's own gateway, resolved in the browser only.
 */
export function useCollaborationRuntimeId(enabled: boolean, gatewayUrl?: string): string | null {
  const key = gatewayUrl ?? "";
  const [result, setResult] = useState<{ key: string; runtimeId: string | null } | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the owner runtime identity is client-local gateway state; the bounded request is canceled logically on unmount and does not belong to a user event.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void fetch(`${gatewayUrl ?? getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).then((response) => {
      if (!response.ok) throw new Error("Runtime unavailable");
      return response.json();
    }).then((value: unknown) => {
      if (active) setResult({ key, runtimeId: collaborationRuntimeFromSystemInfo(value).runtimeId });
    }).catch((error: unknown) => {
      console.warn("[project-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [enabled, gatewayUrl, key]);
  return enabled && result?.key === key ? result.runtimeId : null;
}
