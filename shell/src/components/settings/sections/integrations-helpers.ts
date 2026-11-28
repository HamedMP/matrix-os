import { hasCompletedIntegrationConnection, type IntegrationConnectionSnapshot } from "@matrix-os/contracts";
import type { GmailConnectionMethod } from "@matrix-os/contracts/integration-marketplace";

export interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
  connection_method?: GmailConnectionMethod;
}

/** Only fixed backend contracts get an explanatory partial-service notice. */
export class IntegrationsUnavailableError extends Error {
  constructor(readonly reason: "service" | "preview" = "service") {
    super("IntegrationsUnavailable"); this.name = "IntegrationsUnavailableError";
  }
}

export const INTEGRATIONS_UNAVAILABLE_NOTICE = "Some app connections are unavailable. You can still connect MCP servers and review external approvals below.";
export const PREVIEW_INTEGRATIONS_UNAVAILABLE_NOTICE = "App connections are unavailable on this preview computer. You can still connect MCP servers and review external approvals below.";

type ConnectionState = Pick<ConnectedService, "id" | "service" | "status" | "connected_at">;
function connectionSnapshot(connection: ConnectionState): IntegrationConnectionSnapshot {
  return { id: connection.id, service: connection.service, status: connection.status, connectedAt: connection.connected_at };
}

export function hasCompletedConnectionForService(
  previous: readonly ConnectionState[],
  serviceId: string,
  connections: readonly ConnectionState[],
): boolean {
  return hasCompletedIntegrationConnection(previous.map(connectionSnapshot), serviceId, connections.map(connectionSnapshot));
}

export function shouldLogIntegrationWarning(err: unknown): boolean {
  return !(err instanceof DOMException && err.name === "AbortError");
}
