import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
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
});
