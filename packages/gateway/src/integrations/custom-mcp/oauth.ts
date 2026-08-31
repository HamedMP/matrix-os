import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { PlatformDb, CustomMcpServerBrokerRow } from "../../platform-db.js";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
} from "./crypto.js";
import { validateCustomMcpUrl } from "./security.js";
import { CustomMcpBrokerError, type CustomMcpCredential } from "./broker.js";

const OAUTH_TIMEOUT_MS = 10_000;
const OAUTH_RESPONSE_LIMIT = 64 * 1024;
const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function pinnedRequest(input: {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: unknown }> {
  const target = await validateCustomMcpUrl(input.url);
  const lookup: LookupFunction = ((_hostname, _options, callback) => {
    callback(null, target.address, target.family);
  }) as LookupFunction;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.body ? { "content-length": String(Buffer.byteLength(input.body)) } : {}),
        ...input.headers,
      },
      lookup,
      servername: target.url.hostname,
      timeout: OAUTH_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new Error("OAuth redirects are not allowed during discovery or token exchange"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > OAUTH_RESPONSE_LIMIT) {
          response.destroy(new Error("OAuth response limit exceeded"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status, body: raw ? JSON.parse(raw) : undefined });
        } catch (parseError: unknown) {
          console.warn(
            "[custom-mcp/oauth] response parse failed:",
            parseError instanceof Error ? parseError.message : String(parseError),
          );
          reject(new Error("OAuth server returned invalid JSON"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("OAuth request timed out")));
    request.on("error", reject);
    request.end(input.body);
  });
}

function exactStateMatch(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function protectedResourceMetadataUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `/.well-known/oauth-protected-resource${suffix}`;
  url.search = "";
  return url.href;
}

function authorizationMetadataUrl(server: string): string {
  const url = new URL(server);
  url.pathname = "/.well-known/oauth-authorization-server";
  url.search = "";
  url.hash = "";
  return url.href;
}

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OAuth metadata is invalid");
  }
  return value as Record<string, unknown>;
}

function parseProtectedMetadata(value: unknown): ProtectedResourceMetadata {
  const object = assertObject(value);
  if (typeof object.resource !== "string"
    || !Array.isArray(object.authorization_servers)
    || !object.authorization_servers.every((entry) => typeof entry === "string")
    || object.authorization_servers.length < 1) {
    throw new Error("OAuth protected resource metadata is invalid");
  }
  return object as unknown as ProtectedResourceMetadata;
}

function parseOAuthMetadata(value: unknown): OAuthMetadata {
  const object = assertObject(value);
  if (typeof object.authorization_endpoint !== "string" || typeof object.token_endpoint !== "string") {
    throw new Error("OAuth authorization server metadata is invalid");
  }
  if (Array.isArray(object.code_challenge_methods_supported)
    && !object.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OAuth server does not support PKCE S256");
  }
  return object as unknown as OAuthMetadata;
}

export class CustomMcpOAuthManager {
  constructor(private readonly options: {
    db: PlatformDb;
    encryptionKey: Buffer;
    clientId: string;
    redirectUri: string;
    scopes?: string[];
    now?: () => Date;
    request?: typeof pinnedRequest;
    validateUrl?: typeof validateCustomMcpUrl;
  }) {
    const redirect = new URL(options.redirectUri);
    if (redirect.protocol !== "https:") throw new Error("Custom MCP OAuth redirect URI must use HTTPS");
    if (!options.clientId) throw new Error("MCP_OAUTH_CLIENT_ID is required");
  }

