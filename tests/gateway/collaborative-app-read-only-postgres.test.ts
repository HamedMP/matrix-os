import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createAppInstanceAdapter } from "../../packages/gateway/src/collaboration/app-instance-adapter.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { createScopedAppBridge } from "../../packages/gateway/src/collaboration/scoped-app-bridge.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

// Outcome (ENG-579): an owner shares an app that isn't collaborative; organization members see the
// owner's existing records but cannot change them, while the owner keeps full use.
// Faults detected: a blocked build being unshareable, a member write reaching owner tables, the
// refusal surfacing as an access loss, and the platform directory hiding the share.

const now = new Date("2026-11-25T10:00:00.000Z");
const ownerId = "user_owner";
const memberId = "user_member";
const organizationId = "org_matrix_team";
const appId = "notes";
const catalogId = "50000000-0000-4000-8000-000000000002";
const readinessId = "60000000-0000-4000-8000-000000000002";
const scopeId = "70000000-0000-4000-8000-000000000002";
const build = {
  appId,
  catalogId,
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "undeclared",
  runtimeAbi: "undeclared",
};
const blockedGates = [
  { code: "declaration" as const, status: "blocked" as const, action: "Declare this app's collaborative capability and recheck." },
  { code: "cleanup" as const, status: "passed" as const },
];

