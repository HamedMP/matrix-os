import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createGatewayCollaboration } from "../../packages/gateway/src/collaboration/wiring.js";
import {
  DEFAULT_COLLABORATION_RELAY_ORIGIN,
  loadGatewayCollaborationConfig,
} from "../../packages/gateway/src/collaboration/config.js";
import {
  allowAllOrganizationPrecondition,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

// What a production customer computer actually has: provisioning never writes
// MATRIX_COLLABORATION_CLIENT_ORIGINS (only preview tooling does), so the home must
// still accept the platform's own origin. Before this, every owner session and every
// shared-resource connection on production failed closed with a bare 401.
const productionEnvironment = {
  MATRIX_MACHINE_ID: "11111111-1111-4111-8111-111111111111",
  PLATFORM_INTERNAL_URL: "https://platform.internal",
  UPGRADE_TOKEN: "c".repeat(32),
  DATABASE_URL: "postgres://owner@localhost/owner",
  MATRIX_USER_ID: "user_owner",
  MATRIX_HANDLE: "owner-home",
};

describe("collaboration client origins on a production computer", () => {
  it("accepts the platform relay origin when no client origins are configured", () => {
    const config = loadGatewayCollaborationConfig(productionEnvironment);
    expect(DEFAULT_COLLABORATION_RELAY_ORIGIN).toBe("https://app.matrix-os.com");
    expect(config).toMatchObject({
      relayOrigin: "https://app.matrix-os.com",
      clientOrigins: ["https://app.matrix-os.com"],
    });
  });

  it("follows an overridden relay origin when deriving the default", () => {
    const config = loadGatewayCollaborationConfig({
      ...productionEnvironment,
      COLLABORATION_RELAY_ORIGIN: "https://relay.example.com",
    });
    expect(config).toMatchObject({
      relayOrigin: "https://relay.example.com",
      clientOrigins: ["https://relay.example.com"],
    });
  });

  it("keeps an explicit client origin list exactly as configured, as preview homes rely on", () => {
    const config = loadGatewayCollaborationConfig({
      ...productionEnvironment,
      MATRIX_COLLABORATION_CLIENT_ORIGINS: "https://pr-12.preview.example,https://app.matrix-os.com",
    });
    expect(config?.clientOrigins).toEqual(["https://pr-12.preview.example", "https://app.matrix-os.com"]);
  });

  it("stays fail closed when the configured list is present but entirely malformed", () => {
    // A typo must never widen the allowlist -- not even to the default.
    const config = loadGatewayCollaborationConfig({
      ...productionEnvironment,
      MATRIX_COLLABORATION_CLIENT_ORIGINS: "http://app.matrix-os.com, app.matrix-os.com",
    });
    expect(config?.clientOrigins).toEqual([]);
  });

  it("refuses a relay origin that is not an exact https origin", () => {
    for (const relay of ["http://app.matrix-os.com", "https://app.matrix-os.com/path", "not a url"]) {
      const config = loadGatewayCollaborationConfig({ ...productionEnvironment, COLLABORATION_RELAY_ORIGIN: relay });
      expect(config).toMatchObject({ relayOrigin: null, clientOrigins: [] });
    }
  });
});

describe("direct session origin check with production configuration", () => {
  let fixture: CollaborationTestDatabase;
  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
  });
  afterEach(async () => fixture.destroy());

  it("admits the platform origin Web and Electron present, and nothing else", async () => {
    const runtime = await createGatewayCollaboration({
      db: fixture.db,
      chatRepository: new ChatRepository(fixture.db),
      config: loadGatewayCollaborationConfig(productionEnvironment)!,
      organizationPrecondition: allowAllOrganizationPrecondition,
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveInvitationIdentifier: async (identifier) => ({ actorId: identifier, displayName: identifier }),
      outboxFetch: async () => new Response(null, { status: 204 }),
      startTimers: false,
    });
    try {
      expect(runtime.directVerifier.requireClientOrigin("https://app.matrix-os.com")).toBe("https://app.matrix-os.com");
      expect(() => runtime.directVerifier.requireClientOrigin("https://evil.example")).toThrow(
        expect.objectContaining({ code: "invalid_origin" }),
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("denied direct requests are diagnosable", () => {
  it("logs the denial code, and only the code", async () => {
    const { directErrorResponse } = await import("../../packages/gateway/src/collaboration/direct-routes.js");
    const { DirectAuthError } = await import("../../packages/gateway/src/collaboration/direct-auth.js");
    const { Hono } = await import("hono");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = new Hono();
    app.get("/denied", (c) => directErrorResponse(c, new DirectAuthError("invalid_origin", "Client origin is not allowed"))!);
    const response = await app.request("/denied");
    expect(response.status).toBe(401);
    expect(warn).toHaveBeenCalledWith("[collaboration-direct] request denied", "invalid_origin");
    // The detail message stays server-side and out of the log line's free text.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Client origin is not allowed");
    warn.mockRestore();
  });
});
