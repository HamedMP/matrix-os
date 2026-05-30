export interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
}

export function hasNewConnectionForService(
  previousIds: Set<string>,
  serviceId: string,
  connections: Array<Pick<ConnectedService, "id" | "service">>,
): boolean {
  return connections.some((connection) =>
    connection.service === serviceId && !previousIds.has(connection.id),
  );
}

export function shouldLogIntegrationWarning(err: unknown): boolean {
  return !(err instanceof DOMException && err.name === "AbortError");
}
