const GATEWAY_BASE = "http://localhost:4000";
const API_TIMEOUT_MS = 10_000;

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
  content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function defaultFetcher(): GatewayFetcher {
  return globalThis.fetch as unknown as GatewayFetcher;
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
      headers: { "Content-Type": "application/json" },
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[integrations] connect_service error:", msg);
    return textResult(`Integration service unavailable: ${msg}`);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: input.service,
        action: input.action,
        params: input.params,
        label: input.label,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      return textResult(data.error ?? `Call to ${input.service}/${input.action} failed (status ${res.status})`);
    }

    const data = await res.json();
    return textResult(JSON.stringify(data, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[integrations] call_service error:", msg);
    return textResult(`Integration service unavailable: ${msg}`);
  }
}