describe("read-only organization app share", () => {
  let fixture: CollaborationTestDatabase;
  let adapter: ReturnType<typeof createAppInstanceAdapter>;
  let authority: CollaborationAuthority;
  const kv = { read: vi.fn(async (app: string, key: string) => app === appId && key === "settings" ? "{\"theme\":\"dark\"}" : null) };

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await sql`CREATE SCHEMA notes`.execute(fixture.db);
    await sql`CREATE TABLE notes.items (id TEXT PRIMARY KEY, title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(fixture.db);
    for (let index = 1; index <= 3; index += 1) {
      await sql`INSERT INTO notes.items (id, title) VALUES (${`note-${index}`}, ${`Note ${index}`})`.execute(fixture.db);
    }
    const catalog = new CollaborationResourceCatalog(fixture.db, { now: () => now, createId: () => catalogId });
    await catalog.register({ ownerId, projectId: null, kind: "app", path: appId, incarnation: build.registrationIncarnation });
    const readiness = new CollaborativeAppReadinessRepository(fixture.db, { now: () => now, createId: () => readinessId });
    await readiness.createOrGet({ ownerId, build, artifactRef: `objects/${build.buildId}`, verifierVersion: "v1" });
    await readiness.transition({ id: readinessId, ownerId, expectedRevision: 1, status: "blocked", gateResults: blockedGates });
    await new CollaborativeAppShareRepository(fixture.db, { now: () => now, createId: () => scopeId }).createAtomic({
      ownerId, organizationId, catalogId, readinessId,
      expectedResourceRevision: 0, expectedReadinessRevision: 2, expectedBuildId: build.buildId,
      expectedBinding: null, clientRequestId: randomUUID(), payloadHash: "f".repeat(64), runtimeId: "runtime_owner",
    });
    authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
      now: () => now,
      organizationPrecondition: { require: async ({ actorId, organizationId: requested }) => {
        if (requested !== organizationId || ![ownerId, memberId].includes(actorId)) throw new Error("not current");
        return { actorId, organizationId: requested, membershipEpoch: "epoch-1" };
      } } as never,
    });
    adapter = createAppInstanceAdapter({
      db: fixture.db,
      authority,
      catalog,
      bridge: createScopedAppBridge({
        resolveApp: async (requested) => requested === appId ? { storageSchema: appId,
          tables: { items: { columns: { id: "text", title: "text" } } }, installedVersion: "1.0.0" } : null,
      }),
      now: () => now,
      onCommitted: vi.fn(async () => undefined),
      kv,
      apps: { resolve: async (projectId, requested) => projectId === null && requested === appId
        ? { projectId, appId, bridgeAppId: appId, collaborationMode: "scoped", incarnation: build.registrationIncarnation }
        : null },
    });
  });

  afterEach(async () => fixture.destroy());

  it("lets a member read the owner's records and describes the share as read-only", async () => {
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    expect(member.role).toBe("viewer");
    await expect(adapter.describe(member, appId)).resolves.toMatchObject({
      readiness: "ready", collaborativeBuildId: build.buildId, access: "read_only",
    });
    const listed = await adapter.query(member, appId, { action: "find", table: "items", orderBy: { id: "asc" } });
    expect((listed.result as Array<{ id: string }>).map((row) => row.id)).toEqual(["note-1", "note-2", "note-3"]);
  });

  it("refuses every member write as view-only and leaves owner tables untouched", async () => {
    await expect(authority.authorize({ scopeId, actorId: memberId, action: "mutate_resource" }))
      .rejects.toMatchObject({ code: "forbidden", reason: "read_only" });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    await expect(adapter.mutate(member, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "insert", table: "items", data: { id: "note-4", title: "Sneaky" } },
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(sql<{ count: string }>`SELECT count(*)::text AS count FROM notes.items`.execute(fixture.db))
      .resolves.toMatchObject({ rows: [{ count: "3" }] });
  });

  it("lets a member read the owner's key-value data for the shared app only", async () => {
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    await expect(adapter.readData!(member, appId, "settings")).resolves.toEqual({ value: "{\"theme\":\"dark\"}" });
    await expect(adapter.readData!(member, appId, "missing")).resolves.toEqual({ value: null });
    // Keys normalize like the owner's own bridge: an app that saved "clock.zones" reads "clockzones".
    await expect(adapter.readData!(member, appId, "set.tings")).resolves.toEqual({ value: "{\"theme\":\"dark\"}" });
    await expect(adapter.readData!(member, appId, "..")).rejects.toMatchObject({ code: "invalid_action" });
    await expect(adapter.readData!(member, "other-app", "settings")).rejects.toMatchObject({ code: "not_found" });
    expect(kv.read).toHaveBeenCalledTimes(3);
    expect(kv.read).toHaveBeenLastCalledWith(appId, "settings");
  });

  it("stops key-value reads once the owner stops sharing", async () => {
    const shares = new CollaborativeAppShareRepository(fixture.db, { now: () => now });
    const binding = await shares.getActiveByCatalog({ ownerId, catalogId });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    await shares.stopAtomic({ scopeId, ownerId, expectedScopeRevision: 1, expectedBindingRevision: binding!.revision,
      clientRequestId: randomUUID(), payloadHash: "a".repeat(64) });
    kv.read.mockClear();
    await expect(adapter.readData!(member, appId, "settings")).rejects.toThrow();
    expect(kv.read).not.toHaveBeenCalled();
  });

  // Fault: access was checked only before the KV read, so a stop that committed mid-read still
  // returned owner data.
  it("returns nothing from a key-value read whose share stopped while it was in flight", async () => {
    const shares = new CollaborativeAppShareRepository(fixture.db, { now: () => now });
    const binding = await shares.getActiveByCatalog({ ownerId, catalogId });
    const member = await authority.authorize({ scopeId, actorId: memberId, action: "read" });
    kv.read.mockImplementationOnce(async () => {
      await shares.stopAtomic({ scopeId, ownerId, expectedScopeRevision: 1, expectedBindingRevision: binding!.revision,
        clientRequestId: randomUUID(), payloadHash: "a".repeat(64) });
      return "{\"theme\":\"dark\"}";
    });
    await expect(adapter.readData!(member, appId, "settings")).rejects.toThrow();
  });

  it("keeps the owner's full use of their own app", async () => {
    const owner = await authority.authorize({ scopeId, actorId: ownerId, action: "mutate_resource" });
    await expect(adapter.mutate(owner, appId, {
      clientRequestId: randomUUID(), expectedRevision: 0,
      action: { action: "insert", table: "items", data: { id: "note-4", title: "Owner note" } },
    })).resolves.toMatchObject({ revision: 1, replayed: false });
  });

  it("publishes the read-only share to the platform directory as active", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db, platformBaseUrl: "https://platform.internal", runtimeId: "runtime_owner",
      serviceToken: "runtime-service-secret-0123456789abcdef", fetchImpl, now: () => now, startTimer: false,
    });
    expect(await worker.runOnce()).toBe(1);
    const payload = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as { app?: { state: string } };
    expect(payload.app).toMatchObject({ state: "active" });
    await worker.shutdown();
  });

  it("stops serving the share once its readiness is invalidated by a rebuild", async () => {
    await new CollaborativeAppReadinessRepository(fixture.db, { now: () => now }).invalidateDriftedBuilds({
      ownerId, catalogId, currentBuildId: "9".repeat(64),
    });
    await expect(authority.authorize({ scopeId, actorId: memberId, action: "read" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
