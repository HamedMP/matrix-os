import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createAppInstanceAdapter } from "../../packages/gateway/src/collaboration/app-instance-adapter.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { createScopedAppBridge } from "../../packages/gateway/src/collaboration/scoped-app-bridge.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const now = new Date("2026-11-05T10:00:00.000Z");
const ownerId = "user_owner";
const memberId = "user_member";
const organizationId = "org_matrix_team";
const appId = "teamtracker";
const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessId = "60000000-0000-4000-8000-000000000001";
const scopeId = "70000000-0000-4000-8000-000000000001";
const build = {
  appId,
  catalogId,
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};

describe("collaborative app owner/member common Postgres data", () => {
  let fixture: CollaborationTestDatabase;
  let shares: CollaborativeAppShareRepository;
  let adapter: ReturnType<typeof createAppInstanceAdapter>;
  let authority: CollaborationAuthority;
  const onCommitted = vi.fn(async () => undefined);

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await sql`CREATE SCHEMA teamtracker`.execute(fixture.db);
    // Mirrors a generated Matrix app table: the registry adds created_at/updated_at timestamptz columns.
    await sql`CREATE TABLE teamtracker.tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false, due DATE, score DOUBLE PRECISION,
      meta JSONB, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(fixture.db);
    for (let index = 1; index <= 20; index += 1) {
      await sql`INSERT INTO teamtracker.tasks (id, title) VALUES (${`task-${index}`}, ${`Task ${index}`})`.execute(fixture.db);
    }
    const catalog = new CollaborationResourceCatalog(fixture.db, { now: () => now, createId: () => catalogId });
    await catalog.register({ ownerId, projectId: null, kind: "app", path: appId, incarnation: build.registrationIncarnation });
    const readiness = new CollaborativeAppReadinessRepository(fixture.db, { now: () => now, createId: () => readinessId });
    await readiness.createOrGet({ ownerId, build, artifactRef: `objects/${build.buildId}`, verifierVersion: "v1" });
    await readiness.transition({
      id: readinessId, ownerId, expectedRevision: 1, status: "ready",
      gateResults: [{ code: "cleanup", status: "passed" }], verifiedAt: now,
    });
    shares = new CollaborativeAppShareRepository(fixture.db, { now: () => now, createId: () => scopeId });
    await shares.createAtomic({
      ownerId, organizationId, catalogId, readinessId,
      expectedResourceRevision: 0, expectedReadinessRevision: 2, expectedBuildId: build.buildId,
      expectedBinding: null,
      clientRequestId: randomUUID(), payloadHash: "f".repeat(64), runtimeId: "runtime_owner",
    });
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
      now: () => now,
      organizationPrecondition: { require: async ({ actorId, organizationId: requested }) => {
        if (requested !== organizationId || ![ownerId, memberId].includes(actorId)) throw new Error("not current");
        return { actorId, organizationId: requested, membershipEpoch: "epoch-1" };
      } } as never,
    });
    const bridge = createScopedAppBridge({
      resolveApp: async (requested) => requested === appId ? { storageSchema: appId,
        tables: { tasks: { columns: { id: "text", title: "text" } } }, installedVersion: "1.0.0" } : null,
    });
    adapter = createAppInstanceAdapter({
      db: fixture.db,
      authority,
      catalog,
      bridge,
      now: () => now,
      onCommitted,
      apps: { resolve: async (projectId, requested) => projectId === null && requested === appId
        ? { projectId, appId, bridgeAppId: appId, collaborationMode: "scoped", incarnation: build.registrationIncarnation }
        : null },
    });
  });

  afterEach(async () => fixture.destroy());

  it("reads 20 existing rows from both accounts, mutates once, reloads, and replays a lost response", async () => {
    const owner = await authority.authorize({ scopeId, actorId: ownerId, action: "read" });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    await expect(adapter.describe(member, appId)).resolves.toMatchObject({
      collaborativeBuildId: build.buildId,
      revision: 0,
    });
    await expect(adapter.query(member, appId, { action: "appInfo", app: appId })).resolves.toEqual({
      result: { installedVersion: "1.0.0" },
      revision: 0,
    });
    const find = { action: "find", app: appId, table: "tasks", orderBy: { id: "asc" } };
    expect(await adapter.query(owner, appId, find)).toMatchObject({ result: expect.any(Array), revision: 0 });
    expect((await adapter.query(member, appId, find)).result).toHaveLength(20);
    const clientRequestId = randomUUID();
    const mutation = {
      clientRequestId,
      expectedRevision: 0,
      action: { action: "insert", app: appId, table: "tasks", data: { id: "task-21", title: "Shared task" } },
    };
    await expect(adapter.mutate(member, appId, mutation)).resolves.toEqual({
      result: { id: "task-21" }, revision: 1, replayed: false,
    });
    await expect(adapter.mutate(member, appId, mutation)).resolves.toEqual({
      result: { id: "task-21" }, revision: 1, replayed: true,
    });
    expect(await adapter.query(owner, appId, find)).toMatchObject({ result: expect.any(Array), revision: 1 });
    expect((await adapter.query(member, appId, find)).result).toHaveLength(21);
    const binding = await shares.getActiveByCatalog({ ownerId, catalogId });
    expect(binding).toMatchObject({ dataRevision: 1 });
    const events = await fixture.db.selectFrom("collaboration_events")
      .select(["event_type", "payload", "revision"]).where("scope_id", "=", scopeId).execute();
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ event_type: "resource.app.changed", revision: 1 });
    expect(JSON.stringify(events.at(-1)?.payload)).not.toContain("Shared task");
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it("loads an existing timestamp-bearing task identically for the owner and a member, then edits and deletes it", async () => {
    onCommitted.mockClear();
    await sql`DELETE FROM teamtracker.tasks`.execute(fixture.db);
    await sql`INSERT INTO teamtracker.tasks (id, title, meta, created_at, updated_at)
      VALUES ('existing', 'Existing task', ${JSON.stringify({ tags: ["ops"], nested: { level: 1, when: "2026-11-12" } })}::jsonb,
        '2026-11-12T13:44:05.123Z', '2026-11-12T14:00:00.000+02:00')`.execute(fixture.db);
    const expected = {
      id: "existing", title: "Existing task", done: false, due: null, score: null,
      meta: { tags: ["ops"], nested: { level: 1, when: "2026-11-12" } }, completed_at: null,
      created_at: "2026-11-12T13:44:05.123Z", updated_at: "2026-11-12T12:00:00.000Z",
    };
    const owner = await authority.authorize({ scopeId, actorId: ownerId, action: "read" });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "mutate_resource" });
    const find = { action: "find", app: appId, table: "tasks", orderBy: { created_at: "desc", id: "asc" }, limit: 100 };

    await expect(adapter.query(owner, appId, find)).resolves.toEqual({ result: [expected], revision: 0 });
    await expect(adapter.query(member, appId, find)).resolves.toEqual({ result: [expected], revision: 0 });
    await expect(adapter.query(member, appId, { action: "findOne", app: appId, table: "tasks", id: "existing" }))
      .resolves.toEqual({ result: expected, revision: 0 });
    await expect(adapter.query(member, appId, { action: "count", app: appId, table: "tasks" }))
      .resolves.toEqual({ result: 1, revision: 0 });

    await expect(adapter.mutate(member, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "update", app: appId, table: "tasks", id: "existing", data: { done: true, completed_at: "2026-11-13T09:30:00.000Z" } },
    })).resolves.toEqual({ result: { ok: true }, revision: 1, replayed: false });
    const edited = (await adapter.query(owner, appId, find)) as { result: Array<Record<string, unknown>>; revision: number };
    expect(edited).toEqual({ result: [{ ...expected, done: true, completed_at: "2026-11-13T09:30:00.000Z" }], revision: 1 });
    expect(JSON.parse(JSON.stringify(edited.result))).toEqual(edited.result);

    await expect(adapter.mutate(owner, appId, {
      clientRequestId: randomUUID(), expectedRevision: 1,
      action: { action: "delete", app: appId, table: "tasks", id: "existing" },
    })).resolves.toEqual({ result: { ok: true }, revision: 2, replayed: false });
    await expect(adapter.query(member, appId, find)).resolves.toEqual({ result: [], revision: 2 });
    expect(onCommitted).toHaveBeenCalledTimes(2);
    const events = await fixture.db.selectFrom("collaboration_events").select(["event_type", "revision"])
      .where("scope_id", "=", scopeId).where("event_type", "=", "resource.app.changed").orderBy("scope_seq").execute();
    expect(events.map((event) => Number(event.revision))).toEqual([1, 2]);
  });

  it("fails closed without partial data for non-finite numbers and oversized results", async () => {
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "mutate_resource" });
    await sql`UPDATE teamtracker.tasks SET score = 'NaN'::double precision WHERE id = 'task-1'`.execute(fixture.db);
    await expect(adapter.query(member, appId, { action: "findOne", app: appId, table: "tasks", id: "task-1" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.query(member, appId, { action: "findOne", app: appId, table: "tasks", id: "task-2" }))
      .resolves.toMatchObject({ result: { id: "task-2", created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) } });

    await sql`UPDATE teamtracker.tasks SET score = NULL, title = repeat('x', 1024 * 1024) WHERE id = 'task-1'`.execute(fixture.db);
    await expect(adapter.query(member, appId, { action: "findOne", app: appId, table: "tasks", id: "task-1" }))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(adapter.mutate(member, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "update", app: appId, table: "tasks", id: "task-2", data: { title: "Still writable" } },
    })).resolves.toMatchObject({ revision: 1 });
  });

  it("rejects a stale writer in the binding update and preserves the winning owner record", async () => {
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "mutate_resource" });
    const insert = (id: string) => adapter.mutate(member, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "insert", app: appId, table: "tasks", data: { id, title: id } },
    });
    await expect(insert("winner")).resolves.toMatchObject({ revision: 1 });
    await expect(insert("stale")).rejects.toMatchObject({ code: "conflict" });
    expect((await sql<{ id: string }>`SELECT id FROM teamtracker.tasks WHERE id IN ('winner', 'stale') ORDER BY id`.execute(fixture.db)).rows)
      .toEqual([{ id: "winner" }]);
  });

  it("lets the owner stop sharing after a member changes app data", async () => {
    const before = await shares.getActiveByCatalog({ ownerId, catalogId });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "mutate_resource" });
    await expect(adapter.mutate(member, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "insert", app: appId, table: "tasks", data: { id: "task-21", title: "Shared task" } },
    })).resolves.toMatchObject({ revision: 1 });
    expect(await shares.getActiveByCatalog({ ownerId, catalogId })).toMatchObject({
      revision: before!.revision, dataRevision: 1,
    });
    await expect(shares.stopAtomic({
      scopeId, ownerId, expectedScopeRevision: 1, expectedBindingRevision: before!.revision,
      clientRequestId: randomUUID(), payloadHash: "a".repeat(64),
    })).resolves.toMatchObject({ didStop: true, binding: { state: "stopped" } });
    await expect(authority.authorize({ scopeId, actorId: memberId, action: "read" })).rejects.toThrow();
  });

  it("does not wait on a readiness row lock after taking the live scope lock", async () => {
    let releaseReadiness!: () => void;
    let readinessLocked!: () => void;
    const locked = new Promise<void>((resolve) => { readinessLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const holder = fixture.db.transaction().execute(async (trx) => {
      await trx.selectFrom("collaboration_app_readiness").select("id")
        .where("id", "=", readinessId).forUpdate().executeTakeFirstOrThrow();
      readinessLocked();
      await release;
    });
    await locked;

    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    const pending = adapter.query(member, appId, {
      action: "find",
      app: appId,
      table: "tasks",
      limit: 1,
    });
    const result = await Promise.race([
      pending.then(() => "completed" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 500)),
    ]);

    releaseReadiness();
    await holder;
    await pending;
    expect(result).toBe("completed");
  });
});
