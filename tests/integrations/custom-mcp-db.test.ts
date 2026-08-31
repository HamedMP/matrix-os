import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  createPlatformDb,
  type PlatformDb,
} from "../../packages/gateway/src/platform-db.js";

describe("Custom MCP platform persistence", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let userId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();
    userId = (await db.createUser({
      clerkId: "clerk-custom-mcp",
      handle: "custom-mcp",
      displayName: "Custom MCP",
      email: "mcp@example.test",
      containerId: "container-custom-mcp",
    })).id;
  });

  afterEach(async () => db.destroy());

  it("creates pending records and never exposes encrypted credentials in public rows", async () => {
    const row = await db.createCustomMcpServer({
      userId,
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "bearer",
      encryptedCredentials: "v1.nonce.ciphertext.tag",
      pendingExpiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(row.status).toBe("pending");
    expect(row.revision).toBe(1);
    const publicRows = await db.listCustomMcpServers(userId);
    expect(publicRows).toHaveLength(1);
    expect(publicRows[0]).not.toHaveProperty("encrypted_credentials");

    const privateRow = await db.getCustomMcpServerForBroker(row.id, userId);
    expect(privateRow?.encrypted_credentials).toBe("v1.nonce.ciphertext.tag");
  });

  it("enforces optimistic revisions inside the UPDATE statement", async () => {
    const row = await db.createCustomMcpServer({
      userId,
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
      pendingExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const updated = await db.updateCustomMcpServer(row.id, userId, 1, {
      name: "Research v2",
      enabled: true,
      status: "ready",
      tools: [{
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
        approval: "always_ask",
        enabled: true,
      }],
    });
    expect(updated?.revision).toBe(2);
    expect(updated?.name).toBe("Research v2");

    expect(await db.updateCustomMcpServer(row.id, userId, 1, {
      name: "stale write",
    })).toBeNull();
  });

  it("sweeps only abandoned pending records older than 24 hours", async () => {
    await db.createCustomMcpServer({
      userId,
      name: "Expired",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
      pendingExpiresAt: new Date(Date.now() - 1_000),
    });
    const active = await db.createCustomMcpServer({
      userId,
      name: "Active",
      url: "https://mcp.acme.tools/active",
      authMode: "none",
      pendingExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.updateCustomMcpServer(active.id, userId, 1, { status: "ready" });

    expect(await db.sweepPendingCustomMcpServers(new Date())).toBe(1);
    expect((await db.listCustomMcpServers(userId)).map((server) => server.name)).toEqual(["Active"]);
  });
});
