import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createPlatformDb } from "../../packages/gateway/src/platform-db.js";

const service = "microsoft_outlook";
const now = new Date("2026-11-27T16:00:00Z");
const future = new Date(now.getTime() + 600_000);
const account = { id: "microsoft-user", email: "owner@example.com" };

describe("Matrix Outlook persistence", () => {
  let db: ReturnType<typeof createPlatformDb>;
  let ownerId: string;

  beforeEach(async () => {
    const instance = await createTestPGlite();
    db = createPlatformDb({ dialect: instance.dialect });
    await db.migrate();
    await db.outlook.migrate();
    ownerId = (await db.createUser({
      clerkId: "user_owner", handle: "owner", displayName: "Owner",
      email: "owner@example.com", containerId: "owner-machine",
    })).id;
  });

  afterEach(async () => {
    await db?.destroy();
  });

  it("bounds, expires and consumes each consent attempt once for the same owner", async () => {
    const start = (hash: string, timestamp: Date, expiresAt: Date) => db.outlook.saveAttempt({
      hash, userId: ownerId, encryptedPayload: "sealed", now: timestamp, expiresAt,
    });
    await start("expired", new Date(now.getTime() - 600_001), now);
    const hashes = Array.from({ length: 9 }, () => randomUUID());
    for (const [index, hash] of hashes.entries()) await start(hash, new Date(now.getTime() + index), future);
    await expect(db.outlook.getAttempt("expired", ownerId, now)).resolves.toBeNull();
    await expect(db.outlook.getAttempt(hashes[0], ownerId, now)).resolves.toBeNull();
    await expect(db.outlook.getAttempt(hashes[8], randomUUID(), now)).resolves.toBeNull();
    await expect(db.outlook.consumeAttempt(hashes[8], randomUUID(), now)).resolves.toBeNull();

    const results = await Promise.all([
      db.outlook.consumeAttempt(hashes[8], ownerId, now),
      db.outlook.consumeAttempt(hashes[8], ownerId, now),
    ]);
    expect(results.filter(Boolean)).toEqual([{ userId: ownerId, encryptedPayload: "sealed" }]);
  });

  it("keeps an existing connection label and ID when the same Graph account reconnects", async () => {
    const input = {
      userId: ownerId, service, account, scopes: ["User.Read", "Mail.ReadWrite"],
      encrypt: (connectionId: string) => `sealed-for-${connectionId}`,
    } as const;
    const first = await db.outlook.link({ ...input, label: "Work inbox" });
    const second = await db.outlook.link(input);
    expect(second.id).toBe(first.id);
    expect(second.account_label).toBe("Work inbox");
    expect(second.account_email).toBe("owner@example.com");
    expect(await db.listConnectedServices(ownerId)).toHaveLength(1);
    await expect(db.outlook.getGrant(ownerId, service, first.id)).resolves.toMatchObject({ encrypted: `sealed-for-${first.id}` });
    await expect(db.outlook.getGrant(randomUUID(), service, first.id)).resolves.toBeNull();
    await expect(db.outlook.getGrant(ownerId, "microsoft_outlook_calendar", first.id)).resolves.toBeNull();
  });

  it("cuts over a verified legacy connection in place and remembers the old account for cleanup", async () => {
    const old = await db.connectService({
      userId: ownerId, service, pipedreamAccountId: "ap_legacy",
      accountLabel: "Work inbox", accountEmail: "old@example.com", scopes: [],
    });
    const input = {
      userId: ownerId, service, account, scopes: ["User.Read", "Mail.ReadWrite"],
      encrypt: () => "sealed", replace: { connectionId: old.id, expectedProviderRef: old.pipedream_account_id, graphAccountId: account.id },
    } as const;
    await expect(db.outlook.link({ ...input, account: { ...account, id: "wrong-account" } })).rejects.toThrow();
    await expect(db.getConnectedService(old.id)).resolves.toMatchObject({ status: "active", pipedream_account_id: "ap_legacy" });

    const linked = await db.outlook.link(input);
    expect(linked.id).toBe(old.id);
    expect(linked.account_label).toBe("Work inbox");
    expect(linked.pipedream_account_id).toBe(`matrix_outlook_${old.id}`);
    const sweepTime = new Date(Date.now() + 1000);
    const claims = await Promise.all([
      db.outlook.claimPendingLegacyCleanup(sweepTime),
      db.outlook.claimPendingLegacyCleanup(sweepTime),
    ]);
    expect(claims.flat()).toEqual([{ userId: ownerId, providerAccountId: "ap_legacy" }]);
    await db.outlook.markLegacyCleaned(ownerId, "ap_legacy");
    await expect(db.outlook.claimPendingLegacyCleanup(new Date(sweepTime.getTime() + 120_000))).resolves.toEqual([]);
  });

  it("fences refresh from concurrent reconnect and disconnect and deletes the credential on disconnect", async () => {
    const input = { userId: ownerId, service, account, scopes: ["User.Read", "Mail.ReadWrite"], encrypt: () => "initial" } as const;
    const connection = await db.outlook.link(input);
    const first = await db.outlook.getGrant(ownerId, service, connection.id);
    expect(first).not.toBeNull();
    await db.outlook.link({ ...input, encrypt: () => "reconnected" });
    await expect(db.outlook.refreshGrant(ownerId, connection.id, first!.revision, "stale")).resolves.toBe(false);
    const current = await db.outlook.getGrant(ownerId, service, connection.id);
    expect(current?.encrypted).toBe("reconnected");
    await expect(db.outlook.disconnect(ownerId, connection.id)).resolves.toBe(true);
    await expect(db.outlook.refreshGrant(ownerId, connection.id, current!.revision, "stale")).resolves.toBe(false);
    await expect(db.outlook.getGrant(ownerId, service, connection.id)).resolves.toBeNull();
    await expect(db.getConnectedService(connection.id)).resolves.toMatchObject({ status: "revoked" });
  });
});
