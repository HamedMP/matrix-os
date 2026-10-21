import { describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import { CustomMcpBroker, type CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";

const issuer = "https://auth.design.example";
const secret = "test-only-client-secret:+";
const validateUrl = vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const }));

describe("confidential Custom MCP OAuth clients", () => {
  it.each(["client_secret_basic", "client_secret_post"])("registers and encrypts %s credentials through code exchange, refresh and revocation", async method => {
    const pg = await KyselyPGlite.create();
    const db = createPlatformDb({ dialect: pg.dialect });
    const encryptionKey = Buffer.alloc(32, 16);
    let now = new Date("2026-10-18T12:00:00Z");
    const tokens: Array<{ fields: URLSearchParams; headers: Record<string, string> }> = [];
    const request = vi.fn(async (input: { url: string; body?: string; headers?: Record<string, string> }) => {
      if (input.url.includes("oauth-protected-resource")) return { status: 200, body: { resource: "https://design.example/mcp", authorization_servers: [issuer] } };
      if (input.url.includes("oauth-authorization-server")) return { status: 200, body: {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`,
        token_endpoint_auth_methods_supported: [method], code_challenge_methods_supported: ["S256"],
      } };
      if (input.url.endsWith("/register")) {
        expect(JSON.parse(input.body!).client_name).toBe("Matrix OS");
        expect(JSON.parse(input.body!).token_endpoint_auth_method).toBe(method);
        return { status: 201, body: { client_id: "design-client", client_secret: secret, token_endpoint_auth_method: method } };
      }
      const fields = new URLSearchParams(input.body);
      tokens.push({ fields, headers: input.headers ?? {} });
      if (input.url.endsWith("/revoke")) return { status: 200, body: undefined };
      return { status: 200, body: { access_token: tokens.length === 1 ? "initial-access" : "fresh-access", refresh_token: "refresh-token", token_type: "Bearer", expires_in: 60, scope: tokens.length === 1 ? "mcp:read mcp:write" : "mcp:read" } };
    });
    try {
      await db.migrate();
      const owner = await db.createUser({ clerkId: "confidential", handle: "confidential", displayName: "Test", email: "test@example.test", containerId: "confidential" });
      const server = await db.createCustomMcpServer({ userId: owner.id, presetId: "test-design", name: "Design", url: "https://design.example/mcp", authMode: "oauth", pendingExpiresAt: new Date(now.getTime() + 86400000) });
      const manager = new CustomMcpOAuthManager({ db, encryptionKey, redirectUri: "https://matrix.example/callback", request, validateUrl, now: () => now });
      const authorization = await manager.start(owner.id, server.id, { managedWriteAccess: true });
      expect(authorization).not.toContain(secret);
      await manager.complete(new URL(authorization).searchParams.get("state")!, "code");
      let row = (await db.getCustomMcpServerForBroker(server.id, owner.id))!;
      const initialCredential = decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, encryptionKey, { userId: owner.id, serverId: row.id });
      expect(initialCredential.oauth?.grantedScopes).toEqual(["mcp:read", "mcp:write"]);
      expect(initialCredential.oauth?.managedWriteAccess).toBe(true);
      const broker = new CustomMcpBroker({ db, encryptionKey, projection: { upsert: async () => {}, remove: async () => {} } });
      expect(await broker.getPresetWriteAuthorization(owner.id, "test-design")).toEqual({ enabled: false, scopes: [] });
      await db.updateCustomMcpServer(row.id, owner.id, row.revision, { enabled: true, status: "ready" });
      row = (await db.getCustomMcpServerForBroker(server.id, owner.id))!;
      expect(await broker.getPresetWriteAuthorization(owner.id, "test-design")).toEqual({ enabled: true, scopes: ["mcp:read", "mcp:write"] });
      expect(row.encrypted_credentials).not.toContain(secret);
      expect(JSON.stringify(await db.listCustomMcpServers(owner.id))).not.toContain(secret);
      now = new Date(now.getTime() + 61000);
      await expect(manager.resolveAuthorization(owner.id, row)).resolves.toBe("Bearer fresh-access");
      const refreshed = (await db.getCustomMcpServerForBroker(server.id, owner.id))!;
      const credential = decryptCustomMcpCredential<CustomMcpCredential>(refreshed.encrypted_credentials!, encryptionKey, { userId: owner.id, serverId: server.id });
      expect(credential.oauth?.grantedScopes).toEqual(["mcp:read"]);
      expect(await broker.getPresetWriteAuthorization(owner.id, "test-design")).toEqual({ enabled: true, scopes: ["mcp:read"] });
      await manager.revoke(credential);
      expect(tokens).toHaveLength(3);
      for (const token of tokens) {
        if (method === "client_secret_post") {
          expect(token.fields.get("client_secret")).toBe(secret);
          expect(token.headers.authorization).toBeUndefined();
        } else {
          const form = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
          expect(token.headers.authorization).toBe(`Basic ${Buffer.from(`${form("design-client")}:${form(secret)}`).toString("base64")}`);
          expect(token.fields.has("client_secret")).toBe(false);
        }
      }
      expect(tokens[0].fields.get("code_verifier")).toBeTruthy();
      expect(tokens[1].fields.get("grant_type")).toBe("refresh_token");
      expect(tokens[2].fields.get("token")).toBe("refresh-token");
      await manager.start(owner.id, server.id);
      const reconnect = (await db.getCustomMcpServerForBroker(server.id, owner.id))!;
      const reset = decryptCustomMcpCredential<CustomMcpCredential>(reconnect.encrypted_credentials!, encryptionKey, { userId: owner.id, serverId: server.id });
      expect(reset.oauth?.managedWriteAccess).toBe(false);
      expect(reset.oauth?.grantedScopes).toBeUndefined();
    } finally { await db.destroy(); }
  });

  it("classifies a rejected client registration without saving grant state", async () => {
    const row = { id: "server", user_id: "owner", revision: 1, auth_mode: "oauth", url: "https://design.example/mcp" };
    const save = vi.fn();
    const request = vi.fn().mockResolvedValueOnce({ status: 200, body: { resource: row.url, authorization_servers: [issuer] } })
      .mockResolvedValueOnce({ status: 200, body: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register` } })
      .mockResolvedValueOnce({ status: 403, body: undefined });
    const manager = new CustomMcpOAuthManager({ db: { getCustomMcpServerForBroker: async () => row, updateCustomMcpCredentialsIfCurrent: save } as any,
      encryptionKey: Buffer.alloc(32, 16), redirectUri: "https://matrix.example/callback", request, validateUrl });
    await expect(manager.start("owner", "server")).rejects.toMatchObject({ code: "oauth_client_setup_required" });
    expect(save).not.toHaveBeenCalled();
  });
});
