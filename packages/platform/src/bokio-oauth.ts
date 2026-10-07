import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { BOKIO_PRESET, BOKIO_READ_SCOPES, BokioIntegrationError, BokioUuid, requestBokio } from "./bokio-integration.js";

export interface BokioCredentialRow {
  id: string; user_id: string; preset_id: string | null; url: string; auth_mode: string; status: string; revision: number;
  encrypted_credentials: string | null; created_at: Date | string;
}
export interface BokioCredentialStore {
  getCustomMcpServerForBroker(id: string, userId: string): Promise<BokioCredentialRow | null>;
  getCustomMcpPresetForBroker(presetId: string, userId: string): Promise<BokioCredentialRow | null>;
  updateCustomMcpServer(id: string, userId: string, revision: number, update: { encryptedCredentials?: string; status?: "auth_required" | "ready" | "action_required"; enabled?: boolean; pendingExpiresAt?: Date | null }): Promise<{ id: string; revision: number } | null>;
  createCustomMcpServer(input: { id: string; userId: string; presetId: string; name: string; url: string; authMode: "oauth"; pendingExpiresAt: Date }): Promise<{ id: string; revision: number }>;
  deleteCustomMcpServer(id: string, userId: string): Promise<boolean>;
  deleteCustomMcpServerIfRevision?(id: string, userId: string, revision: number): Promise<boolean>;
}
export interface BokioCredentialCrypto {
  encryptCustomMcpCredential(credential: unknown, key: Buffer, binding: { userId: string; serverId: string }): string;
  decryptCustomMcpCredential<T>(value: string, key: Buffer, binding: { userId: string; serverId: string }): T;
  encryptCustomMcpOAuthState(payload: unknown, key: Buffer): string;
  decryptCustomMcpOAuthState<T>(value: string, key: Buffer): T;
}
const text = z.string().min(1).max(8192).regex(/^[^\s\x00-\x1f\x7f]+$/);
const credentialSchema = z.strictObject({
  kind: z.literal("bokio"), companyId: BokioUuid.optional(), connectionId: BokioUuid.optional(),
  accessToken: text.optional(), refreshToken: text.optional(), expiresAt: z.iso.datetime().optional(),
  state: text.optional(), stateExpiresAt: z.iso.datetime().optional(), refreshing: z.boolean().optional(), authorizing: z.boolean().optional(),
  removingAt: z.iso.datetime().optional(), removalFailed: z.boolean().optional(),
});
type Credential = z.infer<typeof credentialSchema>;
const tokenSchema = z.object({ tenant_id: BokioUuid, tenant_type: z.literal("company"), access_token: text, token_type: z.string().regex(/^bearer$/i), expires_in: z.number().int().min(1).max(86400), refresh_token: text, connection_id: BokioUuid.optional() });
const stateSchema = z.strictObject({ kind: z.literal("bokio"), userId: z.string().min(1).max(128), serverId: z.string().min(1).max(128) });

