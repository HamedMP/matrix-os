/**
 * Matrix Core MCP stdio handlers (spec 2691). Each handler delegates to the
 * local gateway, which proxies to the platform broker; credentials, policy,
 * and approvals never live in this process.
 */
import { wrapExternalContent } from "../security/external-content.js";
import { gatewayAuthHeaders, type GatewayFetcher } from "./integrations.js";

const GATEWAY_BASE = process.env.GATEWAY_URL ?? "http://localhost:4000";
const DISCOVERY_TIMEOUT_MS = 10_000;
// The platform bounds each upstream call at 30s; allow proxy overhead.
const CALL_TIMEOUT_MS = 35_000;
const HARNESS = /^[a-z0-9][a-z0-9_-]{0,31}$/;

interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const failure = (value: string): ToolResult => ({ isError: true, content: [{ type: "text", text: value }] });

function headers(): Record<string, string> {
  const harness = process.env.MATRIX_MCP_HARNESS;
  return { ...gatewayAuthHeaders(), "x-matrix-mcp-entry-point": "stdio",
    ...(harness && HARNESS.test(harness) ? { "x-matrix-mcp-harness": harness } : {}) };
}

async function request(fetcher: GatewayFetcher | undefined, path: string, init: { method: "GET" | "POST"; body?: unknown; timeoutMs: number }) {
  return (fetcher ?? (fetch as unknown as GatewayFetcher))(`${GATEWAY_BASE}/api/mcp-servers/core${path}`, {
    method: init.method,
    headers: headers(),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs),
  });
}

function data(value: unknown): ToolResult {
  return text(wrapExternalContent(JSON.stringify(value, null, 2), { source: "api", includeWarning: true }));
}

export async function listServicesHandler(fetcher?: GatewayFetcher): Promise<ToolResult> {
  try {
    const response = await request(fetcher, "/services", { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS });
    if (!response.ok) return failure("Matrix Core services are currently unavailable.");
    return data(await response.json());
  } catch (error: unknown) {
    console.error("[core-mcp] list_services error:", error instanceof Error ? error.message : error);
    return failure("Matrix Core services are currently unavailable.");
  }
}

export async function searchToolsHandler(input: { query: string; service?: string; limit?: number }, fetcher?: GatewayFetcher): Promise<ToolResult> {
  const params = new URLSearchParams({ query: input.query });
  if (input.service) params.set("service", input.service);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  try {
    const response = await request(fetcher, `/search?${params}`, { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS });
    if (response.status === 404) return failure("That Matrix Core service is not connected.");
    if (!response.ok) return failure("Matrix Core tool search is currently unavailable.");
    return data(await response.json());
  } catch (error: unknown) {
    console.error("[core-mcp] search_tools error:", error instanceof Error ? error.message : error);
    return failure("Matrix Core tool search is currently unavailable.");
  }
}

export async function describeToolHandler(input: { service: string; tool: string }, fetcher?: GatewayFetcher): Promise<ToolResult> {
  const params = new URLSearchParams({ service: input.service, tool: input.tool });
  try {
    const response = await request(fetcher, `/describe?${params}`, { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS });
    if (response.status === 404) return failure("That Matrix Core tool was not found.");
    if (!response.ok) return failure("Matrix Core tool details are currently unavailable.");
    return data(await response.json());
  } catch (error: unknown) {
    console.error("[core-mcp] describe_tool error:", error instanceof Error ? error.message : error);
    return failure("Matrix Core tool details are currently unavailable.");
  }
}

export async function callToolHandler(
  input: { service: string; tool: string; arguments?: Record<string, unknown>; approval_receipt?: string },
  fetcher?: GatewayFetcher,
): Promise<ToolResult> {
  try {
    const response = await request(fetcher, "/call", { method: "POST", timeoutMs: CALL_TIMEOUT_MS, body: {
      service: input.service, tool: input.tool, arguments: input.arguments,
      // Approval comes only from a Matrix-issued receipt, never from this caller.
      approvalGranted: false,
      ...(input.approval_receipt ? { approvalReceipt: input.approval_receipt } : {}),
    } });
    if (!response.ok) {
      const body = await response.json().catch((error: unknown) => {
        console.warn("[core-mcp] call_tool error body unreadable:", error instanceof Error ? error.name : "UnknownError");
        return null;
      }) as { code?: unknown } | null;
      return failure(body?.code === "ambiguous_tool"
        ? "That tool name is ambiguous. Use the exact tool name returned by describe_tool."
        : "The Matrix Core tool call was rejected.");
    }
    const result = await response.json() as { status?: unknown; text?: unknown; isError?: unknown };
    if (result.status === "approval_required") {
      return failure("This tool requires approval in Matrix before it can run. Ask the person to approve it; do not retry with a guessed receipt.");
    }
    if (result.status !== "ok" || typeof result.text !== "string") return failure("The Matrix Core tool returned an invalid result.");
    // The platform already wrapped this upstream output as untrusted content.
    return result.isError === true ? failure(result.text) : text(result.text);
  } catch (error: unknown) {
    console.error("[core-mcp] call_tool error:", error instanceof Error ? error.message : error);
    return failure("The Matrix Core tool is temporarily unavailable.");
  }
}

export async function getApprovalHandler(input: { approval_id: string }, fetcher?: GatewayFetcher): Promise<ToolResult> {
  try {
    const response = await request(fetcher, `/approvals/${encodeURIComponent(input.approval_id)}`, { method: "GET", timeoutMs: DISCOVERY_TIMEOUT_MS });
    if (response.status === 404) return failure("That approval was not found for this run.");
    if (!response.ok) return failure("Matrix approval status is currently unavailable.");
    return text(JSON.stringify(await response.json()));
  } catch (error: unknown) {
    console.error("[core-mcp] get_approval error:", error instanceof Error ? error.message : error);
    return failure("Matrix approval status is currently unavailable.");
  }
}
