import { isChatAgentDriver } from "@matrix-os/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import {
  ChatAgentListResponseSchema, ChatAgentRecipeCatalogSchema, ChatAgentSchema,
  CanonicalProviderCatalogSchema, CreateChatAgentRequestSchema,
} from "@matrix-os/contracts";
import { gatewayAuthHeaders, type GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

const failure = () => ({ isError: true, content: [{ type: "text" as const,
  text: "Agent setup is unavailable. Check Agents & providers and retry. No save has been confirmed; reuse the same request ID when retrying." }] });
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** The host wrapper supplies the owner identity; model inputs cannot choose an owner or URL. */
export function registerChatAgentTools(server: McpServer, fetcher: GatewayFetcher = fetch) {
  async function request(path: string, body?: unknown): Promise<unknown> {
    const headers = gatewayAuthHeaders();
    const response = await fetcher(`${process.env.GATEWAY_URL ?? "http://localhost:4000"}${path}`, {
      method: body ? "POST" : "GET", headers, signal: AbortSignal.timeout(10_000), redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error("AgentGatewayUnavailable");
    return response.json();
  }
  server.registerTool("list_chat_agent_options", {
    description: "Before creating a saved Matrix Agent, discover its available Codex/Hermes model selections, installed recipe skills, integration service names, and existing Agents. This reads metadata only; it does not connect or read external accounts.",
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const agents = ChatAgentListResponseSchema.parse(await request("/api/chat-agents"));
      if (!agents.enabled) return result({ enabled: false, models: [], agents: [], skills: [], services: [] });
      const [catalog, recipeCatalog] = await Promise.all([
        request("/api/chat-providers").then((value) => CanonicalProviderCatalogSchema.parse(value)),
        request("/api/chat-agents/recipe-catalog").then((value) => ChatAgentRecipeCatalogSchema.parse(value)),
      ]);
      return result({ enabled: true,
        agents: agents.agents.map(({ id, name, revision, selection }) => ({ id, name, revision, selection })),
        models: catalog.instances.filter((instance) => instance.availability === "available"
          && isChatAgentDriver(instance.driverKind)
          && instance.supports.interactionModes.includes("default") && instance.supports.permissionModes.includes("full_access"))
          .flatMap((instance) => instance.models.filter((model) => model.availability === "available")
            .map((model) => ({ instanceId: instance.id, model: model.id, harness: instance.driverKind }))),
        skills: recipeCatalog.skills, services: recipeCatalog.services,
      });
    } catch (error: unknown) {
      console.warn("[chat-agent-tools] Options unavailable:", error instanceof Error ? error.name : "UnknownError");
      return failure();
    }
  });
  server.registerTool("create_chat_agent", {
    description: "Save a new reusable Matrix Agent after the user asks to create it and its role is agreed. Call list_chat_agent_options first and use an available selection and installed skill IDs. Reuse clientRequestId on retries. Saving does not run the Agent, grant permissions, connect integrations, or create a schedule. Only report success when this tool returns a saved Agent ID.",
    inputSchema: CreateChatAgentRequestSchema,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async (input) => {
    try {
      const draft = CreateChatAgentRequestSchema.parse(input);
      const saved = ChatAgentSchema.parse(await request("/api/chat-agents", draft));
      return result({ saved: true, id: saved.id, name: saved.name, revision: saved.revision, selection: saved.selection });
    } catch (error: unknown) {
      console.warn("[chat-agent-tools] Save unavailable:", error instanceof Error ? error.name : "UnknownError");
      return failure();
    }
  });
}
