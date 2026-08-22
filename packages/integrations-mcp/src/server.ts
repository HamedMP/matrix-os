import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  callServiceHandler,
  connectServiceHandler,
  describeServiceHandler,
  disconnectServiceHandler,
  listConnectedServicesHandler,
  listIntegrationInventoryHandler,
  syncServicesHandler,
  type GatewayFetcher,
} from "../../kernel/dist/tools/integrations.js";
import { z } from "zod/v4";

export interface IntegrationsMcpServerOptions {
  fetcher?: GatewayFetcher;
}

const serviceSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const labelSchema = z.string().trim().min(1).max(100).optional();

/**
 * Builds the local stdio MCP boundary shared by Matrix coding agents and
 * assistant runtimes. Provider credentials never cross this boundary: every
 * handler delegates to the authenticated local Matrix gateway.
 */
export function createIntegrationsMcpServer(
  options: IntegrationsMcpServerOptions = {},
): McpServer {
  const fetcher = options.fetcher;
  const server = new McpServer(
    { name: "matrix-integrations", version: "1.0.0" },
    {
      instructions:
        "Matrix integrations connected in Settings are available here. At the beginning of a new conversation, call list_integration_inventory when external account context may be relevant. Inventory returns metadata only; call provider actions only when needed for the user's request.",
    },
  );

  server.registerTool(
    "list_integration_inventory",
    {
      description:
        "Discover safe connection metadata for a new conversation (service, account label/email, and status only; never mailbox or provider content).",
    },
    async () => listIntegrationInventoryHandler(fetcher),
  );
  server.registerTool(
    "list_connected_services",
    {
      description:
        "List connected Matrix integrations, including connection ids needed for explicit account management.",
    },
    async () => listConnectedServicesHandler(fetcher),
  );
  server.registerTool(
    "describe_service",
    {
      description: "List Matrix-approved actions and parameters for a connected service before calling it.",
      inputSchema: { service: serviceSchema },
    },
    async (input) => describeServiceHandler(input, fetcher),
  );
  server.registerTool(
    "connect_service",
    {
      description:
        "Start a Matrix Settings-compatible OAuth connection and return the browser authorization URL.",
      inputSchema: { service: serviceSchema, label: labelSchema },
    },
    async (input) => connectServiceHandler(input, fetcher),
  );
  server.registerTool(
    "sync_services",
    {
      description: "Refresh Matrix connection metadata after the user completes OAuth.",
    },
    async () => syncServicesHandler(fetcher),
  );
  server.registerTool(
    "call_service",
    {
      description:
        "Call one Matrix-approved action on a connected service. Use describe_service first when the action schema is unknown.",
      inputSchema: {
        service: serviceSchema,
        action: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
        params: z.record(z.string(), z.unknown()).optional(),
        label: labelSchema,
      },
    },
    async (input) => callServiceHandler(input, fetcher),
  );
  server.registerTool(
    "disconnect_service",
    {
      description:
        "Disconnect one external account by its explicit Matrix connection id. Only use when the user asks to disconnect it.",
      inputSchema: { connection_id: z.uuid() },
      annotations: { destructiveHint: true },
    },
    async (input) => disconnectServiceHandler(input, fetcher),
  );

  return server;
}
