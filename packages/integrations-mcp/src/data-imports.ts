import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ownerDataImportToolDefinitions } from "../../kernel/dist/tools/data-imports.js";
import type { GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

/** Called only for the full owner surface; the shared factory also rejects scoped credentials. */
export function registerOwnerDataImportTools(server: McpServer, fetcher?: GatewayFetcher): void {
  for (const definition of ownerDataImportToolDefinitions(fetcher)) {
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: definition.schema, annotations: definition.annotations,
    }, definition.handler);
  }
}
