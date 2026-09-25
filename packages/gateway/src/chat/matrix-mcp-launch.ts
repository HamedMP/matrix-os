import { createHash, randomBytes } from "node:crypto";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

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

export type MatrixMcpRunScope = "discovery" | "call";

export interface MatrixMcpRunContext {
  actorId: string;
  runId: string;
  scope: MatrixMcpRunScope;
}

/** The configured stdio server only exposes Matrix's stable broker contract. */
export function matrixMcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      "matrix-integrations": {
        command: "/opt/matrix/bin/matrix-integrations-mcp",
        // An argv flag survives MCP child environment sanitization and makes
        // the host launcher deny machine-bearer fallback for this Chat Run.
        args: ["--require-scoped-capability"],
      },
    },
  });
}

export interface MatrixMcpRunCapability {
  token: string;
  revoke(): void;
}

export interface MatrixMcpCapabilityIssuer {
  issue(input: { owner: { type: string; ownerId: string }; runId: string; scope: MatrixMcpRunScope }): MatrixMcpRunCapability | null;
}

export interface MatrixMcpCapabilityRegistry extends MatrixMcpCapabilityIssuer {
  resolve(token: string, method: string, path: string): string | null;
  resolveRunContext(token: string, method: string, path: string): MatrixMcpRunContext | null;
  close(): void;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function permitted(method: string, path: string, scope: MatrixMcpRunScope): boolean {
  return (method === "GET" && (path === "/api/mcp-servers" || DETAIL_PATH.test(path)))
    || (scope === "call" && method === "POST" && CALL_PATH.test(path));
}

/** A bounded, owner-bound, run-lifetime capability for Custom MCP only. */
export function createMatrixMcpCapabilityRegistry(options: {
  configuredOwnerId?: string;
  previewRuntime?: boolean;
  now?: () => number;
}): MatrixMcpCapabilityRegistry {
  const active = new Map<string, { actorId: string; runId: string; scope: MatrixMcpRunScope; expiresAt: number }>();
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
    return grant && permitted(method, path, grant.scope)
      ? { actorId: grant.actorId, runId: grant.runId, scope: grant.scope }
      : null;
  }

  return {
    issue(input) {
      if (closed || options.previewRuntime || !options.configuredOwnerId
        || !SAFE_PRINCIPAL_USER_ID.test(options.configuredOwnerId)
        || input.owner.type !== "personal"
        || input.owner.ownerId !== options.configuredOwnerId
        || (input.scope !== "discovery" && input.scope !== "call")
        || !input.runId || input.runId.length > 256) return null;
      sweep();
      if (active.size >= MAX_ACTIVE) return null;
      const token = randomBytes(32).toString("hex");
      const key = digest(token);
      active.set(key, { actorId: input.owner.ownerId, runId: input.runId, scope: input.scope, expiresAt: now() + LIFETIME_MS });
      return { token, revoke: () => { active.delete(key); } };
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
