import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_PREVIEW_HANDLE_PATTERN as CONTRACT_PATTERN } from "../../packages/contracts/src/index.js";
import { PRIVATE_PREVIEW_HANDLE_PATTERN as CLERK_SYNC_PATTERN } from "../../packages/clerk-sync/src/index.js";
import { registerCustomMcpGatewayRoutes } from "../../packages/gateway/src/integrations/custom-mcp/gateway-routes.js";
import { bootstrapCustomMcpProjection } from "../../packages/gateway/src/integrations/custom-mcp/projection-bootstrap.js";
import { CustomMcpProjectionStore } from "../../packages/gateway/src/integrations/custom-mcp/projection-store.js";

const serverId = "11111111-1111-4111-8111-111111111111";
const listed = {
  id: serverId,
  name: "Research",
  url: "https://mcp.acme.tools/mcp",
  authMode: "bearer",
  status: "ready",
  enabled: true,
  revision: 4,
  tools: [{ name: "search", description: "Search", inputSchema: { type: "object" }, enabled: true, approval: "always_ask" }],
};
const projected = {
  id: serverId,
  name: "Research",
  url: "https://mcp.acme.tools/mcp",
  authMode: "bearer",
  enabled: true,
  revision: 4,
  tools: [{ name: "search", enabled: true, approval: "always_ask" }],
};

async function store() {
  return new CustomMcpProjectionStore(await mkdtemp(join(tmpdir(), "matrix-mcp-bootstrap-")));
}

function respond(...responses: Array<[number, unknown]>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const [status, body] = queue.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  });
}

describe("Custom MCP projection store", () => {
  it("never lets an older revision overwrite a newer one", async () => {
    const projection = await store();
    await projection.upsert({ ...projected, revision: 5 });
    await projection.upsert({ ...projected, revision: 4, enabled: false });
    expect((await projection.read()).servers[0]).toMatchObject({ revision: 5, enabled: true });
    await projection.upsert({ ...projected, revision: 5, enabled: false });
    expect((await projection.read()).servers[0]).toMatchObject({ revision: 5, enabled: false });
  });
});

describe("Private Preview Custom MCP projection pull", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the owner's servers without descriptions, schemas, or status", async () => {
    const projection = await store();
    const fetchImpl = respond([200, [listed]]);
    await expect(bootstrapCustomMcpProjection({
      store: projection, listUrl: "https://platform.test/internal/containers/pv-1907-3fa91c2e/mcp-servers",
      token: "machine-token", fetchImpl, sleep: async () => {},
    })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.test/internal/containers/pv-1907-3fa91c2e/mcp-servers",
      expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer machine-token" }, signal: expect.any(AbortSignal) }),
    );
    expect((await projection.read()).servers).toEqual([projected]);
  });

  it("retries while the platform is not ready and then converges", async () => {
    const projection = await store();
    const fetchImpl = respond([403, {}], [503, {}], [200, [listed]]);
    await expect(bootstrapCustomMcpProjection({
      store: projection, listUrl: "https://platform.test/list", token: "t", fetchImpl, sleep: async () => {},
    })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up on an authentication failure or a malformed response", async () => {
    for (const fetchImpl of [respond([401, {}]), respond([200, { servers: "nope" }])]) {
      const projection = await store();
      await expect(bootstrapCustomMcpProjection({
        store: projection, listUrl: "https://platform.test/list", token: "t", fetchImpl, sleep: async () => {},
      })).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect((await projection.read()).servers).toEqual([]);
    }
  });

  it("stops after a bounded number of attempts", async () => {
    const projection = await store();
    const fetchImpl = respond([503, {}], [503, {}], [503, {}], [503, {}], [503, {}], [503, {}], [503, {}]);
    await expect(bootstrapCustomMcpProjection({
      store: projection, listUrl: "https://platform.test/list", token: "t", fetchImpl, sleep: async () => {}, attempts: 4,
    })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["pv-1907-3fa91c2e", 1],
    ["alice", 0],
    ["pr-1907", 0],
  ])("pulls at startup only on a Private Preview (%s)", async (handle, calls) => {
    const fetchMock = respond([200, []]);
    vi.stubGlobal("fetch", fetchMock);
    const homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-register-"));
    registerCustomMcpGatewayRoutes(new Hono(), {
      homePath,
      clerkUserId: "user_owner",
      projectionToken: "machine-token",
      platformProxy: {
        internalPlatformUrl: "https://platform.test",
        handle,
        token: "machine-token",
        request: async () => new Response(null, { status: 204 }),
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("shares one handle grammar with the platform", () => {
    expect(CONTRACT_PATTERN.source).toBe(CLERK_SYNC_PATTERN.source);
    expect(CONTRACT_PATTERN.flags).toBe(CLERK_SYNC_PATTERN.flags);
  });
});
