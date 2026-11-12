import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { remoteMcpCatalogEntry } from "@matrix-os/contracts/remote-mcp-catalog";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { decryptCustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";
import type { CustomMcpCredential } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { RegisteredMcpOAuthClients } from "../../packages/gateway/src/integrations/custom-mcp/catalog-presets.js";

const SECRET = "matrix-owned-app-secret";
const encryptionKey = Buffer.alloc(32, 21);
const redirectUri = "https://app.matrix-os.com/api/mcp-servers/oauth/callback";
const validateUrl = vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const }));
const github = remoteMcpCatalogEntry("github")!;
const box = remoteMcpCatalogEntry("box")!;

type Call = { method: string; url: string; fields: URLSearchParams; headers: Record<string, string> };

describe("registered-client OAuth with a Matrix-owned vendor app", () => {
  let db: PlatformDb;
  let now: Date;
  let calls: Call[];
  let request: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = createPlatformDb({ dialect: (await KyselyPGlite.create()).dialect });
    await db.migrate();
    now = new Date("2026-11-12T10:00:00Z");
    calls = [];
    request = vi.fn(async (input: { method: string; url: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({ method: input.method, url: input.url, fields: new URLSearchParams(input.body), headers: input.headers ?? {} });
      // A hostile vendor would advertise its own endpoints; the pinned flow must never ask.
      if (input.url.includes("/.well-known/")) {
        return { status: 200, body: { resource: "https://attacker.example/mcp", authorization_servers: ["https://attacker.example"],
          authorization_endpoint: "https://attacker.example/authorize", token_endpoint: "https://attacker.example/token" } };
      }
      if (input.url.endsWith("/revoke")) return { status: 200, body: undefined };
      return { status: 200, body: { access_token: `access-${calls.length}`, refresh_token: "refresh-1", token_type: "bearer", expires_in: 60 } };
    });
  });
  afterEach(async () => { await db.destroy(); });

  async function server(url: string) {
    const owner = await db.createUser({ clerkId: "owner", handle: "owner", displayName: "Owner", email: "owner@example.test", containerId: "owner" });
    const row = await db.createCustomMcpServer({ userId: owner.id, name: "Vendor", url, authMode: "oauth", pendingExpiresAt: new Date(now.getTime() + 86_400_000) });
    await db.updateCustomMcpServer(row.id, owner.id, row.revision, { status: "auth_required", pendingExpiresAt: null });
    return { userId: owner.id, serverId: row.id };
  }

  function manager(env: Record<string, string>) {
    return new CustomMcpOAuthManager({ db, encryptionKey, redirectUri, request, validateUrl, now: () => now,
      registeredClients: RegisteredMcpOAuthClients.fromEnv(env) });
  }

  async function credential(userId: string, serverId: string) {
    const row = (await db.getCustomMcpServerForBroker(serverId, userId))!;
    return { row, value: decryptCustomMcpCredential<CustomMcpCredential>(row.encrypted_credentials!, encryptionKey, { userId, serverId }) };
  }

  // Fault: vendor-advertised metadata redirects the code exchange and the Matrix client secret to another host.
  it("authorizes, exchanges, and refreshes only at the pinned endpoints with the static client", async () => {
    const { userId, serverId } = await server(github.url);
    const oauth = manager({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh-client", MCP_OAUTH_GITHUB_CLIENT_SECRET: SECRET });
    const authorization = new URL(await oauth.start(userId, serverId));
    expect(`${authorization.origin}${authorization.pathname}`).toBe(github.registeredOAuth!.authorizationEndpoint);
    expect(authorization.searchParams.get("client_id")).toBe("gh-client");
    expect(authorization.searchParams.get("scope")).toBe("repo read:org read:user");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.href).not.toContain(SECRET);
    expect(calls).toEqual([]);

    await oauth.complete(authorization.searchParams.get("state")!, "vendor-code");
    expect(calls.map(call => call.url)).toEqual([github.registeredOAuth!.tokenEndpoint]);
    expect(calls[0]!.fields.get("client_secret")).toBe(SECRET);
    expect(calls[0]!.fields.get("client_id")).toBe("gh-client");
    expect(calls[0]!.fields.get("code_verifier")).toBeTruthy();

    const stored = await credential(userId, serverId);
    expect(stored.value.oauth).toMatchObject({ registeredClient: "github", clientId: "gh-client", accessToken: "access-1" });
    expect(stored.value.oauth?.clientSecret).toBeUndefined();
    expect(JSON.stringify(stored.value)).not.toContain(SECRET);

    now = new Date(now.getTime() + 61_000);
    await expect(oauth.resolveAuthorization(userId, stored.row)).resolves.toBe("Bearer access-2");
    expect(calls[1]).toMatchObject({ url: github.registeredOAuth!.tokenEndpoint });
    expect(calls[1]!.fields.get("grant_type")).toBe("refresh_token");
    expect(calls[1]!.fields.get("client_secret")).toBe(SECRET);
    expect(JSON.stringify((await credential(userId, serverId)).value)).not.toContain(SECRET);
    expect(calls.some(call => call.url.includes("attacker"))).toBe(false);
  });

  it("uses HTTP Basic client authentication and the pinned revocation endpoint for Box", async () => {
    const { userId, serverId } = await server(box.url);
    const oauth = manager({ MCP_OAUTH_BOX_CLIENT_ID: "box-client", MCP_OAUTH_BOX_CLIENT_SECRET: SECRET });
    const authorization = new URL(await oauth.start(userId, serverId));
    await oauth.complete(authorization.searchParams.get("state")!, "code");
    await oauth.revoke((await credential(userId, serverId)).value);
    expect(calls.map(call => call.url)).toEqual([box.registeredOAuth!.tokenEndpoint, box.registeredOAuth!.revocationEndpoint]);
    const basic = `Basic ${Buffer.from(`box-client:${SECRET}`).toString("base64")}`;
    for (const call of calls) {
      expect(call.headers.authorization).toBe(basic);
      expect(call.fields.has("client_secret")).toBe(false);
    }
  });

  // Fault: removing or rotating the platform app silently keeps exchanging grants with a stale client.
  it("requires reauthorization once the Matrix app is unconfigured or rotated", async () => {
    const { userId, serverId } = await server(github.url);
    const configured = manager({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh-client", MCP_OAUTH_GITHUB_CLIENT_SECRET: SECRET });
    const state = new URL(await configured.start(userId, serverId)).searchParams.get("state")!;
    await expect(manager({}).complete(state, "code")).rejects.toMatchObject({ code: "action_required" });
    expect(calls).toEqual([]);

    const fresh = new URL(await configured.start(userId, serverId)).searchParams.get("state")!;
    await configured.complete(fresh, "code");
    now = new Date(now.getTime() + 61_000);
    const rotated = manager({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh-client-v2", MCP_OAUTH_GITHUB_CLIENT_SECRET: "rotated" });
    await expect(rotated.resolveAuthorization(userId, (await credential(userId, serverId)).row)).rejects.toMatchObject({ code: "action_required" });
    expect(calls.map(call => call.fields.get("grant_type"))).toEqual(["authorization_code"]);
  });

  // Fault: a registered-client vendor falls back to DCR and fails with a confusing upstream error.
  it("keeps the setup-required outcome for an unconfigured registered-client vendor", async () => {
    const { userId, serverId } = await server(github.url);
    request.mockImplementation(async (input: { url: string }) => input.url.includes("oauth-protected-resource")
      ? { status: 200, body: { resource: github.url, authorization_servers: ["https://github.com/login/oauth"] } }
      : { status: 200, body: { issuer: "https://github.com/login/oauth", authorization_endpoint: "https://github.com/login/oauth/authorize", token_endpoint: "https://github.com/login/oauth/access_token" } });
    await expect(manager({}).start(userId, serverId)).rejects.toMatchObject({ code: "oauth_client_setup_required" });
  });
});
