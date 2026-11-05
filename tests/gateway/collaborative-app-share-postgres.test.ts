import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../../packages/gateway/src/collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../../packages/gateway/src/collaboration/collaborative-app-share-repository.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { CollaborationResourceCatalog } from "../../packages/gateway/src/collaboration/resource-catalog.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const catalogId = "50000000-0000-4000-8000-000000000001";
const readinessId = "60000000-0000-4000-8000-000000000001";
const scopeId = "70000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-05T10:00:00.000Z");
const build = {
  appId: "team-tracker",
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
const input = {
  ownerId: "user_owner",
  organizationId: "org_matrix_team",
  catalogId,
  readinessId,
  expectedResourceRevision: 0,
  expectedReadinessRevision: 2,
  expectedBuildId: build.buildId,
  clientRequestId: "80000000-0000-4000-8000-000000000001",
  payloadHash: "f".repeat(64),
  runtimeId: "runtime_owner",
};

describe("collaborative app atomic share creation", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborativeAppShareRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await new CollaborationResourceCatalog(fixture.db, { now: () => now, createId: () => catalogId }).register({
      ownerId: input.ownerId,
      projectId: null,
      kind: "app",
      path: build.appId,
      incarnation: build.registrationIncarnation,
    });
    const readiness = new CollaborativeAppReadinessRepository(fixture.db, { now: () => now, createId: () => readinessId });
    await readiness.createOrGet({ ownerId: input.ownerId, build, artifactRef: `objects/${build.buildId}`, verifierVersion: "v1" });
    await readiness.transition({
      id: readinessId,
      ownerId: input.ownerId,
      expectedRevision: 1,
      status: "ready",
      gateResults: [{ code: "cleanup", status: "passed" }],
      verifiedAt: now,
    });
    repository = new CollaborativeAppShareRepository(fixture.db, { now: () => now, createId: () => scopeId });
  });

  afterEach(async () => fixture.destroy());

  it("commits one scope, binding, owner invariant, operation, audit, event, and directory outbox and replays exactly", async () => {
    const first = await repository.createAtomic(input);
    expect(first).toMatchObject({ scopeId, binding: { scopeId, catalogId, readinessId, buildId: build.buildId } });
    expect(await repository.createAtomic(input)).toEqual(first);
    await expect(repository.createAtomic({ ...input, payloadHash: "9".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
    for (const [table, expected] of [
      ["collaboration_scopes", 1],
      ["collaboration_app_bindings", 1],
      ["collaboration_members", 1],
      ["collaboration_operations", 1],
      ["collaboration_audit", 1],
      ["collaboration_events", 1],
      ["collaboration_directory_outbox", 1],
    ] as const) {
      const rows = await fixture.db.selectFrom(table).selectAll().execute();
      expect(rows, table).toHaveLength(expected);
    }
    const member = await fixture.db.selectFrom("collaboration_members").selectAll().executeTakeFirstOrThrow();
    expect(member).toMatchObject({ actor_id: input.ownerId, role: "owner", status: "accepted" });
  });

  it("rolls back every related write when the final outbox insert fails", async () => {
    await sql`ALTER TABLE collaboration_directory_outbox
      ADD CONSTRAINT reject_app_share_test CHECK (resource_kind <> 'app')`.execute(fixture.db);
    await expect(repository.createAtomic(input)).rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("collaboration_app_bindings").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("collaboration_members").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("collaboration_operations").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("collaboration_audit").selectAll().execute()).toHaveLength(0);
    expect(await fixture.db.selectFrom("collaboration_events").selectAll().execute()).toHaveLength(0);
  });

  it("projects app shares to current organization membership without grants or recipient rows", async () => {
    await repository.createAtomic(input);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const worker = new CollaborationDirectoryOutbox({
      db: fixture.db,
      platformBaseUrl: "https://platform.internal",
      runtimeId: input.runtimeId,
      serviceToken: "runtime-service-secret-0123456789abcdef",
      fetchImpl,
      now: () => now,
      startTimer: false,
    });
    expect(await worker.runOnce()).toBe(1);
    const payload = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      kind: string;
      audience?: string;
      organizationGrantId?: string;
      recipients: Array<{ actorId: string }>;
    };
    expect(payload).toMatchObject({ kind: "app", audience: "current_membership" });
    expect(payload.organizationGrantId).toBeUndefined();
    expect(payload.recipients).toEqual([{ actorId: input.ownerId, status: "accepted" }]);
    expect(await fixture.db.selectFrom("collaboration_grants").selectAll().execute()).toHaveLength(0);
    await worker.shutdown();
  });

  it("atomically stops with both revisions, bumps auth epoch, records revocation, and retains owner state", async () => {
    await repository.createAtomic(input);
    const stopInput = {
      scopeId,
      ownerId: input.ownerId,
      expectedScopeRevision: 1,
      expectedBindingRevision: 1,
      clientRequestId: "80000000-0000-4000-8000-000000000002",
      payloadHash: "9".repeat(64),
    };
    const stopped = await repository.stopAtomic(stopInput);
    expect(stopped).toMatchObject({ scopeRevision: 2, authEpoch: 2, binding: { state: "stopped", revision: 2 } });
    expect(await repository.stopAtomic(stopInput)).toEqual(stopped);
    await expect(repository.stopAtomic({ ...stopInput, payloadHash: "8".repeat(64) }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.db.selectFrom("collaboration_scopes").select(["lifecycle", "revision", "auth_epoch"])
      .executeTakeFirstOrThrow()).toMatchObject({ lifecycle: "archived", revision: 2, auth_epoch: 2 });
    expect(await fixture.db.selectFrom("collaboration_operations").selectAll().execute()).toHaveLength(2);
    expect(await fixture.db.selectFrom("collaboration_audit").selectAll().execute()).toHaveLength(2);
    expect(await fixture.db.selectFrom("collaboration_events").selectAll().execute()).toHaveLength(2);
    expect(await fixture.db.selectFrom("collaboration_directory_outbox").selectAll().execute()).toHaveLength(2);
    expect(await fixture.db.selectFrom("collaboration_resource_catalog").selectAll().execute()).toHaveLength(1);
    expect(await fixture.db.selectFrom("collaboration_app_readiness").selectAll().execute()).toHaveLength(1);
  });
});
