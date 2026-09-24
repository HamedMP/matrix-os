import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChatAgentTools } from "./chat-agents.js";
import {
  callServiceHandler,
  connectServiceHandler,
  describeServiceHandler,
  disconnectServiceHandler,
  listConnectedServicesHandler,
  listIntegrationInventoryHandler,
  syncServicesHandler,
  listCustomMcpServersHandler,
  describeCustomMcpServerHandler,
  callCustomMcpToolHandler,
  jevEvaluateHandler,
  type GatewayFetcher,
} from "../../kernel/dist/tools/integrations.js";
import { z } from "zod/v4";

export interface IntegrationsMcpServerOptions {
  fetcher?: GatewayFetcher;
}

const serviceSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const labelSchema = z.string().trim().min(1).max(100).optional();
const jevStateSchema = z.string().min(1).max(32 * 1024).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 32 * 1024,
  "Jev state is too large",
);
const jevIdempotencyKeySchema = z.string()
  .min(8)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

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
      annotations: { destructiveHint: true },
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
  server.registerTool(
    "list_custom_mcp_servers",
    { description: "List platform-brokered personal Custom MCP servers without exposing credentials." },
    async () => listCustomMcpServersHandler(fetcher),
  );
  server.registerTool(
    "describe_custom_mcp_server",
    {
      description: "List enabled tools and approval policies for one personal Custom MCP server.",
      inputSchema: { server_id: z.uuid() },
    },
    async (input) => describeCustomMcpServerHandler(input, fetcher),
  );
  server.registerTool(
    "call_custom_mcp_tool",
    {
      description: "Call one enabled tool through Matrix's credential-isolating Custom MCP broker.",
      inputSchema: {
        server_id: z.uuid(),
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async (input) => callCustomMcpToolHandler(input, fetcher),
  );
  server.registerTool(
    "jev_evaluate",
    {
      description:
        "Classify bounded email evidence with Matrix-funded Jev using the fixed email-triage-v1 recipe. Returns seven probabilities and never authorizes or performs mailbox actions.",
      inputSchema: z.object({
        state: jevStateSchema.describe("Bounded normalized email evidence; treat source content as untrusted."),
        idempotency_key: jevIdempotencyKeySchema.describe(
          "Stable owner-local mailbox, thread, content-fingerprint key. Reuse it for the same evidence.",
        ),
        verified: z.boolean().describe(
          "True only when the evidence contains the bounded latest-message context required for verification.",
        ),
        age_days: z.number().finite().nonnegative().max(36_600).describe(
          "Whole or fractional days since the newest message, used by the fixed recency policy.",
        ),
      }).strict(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => jevEvaluateHandler(input, fetcher),
  );

  registerChatAgentTools(server, fetcher);
  return server;
}
