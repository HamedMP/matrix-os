import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CustomMcpProjectionStore,
} from "../../packages/gateway/src/integrations/custom-mcp/projection-store.js";

describe("Custom MCP owner-visible projection", () => {
  it("persists only non-secret fields atomically", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-projection-"));
    const store = new CustomMcpProjectionStore(homePath);
    await store.upsert({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "bearer",
      enabled: true,
      revision: 2,
      tools: [{ name: "search", enabled: true, approval: "always_ask" }],
    });

    const raw = await readFile(join(homePath, "system", "mcp-servers.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      servers: [{
        id: "11111111-1111-4111-8111-111111111111",
        name: "Research",
        url: "https://mcp.acme.tools/mcp",
        authMode: "bearer",
        enabled: true,
        revision: 2,
        tools: [{ name: "search", enabled: true, approval: "always_ask" }],
      }],
    });
    expect(raw).not.toMatch(/token|authorization|credential|oauth/i);
  });

  it("removes one server without disturbing other projections", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-mcp-projection-"));
    const store = new CustomMcpProjectionStore(homePath);
    const base = {
      name: "Server",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none" as const,
      enabled: false,
      revision: 1,
      tools: [],
    };
    await store.upsert({ ...base, id: "11111111-1111-4111-8111-111111111111" });
    await store.upsert({ ...base, id: "22222222-2222-4222-8222-222222222222" });
    await store.remove("11111111-1111-4111-8111-111111111111");

    const projection = await store.read();
    expect(projection.servers.map((server) => server.id)).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
  });
});
