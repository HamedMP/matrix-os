import { z } from "zod/v4";
import type { PlatformDb, GitHubOAuthConnectionsTable } from "../platform-db.js";
import type { ServiceAction } from "./types.js";
import {
  decryptGitHubCredential,
  decryptGitHubOAuthState,
  encryptGitHubCredential,
} from "./github-credential-crypto.js";
import {
  createGitHubAuthorizationRequest,
  executeGitHubIntegrationAction,
  GITHUB_REQUIRED_SCOPES,
  GitHubApiError,
  type GitHubOAuthCredential,
} from "./github-oauth.js";

const REFRESH_EARLY_MS = 60_000;
const STATE_MAX_LENGTH = 8_192;
const CODE_MAX_LENGTH = 512;

const StateSchema = z.object({
  userId: z.uuid(),
  label: z.string().trim().min(1).max(100).optional(),
  redirectTarget: z.enum(["web", "mobile"]),
  codeVerifier: z.string().min(43).max(128).regex(/^[A-Za-z0-9_-]+$/),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
const CredentialSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  scopes: z.array(z.string().min(1).max(128)).max(32),
  expiresAt: z.iso.datetime().optional(),
  refreshTokenExpiresAt: z.iso.datetime().optional(),
});

export interface GitHubProviderClient {
  exchangeCode(code: string, codeVerifier: string): Promise<GitHubOAuthCredential>;
  refreshAccessToken(refreshToken: string): Promise<GitHubOAuthCredential>;
  getViewer(accessToken: string): Promise<{ id: string; login: string; email: string | null }>;
  revokeToken(accessToken: string): Promise<void>;
  requestApi(input: {
    accessToken: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Readonly<Record<string, string>>;
  }): Promise<unknown>;
}

export class GitHubIntegrationError extends Error {
  constructor(readonly code: "authorization_failed" | "not_connected" | "conflict" | "provider_unavailable") {
    super("GitHub integration unavailable");
    this.name = "GitHubIntegrationError";
  }
}

function hasExactRequiredScopes(scopes: readonly string[]): boolean {
  const normalized = new Set(scopes);
  return normalized.size === GITHUB_REQUIRED_SCOPES.length
    && GITHUB_REQUIRED_SCOPES.every((scope) => normalized.has(scope));
}

function publicConnection(row: GitHubOAuthConnectionsTable) {
  return {
    id: row.id,
    service: "github",
    account_label: row.account_label,
    account_email: row.account_email,
    scopes: row.scopes,
    status: row.status,
    connected_at: row.connected_at,
    last_used_at: row.last_used_at,
  };
}

export class GitHubIntegrationBroker {
  private readonly now: () => Date;

