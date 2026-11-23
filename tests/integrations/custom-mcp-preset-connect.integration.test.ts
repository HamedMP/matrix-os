import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { CustomMcpOAuthManager } from "../../packages/gateway/src/integrations/custom-mcp/oauth.js";
import { RemoteMcpClient, type RemoteMcpRequest } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import { createCustomMcpRoutes } from "../../packages/gateway/src/integrations/custom-mcp/routes.js";
import { RegisteredMcpOAuthClients } from "../../packages/gateway/src/integrations/custom-mcp/catalog-presets.js";

// Checkpoint for spec 2691 layer 2: the platform Custom MCP routes, the real
// broker and OAuth manager, and fake vendor OAuth + MCP servers complete a
// preset DCR connect and a Matrix-owned registered-client connect.

const GITHUB_SECRET = "matrix-github-oauth-app-secret";
const redirectUri = "https://app.matrix-os.com/api/mcp-servers/oauth/callback";
const validateUrl = async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 as const });

/** Fake vendors: OAuth endpoints answer the broker's pinned requester; MCP endpoints answer the MCP client. */
class FakeVendors {
  readonly oauthCalls: string[] = [];
  readonly issued = new Map<string, string>();
  private codes = new Map<string, string>();

  oauth = async (input: { method: string; url: string; body?: string; headers?: Record<string, string> }) => {
    this.oauthCalls.push(`${input.method} ${input.url}`);
    const url = new URL(input.url);
    if (url.href === "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp") {
      return { status: 200, body: { resource: "https://mcp.linear.app/mcp", authorization_servers: ["https://mcp.linear.app"] } };
    }
    if (url.href === "https://mcp.linear.app/.well-known/oauth-authorization-server") {
      return { status: 200, body: { issuer: "https://mcp.linear.app", authorization_endpoint: "https://mcp.linear.app/authorize",
        token_endpoint: "https://mcp.linear.app/token", registration_endpoint: "https://mcp.linear.app/register",
        code_challenge_methods_supported: ["S256"] } };
    }
    if (url.href === "https://mcp.linear.app/register") return { status: 201, body: { client_id: "dcr-linear-client" } };
    const fields = new URLSearchParams(input.body);
    if (url.href === "https://mcp.linear.app/token" && fields.get("client_id") === "dcr-linear-client") {
      return this.token("linear", fields.get("code"));
    }
    if (url.href === "https://github.com/login/oauth/access_token"
      && fields.get("client_id") === "gh-app" && fields.get("client_secret") === GITHUB_SECRET) {
      return this.token("github", fields.get("code"));
    }
    return { status: 401, body: undefined };
  };

  /** The user consents at the vendor's authorization page, which redirects with a code. */
  consent(authorizationUrl: string, vendor: string): { state: string; code: string } {
    const url = new URL(authorizationUrl);
    const code = `code-${vendor}`;
    this.codes.set(code, vendor);
    return { state: url.searchParams.get("state")!, code };
  }

  mcp = async (request: RemoteMcpRequest) => {
    const vendor = request.url.includes("linear") ? "linear" : "github";
    if (request.headers.authorization !== `Bearer ${this.issued.get(vendor)}`) return { status: 401, headers: {}, body: undefined };
    const body = request.body as { id?: number; method?: string } | undefined;
    if (!body?.id) return { status: 202, headers: {}, body: undefined };
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: vendor, version: "1" } }
      : { tools: [{ name: `${vendor}_list`, description: `List ${vendor} items`, inputSchema: { type: "object" } }] };
    return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result } };
  };

  private token(vendor: string, code: string | null) {
    if (!code || this.codes.get(code) !== vendor) return { status: 400, body: undefined };
    this.codes.delete(code);
    const accessToken = `${vendor}-access-token`;
    this.issued.set(vendor, accessToken);
    return { status: 200, body: { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: `${vendor}-refresh` } };
  }
}

describe("preset connect through platform routes, broker, and fake vendors", () => {
  let db: PlatformDb;
  let vendors: FakeVendors;
  let app: ReturnType<typeof createCustomMcpRoutes>;
  let userId: string;
  let broker: CustomMcpBroker;

  beforeEach(async () => {
    db = createPlatformDb({ dialect: (await KyselyPGlite.create()).dialect });
    await db.migrate();
    userId = (await db.createUser({ clerkId: "member", handle: "member", displayName: "Member", email: "m@example.test", containerId: "member" })).id;
    vendors = new FakeVendors();
    const encryptionKey = Buffer.alloc(32, 9);
    const registeredClients = RegisteredMcpOAuthClients.fromEnv({ MCP_OAUTH_GITHUB_CLIENT_ID: "gh-app", MCP_OAUTH_GITHUB_CLIENT_SECRET: GITHUB_SECRET });
    const oauth = new CustomMcpOAuthManager({ db, encryptionKey, redirectUri, request: vendors.oauth, validateUrl, registeredClients });
    broker = new CustomMcpBroker({ db, encryptionKey, validateUrl,
      projection: { upsert: async () => {}, remove: async () => {} },
      client: new RemoteMcpClient({ requester: vendors.mcp }),
      resolveOAuthAuthorization: (owner, row) => oauth.resolveAuthorization(owner, row) });
    app = createCustomMcpRoutes({ broker, oauth, catalog: registeredClients, resolveUserId: async () => userId });
  });
  afterEach(async () => {
    await broker.shutdown();
    await db.destroy();
  });

  const post = (path: string, body: unknown = {}) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  async function connectPreset(catalogId: string) {
    const catalog = await (await app.request("/catalog")).json() as { presets: Array<{ id: string }> };
    expect(catalog.presets.map(preset => preset.id)).toContain(catalogId);
    const created = await post("/", { catalogId });
    expect(created.status).toBe(201);
    const server = await created.json() as { id: string; status: string; authMode: string };
    expect(server).toMatchObject({ status: "auth_required", authMode: "oauth" });
    const connect = await post(`/${server.id}/connect`);
    expect(connect.status).toBe(200);
    const { url } = await connect.json() as { url: string };
    const { state, code } = vendors.consent(url, catalogId);
    const callback = await app.request(`/oauth/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(callback.status).toBe(200);
    const discovered = await post(`/${server.id}/discover`);
    expect(discovered.status).toBe(200);
    return { authorizationUrl: new URL(url), server: await discovered.json() as { status: string; tools: Array<{ name: string }> } };
  }

  it("(a) connects a DCR preset end to end", async () => {
    const { authorizationUrl, server } = await connectPreset("linear");
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://mcp.linear.app/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("dcr-linear-client");
    expect(server).toMatchObject({ status: "ready", tools: [{ name: "linear_list" }] });
    expect(vendors.oauthCalls).toContain("POST https://mcp.linear.app/register");
  });

  it("(b) connects a registered-client preset with the Matrix-owned app and pinned endpoints", async () => {
    const { authorizationUrl, server } = await connectPreset("github");
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("gh-app");
    expect(server).toMatchObject({ status: "ready", tools: [{ name: "github_list" }] });
    expect(vendors.oauthCalls).toEqual(["POST https://github.com/login/oauth/access_token"]);
    const listed = await (await app.request("/")).text();
    expect(listed).not.toContain(GITHUB_SECRET);
    expect(listed).not.toContain("github-access-token");
  });
});
