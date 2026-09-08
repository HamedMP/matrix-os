import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import {
  PlatformCollaborationRepository,
  PlatformCollaborationRepositoryError,
} from "../../packages/platform/src/collaboration/repository.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
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

  it("keeps rollout policy server-managed, bounded, and initially off", async () => {
    expect(await repository.getPolicy("m1")).toMatchObject({ mode: "off", revision: 0, cohort: [] });
    await repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "internal",
      cohort: [platformCollaborationActors.owner, platformCollaborationActors.recipientWithoutComputer],
      changedBy: "operator_release",
    });
    expect(await repository.getPolicy("m1")).toMatchObject({ mode: "internal", revision: 1 });
    await expect(repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "enabled",
      cohort: [],
      changedBy: "operator_release",
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("stores only hashed one-use tickets, enforces expiry, and caps outstanding tickets", async () => {
    const first = await repository.createConnectionTicket({
      token: "ticket-secret-one",
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
      policyRevision: 1,
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
        policyRevision: 1,
        expiresAt: "2026-09-07T12:00:30.000Z",
      });
    }
    await expect(repository.createConnectionTicket({
      token: "ticket-over-cap",
      actorId: platformCollaborationActors.outsider,
      scopeId,
      purpose: "events",
      policyRevision: 1,
      expiresAt: "2026-09-07T12:00:30.000Z",
    })).rejects.toBeInstanceOf(PlatformCollaborationRepositoryError);
  });
});
