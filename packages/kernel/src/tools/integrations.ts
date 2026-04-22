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
      `- ${s.service} (${s.account_label}${s.account_email ? `, ${s.account_email}` : ""}) [${s.status}]`,
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
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    console.error("[integrations] call_service error:", err instanceof Error ? err.message : err);
    return textResult("Integration service is temporarily unavailable. Please try again later.");
  }
}
