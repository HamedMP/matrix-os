export interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
}

/** Only the backend's fixed unavailable contract gets the partial-service notice. */
export class IntegrationsUnavailableError extends Error {
  constructor() { super("IntegrationsUnavailable"); this.name = "IntegrationsUnavailableError"; }
}

export const INTEGRATIONS_UNAVAILABLE_NOTICE = "Some app connections are unavailable. You can still connect MCP servers and review external approvals below.";

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