/** Uses the platform's encrypted credential store; never projects REST tokens as MCP tools. */
export class BokioOAuthManager {
  readonly configured: boolean;
  private readonly redirectUri: string | undefined;
  constructor(private readonly options: {
    db: BokioCredentialStore; encryptionKey: Buffer; credentialCrypto?: BokioCredentialCrypto;
    clientId?: string; clientSecret?: string; redirectUri?: string; fetcher?: typeof fetch; now?: () => Date;
  }) {
    this.configured = Boolean(options.clientId && options.clientSecret && options.redirectUri && options.credentialCrypto);
    if (this.configured) {
      BokioUuid.parse(options.clientId);
      if (options.clientSecret!.length > 8192 || /[\r\n]/.test(options.clientSecret!)) throw new BokioIntegrationError("invalid");
      const redirect = new URL(options.redirectUri!);
      if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash || redirect.search) throw new BokioIntegrationError("invalid");
      if (options.encryptionKey.length !== 32) throw new BokioIntegrationError("invalid");
      this.redirectUri = redirect.href;
    }
  }
  async start(userId: string, serverId: string): Promise<string> {
    this.requireConfigured(); const row = await this.requireRow(userId, serverId);
    const old = this.decrypt(row);
    if (old.removingAt) throw new BokioIntegrationError("action_required");
    const state = this.options.credentialCrypto!.encryptCustomMcpOAuthState({ kind: "bokio", userId, serverId }, this.options.encryptionKey);
    const credential: Credential = { kind: "bokio", ...(old.companyId ? { companyId: old.companyId } : {}), ...(old.connectionId ? { connectionId: old.connectionId } : {}), state, stateExpiresAt: new Date(this.now().getTime() + 10 * 60 * 1000).toISOString() };
    await this.persist(row, credential, "auth_required");
    const url = new URL(`${BOKIO_PRESET.url}/authorize`);
    url.searchParams.set("client_id", this.options.clientId!); url.searchParams.set("redirect_uri", this.redirectUri!);
    url.searchParams.set("response_type", "code"); url.searchParams.set("state", state); url.searchParams.set("scope", BOKIO_READ_SCOPES.join(" "));
    if (old.companyId) { url.searchParams.set("bokio_tenantid", old.companyId); url.searchParams.set("bokio_tenanttype", "company"); }
    return url.href;
  }
  async complete(state: string, code: string): Promise<{ serverId: string }> {
    this.requireConfigured();
    let binding: z.infer<typeof stateSchema>;
    try { text.parse(state); text.parse(code); binding = stateSchema.parse(this.options.credentialCrypto!.decryptCustomMcpOAuthState(state, this.options.encryptionKey)); }
    catch (error: unknown) { throw new BokioIntegrationError("invalid"); }
    const row = await this.requireRow(binding.userId, binding.serverId); const old = this.decrypt(row);
    const a = Buffer.from(old.state ?? ""); const b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b) || !old.stateExpiresAt || Date.parse(old.stateExpiresAt) <= this.now().getTime()) throw new BokioIntegrationError("invalid");
    // Claim before contacting Bokio; no replay or simultaneous token exchange.
    const claimedCredential: Credential = { ...old, state: undefined, stateExpiresAt: undefined, authorizing: true };
    const revision = await this.persist(row, claimedCredential, "auth_required");
    const token = await this.exchange({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri! });
    if (old.companyId && old.companyId !== token.tenant_id) throw new BokioIntegrationError("invalid");
    await this.persist({ ...row, revision }, this.fromToken(token), "ready");
    return { serverId: row.id };
  }
  async resolveAuthorization(userId: string, suppliedRow: BokioCredentialRow): Promise<{ authorization: string; companyId: string }> {
    this.requireConfigured(); const row = await this.requireRow(userId, suppliedRow.id); const old = this.decrypt(row);
    if (row.status !== "ready" || old.refreshing || old.removingAt || !old.companyId || !old.accessToken || !old.expiresAt) throw new BokioIntegrationError("action_required");
    if (Date.parse(old.expiresAt) > this.now().getTime() + 30_000) return { authorization: `Bearer ${old.accessToken}`, companyId: old.companyId };
    if (!old.refreshToken) throw new BokioIntegrationError("action_required");
    const revision = await this.persist(row, { ...old, refreshing: true }, "ready");
    try {
      const token = await this.exchange({ grant_type: "refresh_token", refresh_token: old.refreshToken });
      if (token.tenant_id !== old.companyId || (token.connection_id && old.connectionId && token.connection_id !== old.connectionId)) throw new BokioIntegrationError("invalid");
      await this.persist({ ...row, revision }, { ...this.fromToken(token), connectionId: token.connection_id ?? old.connectionId }, "ready");
      return { authorization: `Bearer ${token.access_token}`, companyId: old.companyId };
    } catch (error: unknown) {
      // A timed out refresh may already have consumed the rotating token. Require
      // explicit reconnection instead of retrying or overwriting concurrent auth.
      await this.persist({ ...row, revision }, { kind: "bokio", companyId: old.companyId, connectionId: old.connectionId }, "action_required").catch((persistError: unknown) => console.warn("[bokio] refresh recovery changed concurrently", { errorName: persistError instanceof Error ? persistError.name : "UnknownError" }));
      throw new BokioIntegrationError("action_required");
    }
  }
  async disconnect(userId: string, selected: BokioCredentialRow): Promise<void> {
    this.requireConfigured();
    if (!this.options.db.deleteCustomMcpServerIfRevision) throw new BokioIntegrationError("action_required");
    const row = await this.requireRow(userId, selected.id); const old = this.decrypt(row);
    if (row.revision !== selected.revision) throw new BokioIntegrationError("conflict");
    // Each external request has a 10s total deadline. A 30s lease blocks duplicate
    // revocation while permitting explicit recovery after a crashed process.
    if (old.refreshing || old.authorizing || (old.removingAt && !old.removalFailed && this.now().getTime() - Date.parse(old.removingAt) < 30_000)) throw new BokioIntegrationError("action_required");
    const claimed: Credential = { ...old, state: undefined, stateExpiresAt: undefined,
      removingAt: this.now().toISOString(), removalFailed: false };
    const revision = await this.persist(row, claimed, "action_required");
    try {
      await this.revokeGrant(old, row.status === "auth_required");
      if (!await this.options.db.deleteCustomMcpServerIfRevision(row.id, userId, revision)) throw new BokioIntegrationError("conflict");
    } catch (error: unknown) {
      // Do not reactivate a possibly revoked grant. Keep its encrypted evidence
      // so an explicit disconnect retry can finish the same connection removal.
      await this.persist({ ...row, revision }, { ...claimed, removalFailed: true }, "action_required")
        .catch((persistError: unknown) => console.warn("[bokio] removal recovery changed concurrently", { errorName: persistError instanceof Error ? persistError.name : "UnknownError" }));
      throw error instanceof BokioIntegrationError ? error : new BokioIntegrationError("upstream");
    }
  }
  private async revokeGrant(credential: Credential, incomplete: boolean): Promise<void> {
    if (!credential.connectionId) { if (incomplete) return; throw new BokioIntegrationError("action_required"); }
    const response = await this.tokenRequest({ grant_type: "client_credentials" });
    const token = z.object({ access_token: text, token_type: z.string().regex(/^bearer$/i), tenant_type: z.string().regex(/^general$/i) }).parse(response);
    await requestBokio({ url: `${BOKIO_PRESET.url}/connections/${credential.connectionId}`, method: "DELETE", headers: { Authorization: `Bearer ${token.access_token}` }, maxBytes: 64 * 1024, fetcher: this.options.fetcher });
  }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private requireConfigured(): void { if (!this.configured) throw new BokioIntegrationError("action_required"); }
  private async requireRow(userId: string, serverId: string): Promise<BokioCredentialRow> {
    const row = await this.options.db.getCustomMcpServerForBroker(serverId, userId);
    if (!row || row.user_id !== userId || row.preset_id !== BOKIO_PRESET.id || row.auth_mode !== "oauth" || row.url !== BOKIO_PRESET.url) throw new BokioIntegrationError("not_found");
    return row;
  }
  private decrypt(row: BokioCredentialRow): Credential {
    if (!row.encrypted_credentials) return { kind: "bokio" };
    try { return credentialSchema.parse(this.options.credentialCrypto!.decryptCustomMcpCredential(row.encrypted_credentials, this.options.encryptionKey, { userId: row.user_id, serverId: row.id })); }
    catch (error: unknown) { throw new BokioIntegrationError("action_required"); }
  }
  private async persist(row: BokioCredentialRow, credential: Credential, status: "auth_required" | "ready" | "action_required"): Promise<number> {
    const encrypted = this.options.credentialCrypto!.encryptCustomMcpCredential(credential, this.options.encryptionKey, { userId: row.user_id, serverId: row.id });
    const result = await this.options.db.updateCustomMcpServer(row.id, row.user_id, row.revision, { encryptedCredentials: encrypted, status, enabled: false, pendingExpiresAt: null });
    if (!result) throw new BokioIntegrationError("conflict"); return result.revision;
  }
  private async tokenRequest(fields: Record<string, string>): Promise<unknown> {
    return requestBokio({ url: `${BOKIO_PRESET.url}/token`, method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), maxBytes: 64 * 1024, fetcher: this.options.fetcher });
  }
  private async exchange(fields: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    try { return tokenSchema.parse(await this.tokenRequest(fields)); }
    catch (error: unknown) { throw new BokioIntegrationError("upstream"); }
  }
  private fromToken(token: z.infer<typeof tokenSchema>): Credential {
    return { kind: "bokio", companyId: token.tenant_id, connectionId: token.connection_id, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: new Date(this.now().getTime() + token.expires_in * 1000).toISOString() };
  }
}
