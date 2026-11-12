import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { CollaborativeAppLaunchSessions } from "../../packages/platform/src/collaboration/app-launch-sessions.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createRealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

it("recovers app launches across platform processes and serializes concurrent idempotent admission in real Postgres", async () => {
  const fixture = await createRealPlatformCollaborationTestDatabase();
  const db = fixture.collaborationDb;
  let now = Date.now();
  const options = { db, now: () => now, startTimer: false, ttlMs: 60_000, maxSessions: 4, maxPerActor: 2,
    open: async () => ({ request: async () => new Response("shared module", {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    }), close: async () => undefined }) };
  const first = new CollaborativeAppLaunchSessions(options);
  const second = new CollaborativeAppLaunchSessions(options);
  const restarted = new CollaborativeAppLaunchSessions(options);
  const conflicting = new CollaborativeAppLaunchSessions(options);
  const identity = { actorId: "user_member", scopeId: randomUUID(), organizationId: "org_team", runtimeId: "runtime_owner",
    authorityGeneration: 1, appId: "tasks", catalogId: randomUUID(), buildId: "b".repeat(64), shareRevision: 1 };
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    const clientRequestId = randomUUID();
    const [left, right] = await Promise.all([
      first.create({ ...identity, clientRequestId }), second.create({ ...identity, clientRequestId }),
    ]);
    expect(left).toEqual(right);
    expect(await db.selectFrom("collaboration_app_launches").selectAll().execute()).toHaveLength(1);
    await first.close();
    await second.close();
    expect(await restarted.resolve(left.launchId, identity.actorId, identity.scopeId)).toEqual(identity);
    expect(await restarted.resolve(left.launchId, "user_outsider", identity.scopeId)).toBeNull();
    const asset = await restarted.request({ launchId: left.launchId, actorId: identity.actorId,
      scopeId: identity.scopeId, assetPath: "assets/main.js" });
    expect(await asset.text()).toBe("shared module");
    expect(await restarted.create({ ...identity, clientRequestId })).toEqual(left);
    await expect(conflicting.create({ ...identity, clientRequestId, buildId: "c".repeat(64) }))
      .rejects.toMatchObject({ code: "conflict" });
    await restarted.revokeActor(identity.scopeId, identity.actorId);
    expect(await restarted.resolve(left.launchId, identity.actorId, identity.scopeId)).toBeNull();
    const fresh = await restarted.create({ ...identity, clientRequestId: randomUUID() });
    now += 60_001;
    await restarted.sweep();
    expect(await restarted.resolveAssetCapability(fresh.launchId, identity.scopeId)).toBeNull();
    expect(await db.selectFrom("collaboration_app_launches").selectAll().execute()).toEqual([]);
  } finally {
    await Promise.all([first.close(), second.close(), restarted.close(), conflicting.close()]);
    await fixture.destroy();
  }
});

it("enforces shared launch capacity across independent workers and invalidates evicted cached launches", async () => {
  const fixture = await createRealPlatformCollaborationTestDatabase();
  const db = fixture.collaborationDb;
  const options = { db, startTimer: false, maxSessions: 3, maxPerActor: 2,
    open: async () => ({ request: async () => new Response("module", {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    }), close: async () => undefined }) };
  const left = new CollaborativeAppLaunchSessions(options);
  const right = new CollaborativeAppLaunchSessions(options);
  const identity = { actorId: "user_member", scopeId: randomUUID(), organizationId: "org_team", runtimeId: "runtime_owner",
    authorityGeneration: 1, appId: "tasks", catalogId: randomUUID(), buildId: "b".repeat(64), shareRevision: 1 };
  try {
    await bootstrapPlatformCollaborationDatabase(db);
    const original = await left.create({ ...identity, clientRequestId: randomUUID() });
    await Promise.all(Array.from({ length: 4 }, (_, index) => (index % 2 ? left : right).create({
      ...identity, clientRequestId: randomUUID(),
    })));
    expect(await db.selectFrom("collaboration_app_launches").selectAll().execute()).toHaveLength(2);
    expect(await left.resolve(original.launchId, identity.actorId, identity.scopeId)).toBeNull();
    await expect(left.request({ launchId: original.launchId, actorId: identity.actorId,
      scopeId: identity.scopeId, assetPath: "assets/main.js" })).rejects.toMatchObject({ code: "not_found" });
    for (const actorId of ["user_second", "user_third"]) {
      await right.create({ ...identity, actorId, clientRequestId: randomUUID() });
    }
    expect(await db.selectFrom("collaboration_app_launches").selectAll().execute()).toHaveLength(3);
    await right.revokeScope(identity.scopeId);
    expect(await db.selectFrom("collaboration_app_launches").selectAll().execute()).toEqual([]);
  } finally {
    await Promise.all([left.close(), right.close()]);
    await fixture.destroy();
  }
});
