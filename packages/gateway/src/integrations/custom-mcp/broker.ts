import { randomUUID } from "node:crypto";
import type { PlatformDb } from "../../platform-db.js";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
} from "./crypto.js";
import { RemoteMcpClient } from "./client.js";
import { validateCustomMcpUrl } from "./security.js";
import type {
  CustomMcpApproval,
  CustomMcpAuthMode,
  CustomMcpServer,
  CustomMcpServerProjection,
  CustomMcpStatus,
  CustomMcpTool,
} from "./types.js";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
    redirectUri?: string;
    scopes?: string[];
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
  }): Promise<NonNullable<Awaited<ReturnType<PlatformDb["getCustomMcpServerForBroker"]>>>> {
    let row = await this.options.db.getCustomMcpPresetForBroker(input.presetId, input.userId);
    if (!row) throw new CustomMcpBrokerError("not_found");
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
    const tools = await this.client.discover({
      serverId,
      url: row.url,
      authorization: await this.readAuthorization(userId, row),
    });
    const updated = await this.options.db.updateCustomMcpServer(serverId, userId, row.revision, {
      tools,
      status: "disabled",
      enabled: false,
      actionRequiredReason: null,
    });
    if (!updated) throw new CustomMcpBrokerError("conflict");
    await this.projectOrMarkActionRequired(userId, updated);
    return updated;
  }

  async patch(userId: string, serverId: string, input: PatchCustomMcpInput): Promise<CustomMcpServer> {
    const row = await this.requirePrivate(userId, serverId);
    if (row.revision !== input.revision) throw new CustomMcpBrokerError("conflict");
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
    approvalGranted: boolean;
  }): Promise<unknown> {
    const row = await this.requirePrivate(input.userId, input.serverId);
    if (!row.enabled || row.status !== "ready") throw new CustomMcpBrokerError("forbidden");
    const tool = row.enforcement_projection.find((candidate) => candidate.name === input.toolName);
    const localTool = input.localProjection?.tools.find((candidate) => candidate.name === input.toolName);
    if (!tool?.enabled
      || !localTool?.enabled
      || input.localProjection?.revision !== row.revision) {
      throw new CustomMcpBrokerError("forbidden");
    }
    if ((tool.approval === "always_ask" || localTool.approval === "always_ask")
      && !input.approvalGranted) {
      throw new CustomMcpBrokerError("forbidden", "Tool approval is required");
    }
    return this.client.callTool({
      serverId: row.id,
      url: row.url,
      authorization: await this.readAuthorization(input.userId, row),
      toolName: input.toolName,
      arguments: input.arguments,
    });
  }

  async callSelectedTool(input: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    approvalGranted: boolean;
  }): Promise<unknown> {
    const localProjection = this.options.projection.read
      ? await this.options.projection.read(input.userId, input.serverId)
      : null;
    return this.callTool({ ...input, localProjection });
  }

  async remove(userId: string, serverId: string): Promise<void> {
    const row = await this.requirePrivate(userId, serverId);
    const disabled = await this.options.db.updateCustomMcpServer(serverId, userId, row.revision, {
      enabled: false,
      status: "disabled",
    });
    if (!disabled) throw new CustomMcpBrokerError("conflict");
    try {
      await this.options.projection.remove(userId, serverId);
      if (row.auth_mode === "oauth" && this.options.revokeOAuth) {
        const credential = this.readCredential(userId, row);
        await this.options.revokeOAuth(credential);
      }
    } catch (error) {
      console.error("[custom-mcp] removal requires action:", error instanceof Error ? error.message : String(error));
      await this.options.db.updateCustomMcpServer(serverId, userId, disabled.revision, {
        status: "action_required",
        actionRequiredReason: "credential_revocation_failed",
      });
      throw new CustomMcpBrokerError("action_required");
    }
    if (!await this.options.db.deleteCustomMcpServer(serverId, userId)) {
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
