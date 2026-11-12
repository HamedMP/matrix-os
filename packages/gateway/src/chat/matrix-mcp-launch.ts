import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { previewDriveActionCanonical } from "@matrix-os/contracts";
import { SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import { createIntegrationToolAuthority } from "./integration-tool-authority.js";

const MAX_ACTIVE = 128;
const LIFETIME_MS = 35 * 60_000;
const SERVER_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DETAIL_PATH = new RegExp(`^/api/mcp-servers/${SERVER_ID}$`);
const CALL_PATH = new RegExp(`^/api/mcp-servers/${SERVER_ID}/call$`);
const CORE_DISCOVERY_PATHS = new Set(["/api/mcp-servers/core/services", "/api/mcp-servers/core/search", "/api/mcp-servers/core/describe"]);
const CORE_APPROVAL_PATH = new RegExp(`^/api/mcp-servers/core/approvals/${SERVER_ID}$`);

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

export type MatrixMcpRunScope = "discovery" | "call" | "integration_read" | "chat_call" | "chat_discovery" | "preview_drive_call";

export interface PreviewDriveRunContext {
  chatId: string; runId: string; runGrant: string;
  consumeActionGrant(action: unknown, receipt?: string): string | null;
}

export interface MatrixMcpRunContext {
  actorId: string;
  runId: string;
  scope: MatrixMcpRunScope;
  consumeIntegrationRequest?: ReturnType<typeof createIntegrationToolAuthority>["consumeIntegrationRequest"];
  previewDrive?: PreviewDriveRunContext;
  driveContext?: boolean;
  integrationRead?: boolean;
}

/** Matrix Core MCP (spec 2691): progressive discovery is safe in every mode. */
export const MATRIX_CORE_MCP_DISCOVERY_TOOLS = [
  "mcp__matrix-integrations__list_services",
  "mcp__matrix-integrations__search_tools",
  "mcp__matrix-integrations__describe_tool",
] as const;

/** Broker calls plus status-only approval polling; added only where calls are auto-approved. */
export const MATRIX_CORE_MCP_CALL_TOOLS = [
  "mcp__matrix-integrations__call_tool",
  "mcp__matrix-integrations__get_approval",
] as const;

/** Harness labels for usage analytics; they never select authority. */
export type MatrixMcpHarness = "claude_code" | "codex" | "opencode" | "hermes";
export type MatrixMcpLaunchScope = "call" | "discovery" | "chat_call" | "chat_discovery" | "preview_drive_call";
export const MATRIX_MCP_LAUNCHER = "/opt/matrix/bin/matrix-integrations-mcp";
export const MATRIX_MCP_SERVER_NAME = "matrix-integrations";
export const MATRIX_MCP_RUN_TOKEN_ENV = "MATRIX_AGENT_INTEGRATIONS_TOKEN";

function toolSurface(scope: MatrixMcpLaunchScope, driveContext: boolean, integrationRead: boolean): string {
  if (scope === "preview_drive_call") return "preview-drive-call";
  if (scope.startsWith("chat_")) return `${scope.replace("_", "-")}${driveContext ? "-drive" : ""}`;
  return `custom-mcp-${scope}${integrationRead ? "-integrations" : ""}${driveContext ? "-drive" : ""}`;
}

/**
 * The one stdio server every harness receives. `--require-scoped-capability`
 * survives MCP child environment sanitization and makes the host launcher deny
 * machine-bearer fallback; `--harness` is forwarded only as a usage label.
 */
export function matrixMcpServerLaunch(scope: MatrixMcpLaunchScope, options: {
  harness: MatrixMcpHarness; driveContext?: boolean; integrationRead?: boolean;
}): { command: string; args: string[] } {
  return {
    command: MATRIX_MCP_LAUNCHER,
    args: ["--require-scoped-capability", `--tool-surface=${toolSurface(scope, options.driveContext === true, options.integrationRead === true)}`,
      `--harness=${options.harness}`],
  };
}

/** Claude Code `--mcp-config` JSON. */
export function matrixMcpConfig(scope: MatrixMcpLaunchScope = "call", driveContext = false, integrationRead = false): string {
  return JSON.stringify({
    mcpServers: { [MATRIX_MCP_SERVER_NAME]: matrixMcpServerLaunch(scope, { harness: "claude_code", driveContext, integrationRead }) },
  });
}

/**
 * Codex `-c key=value` overrides (values are TOML; JSON strings and string
 * arrays are valid TOML). `env_vars` forwards only the run bearer by name.
 */
export function codexMatrixMcpConfigArgs(scope: "call" | "discovery"): string[] {
  const server = matrixMcpServerLaunch(scope, { harness: "codex" });
  const key = `mcp_servers.${MATRIX_MCP_SERVER_NAME}`;
  return [
    "-c", `${key}.command=${JSON.stringify(server.command)}`,
    "-c", `${key}.args=${JSON.stringify(server.args)}`,
    "-c", `${key}.env_vars=${JSON.stringify([MATRIX_MCP_RUN_TOKEN_ENV])}`,
  ];
}

const OPENCODE_CORE_DISCOVERY = ["list_services", "search_tools", "describe_tool"] as const;
const OPENCODE_CORE_CALL = ["call_tool", "get_approval"] as const;

/**
 * OpenCode `mcp` block plus exact permission grants. OpenCode names MCP tools
 * `<server>_<tool>`; only the Core tools are allowed, never a server wildcard.
 */
export function openCodeMatrixMcpConfig(scope: "call" | "discovery"): {
  mcp: Record<string, unknown>; permission: Record<string, "allow">;
} {
  const server = matrixMcpServerLaunch(scope, { harness: "opencode" });
  const tools = scope === "call" ? [...OPENCODE_CORE_DISCOVERY, ...OPENCODE_CORE_CALL] : [...OPENCODE_CORE_DISCOVERY];
  return {
    mcp: { [MATRIX_MCP_SERVER_NAME]: { type: "local", command: [server.command, ...server.args],
      environment: { [MATRIX_MCP_RUN_TOKEN_ENV]: `{env:${MATRIX_MCP_RUN_TOKEN_ENV}}` } } },
    permission: Object.fromEntries(tools.map(tool => [`${MATRIX_MCP_SERVER_NAME}_${tool}`, "allow" as const])),
  };
}

export interface MatrixMcpRunCapability {
  token: string;
  surface?: "preview_drive_call";
  previewDrive?: { runGrant: string; chatId: string; runId: string };
  revoke(): void;
  grantIntegrationTool?: ReturnType<typeof createIntegrationToolAuthority>["grantIntegrationTool"];
  bindPreviewActionGrant?(receipt: string, actionGrant: string): boolean;
}

export interface MatrixMcpCapabilityIssuer {
  issue(input: { owner: { type: string; ownerId: string }; runId: string; scope: MatrixMcpRunScope; fullAccess?: boolean; driveContext?: boolean; integrationRead?: boolean }): MatrixMcpRunCapability | null;
}

export interface MatrixMcpCapabilityRegistry extends MatrixMcpCapabilityIssuer {
  authorizePreviewDriveRun(input: { actorId: string; chatId: string; runId: string; runGrant: string;
    onRevoke?: () => void }): boolean;
  disposePendingPreviewDriveRun(input: { actorId: string; chatId: string; runId: string; runGrant: string }): boolean;
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
  if (scope === "preview_drive_call") return (method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog"))
    || (method === "POST" && path === "/api/integrations/call");
  if (scope === "chat_call" || scope === "chat_discovery") {
    if (method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog")) return true;
    if (scope === "chat_call" && ((method === "POST" && ["/api/integrations/call", "/api/integrations/connect", "/api/integrations/sync"].includes(path))
      || (method === "DELETE" && new RegExp(`^/api/integrations/${SERVER_ID}$`).test(path)))) return true;
  }
  if (scope === "integration_read") {
    return (method === "GET" && (path === "/api/integrations" || path === "/api/integrations/agent-catalog"))
      || (method === "POST" && path === "/api/integrations/read-call");
  }
  const call = scope === "call" || scope === "chat_call";
  return (method === "GET" && (path === "/api/mcp-servers" || DETAIL_PATH.test(path) || CORE_DISCOVERY_PATHS.has(path)))
    || (call && method === "POST" && (CALL_PATH.test(path) || path === "/api/mcp-servers/core/call"))
    || (call && method === "GET" && CORE_APPROVAL_PATH.test(path));
}

/** A bounded, owner-bound, run-lifetime capability with explicit tool authority. */
export function createMatrixMcpCapabilityRegistry(options: {
  configuredOwnerId?: string;
  previewRuntime?: boolean;
  now?: () => number;
}): MatrixMcpCapabilityRegistry {
  const active = new Map<string, { actorId: string; runId: string; scope: MatrixMcpRunScope; driveContext?: boolean; integrationRead?: boolean; expiresAt: number;
    authority?: ReturnType<typeof createIntegrationToolAuthority>; previewDrive?: PreviewDriveRunContext;
    onRevoke?: () => void }>();
  const previewRuns = new Map<string, { actorId: string; chatId: string; runGrant: string; expiresAt: number;
    onRevoke?: () => void }>();
  const now = options.now ?? Date.now;
  let closed = false;

  function sweep(): void {
    const current = now();
    for (const [key, value] of active) {
      if (value.expiresAt <= current) { active.delete(key); value.onRevoke?.(); }
    }
    for (const [key, value] of previewRuns) if (value.expiresAt <= current) {
      previewRuns.delete(key); value.onRevoke?.();
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
        ...(grant.authority && !grant.previewDrive ? { consumeIntegrationRequest: grant.authority.consumeIntegrationRequest } : {}),
        ...(grant.previewDrive ? { previewDrive: grant.previewDrive } : {}) }
      : null;
  }

  return {
    authorizePreviewDriveRun(input) {
      if (closed || !options.previewRuntime || !SAFE_PRINCIPAL_USER_ID.test(input.actorId)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.chatId)
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(input.runId)
        || !/^[a-f0-9]{64}$/.test(input.runGrant)) return false;
      sweep();
      if (previewRuns.has(input.runId) || previewRuns.size >= MAX_ACTIVE) return false;
      previewRuns.set(input.runId, { actorId: input.actorId, chatId: input.chatId, runGrant: input.runGrant,
        ...(input.onRevoke ? { onRevoke: input.onRevoke } : {}),
        expiresAt: now() + 2 * 60_000 });
      return true;
    },
    disposePendingPreviewDriveRun(input) {
      const pending = previewRuns.get(input.runId);
      if (!pending || pending.actorId !== input.actorId || pending.chatId !== input.chatId
        || pending.runGrant.length !== input.runGrant.length) return false;
      const expectedGrant = Buffer.from(pending.runGrant);
      const suppliedGrant = Buffer.from(input.runGrant);
      if (expectedGrant.length !== suppliedGrant.length || !timingSafeEqual(expectedGrant, suppliedGrant)) return false;
      // Delete first for idempotent/reentrant disposal; issued capabilities own their revocation.
      previewRuns.delete(input.runId);
      pending.onRevoke?.();
      return true;
    },
    issue(input) {
      if (closed || !input.runId || input.runId.length > 256
        || (input.integrationRead !== undefined && typeof input.integrationRead !== "boolean")
        || (input.integrationRead === true && !["call", "discovery", "integration_read"].includes(input.scope))) return null;
      sweep();
      if (options.previewRuntime) {
        const pending = previewRuns.get(input.runId);
        if (!pending || input.owner.type !== "personal" || input.owner.ownerId !== pending.actorId
          || input.scope !== "chat_call" || input.fullAccess === true || input.driveContext === true || active.size >= MAX_ACTIVE) return null;
        previewRuns.delete(input.runId);
        const token = randomBytes(32).toString("hex");
        const key = digest(token);
        const expiresAt = now() + LIFETIME_MS;
        const authority = createIntegrationToolAuthority({ now, fullAccess: false,
          live: () => !closed && active.has(key) && now() < expiresAt });
        const receipts = new Map<string, { grant: ReturnType<typeof authority.grantIntegrationTool> & {}; actionGrant?: string }>();
        const sweepReceipts = () => {
          for (const [receipt, entry] of receipts) if (!entry.grant.isLive()) receipts.delete(receipt);
        };
        const previewDrive: PreviewDriveRunContext = { chatId: pending.chatId, runId: input.runId,
          runGrant: pending.runGrant,
          consumeActionGrant(action, receipt) {
            if (!receipt || !previewDriveActionCanonical(action)) return null;
            sweepReceipts();
            const entry = receipts.get(receipt);
            if (!entry?.actionGrant || !entry.grant.isLive()
              || !authority.consumeIntegrationRequest("POST", "/api/integrations/call", action, receipt)) return null;
            receipts.delete(receipt);
            return entry.actionGrant;
          } };
        active.set(key, { actorId: pending.actorId, runId: input.runId, scope: "preview_drive_call",
          expiresAt, authority, previewDrive, ...(pending.onRevoke ? { onRevoke: pending.onRevoke } : {}) });
        return { token, surface: "preview_drive_call", previewDrive: { runGrant: pending.runGrant,
          chatId: pending.chatId, runId: input.runId }, revoke: () => {
          if (active.delete(key)) pending.onRevoke?.();
          receipts.clear();
        },
          grantIntegrationTool(tool, action) {
            if (tool !== "mcp__matrix-integrations__call_service" || !previewDriveActionCanonical(action)) return null;
            sweepReceipts();
            if (receipts.size >= 16) return null;
            const grant = authority.grantIntegrationTool(tool, action);
            if (!grant) return null;
            receipts.set(grant.receipt, { grant });
            return { ...grant, revoke() { receipts.delete(grant.receipt); grant.revoke(); } };
          },
          bindPreviewActionGrant(receipt, actionGrant) {
            sweepReceipts();
            const entry = receipts.get(receipt);
            if (!entry || !entry.grant.isLive() || !/^[a-f0-9]{64}$/.test(actionGrant)) return false;
            entry.actionGrant = actionGrant;
            return true;
          } };
      }
      if (!options.configuredOwnerId
        || !SAFE_PRINCIPAL_USER_ID.test(options.configuredOwnerId)
        || input.owner.type !== "personal"
        || input.owner.ownerId !== options.configuredOwnerId
        || !["discovery", "call", "integration_read", "chat_call", "chat_discovery"].includes(input.scope)
        || (input.driveContext && input.scope === "integration_read")) return null;
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
      for (const grant of active.values()) grant.onRevoke?.();
      for (const grant of previewRuns.values()) grant.onRevoke?.();
      active.clear();
      previewRuns.clear();
    },
  };
}
