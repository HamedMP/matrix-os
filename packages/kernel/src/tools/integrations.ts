import { wrapExternalContent } from "../security/external-content.js";

const GATEWAY_BASE = process.env.GATEWAY_URL ?? "http://localhost:4000";
const API_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 35_000; // Pipedream actions timeout at 30s

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.MATRIX_AUTH_TOKEN;
  const clerkUserId = process.env.MATRIX_CLERK_USER_ID;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (clerkUserId) headers["x-platform-user-id"] = clerkUserId;
  return headers;
}

export interface GatewayFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type GatewayFetcher = (
  url: string,
  init: RequestInit,
) => Promise<GatewayFetchResponse>;

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function defaultFetcher(): GatewayFetcher {
  return fetch as unknown as GatewayFetcher;
}

interface ConnectedServiceInventoryItem {
  service: string;
  account_label: string;
  account_email: string | null;
  status: string;
}

/**
 * Returns only connection metadata. This is safe to put in an agent's working
 * context: it makes a newly-connected service discoverable without pulling
 * provider data such as messages, files, or repositories into an unrelated
 * conversation.
 */
export async function listIntegrationInventoryHandler(
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      return textResult("Connected integrations are currently unavailable.");
    }
    const services = (await res.json()) as ConnectedServiceInventoryItem[];
    if (services.length === 0) return textResult("No external services are connected.");
    return textResult(
      `Connected integrations:\n${services.map((service) =>
        `- ${service.service === "gmail" ? "Gmail" : service.service} (${service.account_label}${service.account_email ? `, ${service.account_email}` : ""}) [${service.status}]`,
      ).join("\n")}`,
    );
  } catch (err: unknown) {
    console.error("[integrations] list inventory error:", err instanceof Error ? err.message : err);
    return textResult("Connected integrations are currently unavailable.");
  }
}

export interface DescribeServiceInput {
  service: string;
}

