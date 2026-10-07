import type { PlatformDb, CustomMcpServerBrokerRow } from "../../platform-db.js";
import { decryptCustomMcpCredential, encryptCustomMcpCredential } from "./crypto.js";
import { CustomMcpBrokerError, CustomMcpRefreshPendingError, isCustomMcpRefreshClaimActive, type CustomMcpCredential } from "./broker.js";
export { CustomMcpRefreshPendingError } from "./broker.js";
const validToken = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value);
interface Token { access_token: string; refresh_token?: string; expires_in?: number; token_type: string }

export async function resolveCustomMcpOAuthAuthorization(options: {
  db: PlatformDb; encryptionKey: Buffer; userId: string; row: CustomMcpServerBrokerRow; now: Date; configuredClientId?: string;
  exchangeToken(endpoint: string, fields: Record<string, string>): Promise<Token>;
}): Promise<string | undefined> {
  const { db, encryptionKey, userId, row: selected, now } = options;
  if (selected.user_id !== userId) throw new CustomMcpBrokerError("forbidden");
  if (selected.auth_mode !== "oauth") return undefined;
  const row = await db.getCustomMcpServerForBroker(selected.id, userId);
  if (!row || row.user_id !== userId) throw new CustomMcpBrokerError("not_found");
  if (row.revision !== selected.revision || row.url !== selected.url || row.auth_mode !== "oauth") throw new CustomMcpBrokerError("conflict");
  if (!row.encrypted_credentials || !["ready", "disabled", "degraded"].includes(row.status)) throw new CustomMcpBrokerError("action_required");
  let credential: CustomMcpCredential;
  try { credential = decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials, encryptionKey, { userId, serverId: row.id }); }
  catch (error: unknown) { throw new CustomMcpBrokerError("action_required"); }
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new CustomMcpBrokerError("action_required");
  const oauth = credential.oauth;
  if (!oauth || typeof oauth !== "object" || oauth.removing || !validToken(oauth.accessToken) || oauth.state) throw new CustomMcpBrokerError("action_required");
  const encrypt = (next: CustomMcpCredential) => encryptCustomMcpCredential(next, encryptionKey, { userId, serverId: row.id });
  const cas = (expected: string, encrypted: string, status = row.status) => db.updateCustomMcpCredentialsIfCurrent(row.id, userId, row.revision, expected, encrypted, status);
  const unavailable: CustomMcpCredential = { ...credential, oauth: { ...oauth, accessToken: undefined, refreshing: undefined, refreshStartedAt: undefined } };
  if (oauth.refreshing) {
    if (isCustomMcpRefreshClaimActive(oauth, now)) throw new CustomMcpRefreshPendingError();
    if (!await cas(row.encrypted_credentials, encrypt(unavailable), "action_required")) throw new CustomMcpBrokerError("conflict");
    throw new CustomMcpBrokerError("action_required");
  }
  if (oauth.expiresAt !== undefined && typeof oauth.expiresAt !== "string") throw new CustomMcpBrokerError("action_required");
  const expiresAt = oauth.expiresAt === undefined ? undefined : Date.parse(oauth.expiresAt);
  if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new CustomMcpBrokerError("action_required");
  if (expiresAt === undefined || expiresAt > now.getTime() + 30_000) return `Bearer ${oauth.accessToken}`;
  if (!validToken(oauth.refreshToken) || !oauth.tokenEndpoint || !oauth.resource) throw new CustomMcpBrokerError("action_required");
  const clientId = oauth.clientId ?? options.configuredClientId;
  if (!clientId) throw new CustomMcpBrokerError("action_required");
  const claim = encrypt({ ...credential, oauth: { ...oauth, refreshing: true, refreshStartedAt: now.toISOString() } });
  if (!await cas(row.encrypted_credentials, claim)) throw new CustomMcpRefreshPendingError();
  try {
    const token = await options.exchangeToken(oauth.tokenEndpoint, { grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: clientId, resource: oauth.resource });
    const next = encrypt({ ...credential, oauth: { ...oauth, accessToken: token.access_token, refreshToken: token.refresh_token ?? oauth.refreshToken,
      expiresAt: token.expires_in ? new Date(now.getTime() + token.expires_in * 1000).toISOString() : undefined,
      refreshing: undefined, refreshStartedAt: undefined } });
    if (!await cas(claim, next)) throw new CustomMcpBrokerError("conflict");
    return `Bearer ${token.access_token}`;
  } catch (error: unknown) {
    if (error instanceof CustomMcpBrokerError && error.code === "conflict") throw error;
    // Network failure may mean the refresh token was already consumed. Never
    // automatically repeat it or replace a more recent reconnect's ciphertext.
    const persisted = await cas(claim, encrypt(unavailable), "action_required");
    console.warn("[custom-mcp/oauth] refresh failed", { errorName: error instanceof Error ? error.name : "UnknownError", credentialChanged: !persisted });
    if (!persisted) throw new CustomMcpBrokerError("conflict");
    throw new CustomMcpBrokerError("action_required");
  }
}
