import { describe, expect, it, vi } from "vitest";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

function setup(supported: boolean, scopes?: string[]) {
  const row = { id: "server", user_id: "owner", url: "https://mcp.loops.so/", auth_mode: "oauth", revision: 1 };
  const request = vi.fn().mockResolvedValueOnce({ status: 200, body: {
    resource: row.url, authorization_servers: ["https://auth.loops.so"], scopes_supported: ["mcp"],
  } }).mockResolvedValueOnce({ status: 200, body: {
    issuer: "https://auth.loops.so", authorization_endpoint: "https://auth.loops.so/authorize",
    token_endpoint: "https://auth.loops.so/token", code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: supported,
  } });
  const db = { getCustomMcpServerForBroker: vi.fn(async () => row),
    updateCustomMcpCredentialsIfCurrent: vi.fn(async () => true) } as unknown as PlatformDb;
  const manager = new CustomMcpOAuthManager({ db, encryptionKey: Buffer.alloc(32, 6),
    redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
    clientMetadataUrl: "https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata",
    request, validateUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const })),
    scopes,
  });
  return { manager, request, db };
}

describe("OAuth Client ID Metadata Documents", () => {
  it("uses the published Matrix client document only when discovery advertises support", async () => {
    const { manager, request } = setup(true);
    const url = new URL(await manager.start("owner", "server"));
    expect(url.searchParams.get("client_id")).toBe("https://app.matrix-os.com/api/mcp-servers/oauth/client-metadata");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("fails closed when neither CIMD nor dynamic registration is supported", async () => {
    const { manager } = setup(false);
    await expect(manager.start("owner", "server")).rejects.toThrow();
  });
  it("rejects invalid or non-public metadata client URLs at configuration time", () => {
    expect(() => new CustomMcpOAuthManager({ db: {} as PlatformDb, encryptionKey: Buffer.alloc(32, 5),
      redirectUri: "https://app.matrix-os.com/api/mcp-servers/oauth/callback",
      clientMetadataUrl: "http://localhost/client",
    })).toThrow();
  });
});
