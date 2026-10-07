import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";

describe("OAuth credential atomicity", () => {
  let db: PlatformDb; let userId: string; let serverId: string;
  beforeEach(async () => {
    const instance = await KyselyPGlite.create(); db = createPlatformDb({ dialect: instance.dialect }); await db.migrate();
    userId = (await db.createUser({ clerkId: "owner", handle: "owner", displayName: "Owner", email: "owner@example.test", containerId: "fixture" })).id;
    serverId = randomUUID();
    await db.createCustomMcpServer({ id: serverId, userId, presetId: "loops", name: "Loops", url: "https://mcp.loops.so/", authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 60000) });
    await db.updateCustomMcpCredentials(serverId, userId, 1, "initial-ciphertext", "ready");
  });
  afterEach(async () => { await db.destroy(); });
  it("creates an owner preset idempotently under concurrent requests", async () => {
    const rows = await Promise.all(["one", "two"].map(suffix => db.createCustomMcpServer({ userId, presetId: "bokio", name: `Bokio ${suffix}`,
      url: "https://api.bokio.se", authMode: "oauth", pendingExpiresAt: new Date(Date.now() + 60000) })));
    expect(rows[0]?.id).toBe(rows[1]?.id);
    expect(await db.getCustomMcpPresetForBroker("bokio", userId)).toMatchObject({ id: rows[0]?.id, revision: 1 });
  });

  it("claims rotating credentials once without changing the tool-policy revision", async () => {
    const results = await Promise.all(["claim-one", "claim-two"].map(cipher =>
      db.updateCustomMcpCredentialsIfCurrent(serverId, userId, 1, "initial-ciphertext", cipher, "ready")));
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await db.getCustomMcpServerForBroker(serverId, userId);
    expect(row?.revision).toBe(1);
    expect(row?.encrypted_credentials).toBe(results[0] ? "claim-one" : "claim-two");
    expect(await db.updateCustomMcpCredentialsIfCurrent(serverId, randomUUID(), 1, row!.encrypted_credentials!, "foreign", "ready")).toBe(false);
  });
  it("does not delete a reauthorized connection or overwrite a newer credential", async () => {
    await db.updateCustomMcpServer(serverId, userId, 1, { encryptedCredentials: "new-auth", status: "ready" });
    expect(await db.deleteCustomMcpServerIfRevision(serverId, userId, 1)).toBe(false);
    expect(await db.updateCustomMcpCredentialsIfCurrent(serverId, userId, 1, "initial-ciphertext", "stale", "ready")).toBe(false);
    expect(await db.deleteCustomMcpServerIfRevision(serverId, userId, 2)).toBe(true);
  });
});
