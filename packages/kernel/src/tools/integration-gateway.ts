import { createHmac } from "node:crypto";

export const GATEWAY_BASE = process.env.GATEWAY_URL ?? "http://localhost:4000";
export const API_TIMEOUT_MS = 10_000;
export const ACTION_TIMEOUT_MS = 35_000; // Pipedream actions timeout at 30s

export function gatewayAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const scopedToken = process.env.MATRIX_AGENT_INTEGRATIONS_TOKEN;
  if (scopedToken !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(scopedToken)) throw new Error("InvalidAgentIntegrationCapability");
    headers.Authorization = `Bearer ${scopedToken}`;
    return headers;
  }
  const token = process.env.MATRIX_AUTH_TOKEN;
  const clerkUserId = process.env.MATRIX_CLERK_USER_ID;
  if (process.env.MATRIX_AGENT_OWNER_ID || process.env.MATRIX_AGENT_OWNER_PROOF) {
    throw new Error("LegacyAgentDelegationRejected");
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // The local MCP process inherits the authenticated Chat run's owner ID.
  // The gateway ignores an unsigned user header and otherwise falls back to
  // the VPS owner, which can be a different user on a shared Preview computer.
  if (token && clerkUserId && /^[A-Za-z0-9_-]{1,256}$/.test(clerkUserId)) {
    headers["x-platform-user-id"] = clerkUserId;
    headers["x-platform-verified"] = createHmac("sha256", token).update(clerkUserId).digest("hex");
  }
  return headers;
}

export interface GatewayFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
  headers?: Headers;
}

export type GatewayFetcher = (
  url: string,
  init: RequestInit,
) => Promise<GatewayFetchResponse>;

export interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

export function defaultFetcher(): GatewayFetcher {
  return fetch as unknown as GatewayFetcher;
}
