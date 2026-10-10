import { createHash, randomBytes } from "node:crypto";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import { createIntegrationToolAuthority } from "./integration-tool-authority.js";

const MAX_ACTIVE = 128;
const LIFETIME_MS = 35 * 60_000;
const SERVER_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DETAIL_PATH = new RegExp(`^/api/mcp-servers/${SERVER_ID}$`);
const CALL_PATH = new RegExp(`^/api/mcp-servers/${SERVER_ID}/call$`);

/** Set only by Gateway auth after a live scoped Run bearer resolves. */
export const MATRIX_MCP_RUN_CONTEXT_KEY = "matrixMcpRunCapability";

export const MATRIX_CUSTOM_MCP_DISCOVERY_TOOLS = [
  "mcp__matrix-integrations__list_custom_mcp_servers",
  "mcp__matrix-integrations__describe_custom_mcp_server",
] as const;

export const MATRIX_CUSTOM_MCP_TOOLS = [
  ...MATRIX_CUSTOM_MCP_DISCOVERY_TOOLS,
  "mcp__matrix-integrations__call_custom_mcp_tool",
] as const;

export const MATRIX_INTEGRATION_READ_TOOLS = [
  "mcp__matrix-integrations__list_integration_inventory",
  "mcp__matrix-integrations__describe_service",
  "mcp__matrix-integrations__call_service",
] as const;

export const MATRIX_COMPANY_DRIVE_TOOLS = [
  "mcp__matrix-integrations__search_company_drive",
  "mcp__matrix-integrations__read_company_drive_file",
] as const;

export type MatrixMcpRunScope = "discovery" | "call" | "integration_read" | "chat_call" | "chat_discovery";

export interface MatrixMcpRunContext {
  actorId: string;
  runId: string;
  scope: MatrixMcpRunScope;
  consumeIntegrationRequest?: ReturnType<typeof createIntegrationToolAuthority>["consumeIntegrationRequest"];
  driveContext?: boolean;
  integrationRead?: boolean;
}

/** The configured stdio server only exposes Matrix's stable broker contract. */
export function matrixMcpConfig(scope: "call" | "discovery" | "chat_call" | "chat_discovery" = "call", driveContext = false, integrationRead = false): string {
  return JSON.stringify({
    mcpServers: {
      "matrix-integrations": {
        command: "/opt/matrix/bin/matrix-integrations-mcp",
        // An argv flag survives MCP child environment sanitization and makes
        // the host launcher deny machine-bearer fallback for this Chat Run.
        args: ["--require-scoped-capability", `--tool-surface=${scope.startsWith("chat_") ? `${scope.replace("_", "-")}${driveContext ? "-drive" : ""}` : `custom-mcp-${scope}${integrationRead ? "-integrations" : ""}${driveContext ? "-drive" : ""}`}`],
      },
    },
  });
}

export interface MatrixMcpRunCapability {
  token: string;
  revoke(): void;
  grantIntegrationTool?: ReturnType<typeof createIntegrationToolAuthority>["grantIntegrationTool"];
}

export interface MatrixMcpCapabilityIssuer {
  issue(input: { owner: { type: string; ownerId: string }; runId: string; scope: MatrixMcpRunScope; fullAccess?: boolean; driveContext?: boolean; integrationRead?: boolean }): MatrixMcpRunCapability | null;
}

