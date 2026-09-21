import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createGatewayCollaboration, loadGatewayCollaborationConfig } from "../../packages/gateway/src/collaboration/wiring.js";
import { describeGatewayCollaborationConfiguration } from "../../packages/gateway/src/collaboration/config.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  allowAllOrganizationPrecondition,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const legacyKey = "a".repeat(32);
const directEnvironment = {
  MATRIX_RUNTIME_ID: runtimeId,
  PLATFORM_INTERNAL_URL: "https://platform.internal",
  UPGRADE_TOKEN: "c".repeat(32),
  DATABASE_URL: "postgres://owner@localhost/owner",
  MATRIX_COLLABORATION_CLIENT_ORIGINS: "https://app.matrix-os.com",
};

describe("S18 direct-only gateway startup configuration", () => {
  let fixture: CollaborationTestDatabase;
  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });
  afterEach(async () => fixture.destroy());

  it("starts direct collaboration without V1 actor-proof environment keys", () => {
    expect(describeGatewayCollaborationConfiguration(directEnvironment)).toEqual({ configured: true });
    expect(loadGatewayCollaborationConfig(directEnvironment)).toMatchObject({
      runtimeId, clientOrigins: ["https://app.matrix-os.com"],
    });
  });

  it("ignores retained V1 keys and denies an otherwise valid legacy proof", async () => {
    const config = loadGatewayCollaborationConfig({
      ...directEnvironment,
      MATRIX_COLLABORATION_ACTIVE_KEY_ID: "legacy-key",
      MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "legacy-key": legacyKey }),
    });
    expect(config).not.toBeNull();
    expect(config).not.toHaveProperty("proofKeys");
    const runtime = await createGatewayCollaboration({
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: config!,
      organizationPrecondition: allowAllOrganizationPrecondition,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      const method = "GET" as const;
      const path = "/api/collaboration/scopes/10000000-0000-4000-8000-000000000001";
      const body = new Uint8Array();
      const signedProof = new CollaborationProofSigner({
        activeKeyId: "legacy-key", keys: { "legacy-key": legacyKey },
      }).signHttp({ actorId: "user_member", ownerId: "user_owner", runtimeId, method, path, query: "", body });
      await expect(runtime.verifier.verifyHttp({ signedProof, method, path, query: "", body }))
        .rejects.toMatchObject({ code: "invalid_proof" });
    } finally {
      await runtime.shutdown();
    }
  });
});
