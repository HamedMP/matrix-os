export interface ConnectedService {
  id: string;
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
  connected_at: string;
}

/** Only fixed backend contracts get an explanatory partial-service notice. */
export class IntegrationsUnavailableError extends Error {
  constructor(readonly reason: "service" | "preview" = "service") {
    super("IntegrationsUnavailable"); this.name = "IntegrationsUnavailableError";
  }
}

export const INTEGRATIONS_UNAVAILABLE_NOTICE = "Some app connections are unavailable. You can still connect MCP servers and review external approvals below.";
export const PREVIEW_INTEGRATIONS_UNAVAILABLE_NOTICE = "App connections are unavailable on this preview computer. You can still connect MCP servers and review external approvals below.";

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