export interface MatrixMcpCapabilityRegistry extends MatrixMcpCapabilityIssuer {
  resolve(token: string, method: string, path: string): string | null;
  resolveRunContext(token: string, method: string, path: string): MatrixMcpRunContext | null;
  close(): void;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function permitted(method: string, path: string, scope: MatrixMcpRunScope, integrationRead = false): boolean {
  if (integrationRead && ((method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog"))
    || (method === "POST" && path === "/api/integrations/read-call"))) return true;
  if (scope === "chat_call" || scope === "chat_discovery") {
    if (method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog")) return true;
    if (scope === "chat_call" && ((method === "POST" && ["/api/integrations/call", "/api/integrations/connect", "/api/integrations/sync"].includes(path))
      || (method === "DELETE" && new RegExp(`^/api/integrations/${SERVER_ID}$`).test(path)))) return true;
  }
  if (scope === "integration_read") {
    return (method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog"))
      || (method === "POST" && path === "/api/integrations/read-call");
  }
  return (method === "GET" && (path === "/api/mcp-servers" || DETAIL_PATH.test(path)))
    || ((scope === "call" || scope === "chat_call") && method === "POST" && CALL_PATH.test(path));
}

/** A bounded, owner-bound, run-lifetime capability with explicit tool authority. */
export function createMatrixMcpCapabilityRegistry(options: {
  configuredOwnerId?: string;
  previewRuntime?: boolean;
  now?: () => number;
}): MatrixMcpCapabilityRegistry {
  const active = new Map<string, { actorId: string; runId: string; scope: MatrixMcpRunScope; driveContext?: boolean; integrationRead?: boolean; expiresAt: number;
    authority?: ReturnType<typeof createIntegrationToolAuthority> }>();
  const now = options.now ?? Date.now;
  let closed = false;

  function sweep(): void {
    const current = now();
    for (const [key, value] of active) {
      if (value.expiresAt <= current) active.delete(key);
    }
  }

  function resolveRunContext(token: string, method: string, path: string): MatrixMcpRunContext | null {
    if (closed || !/^[a-f0-9]{64}$/.test(token)) return null;
    sweep();
    const grant = active.get(digest(token));
    return grant && (permitted(method, path, grant.scope, grant.integrationRead)
      || (grant.driveContext === true && method === "POST"
        && (path === "/api/chat-drive-context/search" || path === "/api/chat-drive-context/read")))
      ? { actorId: grant.actorId, runId: grant.runId, scope: grant.scope,
        ...(grant.driveContext ? { driveContext: true } : {}),
        ...(grant.integrationRead ? { integrationRead: true } : {}),
        ...(grant.authority ? { consumeIntegrationRequest: grant.authority.consumeIntegrationRequest } : {}) }
      : null;
  }

  return {
    issue(input) {
      if (closed || options.previewRuntime || !input.runId || input.runId.length > 256) return null;
      sweep();
      if (!options.configuredOwnerId
        || !SAFE_PRINCIPAL_USER_ID.test(options.configuredOwnerId)
        || input.owner.type !== "personal"
        || input.owner.ownerId !== options.configuredOwnerId
        || !["discovery", "call", "integration_read", "chat_call", "chat_discovery"].includes(input.scope)
        || (input.driveContext && input.scope === "integration_read")
        || (input.integrationRead !== undefined && typeof input.integrationRead !== "boolean")
        || (input.integrationRead === true && input.scope.startsWith("chat_"))) return null;
      if (active.size >= MAX_ACTIVE) return null;
      const token = randomBytes(32).toString("hex");
      const key = digest(token);
      const expiresAt = now() + LIFETIME_MS;
      const authority = input.scope === "chat_call" ? createIntegrationToolAuthority({
        now, fullAccess: input.fullAccess === true,
        live: () => !closed && active.has(key) && now() < expiresAt,
      }) : undefined;
      active.set(key, { actorId: input.owner.ownerId, runId: input.runId, scope: input.scope, ...(input.driveContext ? { driveContext: true } : {}), ...(input.integrationRead === true ? { integrationRead: true } : {}), expiresAt, authority });
      return { token, revoke: () => { active.delete(key); },
        ...(authority ? { grantIntegrationTool: authority.grantIntegrationTool } : {}) };
    },
    resolve(token, method, path) {
      return resolveRunContext(token, method, path)?.actorId ?? null;
    },
    resolveRunContext,
    close() {
      closed = true;
      active.clear();
    },
  };
}
