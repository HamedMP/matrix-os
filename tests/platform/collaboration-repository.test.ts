import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import {
  PlatformCollaborationRepository,
  PlatformCollaborationRepositoryError,
} from "../../packages/platform/src/collaboration/repository.js";
import {
  createPlatformCollaborationTestDatabase,
  createRealPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type RealPlatformCollaborationTestDatabase,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const scopeId = "10000000-0000-4000-8000-000000000001";

describe("PlatformCollaborationRepository", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("stores content-free directory and recipient discovery projections idempotently", async () => {
    const event = {
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat" as const,
      authorityGeneration: 1,
      metadataRevision: 2,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "invited" as const }],
    };
    await repository.applyDirectoryEvent(event);
    await repository.applyDirectoryEvent(event);

    expect(await repository.listForActor(platformCollaborationActors.recipientWithoutComputer)).toEqual([{
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      status: "invited",
    }]);
    expect(JSON.stringify(await fixture.collaborationDb.selectFrom("collaboration_directory").selectAll().execute()))
      .not.toMatch(/title|message|transcript|content/i);
  });

  it("projects standalone file, folder and app scopes for member discovery", async () => {
    for (const [index, kind] of (["file", "folder", "app"] as const).entries()) {
      const resourceScopeId = `10000000-0000-4000-8000-${(index + 101).toString().padStart(12, "0")}`;
      await repository.applyDirectoryEvent({
        eventId: `20000000-0000-4000-8000-${(index + 101).toString().padStart(12, "0")}`,
        scopeId: resourceScopeId,
        runtimeId: "runtime_owner",
        ownerId: platformCollaborationActors.owner,
        kind,
        organizationId: "org_matrix_team",
        authorityGeneration: 1,
        metadataRevision: 1,
        recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "invited" }],
      });
      await expect(repository.getDirectoryRoute(resourceScopeId)).resolves.toMatchObject({ kind });
    }
    const shares = await repository.listForActor(platformCollaborationActors.recipientWithoutComputer);
    expect(shares.map((share) => share.kind)).toEqual(["file", "folder", "app"]);
  });

  it("upgrades an existing directory kind constraint before accepting standalone resources", async () => {
    await sql`ALTER TABLE collaboration_directory DROP CONSTRAINT collaboration_directory_kind_check`.execute(fixture.collaborationDb);
    await sql`ALTER TABLE collaboration_directory ADD CONSTRAINT collaboration_directory_kind_check
      CHECK (kind IN ('chat', 'terminal', 'project'))`.execute(fixture.collaborationDb);

    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000104",
      scopeId: "10000000-0000-4000-8000-000000000104",
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "file",
      organizationId: "org_matrix_team",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "invited" }],
    });
    await expect(repository.getDirectoryRoute("10000000-0000-4000-8000-000000000104"))
      .resolves.toMatchObject({ kind: "file" });
  });

  it("does not let a different event at the same revision replace newer directory state", async () => {
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000010",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 2,
      metadataRevision: 4,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
    });
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000009",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 4,
      recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "revoked" }],
    });

    expect(await repository.listForActor(platformCollaborationActors.recipientWithoutComputer)).toMatchObject([{
      authorityGeneration: 2,
      status: "accepted",
    }]);
  });

  it("removes revoked discovery projections through a bounded retention cleanup", async () => {
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000020",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.outsider, status: "revoked" }],
    });

    await expect(repository.cleanupRevokedDirectoryEntries({
      olderThan: "2026-09-07T12:00:01.000Z",
      limit: 1,
    })).resolves.toBe(1);
    await expect(fixture.collaborationDb.selectFrom("collaboration_user_index").selectAll().execute())
      .resolves.toEqual([]);
    await expect(fixture.collaborationDb.selectFrom("collaboration_directory").selectAll().execute())
      .resolves.toEqual([]);
  });

  it("paginates one actor and status without dropping entries at the same timestamp", async () => {
    for (let index = 1; index <= 3; index += 1) {
      await repository.applyDirectoryEvent({
        eventId: `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        scopeId: `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        runtimeId: "runtime_owner",
        ownerId: platformCollaborationActors.owner,
        kind: "chat",
        authorityGeneration: 1,
        metadataRevision: 1,
        recipients: [{ actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" }],
      });
    }
    const first = await repository.listForActorPage(
      platformCollaborationActors.recipientWithoutComputer,
      "accepted",
      { limit: 2 },
    );
    expect(first.items.map((entry) => entry.scopeId)).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ]);
    expect(first.nextCursor).toBeDefined();
    const second = await repository.listForActorPage(
      platformCollaborationActors.recipientWithoutComputer,
      "accepted",
      { limit: 2, after: first.nextCursor },
    );
    expect(second.items.map((entry) => entry.scopeId)).toEqual([
      "10000000-0000-4000-8000-000000000003",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("stores only hashed one-use tickets, enforces expiry, and caps outstanding tickets", async () => {
    const first = await repository.createConnectionTicket({
      token: "ticket-secret-one",
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
      expiresAt: "2026-09-07T12:00:30.000Z",
    });
    const rows = await fixture.collaborationDb.selectFrom("collaboration_connection_tickets")
      .selectAll().execute();
    expect(rows[0]?.token_hash).toBe(createHash("sha256").update("ticket-secret-one").digest("hex"));
    expect(JSON.stringify(rows)).not.toContain("ticket-secret-one");
    await expect(repository.consumeConnectionTicket({
      token: "ticket-secret-one",
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
    })).resolves.toMatchObject({ ticketId: first.ticketId });
    await expect(repository.consumeConnectionTicket({
      token: "ticket-secret-one",
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
    })).rejects.toMatchObject({ code: "invalid_ticket" });

    for (let index = 0; index < 20; index += 1) {
      await repository.createConnectionTicket({
        token: `ticket-${index}`,
        actorId: platformCollaborationActors.outsider,
        scopeId,
        purpose: "events",
        expiresAt: "2026-09-07T12:00:30.000Z",
      });
    }
    await expect(repository.createConnectionTicket({
      token: "ticket-over-cap",
      actorId: platformCollaborationActors.outsider,
      scopeId,
      purpose: "events",
      expiresAt: "2026-09-07T12:00:30.000Z",
    })).rejects.toBeInstanceOf(PlatformCollaborationRepositoryError);
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("PlatformCollaborationRepository PostgreSQL cleanup races", () => {
  let fixture: RealPlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;

  beforeEach(async () => {
    fixture = await createRealPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("preserves a fresh recipient committed while revoked cleanup waits on the directory", async () => {
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000030",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [{ actorId: platformCollaborationActors.outsider, status: "revoked" }],
    });

    let directoryLocked!: () => void;
    const locked = new Promise<void>((resolve) => { directoryLocked = resolve; });
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = fixture.collaborationDb.transaction().execute(async (trx) => {
      await trx.selectFrom("collaboration_directory")
        .select("scope_id")
        .where("scope_id", "=", scopeId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      directoryLocked();
      await writerGate;
      await trx.insertInto("collaboration_user_index").values({
        actor_id: platformCollaborationActors.recipientWithoutComputer,
        scope_id: scopeId,
        status: "accepted",
        invitation_id: null,
        locator_generation: 1,
        last_event_id: "20000000-0000-4000-8000-000000000031",
        updated_at: now.toISOString(),
      }).execute();
    });
    await locked;

    let cleanupSettled = false;
    const cleanup = repository.cleanupRevokedDirectoryEntries({
      olderThan: "2026-09-07T12:00:01.000Z",
      limit: 1,
    }).finally(() => { cleanupSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cleanupSettled).toBe(false);
    releaseWriter();
    await writer;

    await expect(cleanup).resolves.toBe(1);
    await expect(repository.listForActor(platformCollaborationActors.recipientWithoutComputer)).resolves.toHaveLength(1);
    await expect(fixture.collaborationDb.selectFrom("collaboration_directory").select("scope_id").executeTakeFirst())
      .resolves.toMatchObject({ scope_id: scopeId });
  });
});
