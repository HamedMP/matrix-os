"use client";

import { ResourceSharingButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo, createShellCollaborationApi } from "@/lib/collaboration";
import { CollaborationOrganization } from "@/lib/collaboration-organization";

export function FileResourceSharing({ kind, path }: { kind: "file" | "folder" | "app"; path: string }) {
  const platformHost = useBrowserOrigin();
  const api = useMemo(() => platformHost ? createShellCollaborationApi(platformHost) : null, [platformHost]);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch(`${getGatewayUrl()}/api/system/info`, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
    }).then(async (response) => {
      if (!response.ok) throw new Error("Runtime unavailable");
      const runtime = collaborationRuntimeFromSystemInfo(await response.json());
      if (active) setRuntimeId(runtime.runtimeId);
    }).catch((failure: unknown) => {
      console.warn("[resource-collaboration] runtime unavailable", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { active = false; };
  }, []);
  return api ? <CollaborationOrganization>{(organizationId) => <ResourceSharingButton
    api={api} runtimeId={runtimeId} organizationId={organizationId} kind={kind} path={path} />}</CollaborationOrganization> : null;
}
