/**
 * Two fake Streamable HTTP MCP upstreams behind the real RemoteMcpClient, plus
 * the real broker on a real (PGlite) platform database. Only the network edge
 * is faked; JSON-RPC framing, sessions, policy, and approvals are production code.
 */
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { CustomMcpBroker } from "../../packages/gateway/src/integrations/custom-mcp/broker.js";
import { RemoteMcpClient, type RemoteMcpRequest, type RemoteMcpRequester } from "../../packages/gateway/src/integrations/custom-mcp/client.js";
import type { CustomMcpServerProjection } from "../../packages/gateway/src/integrations/custom-mcp/types.js";

export interface FakeUpstreamTool {
  name: string;
  description: string;
  result?: (args: Record<string, unknown>) => unknown;
  fail?: boolean;
}

export interface FakeUpstream { host: string; tools: FakeUpstreamTool[]; calls: Array<{ tool: string; args: unknown }> }

export function fakeUpstreams(upstreams: FakeUpstream[]): RemoteMcpRequester {
  return async (request: RemoteMcpRequest) => {
    const upstream = upstreams.find(candidate => new URL(request.url).hostname === candidate.host);
    if (!upstream) throw new Error("unknown upstream");
    if (request.method === "DELETE") return { status: 200, headers: {}, body: undefined };
    const body = request.body as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (body.method === "notifications/initialized") return { status: 202, headers: {}, body: undefined };
    if (body.method === "initialize") {
      return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {} } } };
    }
    if (body.method === "tools/list") {
      return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id, result: {
        tools: upstream.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: { type: "object" } })),
      } } };
    }
    if (body.method === "tools/call") {
      const tool = upstream.tools.find(candidate => candidate.name === body.params?.name);
      upstream.calls.push({ tool: body.params?.name ?? "", args: body.params?.arguments });
      if (!tool || tool.fail) return { status: 500, headers: {}, body: { jsonrpc: "2.0", id: body.id, error: { message: "upstream exploded with secret detail" } } };
      return { status: 200, headers: {}, body: { jsonrpc: "2.0", id: body.id,
        result: tool.result?.(body.params?.arguments ?? {}) ?? { content: [{ type: "text", text: `${tool.name} ok` }] } } };
    }
    throw new Error(`unexpected method ${body.method}`);
  };
}

export interface CoreFixture {
  pglite: InstanceType<typeof KyselyPGlite>;
  db: PlatformDb;
  broker: CustomMcpBroker;
  userId: string;
  actorId: string;
  connect(name: string, host: string, approvals: Record<string, "allow" | "always_ask" | "blocked">): Promise<string>;
  close(): Promise<void>;
}

export async function createCoreFixture(upstreams: FakeUpstream[]): Promise<CoreFixture> {
  const pglite = await KyselyPGlite.create();
  const db = createPlatformDb({ dialect: pglite.dialect });
  await db.migrate();
  const actorId = "user_core_owner";
  const userId = (await db.createUser({ clerkId: actorId, handle: "coreowner", displayName: "Core Owner",
    email: "core@example.test", containerId: "container-core" })).id;
  const projections = new Map<string, CustomMcpServerProjection>();
  const broker = new CustomMcpBroker({
    db, encryptionKey: Buffer.alloc(32, 7),
    validateUrl: async () => { /* fixture hosts are not resolvable; SSRF policy has its own suite */ },
    client: new RemoteMcpClient({ requester: fakeUpstreams(upstreams) }),
    projection: {
      upsert: async (_user, projection) => { projections.set(projection.id, projection); },
      remove: async (_user, serverId) => { projections.delete(serverId); },
      read: async (_user, serverId) => projections.get(serverId) ?? null,
    },
  });
  return {
    pglite, db, broker, userId, actorId,
    async connect(name, host, approvals) {
      const created = await broker.create(userId, { name, url: `https://${host}/mcp`, authMode: "none" });
      const discovered = await broker.discover(userId, created.id);
      const patched = await broker.patch(userId, created.id, { revision: discovered.revision, enabled: true,
        tools: discovered.tools.map(tool => {
          const policy = approvals[tool.name] ?? "always_ask";
          return { name: tool.name, enabled: policy !== "blocked", approval: policy === "blocked" ? "always_ask" : policy };
        }) });
      return patched.id;
    },
    async close() { await broker.shutdown(); await db.destroy(); },
  };
}
