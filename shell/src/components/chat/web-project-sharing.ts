"use client";

import type { ProjectSharingContext } from "@matrix-os/ui";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { useCollaborationRuntimeId } from "@/lib/use-collaboration-runtime-id";

/** Collaboration for the routed computer, resolved once for the Projects rail and the add-project dialog. */
export function useWebProjectSharingContext(gatewayUrl: string, enabled: boolean): ProjectSharingContext | null {
  const { status, organizationId } = useCollaborationOrganization();
  const active = enabled && status !== "none";
  const api = useShellCollaborationApi(useBrowserOrigin(), active);
  const runtimeId = useCollaborationRuntimeId(active, gatewayUrl);
  return useMemo(() => status !== "none" && active && api && runtimeId
    ? { api, runtimeId, organizationId: status === "member" ? organizationId : null, organizationStatus: status }
    : null, [active, api, organizationId, runtimeId, status]);
}
