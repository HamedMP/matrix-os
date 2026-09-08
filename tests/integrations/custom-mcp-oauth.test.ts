import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
} from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

describe("Custom MCP OAuth", () => {
  it("discovers metadata and creates expiring PKCE S256 state encrypted at rest", async () => {
    const key = Buffer.alloc(32, 9);
    let encrypted = "";
    const row = {
      id: "012b72f8-33e3-455f-9ee3-dc15069932bb",
      user_id: "owner",
      url: "https://mcp.acme.tools/mcp",
      auth_mode: "oauth",
      revision: 2,
    };
    const db = {
      getCustomMcpServerForBroker: vi.fn(async () => row),
      updateCustomMcpCredentials: vi.fn(async (_id, _user, _revision, value) => { encrypted = value; return true; }),
    } as unknown as PlatformDb;
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { resource: row.url, authorization_servers: ["https://auth.acme.tools"] } })
      .mockResolvedValueOnce({ status: 200, body: {
        authorization_endpoint: "https://auth.acme.tools/authorize",
        token_endpoint: "https://auth.acme.tools/token",
        code_challenge_methods_supported: ["S256"],
      } });
    const oauth = new CustomMcpOAuthManager({
      db,
      encryptionKey: key,
      clientId: "matrix-client",
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      request,
      validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })),
    });
    const authorization = new URL(await oauth.start("owner", row.id));
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("resource")).toBe(row.url);
    expect(authorization.searchParams.get("state")).toHaveLength(43);
    expect(encrypted).not.toContain(authorization.searchParams.get("state")!);
    const credential = decryptCustomMcpCredential<any>(encrypted, key, { userId: "owner", serverId: row.id });
    expect(credential.oauth.stateExpiresAt).toBe("2026-08-29T00:10:00.000Z");
    expect(credential.oauth.verifier.length).toBeGreaterThan(43);
  });

  it("registers a public OAuth client dynamically when no client ID is configured", async () => {
    const key = Buffer.alloc(32, 7);
    let encrypted = "";
    const row = {
      id: "118b72f8-33e3-455f-9ee3-dc15069932bb",
      user_id: "owner",
      url: "https://mcp.granola.ai/mcp",
      auth_mode: "oauth",
      revision: 4,
    };
    const db = {
      getCustomMcpServerForBroker: vi.fn(async () => row),
      updateCustomMcpCredentials: vi.fn(async (_id, _user, _revision, value) => {
        encrypted = value;
        return true;
      }),
    } as unknown as PlatformDb;
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          resource: row.url,
          authorization_servers: ["https://mcp-auth.granola.ai"],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          issuer: "https://mcp-auth.granola.ai",
          authorization_endpoint: "https://mcp-auth.granola.ai/authorize",
          token_endpoint: "https://mcp-auth.granola.ai/token",
          registration_endpoint: "https://mcp-auth.granola.ai/register",
          code_challenge_methods_supported: ["S256"],
        },
      })
      .mockResolvedValueOnce({
        status: 201,
        body: {
          client_id: "granola-dynamic-client",
          token_endpoint_auth_method: "none",
        },
      });
    const validateUrl = vi.fn(async (url: string) => ({
      url: new URL(url),
      address: "93.184.216.34",
      family: 4 as const,
    }));
    const oauth = new CustomMcpOAuthManager({
      db,
      encryptionKey: key,
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      request,
      validateUrl,
    });

    const authorization = new URL(await oauth.start("owner", row.id));

    expect(authorization.searchParams.get("client_id")).toBe("granola-dynamic-client");
    expect(validateUrl).toHaveBeenCalledWith("https://mcp-auth.granola.ai/register");
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      url: "https://mcp-auth.granola.ai/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Matrix OS",
        redirect_uris: ["https://app.matrix-os.com/api/mcp-servers/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
    });
    const credential = decryptCustomMcpCredential<any>(encrypted, key, {
      userId: "owner",
      serverId: row.id,
    });
    expect(credential.oauth).toMatchObject({
      clientId: "granola-dynamic-client",
      clientIssuer: "https://mcp-auth.granola.ai/",
    });
  });

  it("rejects dynamic registrations that require a client secret", async () => {
    const row = {
      id: "218b72f8-33e3-455f-9ee3-dc15069932bb",
      user_id: "owner",
      url: "https://mcp.granola.ai/mcp",
      auth_mode: "oauth",
      revision: 1,
    };
    const db = {
      getCustomMcpServerForBroker: vi.fn(async () => row),
      updateCustomMcpCredentials: vi.fn(),
    } as unknown as PlatformDb;
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { resource: row.url, authorization_servers: ["https://mcp-auth.granola.ai"] } })
      .mockResolvedValueOnce({ status: 200, body: {
        issuer: "https://mcp-auth.granola.ai",
        authorization_endpoint: "https://mcp-auth.granola.ai/authorize",
        token_endpoint: "https://mcp-auth.granola.ai/token",
        registration_endpoint: "https://mcp-auth.granola.ai/register",
      } })
      .mockResolvedValueOnce({ status: 201, body: {
        client_id: "confidential-client",
        client_secret: "must-not-store",
        token_endpoint_auth_method: "client_secret_basic",
      } });
    const oauth = new CustomMcpOAuthManager({
      db,
      encryptionKey: Buffer.alloc(32, 8),
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      request,
      validateUrl: vi.fn(async (url: string) => ({
        url: new URL(url),
        address: "93.184.216.34",
        family: 4 as const,
      })),
    });

    await expect(oauth.start("owner", row.id)).rejects.toMatchObject({ code: "upstream" });
    expect(db.updateCustomMcpCredentials).not.toHaveBeenCalled();
  });

  it("reuses a dynamically registered client only for its bound issuer", async () => {
    const key = Buffer.alloc(32, 6);
    const row = {
      id: "318b72f8-33e3-455f-9ee3-dc15069932bb",
      user_id: "owner",
      url: "https://mcp.granola.ai/mcp",
      auth_mode: "oauth",
      revision: 3,
      encrypted_credentials: "",
    };
    row.encrypted_credentials = encryptCustomMcpCredential({
      oauth: {
        clientId: "cached-granola-client",
        clientIssuer: "https://mcp-auth.granola.ai/",
      },
    }, key, { userId: "owner", serverId: row.id });
    const db = {
      getCustomMcpServerForBroker: vi.fn(async () => row),
      updateCustomMcpCredentials: vi.fn(async () => true),
    } as unknown as PlatformDb;
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: {
        resource: row.url,
        authorization_servers: ["https://mcp-auth.granola.ai"],
      } })
      .mockResolvedValueOnce({ status: 200, body: {
        issuer: "https://mcp-auth.granola.ai",
        authorization_endpoint: "https://mcp-auth.granola.ai/authorize",
        token_endpoint: "https://mcp-auth.granola.ai/token",
        registration_endpoint: "https://mcp-auth.granola.ai/register",
      } });
    const oauth = new CustomMcpOAuthManager({
      db,
      encryptionKey: key,
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      request,
      validateUrl: vi.fn(async (url: string) => ({
        url: new URL(url),
        address: "93.184.216.34",
        family: 4 as const,
      })),
    });

    const authorization = new URL(await oauth.start("owner", row.id));

    expect(authorization.searchParams.get("client_id")).toBe("cached-granola-client");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects authorization metadata for a different issuer", async () => {
    const row = {
      id: "418b72f8-33e3-455f-9ee3-dc15069932bb",
      user_id: "owner",
      url: "https://mcp.granola.ai/mcp",
      auth_mode: "oauth",
      revision: 1,
    };
    const db = {
      getCustomMcpServerForBroker: vi.fn(async () => row),
      updateCustomMcpCredentials: vi.fn(),
    } as unknown as PlatformDb;
    const request = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: {
        resource: row.url,
        authorization_servers: ["https://mcp-auth.granola.ai"],
      } })
      .mockResolvedValueOnce({ status: 200, body: {
        issuer: "https://auth.attacker.example",
        authorization_endpoint: "https://auth.attacker.example/authorize",
        token_endpoint: "https://auth.attacker.example/token",
        registration_endpoint: "https://auth.attacker.example/register",
      } });
    const oauth = new CustomMcpOAuthManager({
      db,
      encryptionKey: Buffer.alloc(32, 5),
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      request,
      validateUrl: vi.fn(async (url: string) => ({
        url: new URL(url),
        address: "93.184.216.34",
        family: 4 as const,
      })),
    });

    await expect(oauth.start("owner", row.id)).rejects.toMatchObject({ code: "upstream" });
    expect(db.updateCustomMcpCredentials).not.toHaveBeenCalled();
  });
});
