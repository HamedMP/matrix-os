"use client";

import { createExternalMcpApprovalsFetchTransport, type ExternalMcpApprovalsTransport } from "@matrix-os/ui";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";

/**
 * The owner approval routes are platform-owned and session-routed on the app
 * origin (spec 2691, layer 7). They are deliberately not built from
 * `getGatewayUrl()`: under `/vm/<handle>` that targets the VPS gateway, which
 * does not mount them. Same origin rule as the organization admin client.
 */
export function useShellExternalMcpApprovals(): ExternalMcpApprovalsTransport | null {
  const origin = useBrowserOrigin();
  return useMemo(() => origin ? createExternalMcpApprovalsFetchTransport({ baseUrl: origin }) : null, [origin]);
}
