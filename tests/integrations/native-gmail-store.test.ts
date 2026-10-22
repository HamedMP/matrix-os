import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { NativeGmailStore } from "../../packages/gateway/src/integrations/native-gmail/types.js";

describe("native Gmail durable owner binding", () => {
  let db: PlatformDb;
  let store: NativeGmailStore;
  let userId: string;
  const now = new Date("2026-10-07T10:00:00Z");
  beforeEach(async () => {
    const pg = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pg.dialect });
    await db.migrate();
    store = db.nativeGmailStore!;
    userId = (await db.createUser({ clerkId: "gmail-owner", handle: "gmail-owner", displayName: "Owner",
      email: "owner@example.test", containerId: "gmail-container", pipedreamExternalId: "external-owner" })).id;
  });
  afterEach(async () => db.destroy());
  const connect = () => store.connect({ userId, externalUserId: "external-owner", email: "mail@example.test",
    label: "Work", scopes: ["https://www.googleapis.com/auth/gmail.modify"], encrypt: (id) => `encrypted:${id}`, now });

  it("atomically reconnects the same email with immutable IDs and canonical projection", async () => {
    const first = await connect();
    const second = await connect();
    expect(second.accountId).toBe(first.accountId);
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.revision).toBe(first.revision + 1);
    expect((await db.listConnectedServices(userId))).toHaveLength(1);
    expect(await store.lookup({ externalUserId: "other", accountId: first.accountId })).toBeNull();
    expect((await store.lookup({ externalUserId: "external-owner", accountId: first.accountId }))?.userId).toBe(userId);
    await expect(store.connect({ userId, externalUserId: "other", email: "mail@example.test", label: "Bad", scopes: [], encrypt: () => "secret", now })).rejects.toThrow();
  });

  it("rolls back canonical projection if encryption fails", async () => {
    await connect();
    await expect(store.connect({ userId, externalUserId: "external-owner", email: "other@example.test", label: "Other",
      scopes: [], encrypt: () => { throw new Error("encryption failure"); }, now })).rejects.toThrow();
    expect(await db.listConnectedServices(userId)).toHaveLength(1);
  });

  it("consumes state once, expires state, and caps pending sessions per owner", async () => {
    for (let n = 0; n < 9; n++) await store.startState({ hash: `hash${n}`, userId, externalUserId: "external-owner",
      encryptedVerifier: "encrypted", label: "Work", expiresAt: new Date(now.getTime() + 600_000), now });
    expect(await store.consumeState("hash0", now)).toBeNull();
    expect((await store.consumeState("hash8", now))?.userId).toBe(userId);
    expect(await store.consumeState("hash8", now)).toBeNull();
    expect(await store.consumeState("hash7", new Date(now.getTime() + 600_001))).toBeNull();
  });

  it("serializes refresh and rejects stale settlement after reconnect or canonical revocation", async () => {
    const first = await connect();
    const lease = await store.acquireLease(first, now);
    expect(lease).not.toBeNull();
    expect(await store.acquireLease(first, now)).toBeNull();
    expect(await store.lookup({ externalUserId: "external-owner", accountId: first.accountId }, now)).toBeNull();
    await expect(connect()).rejects.toThrow();
    await store.releaseLease(lease!);
    await connect();
    expect(await store.settle(lease!, "rotated", "active", now)).toBe(false);
    const row = await store.lookup({ externalUserId: "external-owner", accountId: first.accountId });
    const next = await store.acquireLease(row!, now);
    await db.updateServiceStatus(first.connectionId, "revoked");
    expect(await store.settle(next!, "rotated", "active", now)).toBe(false);
    expect(await store.lookup({ externalUserId: "external-owner", accountId: first.accountId }, now)).toBeNull();
  });

  it("allows owner revocation of expired credentials without admitting expired refresh", async () => {
    const row = await connect();
    await db.updateServiceStatus(row.connectionId, "expired");
    const expired = await store.byConnection({ userId, connectionId: row.connectionId });
    expect(expired?.status).toBe("expired");
    expect(await store.acquireLease(expired!, now)).toBeNull();
    const revoke = await store.acquireLease(expired!, now, "revoke");
    expect(revoke).not.toBeNull();
    expect(await store.remove(revoke!, now)).toBe(true);
  });

  it("serializes consent and revocation across a durable bounded owner lease", async () => {
    const lock = await store.acquireOwnerLease(userId, now);
    expect(lock).not.toBeNull();
    expect(await store.acquireOwnerLease(userId, now)).toBeNull();
    expect(await store.acquireOwnerLease(userId, new Date(now.getTime()+30_001))).not.toBeNull();
    await store.releaseOwnerLease(userId, lock!);
    expect(await store.acquireOwnerLease(userId, new Date(now.getTime()+30_001))).toBeNull();
  });

  it("expires failed refresh leases, settles invalid grants without resurrection and cascades deletion", async () => {
    const row = await connect();
    const lease = await store.acquireLease(row, now);
    const later = new Date(now.getTime() + 30_001);
    expect(await store.settle(lease!, "late", "active", later)).toBe(false);
    const replacement = await store.acquireLease(row, later);
    expect(replacement).not.toBeNull();
    expect(await store.settle(replacement!, row.encryptedCredentials, "expired", later)).toBe(true);
    expect(await store.lookup({ externalUserId: "external-owner", accountId: row.accountId })).toBeNull();
    await db.raw("DELETE FROM users WHERE id = $1", [userId]);
    expect(await store.byConnection({ userId, connectionId: row.connectionId })).toBeNull();
  });
});
