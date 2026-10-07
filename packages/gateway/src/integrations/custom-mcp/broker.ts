import { randomUUID } from "node:crypto";
import type { PlatformDb } from "../../platform-db.js";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
} from "./crypto.js";
import { MAX_CUSTOM_MCP_TOOLS, RemoteMcpClient } from "./client.js";
import { customMcpArgumentsDigest } from "./approval-digest.js";
import { validateCustomMcpUrl } from "./security.js";
import { hasManagedSettingsClaim } from "./managed-settings-claim.js";
import type {
  CustomMcpApproval,
  CustomMcpAuthMode,
  CustomMcpServer,
  CustomMcpServerProjection,
  CustomMcpStatus,
  CustomMcpTool,
} from "./types.js";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_LEASE_MS = 30_000;

export interface CustomMcpCredential {
  authorization?: string;
  oauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    state?: string;
    stateExpiresAt?: string;
    verifier?: string;
    tokenEndpoint?: string;
    authorizationEndpoint?: string;
    resource?: string;
    revocationEndpoint?: string;
    clientId?: string;
    clientIssuer?: string;
    redirectUri?: string;
    scopes?: string[];
    /** Credential refresh lease; does not change the projection policy revision. */
    refreshing?: boolean;
    refreshStartedAt?: string;
    /** Removal owns this grant until revocation and deletion succeed. */
    removing?: boolean;
  };
}

export interface CustomMcpProjectionBroker {
  upsert(userId: string, server: CustomMcpServerProjection): Promise<void>;
  remove(userId: string, serverId: string): Promise<void>;
  read?(userId: string, serverId: string): Promise<CustomMcpServerProjection | null>;
}

export interface CreateCustomMcpInput {
  name: string;
  url: string;
  authMode: CustomMcpAuthMode;
  credential?: string;
}

export interface PatchCustomMcpInput {
  revision: number;
  name?: string;
  enabled?: boolean;
  tools?: Array<{
    name: string;
    enabled: boolean;
    approval: CustomMcpApproval;
  }>;
}

export class CustomMcpBrokerError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "forbidden" | "upstream" | "action_required",
    message = "Custom MCP operation failed",
  ) {
    super(message);
    this.name = "CustomMcpBrokerError";
  }
}

/** Shared lease semantics for OAuth authorization and connection removal. */
export function isCustomMcpRefreshClaimActive(oauth: CustomMcpCredential["oauth"], now: Date): boolean {
  if (!oauth?.refreshing) return false;
  const startedAt = typeof oauth.refreshStartedAt === "string" ? Date.parse(oauth.refreshStartedAt) : NaN;
  return Number.isFinite(startedAt) && startedAt <= now.getTime() && now.getTime() - startedAt < REFRESH_LEASE_MS;
}

/** Contention is transient; no caller may retry the rotating token itself. */
export class CustomMcpRefreshPendingError extends CustomMcpBrokerError {
  readonly refreshPending = true;
  readonly retryAfterMs = 1_000;
  constructor() { super("upstream"); this.name = "CustomMcpRefreshPendingError"; }
}

function toProjection(server: CustomMcpServer): CustomMcpServerProjection {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    authMode: server.authMode,
    enabled: server.enabled,
    revision: server.revision,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      enabled: tool.enabled,
      approval: tool.approval,
    })),
  };
}

function authorizationFor(
  authMode: CustomMcpAuthMode,
  credential: string | undefined,
): CustomMcpCredential | undefined {
  if (authMode === "none" || authMode === "oauth") return undefined;
  if (!credential || credential.length > 8_192) {
    throw new CustomMcpBrokerError("invalid", "Credential is required");
  }
  return authMode === "bearer"
    ? { authorization: `Bearer ${credential}` }
    : { authorization: `X-API-Key ${credential}` };
}

export class CustomMcpBroker {
  private readonly client: RemoteMcpClient;

