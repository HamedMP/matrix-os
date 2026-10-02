import { z } from "zod/v4";
import { createHash, randomBytes } from "node:crypto";
import { customMcpArgumentsDigest } from "../integrations/custom-mcp/approval-digest.js";

const service = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const label = z.string().trim().min(1).max(100);
const call = z.strictObject({ service, action: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/),
  label, params: z.record(z.string(), z.unknown()).optional() });
const connect = z.strictObject({ service, label: label.optional() });
const disconnect = z.strictObject({ connection_id: z.uuid() });
const empty = z.strictObject({});
export const MATRIX_INTEGRATION_DISCOVERY_TOOLS = [
  "mcp__matrix-integrations__list_integration_inventory",
  "mcp__matrix-integrations__list_connected_services",
  "mcp__matrix-integrations__describe_service",
] as const;
export const MATRIX_INTEGRATION_ACTION_TOOLS = [
  "mcp__matrix-integrations__call_service", "mcp__matrix-integrations__connect_service",
  "mcp__matrix-integrations__sync_services", "mcp__matrix-integrations__disconnect_service",
] as const;

export interface IntegrationToolRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  title: string;
}

export function integrationToolRequest(tool: string, input: Record<string, unknown>): IntegrationToolRequest | null {
  if (tool === MATRIX_INTEGRATION_ACTION_TOOLS[0]) {
    const value = call.safeParse(input);
    return value.success ? { method: "POST", path: "/api/integrations/call",
      body: { ...value.data, params: value.data.params ?? {} },
      title: `Allow ${value.data.service}/${value.data.action} (${value.data.label})?` } : null;
  }
  if (tool === MATRIX_INTEGRATION_ACTION_TOOLS[1]) {
    const value = connect.safeParse(input);
    return value.success ? { method: "POST", path: "/api/integrations/connect",
      body: { service: value.data.service, ...(value.data.label ? { label: value.data.label } : {}) },
      title: `Connect ${value.data.service}?` } : null;
  }
  if (tool === MATRIX_INTEGRATION_ACTION_TOOLS[2] && empty.safeParse(input).success) {
    return { method: "POST", path: "/api/integrations/sync", body: {}, title: "Refresh connected accounts?" };
  }
  if (tool === MATRIX_INTEGRATION_ACTION_TOOLS[3]) {
    const value = disconnect.safeParse(input);
    return value.success ? { method: "DELETE", path: `/api/integrations/${value.data.connection_id}`,
      body: {}, title: `Disconnect account ${value.data.connection_id}?` } : null;
  }
  return null;
}

function requestDigest(method: string, path: string, body: unknown): string | null {
  let request: IntegrationToolRequest | null = null;
  if (method === "POST" && path === "/api/integrations/call") {
    request = integrationToolRequest(MATRIX_INTEGRATION_ACTION_TOOLS[0], body as Record<string, unknown>);
  } else if (method === "POST" && path === "/api/integrations/connect") {
    request = integrationToolRequest(MATRIX_INTEGRATION_ACTION_TOOLS[1], body as Record<string, unknown>);
  } else if (method === "POST" && path === "/api/integrations/sync") {
    request = integrationToolRequest(MATRIX_INTEGRATION_ACTION_TOOLS[2], body as Record<string, unknown>);
  } else if (method === "DELETE" && empty.safeParse(body).success) {
    request = integrationToolRequest(MATRIX_INTEGRATION_ACTION_TOOLS[3], { connection_id: path.slice("/api/integrations/".length) });
  }
  if (!request || request.path !== path) return null;
  try { return customMcpArgumentsDigest({ method, path, body: request.body }); }
  catch (error: unknown) {
    console.warn("[chat-integrations] Invalid bounded action arguments", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

/** Main-process grants, never agent-provided approval flags. Bound to one live capability. */
export function createIntegrationToolAuthority(options: { live(): boolean; now(): number; fullAccess?: boolean }) {
  const grants: Array<{ digest: string; receiptHash: string; expiresAt: number }> = [];
  function sweep() {
    for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.expiresAt <= options.now()) grants.splice(i, 1);
  }
  function grantIntegrationTool(tool: string, input: Record<string, unknown>): { receipt: string; revoke(): void; isLive(): boolean } | null {
    if (!options.live()) return null;
    const request = integrationToolRequest(tool, input);
    const digest = request && requestDigest(request.method, request.path, request.body);
    sweep();
    if (!digest || grants.length >= 16) return null;
    const receipt = randomBytes(32).toString("hex");
    const grant = { digest, receiptHash: createHash("sha256").update(receipt).digest("hex"), expiresAt: options.now() + 90_000 };
    grants.push(grant);
    return { receipt, revoke() {
      // Identity, rather than digest, isolates concurrent identical approvals.
      const index = grants.indexOf(grant);
      if (index >= 0) grants.splice(index, 1);
    }, isLive() { return options.live() && grant.expiresAt > options.now() && grants.includes(grant); } };
  }
  return {
    grantIntegrationTool,
    consumeIntegrationRequest(method: string, path: string, body: unknown, receipt?: string): boolean {
      if (!options.live()) return false;
      const digest = requestDigest(method, path, body);
      if (!digest) return false;
      if (options.fullAccess) return true;
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt)) return false;
      const receiptHash = createHash("sha256").update(receipt).digest("hex");
      sweep();
      const index = grants.findIndex(grant => grant.receiptHash === receiptHash && grant.digest === digest);
      if (index < 0) return false;
      grants.splice(index, 1);
      return true;
    },
  };
}
