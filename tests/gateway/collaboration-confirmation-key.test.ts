import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { generateRuntimeKeyPair } from "../../packages/gateway/src/collaboration/direct-crypto.js";
import { createGatewayCollaboration, loadGatewayCollaborationConfig } from "../../packages/gateway/src/collaboration/wiring.js";
import {
  allowAllOrganizationPrecondition,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const runtimeId = "runtime_confirmation_owner";
const ownerId = "user_confirmation_owner";
const organizationId = "org_matrix_team";
const config = {
  runtimeId,
  activeKeyId: "key-1",
  proofKeys: { "key-1": "a".repeat(32) },
  platformBaseUrl: "https://platform.internal",
  serviceToken: "c".repeat(32),
  clientOrigins: [],
};

describe("home-local collaboration confirmation key", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = process.env.MATRIX_TEST_POSTGRES_URL
      ? await createRealCollaborationTestDatabase()
      : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });

  afterEach(async () => fixture.destroy());

  it("does not require a deployed preflight secret in gateway configuration", () => {
    const loaded = loadGatewayCollaborationConfig({
      MATRIX_RUNTIME_ID: runtimeId,
      PLATFORM_INTERNAL_URL: config.platformBaseUrl,
      UPGRADE_TOKEN: config.serviceToken,
    });
    expect(loaded).toMatchObject({ runtimeId });
    expect(loaded).not.toHaveProperty("preflightSecret");
  });

  it("accepts an unexpired project confirmation after gateway restart and rejects it after identity rotation", async () => {
    const makeRuntime = () => createGatewayCollaboration({
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config,
      organizationPrecondition: allowAllOrganizationPrecondition,
      projectSource: { getProject: async (actor, projectId) => actor === ownerId
        ? { id: projectId, ownerId, revision: 7 }
        : null },
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    const first = await makeRuntime();
    const pending = await first.projectScope!.preflight({ ownerId, organizationId, projectId: "project_restart" });
    const rotated = await first.projectScope!.preflight({ ownerId, organizationId, projectId: "project_rotation" });
    await first.shutdown();

    const restarted = await makeRuntime();
    await expect(restarted.projectScope!.prepare({
      ownerId, organizationId, projectId: "project_restart",
      clientRequestId: "10000000-0000-4000-8000-000000000010",
      payloadHash: "a".repeat(64),
      expectedProjectRevision: pending.projectRevision,
      confirmationToken: pending.confirmationToken!,
    })).resolves.toMatchObject({ resourceId: "project_restart" });
    await restarted.shutdown();

    const next = generateRuntimeKeyPair();
    await fixture.db.updateTable("collaboration_runtime_identity")
      .set({ key_id: "rotated-home", seed: next.seed, public_key: next.publicKey })
      .where("singleton", "=", 1).execute();
    const afterRotation = await makeRuntime();
    await expect(afterRotation.projectScope!.prepare({
      ownerId, organizationId, projectId: "project_rotation",
      clientRequestId: "10000000-0000-4000-8000-000000000011",
      payloadHash: "b".repeat(64),
      expectedProjectRevision: rotated.projectRevision,
      confirmationToken: rotated.confirmationToken!,
    })).rejects.toMatchObject({ code: "invalid_confirmation" });
    await afterRotation.shutdown();
  });
});