  constructor(private readonly options: {
    db: PlatformDb;
    encryptionKey: Buffer;
    projection: CustomMcpProjectionBroker;
    client?: RemoteMcpClient;
    now?: () => Date;
    validateUrl?: typeof validateCustomMcpUrl;
    revokeOAuth?: (credential: CustomMcpCredential) => Promise<void>;
    /** Provider-specific REST presets must revoke their own grant before deletion. */
    removeManagedPreset?: (userId: string, row: NonNullable<Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>>>, runtimeDestroyed: boolean) => Promise<boolean>;
    resolveOAuthAuthorization?: (
      userId: string,
      row: NonNullable<Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>>>,
    ) => Promise<string | undefined>;
  }) {
    this.client = options.client ?? new RemoteMcpClient();
  }

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }

  async list(userId: string): Promise<CustomMcpServer[]> {
    return this.options.db.listCustomMcpServers(userId);
  }

  async sweepPending(): Promise<number> {
    return this.options.db.sweepPendingCustomMcpServers(this.options.now?.() ?? new Date());
  }

  async getPreset(userId: string, presetId: string) {
    return this.options.db.getCustomMcpPresetForBroker(presetId, userId);
  }

  async ensurePreset(input: {
    userId: string;
    presetId: string;
    name: string;
    url: string;
  }): Promise<NonNullable<Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>>>> {
    const existing = await this.options.db.getCustomMcpPresetForBroker(input.presetId, input.userId);
    if (existing) return existing;
    await this.validateRemoteUrl(input.url);
    const id = randomUUID();
    const now = this.options.now?.() ?? new Date();
    const pending = await this.options.db.createCustomMcpServer({
      id,
      userId: input.userId,
      presetId: input.presetId,
      name: input.name,
      url: input.url,
      authMode: "oauth",
      pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    });
    // A concurrent request may have created the owner-scoped singleton.
    if (pending.id !== id) return this.requirePrivate(input.userId, pending.id);
    await this.options.projection.upsert(input.userId, toProjection(pending));
    const activated = await this.options.db.updateCustomMcpServer(id, input.userId, pending.revision, {
      status: "auth_required",
      pendingExpiresAt: null,
    });
    if (!activated) throw new CustomMcpBrokerError("conflict");
    await this.options.projection.upsert(input.userId, toProjection(activated));
    return await this.requirePrivate(input.userId, id);
  }

  async activatePreset(input: {
    userId: string;
    presetId: string;
    allowedTools: readonly string[];
    requiredTools?: readonly string[];
    expectedRevision?: number;
  }): Promise<NonNullable<Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>>>> {
    let row = await this.options.db.getCustomMcpPresetForBroker(input.presetId, input.userId);
    if (!row) throw new CustomMcpBrokerError("not_found");
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) throw new CustomMcpBrokerError("conflict");
    if (hasManagedSettingsClaim(row, this.options.encryptionKey)) throw new CustomMcpBrokerError("action_required");
    if (row.status === "ready" && row.enabled) return row;
    if (row.status === "auth_required") return row;
    const discovered = await this.client.discover({
      serverId: row.id,
      url: row.url,
      authorization: await this.readAuthorization(input.userId, row),
    });
    const allowed = new Set(input.allowedTools);
    const tools = discovered.map((tool) => ({
      ...tool,
      enabled: allowed.has(tool.name),
      approval: "allow" as const,
    }));
    if (!(input.requiredTools ?? input.allowedTools).every((name) =>
      tools.some((tool) => tool.name === name))) {
      throw new CustomMcpBrokerError("upstream", "Curated MCP tool contract is unavailable");
    }
    const updated = await this.options.db.updateCustomMcpServer(row.id, input.userId, row.revision, {
      tools,
      enabled: true,
      status: "ready",
      discoveredAt: this.options.now?.() ?? new Date(),
    });
    if (!updated) throw new CustomMcpBrokerError("conflict");
    await this.options.projection.upsert(input.userId, toProjection(updated));
    row = await this.requirePrivate(input.userId, row.id);
    return row;
  }

  async describe(userId: string, serverId: string): Promise<CustomMcpServer> {
    const server = await this.options.db.getCustomMcpServerForBroker(serverId, userId);
    if (!server) throw new CustomMcpBrokerError("not_found");
    return {
      id: server.id,
      name: server.name,
      url: server.url,
      authMode: server.auth_mode,
      status: server.status,
      enabled: server.enabled,
      revision: server.revision,
      tools: server.tools,
    };
  }

  async create(userId: string, input: CreateCustomMcpInput): Promise<CustomMcpServer> {
    await this.validateRemoteUrl(input.url);
    const id = randomUUID();
    const credential = authorizationFor(input.authMode, input.credential);
    const encryptedCredentials = credential
      ? encryptCustomMcpCredential(credential, this.options.encryptionKey, { userId, serverId: id })
      : undefined;
    const now = this.options.now?.() ?? new Date();
    const pending = await this.options.db.createCustomMcpServer({
      id,
      userId,
      name: input.name,
      url: input.url,
      authMode: input.authMode,
      encryptedCredentials,
      pendingExpiresAt: new Date(now.getTime() + PENDING_TTL_MS),
    });

    try {
      await this.options.projection.upsert(userId, toProjection(pending));
    } catch (error) {
      console.error("[custom-mcp] initial projection failed:", error instanceof Error ? error.message : String(error));
      throw new CustomMcpBrokerError("upstream");
    }

    const status: CustomMcpStatus = input.authMode === "oauth" ? "auth_required" : "disabled";
    const activated = await this.options.db.updateCustomMcpServer(id, userId, pending.revision, {
      status,
      pendingExpiresAt: null,
    });
    if (!activated) throw new CustomMcpBrokerError("conflict");
    await this.projectOrMarkActionRequired(userId, activated);
    return activated;
  }

  async discover(userId: string, serverId: string): Promise<CustomMcpServer> {
    const row = await this.requirePrivate(userId, serverId);
    if (hasManagedSettingsClaim(row, this.options.encryptionKey)) throw new CustomMcpBrokerError("action_required");
    if (row.tools.length > MAX_CUSTOM_MCP_TOOLS) throw new CustomMcpBrokerError("invalid");
    const discovered = await this.client.discover({
      serverId,
      url: row.url,
      authorization: await this.readAuthorization(userId, row),
    });
    if (discovered.length > MAX_CUSTOM_MCP_TOOLS) throw new CustomMcpBrokerError("upstream");
    // This bounded lookup is discarded after this discovery request.
    const previous = new Map(row.tools.map((tool) => [tool.name, tool]));
    const tools = discovered.map((tool) => ({
      ...tool,
      enabled: previous.get(tool.name)?.enabled ?? true,
      approval: previous.get(tool.name)?.approval ?? "always_ask",
    }));
    // First discovery activates the server. Later discoveries preserve a
    // deliberate server disablement and each existing tool's policy.
    const enabled = tools.some((tool) => tool.enabled) && (row.discovered_at === null || row.enabled);
    const updated = await this.options.db.updateCustomMcpServer(serverId, userId, row.revision, {
      tools,
      status: enabled ? "ready" : "disabled",
      enabled,
      discoveredAt: this.options.now?.() ?? new Date(),
      actionRequiredReason: null,
    });
    if (!updated) throw new CustomMcpBrokerError("conflict");
    await this.projectOrMarkActionRequired(userId, updated);
    return updated;
  }

  async patch(userId: string, serverId: string, input: PatchCustomMcpInput): Promise<CustomMcpServer> {
    const row = await this.requirePrivate(userId, serverId);
    if (row.revision !== input.revision) throw new CustomMcpBrokerError("conflict");
    if (hasManagedSettingsClaim(row, this.options.encryptionKey)) throw new CustomMcpBrokerError("action_required");
    if (row.preset_id === "bokio") {
      // Bokio is a fixed REST integration, not an MCP server. Its OAuth state
      // owns readiness; the false MCP-enabled flag deliberately exposes no tools.
      if (input.enabled !== undefined || input.tools !== undefined) throw new CustomMcpBrokerError("invalid");
      const renamed = await this.options.db.updateCustomMcpServer(serverId, userId, input.revision, {
        ...(input.name !== undefined ? { name: input.name } : {}),
      });
      if (!renamed) throw new CustomMcpBrokerError("conflict");
      // Native REST reads use the platform row directly, never an MCP projection.
      return renamed;
    }
    if (row.tools.length > MAX_CUSTOM_MCP_TOOLS || (input.tools?.length ?? 0) > MAX_CUSTOM_MCP_TOOLS) {
      throw new CustomMcpBrokerError("invalid");
    }
    let tools: CustomMcpTool[] | undefined;
    if (input.tools) {
      const discovered = new Map(row.tools.map((tool) => [tool.name, tool]));
      const names = new Set<string>();
      tools = input.tools.map((selection) => {
        if (names.has(selection.name)) throw new CustomMcpBrokerError("invalid");
        names.add(selection.name);
        const tool = discovered.get(selection.name);
        if (!tool) throw new CustomMcpBrokerError("invalid");
        return { ...tool, enabled: selection.enabled, approval: selection.approval };
      });
      for (const tool of row.tools) {
        if (!names.has(tool.name)) tools.push({ ...tool, enabled: false, approval: "always_ask" });
      }
    }
    const enabled = input.enabled ?? row.enabled;
    if (enabled && !(tools ?? row.tools).some((tool) => tool.enabled)) {
      throw new CustomMcpBrokerError("invalid", "Select at least one tool before enabling the server");
    }
    const status: CustomMcpStatus = enabled ? "ready" : "disabled";
    const updated = await this.options.db.updateCustomMcpServer(serverId, userId, input.revision, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      enabled,
      status,
      ...(tools ? { tools } : {}),
    });
    if (!updated) throw new CustomMcpBrokerError("conflict");
    await this.projectOrMarkActionRequired(userId, updated);
    return updated;
  }

  async test(userId: string, serverId: string): Promise<{ ok: true; tools: number }> {
    const row = await this.requirePrivate(userId, serverId);
    const tools = await this.client.discover({
      serverId,
      url: row.url,
      authorization: await this.readAuthorization(userId, row),
    });
    return { ok: true, tools: tools.length };
  }

  async callTool(input: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    localProjection: CustomMcpServerProjection | null;
    approvalGranted?: boolean;
    approvalReceipt?: string;
    actorId?: string;
    runId?: string;
  }): Promise<unknown> {
    return this.executeTool(input);
  }

  private async executeTool(input: {
    userId: string; serverId: string; toolName: string;
    arguments?: Record<string, unknown>; localProjection: CustomMcpServerProjection | null;
    approvalGranted?: boolean; approvalReceipt?: string; actorId?: string; runId?: string;
  }, managedPresetId?: string): Promise<unknown> {
    if (input.approvalGranted === true) throw new CustomMcpBrokerError("forbidden");
    const row = await this.requirePrivate(input.userId, input.serverId);
    // Managed meta-tools may reach write APIs. Only the reviewed action planner
    // can invoke these rows; raw Custom MCP endpoints cannot bypass that planner.
    if (row.preset_id ? row.preset_id !== managedPresetId : managedPresetId !== undefined) {
      throw new CustomMcpBrokerError("forbidden");
    }
    if (!row.enabled || row.status !== "ready") throw new CustomMcpBrokerError("forbidden");
    const tool = row.enforcement_projection.find((candidate) => candidate.name === input.toolName);
    const localTool = input.localProjection?.tools.find((candidate) => candidate.name === input.toolName);
    if (!tool?.enabled
      || !localTool?.enabled
      || input.localProjection?.revision !== row.revision) {
      throw new CustomMcpBrokerError("forbidden");
    }
    if (tool.approval === "always_ask" || localTool.approval === "always_ask") {
      if (!input.actorId || !input.runId || !input.approvalReceipt) {
        throw new CustomMcpBrokerError("forbidden", "Tool approval is required");
      }
      let argsDigest: string;
      try { argsDigest = customMcpArgumentsDigest(input.arguments); }
      catch (error) {
        console.warn("[custom-mcp] invalid approval arguments:", error instanceof Error ? "error" : "non-error");
        throw new CustomMcpBrokerError("invalid");
      }
      const consumed = await this.options.db.consumeCustomMcpToolApproval({
        userId: input.userId, actorId: input.actorId, runId: input.runId,
        serverId: input.serverId, serverRevision: row.revision,
        toolName: input.toolName, argsDigest, receipt: input.approvalReceipt,
      });
      if (!consumed) throw new CustomMcpBrokerError("forbidden", "Tool approval is required");
    }
    const authorization = await this.readAuthorization(input.userId, row);
    // Authorization may rotate a token and await remote I/O. Owner policy is
    // authoritative again at dispatch, independently of credential settlement.
    const current = await this.requirePrivate(input.userId, row.id);
    if (current.revision !== row.revision || !current.enabled || current.status !== "ready") {
      throw new CustomMcpBrokerError("forbidden");
    }
    return this.client.callTool({
      serverId: row.id,
      url: row.url,
      authorization,
      toolName: input.toolName,
      arguments: input.arguments,
    });
  }

  async callSelectedTool(input: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    approvalGranted?: boolean;
    approvalReceipt?: string;
    actorId?: string;
    runId?: string;
  }): Promise<unknown> {
    const localProjection = this.options.projection.read
      ? await this.options.projection.read(input.userId, input.serverId)
      : null;
    return this.callTool({ ...input, localProjection });
  }

  async callManagedPresetTool(input: {
    userId: string; serverId: string; presetId: string; toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown> {
    const localProjection = this.options.projection.read
      ? await this.options.projection.read(input.userId, input.serverId) : null;
    return this.executeTool({ ...input, localProjection }, input.presetId);
  }

  async prepareToolApproval(input: {
    userId: string;
    actorId: string;
    runId: string;
    generation: number;
    nativeRequestId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<{ kind: "allow" } | { kind: "pending"; approvalId: string; expiresAt: string }> {
    const row = await this.requirePrivate(input.userId, input.serverId);
    const local = this.options.projection.read
      ? await this.options.projection.read(input.userId, input.serverId) : null;
    const tool = row.enforcement_projection.find((candidate) => candidate.name === input.toolName);
    const localTool = local?.tools.find((candidate) => candidate.name === input.toolName);
    if (!row.enabled || row.status !== "ready" || !tool?.enabled || !localTool?.enabled
      || local?.revision !== row.revision) throw new CustomMcpBrokerError("forbidden");
    let argsDigest: string;
    try { argsDigest = customMcpArgumentsDigest(input.arguments); }
    catch (error) {
      console.warn("[custom-mcp] invalid approval arguments:", error instanceof Error ? "error" : "non-error");
      throw new CustomMcpBrokerError("invalid");
    }
    if (tool.approval === "allow" && localTool.approval === "allow") return { kind: "allow" };
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const reserved = await this.options.db.reserveCustomMcpToolApproval({
      userId: input.userId, actorId: input.actorId, runId: input.runId,
      generation: input.generation,
      nativeRequestId: input.nativeRequestId, serverId: input.serverId,
      serverRevision: row.revision, toolName: input.toolName, argsDigest, expiresAt,
    });
    if (!reserved) throw new CustomMcpBrokerError("forbidden", "Tool approval is unavailable");
    return { kind: "pending", approvalId: reserved.approvalId,
      expiresAt: reserved.expiresAt.toISOString() };
  }

  async remove(userId: string, serverId: string): Promise<void> {
    return this.removeConnection(userId,serverId,false);
  }

  /** Platform deletion calls this only after all owner runtimes have been destroyed. */
  async removeForAccountDeletion(userId: string, serverId: string): Promise<void> {
    return this.removeConnection(userId,serverId,true);
  }

  private async removeConnection(userId: string, serverId: string, runtimeDestroyed: boolean): Promise<void> {
    const row = await this.requirePrivate(userId, serverId);
    if (row.user_id !== userId) throw new CustomMcpBrokerError("forbidden");
    if (row.preset_id && await this.options.removeManagedPreset?.(userId, row, runtimeDestroyed)) return;
    const credential = this.readCredential(userId, row);
    if (row.auth_mode === "oauth" && !credential.oauth?.removing
      && isCustomMcpRefreshClaimActive(credential.oauth, this.options.now?.() ?? new Date())) throw new CustomMcpRefreshPendingError();
    // Expired/crashed claims are never exchanged again here. Preserve their
    // stored grant for revocation, and retain it for an explicit retry on failure.
    const removalEncrypted = row.auth_mode === "oauth"
      ? encryptCustomMcpCredential({ ...credential, oauth: { ...credential.oauth, removing: true,
        refreshing: undefined, refreshStartedAt: undefined } }, this.options.encryptionKey, { userId, serverId })
      : row.encrypted_credentials;
    if (!await this.options.db.claimCustomMcpRemovalIfCurrent(serverId, userId, row.revision, row.encrypted_credentials, removalEncrypted)) {
      throw new CustomMcpBrokerError("conflict");
    }
    const disabledRevision = row.revision + 1;
    try {
      if (!runtimeDestroyed) await this.options.projection.remove(userId, serverId);
      if (row.auth_mode === "oauth") {
        const hasGrant = Boolean(credential.oauth?.refreshToken || credential.oauth?.accessToken);
        if (runtimeDestroyed && hasGrant && (!credential.oauth?.revocationEndpoint || !this.options.revokeOAuth)) {
          throw new CustomMcpBrokerError('action_required');
        }
        if (this.options.revokeOAuth) await this.options.revokeOAuth(credential);
      }
    } catch (error) {
      console.error("[custom-mcp] removal requires action:", error instanceof Error ? error.message : String(error));
      await this.options.db.updateCustomMcpServer(serverId, userId, disabledRevision, {
        status: "action_required",
        actionRequiredReason: "credential_revocation_failed",
      });
      throw new CustomMcpBrokerError("action_required");
    }
    if (!await this.options.db.deleteCustomMcpServerIfRevision(serverId, userId, disabledRevision)) {
      throw new CustomMcpBrokerError("conflict");
    }
  }

  private async requirePrivate(userId: string, serverId: string) {
    const row = await this.options.db.getCustomMcpServerForBroker(serverId, userId);
    if (!row) throw new CustomMcpBrokerError("not_found");
    return row;
  }

  private async validateRemoteUrl(url: string): Promise<void> {
    try {
      await (this.options.validateUrl ?? validateCustomMcpUrl)(url);
    } catch (validationError: unknown) {
      console.warn(
        "[custom-mcp] remote URL validation failed:",
        validationError instanceof Error ? validationError.message : String(validationError),
      );
      throw new CustomMcpBrokerError("invalid", "Custom MCP server URL is not allowed");
    }
  }

  private readCredential(
    userId: string,
    row: Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>> & {},
  ): CustomMcpCredential {
    if (!row.encrypted_credentials) return {};
    return decryptCustomMcpCredential<CustomMcpCredential>(
      row.encrypted_credentials,
      this.options.encryptionKey,
      { userId, serverId: row.id },
    );
  }

  private async readAuthorization(
    userId: string,
    row: Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>> & {},
  ): Promise<string | undefined> {
    if (row.auth_mode === "oauth" && this.options.resolveOAuthAuthorization) {
      return this.options.resolveOAuthAuthorization(userId, row);
    }
    const credential = this.readCredential(userId, row);
    if (credential.oauth?.removing) throw new CustomMcpBrokerError("action_required");
    if (credential.oauth?.accessToken) return `Bearer ${credential.oauth.accessToken}`;
    if (!credential.authorization) return undefined;
    if (credential.authorization.startsWith("X-API-Key ")) {
      // The HTTP client accepts a single authorization string today. Preserve
      // the mode marker so the request layer can translate it without ever
      // exposing the value to callers.
      return credential.authorization;
    }
    return credential.authorization;
  }

  private async projectOrMarkActionRequired(
    userId: string,
    server: CustomMcpServer,
  ): Promise<void> {
    try {
      await this.options.projection.upsert(userId, toProjection(server));
    } catch (error) {
      console.error("[custom-mcp] projection reconciliation failed:", error instanceof Error ? error.message : String(error));
      await this.options.db.updateCustomMcpServer(server.id, userId, server.revision, {
        enabled: false,
        status: "action_required",
        actionRequiredReason: "projection_reconciliation_failed",
      });
      throw new CustomMcpBrokerError("action_required");
    }
  }
}
