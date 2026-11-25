import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ownerDataImportToolsAvailable } from "../../kernel/dist/tools/data-imports.js";
import { gatewayDocumentTools, loadDocumentToolFactory } from "../../kernel/dist/tools/documents.js";
import type { GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

// Resolved once at load: if the document contracts cannot load in this
// runtime, the integrations server still starts, without document tools.
const documentToolFactory = await loadDocumentToolFactory();

/**
 * Document and sheet tools for owner coding agents, over the local gateway's
 * `/api/office` routes. Only the owner credential may use them, never a
 * scoped Run capability. Tools that resolve proposals are left out: this
 * surface has no owner-approval gate, so the owner accepts or rejects in the
 * Docs and Sheets apps or through Chat.
 */
export function registerDocumentTools(server: McpServer, fetcher?: GatewayFetcher): void {
  if (!documentToolFactory || !ownerDataImportToolsAvailable()) return;
  for (const definition of documentToolFactory(gatewayDocumentTools(fetcher))) {
    if (definition.requiresApproval) continue;
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: definition.schema, annotations: definition.annotations,
    }, definition.handler);
  }
}
