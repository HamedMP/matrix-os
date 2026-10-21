import { hasCompletedIntegrationConnection, type IntegrationConnectionSnapshot } from "@matrix-os/contracts";

export interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
}

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
