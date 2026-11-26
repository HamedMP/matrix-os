import type { BotConnectionRequest, ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { Button } from "../Button.js";
import type { ChatAgentIntegrationConnection, ChatAgentMcpServer } from "./client.js";

export function AgentConnectionAction({
  resource, catalog, connections, mcpServers = [], loading, unavailable, onOpenSettings, onRefresh, onChooseIntegration,
}: {
  resource: BotConnectionRequest;
  catalog: ChatAgentRecipeCatalog | null;
  connections: readonly ChatAgentIntegrationConnection[];
  mcpServers?: readonly ChatAgentMcpServer[];
  loading?: boolean;
  unavailable?: boolean;
  onOpenSettings(resource: "integrations" | "mcp"): void;
  onRefresh?(): void;
  onChooseIntegration?(): void;
}) {
  const isMcp = resource.kind === "mcp";
  const service = resource.kind === "integration"
    ? catalog?.services.find(candidate => candidate.id === resource.service)
    : undefined;
  if (!isMcp && !service) return null;

  const connected = service && connections.some(connection =>
    connection.service === service.id && connection.status === "active");
  const requestedMcpName = resource.kind === "mcp" ? resource.name : undefined;
  const matches = requestedMcpName
    ? mcpServers.filter(server => server.name.toLowerCase() === requestedMcpName.toLowerCase()) : [];
  const readyMcp = matches.length === 1 && matches[0]?.enabled && matches[0].status === "ready" ? matches[0] : undefined;
  const label = isMcp ? readyMcp?.name ?? "MCP server" : service?.name;
  const action = isMcp ? "Open MCP settings" : connected ? "Manage connection" : `Connect ${label}`;
  const status = loading ? "Checking your connection…"
    : unavailable ? "Connection status could not be verified."
    : readyMcp ? `${label} is ready on this computer.`
    : isMcp ? "Add or authorize an MCP server in Settings."
    : connected ? `${label} is connected to Matrix.` : `Connect ${label} in Settings.`;

  return <section aria-label={`Connect ${label} from Chat`} className="grid min-w-0 gap-2 rounded-lg border px-3 py-2">
    <p className="text-sm" role="status">{status}</p>
    {connected && !loading && !unavailable ? <p className="text-xs text-muted-foreground">
      Choose what this Agent can access.
    </p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={loading}
        onClick={() => onOpenSettings(isMcp ? "mcp" : "integrations")}>{action}</Button>
      {connected && !loading && !unavailable && onChooseIntegration ? <Button
        type="button" size="sm" variant="secondary" onClick={onChooseIntegration}>Choose for this Agent</Button> : null}
      {(!isMcp || requestedMcpName) && onRefresh ? <Button type="button" size="sm" variant="ghost" disabled={loading}
        onClick={onRefresh}>Check connection</Button> : null}
    </div>
  </section>;
}
