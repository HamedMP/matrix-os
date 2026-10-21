import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLABORATION_DIRECT_PROTOCOL_VERSION, toLogicalRuntimeId } from "@matrix-os/contracts";
import {
  ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, possessionPayload,
  proofKeyThumbprint, signEd25519, ticketSigningPayload,
} from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { DirectAuthError, DirectReplayCache, DirectTicketVerifier } from "../../packages/gateway/src/collaboration/direct-auth.js";
import { createDirectSessionRoutes, directErrorResponse } from "../../packages/gateway/src/collaboration/direct-routes.js";
import { OwnerRuntimeSessionService } from "../../packages/gateway/src/collaboration/owner-runtime-sessions.js";
import { createOrganizationPrecondition } from "../../packages/gateway/src/collaboration/organization-precondition.js";
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

describe("owner session through the HTTP route on a production home", () => {
  // The request that failed in production: POST /api/collaboration/owner-runtime/sessions on a
  // home whose client origins come from a production environment (none configured).
  const clock = new Date("2026-10-02T14:47:43.000Z");
  const ownerId = "user_owner";
  const organizationId = "org_matrix_team";
  const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
  const platformKey = ed25519PrivateKeyFromSeed(Buffer.alloc(32, 9).toString("base64url"));

  function ownerSessionRoutes() {
    const config = loadGatewayCollaborationConfig(productionEnvironment)!;
    const verifier = new DirectTicketVerifier({
      runtimeId,
      platformKeys: () => [{ keyId: "platform", algorithm: "ed25519", publicKey: ed25519PublicKeyRaw(platformKey) }],
      controlFresh: () => true,
      allowedClientOrigins: config.clientOrigins,
      replay: new DirectReplayCache({ now: () => clock }),
      now: () => clock,
    });
    const ownerRuntimeSessions = new OwnerRuntimeSessionService({
      verifier, ownerId, runtimeId, now: () => clock,
      organizationPrecondition: createOrganizationPrecondition({
        source: { assertMembership: async () => ({ member: true, expiresAt: new Date(clock.getTime() + 20_000).toISOString() }) },
        now: () => clock,
      }),
    });
    const routes = createDirectSessionRoutes({ sessions: {} as never, ownerRuntimeSessions });
    return { routes, ownerRuntimeSessions };
  }

  function sessionRequest(clientOrigin: string) {
    const key = generateKeyPairSync("ed25519");
    const proofPublicKey = ed25519PublicKeyRaw(key.publicKey);
    const ticket = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, ticketId: randomUUID(), nonce: randomUUID().replaceAll("-", ""),
      actorId: ownerId, organizationId, resource: { kind: "owner_runtime" }, purpose: "owner_runtime",
      runtime: { runtimeId: toLogicalRuntimeId(runtimeId), authorityGeneration: 1 },
      proofKeyThumbprint: proofKeyThumbprint(proofPublicKey), maxActions: 8,
      issuedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 30_000).toISOString(),
    };
    return {
      clientRequestId: randomUUID(),
      signedTicket: { ticket, keyId: "platform", signature: signEd25519(platformKey, ticketSigningPayload(ticket)) },
      proofPublicKey,
      possession: signEd25519(key.privateKey, possessionPayload({ ticketNonce: ticket.nonce, purpose: "owner_runtime" })),
      clientOrigin,
    };
  }

  async function post(routes: ReturnType<typeof ownerSessionRoutes>["routes"], body: unknown) {
    return routes.request("/api/collaboration/owner-runtime/sessions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("opens an owner session for the platform origin Web and Electron present", async () => {
    const { routes, ownerRuntimeSessions } = ownerSessionRoutes();
    try {
      const response = await post(routes, sessionRequest("https://app.matrix-os.com"));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ actorId: ownerId, organizationId, purpose: "owner_runtime" });
    } finally {
      await ownerRuntimeSessions.shutdown();
    }
  });

  it("still refuses any other origin, generically", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { routes, ownerRuntimeSessions } = ownerSessionRoutes();
    try {
      const response = await post(routes, sessionRequest("https://evil.example"));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Collaboration request denied" });
    } finally {
      await ownerRuntimeSessions.shutdown();
      warn.mockRestore();
    }
  });
});

describe("denied direct requests are diagnosable without flooding the log", () => {
  afterEach(() => { vi.useRealTimers(); });

  function deniedApp() {
    const app = new Hono();
    app.get("/denied", (c) => directErrorResponse(c, new DirectAuthError("invalid_ticket", "Connection ticket is invalid"))!);
    return app;
  }

  it("logs the denial code, and only the code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await deniedApp().request("/denied");
    expect(response.status).toBe(401);
    expect(warn).toHaveBeenCalledWith("[collaboration-direct] request denied", "invalid_ticket");
    // The detail message stays server-side and out of the log line's free text.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Connection ticket is invalid");
    warn.mockRestore();
  });

  it("logs a repeated code at most once a minute, then reports how many it suppressed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = deniedApp();
    vi.setSystemTime(new Date("2032-01-01T00:00:00.000Z"));
    await app.request("/denied");
    vi.setSystemTime(new Date("2032-01-01T00:00:01.000Z"));
    await app.request("/denied");
    await app.request("/denied");
    expect(warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2032-01-01T00:01:01.000Z"));
    await app.request("/denied");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith("[collaboration-direct] request denied", "invalid_ticket", { suppressed: 2 });
    warn.mockRestore();
  });
});
