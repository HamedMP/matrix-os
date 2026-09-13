import type { ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import type { ChatAgentIntegrationConnection } from "./client.js";

export function serviceName(service: string, catalog: ChatAgentRecipeCatalog | null): string {
  const known = catalog?.services.find((candidate) => candidate.id === service)?.name;
  if (known) return known;
  return service.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function activeConnections(service: string, connections: ChatAgentIntegrationConnection[]) {
  return connections.filter((connection) => connection.service === service && connection.status === "active");
}

export function accountForNewIntegration(service: string, connections: ChatAgentIntegrationConnection[]): string | undefined {
  const active = activeConnections(service, connections);
  return active.length === 1 ? active[0]!.account_label : undefined;
}

export function integrationConnectionMessage(input: {
  name: string; serviceAvailable: boolean; connectionError: string;
  selected?: string; selectedUnavailable: boolean; accountCount: number;
}): string {
  if (!input.serviceAvailable) return "Saved integration is unavailable. It will be kept until you remove it.";
  if (input.connectionError) return input.selected
    ? "Account status could not be verified. Your saved choice is preserved."
    : "Account status could not be verified. Keep Ask when run or retry.";
  if (input.selectedUnavailable) return "Saved account is unavailable. It will be kept until you choose another account.";
  if (input.accountCount === 0) return `No connected account. Connect ${input.name} before this workflow can read it.`;
  if (input.accountCount > 1 && !input.selected) return "Choose an account or keep Ask when run.";
  return "Connected.";
}