  constructor(private readonly options: {
    db: PlatformDb;
    client: GitHubProviderClient;
    clientId: string;
    callbackUrl: string;
    encryptionKey: Buffer;
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  start(userId: string, input: { label?: string; redirectTarget: "web" | "mobile" }): string {
    const parsed = z.uuid().safeParse(userId);
    const label = input.label === undefined ? undefined : z.string().trim().min(1).max(100).parse(input.label);
    if (!parsed.success) throw new GitHubIntegrationError("authorization_failed");
    return createGitHubAuthorizationRequest({
      clientId: this.options.clientId,
      callbackUrl: this.options.callbackUrl,
      encryptionKey: this.options.encryptionKey,
      userId: parsed.data,
      ...(label ? { label } : {}),
      redirectTarget: input.redirectTarget,
      now: this.now(),
      ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
    }).url;
  }

  resolveRedirectTarget(stateValue: string): "web" | "mobile" {
    return this.readState(stateValue).redirectTarget;
  }

  async complete(stateValue: string, codeValue: string): Promise<{
    redirectTarget: "web" | "mobile";
    connection: ReturnType<typeof publicConnection>;
  }> {
    if (codeValue.length > CODE_MAX_LENGTH) {
      throw new GitHubIntegrationError("authorization_failed");
    }
    const state = this.readState(stateValue);

    let credential: GitHubOAuthCredential;
    try {
      credential = CredentialSchema.parse(await this.options.client.exchangeCode(codeValue, state.codeVerifier));
    } catch {
      throw new GitHubIntegrationError("authorization_failed");
    }
    if (!hasExactRequiredScopes(credential.scopes)) {
      await this.bestEffortRevoke(credential.accessToken);
      throw new GitHubIntegrationError("authorization_failed");
    }

    try {
      const viewer = await this.options.client.getViewer(credential.accessToken);
      const encryptedCredentials = encryptGitHubCredential(credential, this.options.encryptionKey, {
        userId: state.userId,
        githubUserId: viewer.id,
      });
      const row = await this.options.db.connectGitHubService({
        userId: state.userId,
        githubUserId: viewer.id,
        login: viewer.login,
        accountLabel: state.label ?? viewer.login,
        accountEmail: viewer.email,
        scopes: credential.scopes,
        encryptedCredentials,
      });
      return { redirectTarget: state.redirectTarget, connection: publicConnection(row) };
    } catch (error) {
      await this.bestEffortRevoke(credential.accessToken);
      if (error instanceof GitHubIntegrationError) throw error;
      throw new GitHubIntegrationError("provider_unavailable");
    }
  }

  async listConnections(userId: string): Promise<Array<ReturnType<typeof publicConnection>>> {
    return (await this.options.db.listGitHubConnections(userId)).map(publicConnection);
  }

  async call(input: {
    userId: string;
    connectionId?: string;
    action: ServiceAction;
    params?: Record<string, unknown>;
  }): Promise<{ data: unknown }> {
    const rows = (await this.options.db.listGitHubConnections(input.userId)).filter((row) => row.status === "active");
    const row = input.connectionId ? rows.find((item) => item.id === input.connectionId) : rows[0];
    if (!row) throw new GitHubIntegrationError("not_connected");
    let credential: z.infer<typeof CredentialSchema>;
    try {
      credential = CredentialSchema.parse(decryptGitHubCredential(row.encrypted_credentials, this.options.encryptionKey, {
        userId: row.user_id,
        githubUserId: row.github_user_id,
      }));
    } catch {
      await this.options.db.markGitHubConnectionExpiredIfCurrent(row.id, row.user_id, row.revision, row.encrypted_credentials);
      throw new GitHubIntegrationError("authorization_failed");
    }

    if (credential.expiresAt && Date.parse(credential.expiresAt) <= this.now().getTime() + REFRESH_EARLY_MS) {
      credential = await this.refresh(row, credential);
    }
    try {
      const result = await executeGitHubIntegrationAction({
        client: this.options.client,
        accessToken: credential.accessToken,
        action: input.action,
        params: input.params,
      });
      await this.options.db.touchGitHubConnectionUsage(row.id, row.user_id);
      return result;
    } catch (error) {
      if (error instanceof GitHubApiError && error.kind === "unauthorized") {
        await this.options.db.markGitHubConnectionExpiredIfCurrent(row.id, row.user_id, row.revision, row.encrypted_credentials);
      }
      throw new GitHubIntegrationError(error instanceof GitHubApiError && error.kind === "unauthorized"
        ? "authorization_failed" : "provider_unavailable");
    }
  }

  async disconnect(userId: string, connectionId: string): Promise<boolean> {
    const existing = await this.options.db.getGitHubConnection(connectionId);
    if (!existing || existing.user_id !== userId) return false;
    let credential: z.infer<typeof CredentialSchema>;
    try {
      credential = CredentialSchema.parse(decryptGitHubCredential(existing.encrypted_credentials, this.options.encryptionKey, {
        userId: existing.user_id,
        githubUserId: existing.github_user_id,
      }));
    } catch {
      throw new GitHubIntegrationError("authorization_failed");
    }
    const claimed = existing.status === "revocation_pending"
      ? existing
      : await this.options.db.claimGitHubConnectionRevocation(
        existing.id, existing.user_id, existing.revision, existing.encrypted_credentials,
      );
    if (!claimed) throw new GitHubIntegrationError("conflict");
    try {
      await this.options.client.revokeToken(credential.accessToken);
    } catch {
      throw new GitHubIntegrationError("provider_unavailable");
    }
    if (!await this.options.db.deleteGitHubConnectionIfClaimed(
      claimed.id, claimed.user_id, claimed.revision, claimed.encrypted_credentials,
    )) throw new GitHubIntegrationError("conflict");
    return true;
  }

  async rename(userId: string, connectionId: string,
    labelValue: string): Promise<ReturnType<typeof publicConnection>> {
    const label = z.string().trim().min(1).max(100).parse(labelValue);
    const row = await this.options.db.updateGitHubAccountLabel(connectionId, userId, label);
    if (!row) throw new GitHubIntegrationError("not_connected");
    return publicConnection(row);
  }

  async refreshConnection(userId: string,
    connectionId: string): Promise<ReturnType<typeof publicConnection>> {
    const row = await this.options.db.getGitHubConnection(connectionId);
    if (!row || row.user_id !== userId || row.status !== "active") {
      throw new GitHubIntegrationError("not_connected");
    }
    let credential: z.infer<typeof CredentialSchema>;
    try {
      credential = CredentialSchema.parse(decryptGitHubCredential(
        row.encrypted_credentials,
        this.options.encryptionKey,
        { userId: row.user_id, githubUserId: row.github_user_id },
      ));
    } catch {
      await this.options.db.markGitHubConnectionExpiredIfCurrent(
        row.id, row.user_id, row.revision, row.encrypted_credentials,
      );
      throw new GitHubIntegrationError("authorization_failed");
    }
    if (!credential.refreshToken) return publicConnection(row);
    await this.refresh(row, credential);
    const refreshed = await this.options.db.getGitHubConnection(connectionId);
    if (!refreshed || refreshed.user_id !== userId || refreshed.status !== "active") {
      throw new GitHubIntegrationError("conflict");
    }
    return publicConnection(refreshed);
  }

  private readState(stateValue: string): z.infer<typeof StateSchema> {
    if (stateValue.length > STATE_MAX_LENGTH) throw new GitHubIntegrationError("authorization_failed");
    let state: z.infer<typeof StateSchema>;
    try {
      state = StateSchema.parse(decryptGitHubOAuthState(stateValue, this.options.encryptionKey));
    } catch {
      throw new GitHubIntegrationError("authorization_failed");
    }
    const now = this.now().getTime();
    const issuedAt = Date.parse(state.issuedAt);
    const expiresAt = Date.parse(state.expiresAt);
    if (issuedAt > now + 60_000 || expiresAt <= now || expiresAt - issuedAt > 10 * 60_000) {
      throw new GitHubIntegrationError("authorization_failed");
    }
    return state;
  }

  private async refresh(row: GitHubOAuthConnectionsTable,
    current: z.infer<typeof CredentialSchema>): Promise<z.infer<typeof CredentialSchema>> {
    if (!current.refreshToken || (current.refreshTokenExpiresAt
      && Date.parse(current.refreshTokenExpiresAt) <= this.now().getTime())) {
      await this.options.db.markGitHubConnectionExpiredIfCurrent(row.id, row.user_id, row.revision, row.encrypted_credentials);
      throw new GitHubIntegrationError("authorization_failed");
    }
    let next: z.infer<typeof CredentialSchema>;
    try {
      next = CredentialSchema.parse(await this.options.client.refreshAccessToken(current.refreshToken));
    } catch {
      await this.options.db.markGitHubConnectionExpiredIfCurrent(row.id, row.user_id, row.revision, row.encrypted_credentials);
      throw new GitHubIntegrationError("authorization_failed");
    }
    if (!hasExactRequiredScopes(next.scopes)) {
      await this.bestEffortRevoke(next.accessToken);
      await this.options.db.markGitHubConnectionExpiredIfCurrent(row.id, row.user_id, row.revision, row.encrypted_credentials);
      throw new GitHubIntegrationError("authorization_failed");
    }
    const encrypted = encryptGitHubCredential(next, this.options.encryptionKey, {
      userId: row.user_id,
      githubUserId: row.github_user_id,
    });
    if (!await this.options.db.updateGitHubCredentialsIfCurrent(
      row.id, row.user_id, row.revision, row.encrypted_credentials, encrypted,
    )) throw new GitHubIntegrationError("conflict");
    row.encrypted_credentials = encrypted;
    return next;
  }

  private async bestEffortRevoke(accessToken: string): Promise<void> {
    try {
      await this.options.client.revokeToken(accessToken);
    } catch (error) {
      console.warn("[github-integration] Token cleanup failed:", error instanceof Error ? error.name : typeof error);
    }
  }
}
