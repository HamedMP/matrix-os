"use client";

import { useMemo } from "react";
import { createOrganizationMcpAdminClient, createOrganizationMcpHttpApi } from "./client.js";
import type { WithOrganizationMcpClient } from "./OrganizationConnectionsPanel.js";

/** One stable admin client per platform origin and organization; null until both are known or when the origin is invalid. */
export function useOrganizationMcpClient(platformBaseUrl: string | null, organizationId: string | null): WithOrganizationMcpClient | null {
  return useMemo<WithOrganizationMcpClient | null>(() => {
    if (!platformBaseUrl || !organizationId) return null;
    try {
      const client = createOrganizationMcpAdminClient(createOrganizationMcpHttpApi({ baseUrl: platformBaseUrl }), organizationId);
      return (action) => action(client);
    } catch (error: unknown) {
      console.warn("[org-mcp] platform origin unavailable", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }, [organizationId, platformBaseUrl]);
}
