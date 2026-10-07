import { MANAGED_INTEGRATIONS } from "@matrix-os/contracts/managed-integrations";
import type { ServiceDefinition } from "./types.js";

export const MANAGED_SERVICE_REGISTRY: Record<string, ServiceDefinition> = Object.fromEntries(
  Object.values(MANAGED_INTEGRATIONS).map(p => [p.id, {
    id: p.id, name: p.name, category: p.category, connectorKind: "mcp_preset" as const,
    mcpPreset: { url: p.url, authMode: "oauth" as const }, authType: "oauth" as const,
    icon: p.id, logoUrl: p.id === "loops" ? "https://pipedream.com/s.v0/app_WnhP8N/logo/96" : p.id === "lemlist" ? "https://pipedream.com/s.v0/app_1gKhnN/logo/96" : "https://pipedream.com/s.v0/app_mo7h7A/logo/96",
    actions: Object.fromEntries(Object.entries(p.actions).map(([id, action]) => [id, {
      description: action.description, risk: "read" as const, params: action.params, paramsSchema: action.schema,
    }])),
  }]),
);