  async start(userId: string, serverId: string): Promise<string> {
    const row = await this.requireOAuthRow(userId, serverId);
    const request = this.options.request ?? pinnedRequest;
    const validateUrl = this.options.validateUrl ?? validateCustomMcpUrl;
    const resourceResponse = await request({
      method: "GET",
      url: protectedResourceMetadataUrl(row.url),
    });
    if (resourceResponse.status !== 200) throw new CustomMcpBrokerError("upstream");
    const resource = parseProtectedMetadata(resourceResponse.body);
    await validateUrl(resource.resource);
    const configuredEndpoint = new URL(row.url);
    const resourceEndpoint = new URL(resource.resource);
    if (configuredEndpoint.origin !== resourceEndpoint.origin) {
      throw new CustomMcpBrokerError("invalid", "OAuth resource audience mismatch");
    }
    const authorizationServer = resource.authorization_servers[0]!;
    await validateUrl(authorizationServer);
    const metadataResponse = await request({
      method: "GET",
      url: authorizationMetadataUrl(authorizationServer),
    });
    if (metadataResponse.status !== 200) throw new CustomMcpBrokerError("upstream");
    const metadata = parseOAuthMetadata(metadataResponse.body);
    await Promise.all([
      validateUrl(metadata.authorization_endpoint),
      validateUrl(metadata.token_endpoint),
      ...(metadata.revocation_endpoint ? [validateUrl(metadata.revocation_endpoint)] : []),
    ]);

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const now = this.options.now?.() ?? new Date();
    const scopes = this.options.scopes ?? resource.scopes_supported ?? metadata.scopes_supported ?? [];
    const existingCredential = this.decrypt(userId, row);
    const credential: CustomMcpCredential = {
      oauth: {
        ...existingCredential.oauth,
        state,
        stateExpiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
        verifier,
        tokenEndpoint: metadata.token_endpoint,
        authorizationEndpoint: metadata.authorization_endpoint,
        resource: resource.resource,
        revocationEndpoint: metadata.revocation_endpoint,
        clientId: this.options.clientId,
        redirectUri: this.options.redirectUri,
        scopes,
      },
    } as CustomMcpCredential;
    await this.persistCredential(userId, row, credential, "auth_required");

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", this.options.clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.options.redirectUri);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("resource", resource.resource);
    if (scopes.length > 0) authorizationUrl.searchParams.set("scope", scopes.join(" "));
    return authorizationUrl.href;
  }

