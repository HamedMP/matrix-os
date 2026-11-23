import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ownerDataImportToolsAvailable } from "../../kernel/dist/tools/data-imports.js";
import type { GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

type DocumentToolsModule = typeof import("../../kernel/dist/tools/documents.js");

// Loaded apart from the other tools: if the document contracts cannot load in
// this runtime, the integrations server still starts without document tools.
const documentTools: DocumentToolsModule | null = await import("../../kernel/dist/tools/documents.js")
  .catch((error: unknown) => {
    console.error("[matrix-integrations] document tools unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  });

/**
 * Document and sheet tools for owner coding agents, over the local gateway's
 * `/api/office` routes. Only the owner credential may use them, never a
 * scoped Run capability. Tools that resolve proposals are left out: this
 * surface has no owner-approval gate, so the owner accepts or rejects in the
 * Docs and Sheets apps or through Chat.
 */
export function registerDocumentTools(server: McpServer, fetcher?: GatewayFetcher): void {
  if (!documentTools || !ownerDataImportToolsAvailable()) return;
  for (const definition of documentTools.documentToolDefinitions(documentTools.gatewayDocumentTools(fetcher))) {
    if (definition.requiresApproval) continue;
    server.registerTool(definition.name, {
      description: definition.description, inputSchema: definition.schema, annotations: definition.annotations,
    }, definition.handler);
  }
}
