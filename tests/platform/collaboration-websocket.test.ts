import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import {
  buildCollaborationWebSocketUpgradeHeaders,
  CollaborationWebSocketAuthorizer,
  CollaborationWebSocketError,
  isCollaborationWebSocketCandidate,
  isCollaborationWebSocketPath,
} from "../../packages/platform/src/collaboration/websocket.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
  platformCollaborationActors,
  type PlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const scopeId = "10000000-0000-4000-8000-000000000001";
const eventPath = `/ws/collaboration/scopes/${scopeId}/events`;

describe("CollaborationWebSocketAuthorizer", () => {
  let fixture: PlatformCollaborationTestDatabase;
  let repository: PlatformCollaborationRepository;
  let authorizer: CollaborationWebSocketAuthorizer;
  let tokenNumber: number;

  beforeEach(async () => {
    fixture = await createPlatformCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
    repository = new PlatformCollaborationRepository(fixture.collaborationDb, { now: () => now });
    await repository.applyDirectoryEvent({
      eventId: "20000000-0000-4000-8000-000000000001",
      scopeId,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      kind: "chat",
      authorityGeneration: 1,
      metadataRevision: 1,
      recipients: [
        { actorId: platformCollaborationActors.owner, status: "accepted" },
        { actorId: platformCollaborationActors.recipientWithoutComputer, status: "accepted" },
      ],
    });
    await repository.setPolicy({
      milestone: "m1",
      expectedRevision: 0,
      mode: "internal",
      cohort: [platformCollaborationActors.owner, platformCollaborationActors.recipientWithoutComputer],
      changedBy: "operator_test",
    });
    tokenNumber = 0;
    authorizer = new CollaborationWebSocketAuthorizer({
      repository,
      signer: new CollaborationProofSigner({
        activeKeyId: "collaboration-key-1",
        keys: { "collaboration-key-1": key },
        now: () => now,
        createNonce: () => "a".repeat(32),
      }),
      allowedOrigins: ["https://app.matrix-os.com"],
      enabledPurposes: ["events"],
      now: () => now,
      createToken: () => `${"a".repeat(43)}${++tokenNumber}`,
    });
  });

  afterEach(async () => {
    await destroyPlatformCollaborationTestDatabase(fixture);
  });

  it("issues a hashed ticket and exchanges it once for an exact scoped upgrade proof", async () => {
    const issued = await authorizer.issueTicket({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
      clientRequestId: "40000000-0000-4000-8000-000000000001",
    });
    expect(issued.ticket).toBe(`${"a".repeat(43)}1`);
    expect(JSON.stringify(await fixture.collaborationDb.selectFrom("collaboration_connection_tickets")
      .selectAll().execute())).not.toContain(issued.ticket);

    const upgrade = await authorizer.authorizeUpgrade({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      authentication: "ticket",
      rawPath: `${eventPath}?ticket=${encodeURIComponent(issued.ticket)}&after=1`,
      origin: "https://app.matrix-os.com",
    });
    expect(upgrade).toMatchObject({
      upstreamPath: `${eventPath}?after=1`,
      runtimeId: "runtime_owner",
      ownerId: platformCollaborationActors.owner,
      scopeId,
      purpose: "events",
    });
    const verifier = new CollaborationActorProofVerifier({
      runtimeId: "runtime_owner",
      keys: { "collaboration-key-1": key },
      now: () => now,
    });
    await expect(verifier.verifySocket({
      signedProof: upgrade.signedProof,
      purpose: "events",
      path: eventPath,
      query: "after=1",
    })).resolves.toMatchObject({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
    });
    await expect(authorizer.authorizeUpgrade({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      authentication: "ticket",
      rawPath: `${eventPath}?ticket=${encodeURIComponent(issued.ticket)}`,
      origin: "https://app.matrix-os.com",
    })).rejects.toMatchObject({ code: "invalid_ticket" });
  });

  it("supports an authenticated same-origin session without exposing credentials upstream", async () => {
    const upgrade = await authorizer.authorizeUpgrade({
      actorId: platformCollaborationActors.owner,
      authentication: "session",
      rawPath: eventPath,
      origin: "https://app.matrix-os.com",
    });
    expect(upgrade.upstreamPath).toBe(eventPath);
    expect(upgrade.signedProof.proof.actorId).toBe(platformCollaborationActors.owner);
  });

  it.each([
    { rawPath: `${eventPath}?token=public-snapshot`, origin: "https://app.matrix-os.com" },
    { rawPath: `${eventPath}?ticket=unknown&extra=value`, origin: "https://app.matrix-os.com" },
    { rawPath: `${eventPath}/child`, origin: "https://app.matrix-os.com" },
    { rawPath: eventPath, origin: "https://evil.example" },
    { rawPath: `/ws/collaboration/scopes/${scopeId}/terminal`, origin: "https://app.matrix-os.com" },
  ])("rejects unsafe, snapshot, cross-origin, and disabled upgrade %#", async ({ rawPath, origin }) => {
    await expect(authorizer.authorizeUpgrade({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      authentication: "session",
      rawPath,
      origin,
    })).rejects.toBeInstanceOf(CollaborationWebSocketError);
  });

  it("rejects stale directory membership before consuming a ticket", async () => {
    const issued = await authorizer.issueTicket({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      scopeId,
      purpose: "events",
      clientRequestId: "40000000-0000-4000-8000-000000000002",
    });
    await fixture.collaborationDb.updateTable("collaboration_user_index").set({ status: "revoked" })
      .where("actor_id", "=", platformCollaborationActors.recipientWithoutComputer)
      .where("scope_id", "=", scopeId).execute();
    await expect(authorizer.authorizeUpgrade({
      actorId: platformCollaborationActors.recipientWithoutComputer,
      authentication: "ticket",
      rawPath: `${eventPath}?ticket=${encodeURIComponent(issued.ticket)}`,
      origin: "https://app.matrix-os.com",
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("recognizes only exact collaboration socket paths and strips caller credentials upstream", () => {
    expect(isCollaborationWebSocketPath(eventPath)).toBe(true);
    expect(isCollaborationWebSocketPath(`${eventPath}?after=2`)).toBe(true);
    expect(isCollaborationWebSocketPath(`${eventPath}/child`)).toBe(false);
    expect(isCollaborationWebSocketPath(`/ws/collaboration/scopes/${scopeId}/unknown`)).toBe(false);
    expect(isCollaborationWebSocketCandidate(`${eventPath}/child`)).toBe(true);

    const headers = buildCollaborationWebSocketUpgradeHeaders({
      incomingHeaders: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "safe-key",
        "sec-websocket-version": "13",
        authorization: "Bearer caller-secret",
        cookie: "__session=caller-secret",
        "x-platform-user-id": "forged-owner",
        "x-matrix-collaboration-proof": "forged-proof",
      },
      externalHost: "app.matrix-os.com",
      signedProof: { proof: { value: "safe" }, signature: "signed" },
    });
    expect(headers).toContain("sec-websocket-key: safe-key");
    expect(headers).toContain("x-matrix-collaboration-proof:");
    expect(headers).not.toContain("caller-secret");
    expect(headers).not.toContain("forged-owner");
    expect(headers).not.toContain("forged-proof");
    expect(headers).not.toContain("authorization:");
    expect(headers).not.toContain("cookie:");
  });
});