  async complete(userId: string, state: string, code: string): Promise<{ serverId: string }> {
    const rows = await this.options.db.listCustomMcpServers(userId);
    let match: { row: CustomMcpServerBrokerRow; credential: CustomMcpCredential } | undefined;
    for (const server of rows) {
      const row = await this.options.db.getCustomMcpServerForBroker(server.id, userId);
      if (!row?.encrypted_credentials || row.auth_mode !== "oauth") continue;
      const credential = this.decrypt(userId, row);
      if (exactStateMatch(credential.oauth?.state, state)) {
        match = { row, credential };
        break;
      }
    }
    if (!match?.credential.oauth) throw new CustomMcpBrokerError("invalid");
    const oauth = match.credential.oauth as NonNullable<CustomMcpCredential["oauth"]> & {
      clientId: string;
      redirectUri: string;
      scopes?: string[];
    };
    const now = this.options.now?.() ?? new Date();
    if (!oauth.stateExpiresAt || new Date(oauth.stateExpiresAt).getTime() <= now.getTime()
      || !oauth.verifier || !oauth.tokenEndpoint || !oauth.resource) {
      throw new CustomMcpBrokerError("invalid");
    }
    // Consume state before contacting the token endpoint. The optimistic
    // revision update makes concurrent/replayed callbacks one-time; a failed
    // exchange requires the user to restart authorization with fresh state.
    const claimedCredential: CustomMcpCredential = {
      oauth: { ...oauth, state: undefined, stateExpiresAt: undefined },
    };
    const encryptedClaim = encryptCustomMcpCredential(
      claimedCredential,
      this.options.encryptionKey,
      { userId, serverId: match.row.id },
    );
    const claimed = await this.options.db.updateCustomMcpServer(match.row.id, userId, match.row.revision, {
      encryptedCredentials: encryptedClaim,
      status: "auth_required",
    });
    if (!claimed) throw new CustomMcpBrokerError("invalid");
    const claimedRow = await this.options.db.getCustomMcpServerForBroker(match.row.id, userId);
    if (!claimedRow) throw new CustomMcpBrokerError("not_found");
    const token = await this.exchangeToken(oauth.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      code_verifier: oauth.verifier,
      resource: oauth.resource,
    });
    const next: CustomMcpCredential = {
      oauth: {
        ...oauth,
        state: undefined,
        stateExpiresAt: undefined,
        verifier: undefined,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: token.expires_in
          ? new Date(now.getTime() + token.expires_in * 1_000).toISOString()
          : undefined,
      },
    };
    await this.persistCredential(userId, claimedRow, next, "disabled");
    return { serverId: match.row.id };
  }

  async resolveAuthorization(userId: string, row: CustomMcpServerBrokerRow): Promise<string | undefined> {
    if (row.auth_mode !== "oauth") return undefined;
    let credential = this.decrypt(userId, row);
    const oauth = credential.oauth;
    if (!oauth?.accessToken) return undefined;
    const now = this.options.now?.() ?? new Date();
    const needsRefresh = oauth.expiresAt
      ? new Date(oauth.expiresAt).getTime() <= now.getTime() + 30_000
      : false;
    if (!needsRefresh) return `Bearer ${oauth.accessToken}`;
    if (!oauth.refreshToken || !oauth.tokenEndpoint || !oauth.resource) {
      throw new CustomMcpBrokerError("action_required");
    }
    const extended = oauth as typeof oauth & { clientId?: string };
    const token = await this.exchangeToken(oauth.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: extended.clientId ?? this.options.clientId,
      resource: oauth.resource,
    });
    credential = {
      oauth: {
        ...oauth,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? oauth.refreshToken,
        expiresAt: token.expires_in
          ? new Date(now.getTime() + token.expires_in * 1_000).toISOString()
          : undefined,
      },
    };
    await this.persistCredential(userId, row, credential, row.status);
    return `Bearer ${token.access_token}`;
  }

  async revoke(credential: CustomMcpCredential): Promise<void> {
    const oauth = credential.oauth as (NonNullable<CustomMcpCredential["oauth"]> & {
      revocationEndpoint?: string;
      clientId?: string;
    }) | undefined;
    if (!oauth?.revocationEndpoint) return;
    const token = oauth.refreshToken ?? oauth.accessToken;
    if (!token) return;
    const body = new URLSearchParams({
      token,
      client_id: oauth.clientId ?? this.options.clientId,
    }).toString();
    const response = await (this.options.request ?? pinnedRequest)({
      method: "POST",
      url: oauth.revocationEndpoint,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (response.status < 200 || response.status >= 300) throw new Error("OAuth revocation failed");
  }

  private async exchangeToken(endpoint: string, fields: Record<string, string>): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams(fields).toString();
    const response = await (this.options.request ?? pinnedRequest)({
      method: "POST",
      url: endpoint,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (response.status < 200 || response.status >= 300) throw new CustomMcpBrokerError("upstream");
    const object = assertObject(response.body);
    if (typeof object.access_token !== "string" || object.token_type !== "Bearer") {
      throw new CustomMcpBrokerError("upstream");
    }
    return object as unknown as OAuthTokenResponse;
  }

  private async requireOAuthRow(userId: string, serverId: string): Promise<CustomMcpServerBrokerRow> {
    const row = await this.options.db.getCustomMcpServerForBroker(serverId, userId);
    if (!row) throw new CustomMcpBrokerError("not_found");
    if (row.auth_mode !== "oauth") throw new CustomMcpBrokerError("invalid");
    return row;
  }

  private decrypt(userId: string, row: CustomMcpServerBrokerRow): CustomMcpCredential {
    if (!row.encrypted_credentials) return {};
    return decryptCustomMcpCredential<CustomMcpCredential>(
      row.encrypted_credentials,
      this.options.encryptionKey,
      { userId, serverId: row.id },
    );
  }

  private async persistCredential(
    userId: string,
    row: CustomMcpServerBrokerRow,
    credential: CustomMcpCredential,
    status: CustomMcpServerBrokerRow["status"],
  ): Promise<void> {
    const encrypted = encryptCustomMcpCredential(
      credential,
      this.options.encryptionKey,
      { userId, serverId: row.id },
    );
    if (!await this.options.db.updateCustomMcpCredentials(row.id, userId, row.revision, encrypted, status)) {
      throw new CustomMcpBrokerError("conflict");
    }
  }
}
