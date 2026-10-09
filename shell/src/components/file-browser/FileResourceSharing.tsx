"use client";

import { LegacyResourceAccessButton } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { getGatewayUrl } from "@/lib/gateway";
import { collaborationRuntimeFromSystemInfo } from "@/lib/collaboration";
import { CollaborationOrganization, useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";

export function FileResourceSharing({ kind, path, containerClassName }: {
  kind: "file" | "folder" | "app";
  path: string;
  containerClassName?: string;
}) {
  const platformHost = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const api = useShellCollaborationApi(platformHost, organizationStatus !== "none");
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- owner runtime identity is local gateway state; the bounded request has an unmount guard and follows the existing project Share adapter.
  useEffect(() => {
    if (organizationStatus === "none") return;
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
  }, [organizationStatus]);
  return api ? <CollaborationOrganization>{(organizationId) => <LegacyResourceAccessButton
    api={api} runtimeId={runtimeId} organizationId={organizationId} kind={kind} path={path}
    containerClassName={containerClassName} />}</CollaborationOrganization> : null;
}
