import {
  buildCustomerVpsProxyUrl,
  type CustomerVpsProxyMachine,
} from "./profile-routing.js";

export function buildCustomMcpProjectionUrl(
  machine: CustomerVpsProxyMachine,
  serverId?: string,
): string {
  const path = `/api/internal/mcp-projection${
    serverId ? `/${encodeURIComponent(serverId)}` : ""
  }`;
  const target = buildCustomerVpsProxyUrl(machine, path);
  if (!target) throw new Error("Custom MCP owner runtime is unavailable");
  return target;
}