/** Lists Matrix-approved actions and parameter names for one service. */
export async function describeServiceHandler(
  input: DescribeServiceInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations/available`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) return textResult("Integration service details are currently unavailable.");
    const available = (await res.json()) as Array<{
      id: string;
      name: string;
      actions?: Record<string, { description?: string; risk?: "read" | "write" | "destructive"; params?: Record<string, { type?: string; required?: boolean }> }>;
    }>;
    const service = available.find((item) => item.id === input.service);
    if (!service) return textResult(`No Matrix integration is available for ${input.service}.`);
    const actions = Object.entries(service.actions ?? {}).map(([name, action]) => {
      const params = Object.entries(action.params ?? {}).map(([param, definition]) =>
        `${param}${definition.required ? " (required)" : ""}${definition.type ? `: ${definition.type}` : ""}`,
      );
      return `- ${name} [${action.risk ?? "read"}]${action.description ? ` — ${action.description}` : ""}${params.length > 0 ? ` (${params.join(", ")})` : ""}`;
    });
    return textResult(`${service.name} actions:\n${actions.length > 0 ? actions.join("\n") : "No approved actions are currently available."}`);
  } catch (err: unknown) {
    console.error("[integrations] describe service error:", err instanceof Error ? err.message : err);
    return textResult("Integration service details are currently unavailable.");
  }
}

// ---------------------------------------------------------------------------
// connect_service
// ---------------------------------------------------------------------------

export interface ConnectServiceInput {
  service: string;
  label?: string;
}

export async function connectServiceHandler(
  input: ConnectServiceInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations/connect`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ service: input.service, label: input.label }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      return textResult(data.error ?? `Failed to connect ${input.service} (status ${res.status})`);
    }

    const data = (await res.json()) as { url: string; service: string };
    return textResult(
      `To connect ${data.service}, open this URL in your browser:\n\n${data.url}\n\nAfter authorizing, the connection will appear automatically.`,
    );
  } catch (err: unknown) {
    console.error("[integrations] connect_service error:", err instanceof Error ? err.message : err);
    return textResult("Integration service is temporarily unavailable. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// list_connected_services
// ---------------------------------------------------------------------------

export async function listConnectedServicesHandler(
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      return textResult(data.error ?? `Failed to list connected services (status ${res.status})`);
    }
    const services = (await res.json()) as Array<{
      id: string;
      service: string;
      account_label: string;
      account_email: string | null;
      status: string;
    }>;
    if (services.length === 0) {
      return textResult(
        "No services are connected yet. Use connect_service to start an OAuth flow, then sync_services to confirm.",
      );
    }
    const lines = services.map((s) =>
      `- ${s.service} (${s.account_label}${s.account_email ? `, ${s.account_email}` : ""}) [${s.status}] [connection id: ${s.id}]`,
    );
    return textResult(`Connected services (${services.length}):\n${lines.join("\n")}`);
  } catch (err: unknown) {
    console.error("[integrations] list_connected_services error:", err instanceof Error ? err.message : err);
    return textResult("Integration service is temporarily unavailable. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// sync_services -- force pull latest state from Pipedream into local DB.
// Use when the user says "I just authorized X, check again" in environments
// where the OAuth webhook can't reach the gateway (local dev, behind NAT).
// ---------------------------------------------------------------------------

export async function syncServicesHandler(
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations/sync`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      return textResult(data.error ?? `Sync failed (status ${res.status})`);
    }
    const data = (await res.json()) as {
      synced: number;
      services: Array<{ service: string; account_label: string; account_email: string | null }>;
    };
    if (data.synced === 0) {
      const totalCount = data.services.length;
      if (totalCount === 0) {
        return textResult(
          "No services connected yet. Use connect_service to start an OAuth flow first.",
        );
      }
      return textResult(
        `No new services to sync. ${totalCount} already connected: ${data.services.map((s) => s.service).join(", ")}`,
      );
    }
    const lines = data.services.map((s) =>
      `- ${s.service} (${s.account_label}${s.account_email ? `, ${s.account_email}` : ""})`,
    );
    return textResult(
      `Synced ${data.synced} new service(s). All connected services (${data.services.length}):\n${lines.join("\n")}`,
    );
  } catch (err: unknown) {
    console.error("[integrations] sync_services error:", err instanceof Error ? err.message : err);
    return textResult("Integration service is temporarily unavailable. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// call_service
// ---------------------------------------------------------------------------

export interface CallServiceInput {
  service: string;
  action: string;
  params?: Record<string, unknown>;
  label?: string;
}

export async function callServiceHandler(
  input: CallServiceInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(`${GATEWAY_BASE}/api/integrations/call`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        service: input.service,
        action: input.action,
        params: input.params,
        label: input.label,
      }),
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      return textResult(data.error ?? `Call to ${input.service}/${input.action} failed (status ${res.status})`);
    }

    const data = await res.json();
    return textResult(
      wrapExternalContent(JSON.stringify(data, null, 2), {
        source: "api",
        includeWarning: true,
      }),
    );
  } catch (err: unknown) {
    console.error("[integrations] call_service error:", err instanceof Error ? err.message : err);
    return textResult("Integration service is temporarily unavailable. Please try again later.");
  }
}

// ---------------------------------------------------------------------------
// disconnect_service
// ---------------------------------------------------------------------------

export interface DisconnectServiceInput {
  connection_id: string;
}

export async function disconnectServiceHandler(
  input: DisconnectServiceInput,
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const res = await fetcher(
      `${GATEWAY_BASE}/api/integrations/${encodeURIComponent(input.connection_id)}`,
      {
        method: "DELETE",
        headers: authHeaders(),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      return textResult("The integration could not be disconnected. Please try again.");
    }
    return textResult("Disconnected the integration.");
  } catch (err: unknown) {
    console.error("[integrations] disconnect_service error:", err instanceof Error ? err.message : err);
    return textResult("The integration could not be disconnected. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Personal Custom MCP servers. Upstream credentials remain in the platform
// broker; these handlers only exchange safe configuration and wrapped output.
// ---------------------------------------------------------------------------

interface CustomMcpInventoryItem {
  id: string;
  name: string;
  url: string;
  status: string;
  enabled: boolean;
  revision: number;
  tools: Array<{
    name: string;
    description: string;
    approval: "always_ask" | "allow";
    enabled: boolean;
  }>;
}

export async function listCustomMcpServersHandler(
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const response = await fetcher(`${GATEWAY_BASE}/api/mcp-servers`, {
      method: "GET",
      headers: authHeaders(),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) return textResult("Custom MCP servers are currently unavailable.");
    const servers = await response.json() as CustomMcpInventoryItem[];
    if (servers.length === 0) return textResult("No personal Custom MCP servers are configured.");
    return textResult(wrapExternalContent(`Custom MCP servers:\n${servers.map((server) =>
      `- ${server.name} [${server.status}]${server.enabled ? " enabled" : " disabled"} [server id: ${server.id}]`,
    ).join("\n")}`, { source: "api", includeWarning: true }));
  } catch (error: unknown) {
    console.error("[custom-mcp] list error:", error instanceof Error ? error.message : error);
    return textResult("Custom MCP servers are currently unavailable.");
  }
}

export async function describeCustomMcpServerHandler(
  input: { server_id: string },
  fetcher: GatewayFetcher = defaultFetcher(),
): Promise<ToolResult> {
  try {
    const response = await fetcher(
      `${GATEWAY_BASE}/api/mcp-servers/${encodeURIComponent(input.server_id)}`,
      { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    if (!response.ok) return textResult("Custom MCP server details are unavailable.");
    const server = await response.json() as CustomMcpInventoryItem;
    const tools = server.tools.filter((tool) => tool.enabled).map((tool) =>
      `- ${tool.name} [approval: ${tool.approval}]${tool.description ? ` — ${tool.description}` : ""}`,
    );
    return textResult(wrapExternalContent(
      `${server.name} [${server.status}]\n${tools.length ? tools.join("\n") : "No tools are enabled."}`,
      { source: "api", includeWarning: true },
    ));
  } catch (error: unknown) {
    console.error("[custom-mcp] describe error:", error instanceof Error ? error.message : error);
    return textResult("Custom MCP server details are unavailable.");
  }
}

export async function callCustomMcpToolHandler(
  input: { server_id: string; tool: string; arguments?: Record<string, unknown> },
  fetcher: GatewayFetcher = defaultFetcher(),
  approvalGranted = false,
): Promise<ToolResult> {
  try {
    const response = await fetcher(
      `${GATEWAY_BASE}/api/mcp-servers/${encodeURIComponent(input.server_id)}/call`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          tool: input.tool,
          arguments: input.arguments,
          // Only the in-process kernel passes true, after its native approval
          // hook. External stdio MCP clients leave this false; `allow` tools
          // still work, while `always_ask` fails closed at the broker.
          approvalGranted,
        }),
        signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) return textResult("The Custom MCP tool call was rejected.");
    return textResult(wrapExternalContent(JSON.stringify(await response.json(), null, 2), {
      source: "api",
      includeWarning: true,
    }));
  } catch (error: unknown) {
    console.error("[custom-mcp] call error:", error instanceof Error ? error.message : error);
    return textResult("The Custom MCP tool is temporarily unavailable.");
  }
}
