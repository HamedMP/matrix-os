/**
 * S20 / T098 (platform side): collaboration composition always constructs and
 * fails closed with a logged generic denial when signing or origin
 * configuration is missing. No release flag exists.
 */
import { Hono } from "hono";
import type { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import { createFailClosedPlatformCollaboration } from "../../packages/platform/src/collaboration/fail-closed.js";
import { describePlatformCollaborationConfiguration } from "../../packages/platform/src/collaboration/wiring.js";
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import {
  CollaborationIdentifierResolutionError,
  PlatformCollaborationIdentifierResolver,
} from "../../packages/platform/src/collaboration/identifier-resolver.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { inventoryPlatformPersonToPersonRecords } from "../../packages/platform/src/collaboration/person-to-person-inventory.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const signing = {
  MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "direct-key",
  MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ "direct-key": Buffer.alloc(32, 1).toString("base64url") }),
};

describe("S20 platform organization precondition: fail-closed composition", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the missing configuration and ignores any legacy flag value", () => {
    expect(describePlatformCollaborationConfiguration({ MATRIX_COLLABORATION_ENABLED: "true" }))
      .toEqual({ configured: false, reason: "origin_configuration_missing" });
    expect(describePlatformCollaborationConfiguration({
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
    })).toEqual({ configured: false, reason: "signing_configuration_missing" });
    expect(describePlatformCollaborationConfiguration({
      ...signing,
      MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com",
      MATRIX_COLLABORATION_ENABLED: "false",
    })).toMatchObject({ configured: true });
  });

  it("denies every collaboration and internal collaboration route with one generic body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 0;
    const composition = createFailClosedPlatformCollaboration({
      reason: "signing_configuration_missing",
      now: () => clock,
    });
    const app = new Hono();
    composition.register(app);
    expect(warn).toHaveBeenCalledWith("[platform-collaboration] wiring fail-closed", "signing_configuration_missing");
    warn.mockClear();
    const responses = await Promise.all([
      app.request("/api/collaboration/inbox"),
      app.request("/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/connection-tickets", {
        method: "POST", body: "{}",
      }),
      app.request("/internal/collaboration/participants/user_x", {
        headers: { authorization: `Bearer ${"t".repeat(40)}`, "x-matrix-runtime-id": "vps:x" },
      }),
      app.request("/internal/collaboration/directory", { method: "PUT", body: "{}" }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Collaboration unavailable" });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await app.request("/api/collaboration/shared");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(() => composition.register(new Hono())).toThrow();
  });

  it("applies the collaboration body limit to mutating verbs on both prefixes while fail-closed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const composition = createFailClosedPlatformCollaboration({ reason: "origin_configuration_missing" });
    const app = new Hono();
    composition.register(app);
    const oversized = "x".repeat(COLLABORATION_HTTP_BODY_LIMIT + 1);
    for (const path of ["/api/collaboration/scopes/10000000-0000-4000-8000-000000000001/connection-tickets", "/internal/collaboration/directory"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await app.request(path, { method, body: oversized });
        expect(response.status).toBe(413);
      }
    }
    expect((await app.request("/internal/collaboration/directory", { method: "DELETE" })).status).toBe(503);
  });

  it("fails closed from the bootstrap entrypoint when runtime authentication is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const composition = await bootstrapPlatformCollaboration({
      env: { ...signing, MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com" },
      db: undefined as unknown as PlatformDB,
      platformSecret: "",
      platformJwtSecret: "platform-jwt-secret",
      customerVpsProxyDispatcher: undefined as unknown as Agent,
    });
    expect("failClosed" in composition && composition.failClosed.reason).toBe("runtime_authentication_missing");
    expect(composition.direct).toBeUndefined();
  });
});

describe("S20 / T101: invitation identifiers resolve only inside the organization", () => {
  const member = { actorId: "user_member", displayName: "Member" };
  const outsider = { actorId: "user_outsider", displayName: "Outsider" };
  const accounts = new Map([[member.actorId, member], [outsider.actorId, outsider]]);

  function resolver(projection?: { isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean> }) {
    return new PlatformCollaborationIdentifierResolver({
      getAccountByActorId: async (actorId) => accounts.get(actorId) ?? null,
      listAccountsByUsername: async (username) => username === "member" ? [member] : username === "outsider" ? [outsider] : [],
      ...(projection ? { membershipProjection: projection } : {}),
    });
  }

  it("resolves nothing while no membership projection is registered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(resolver().resolve(member.actorId, "org_matrix_team"))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(resolver().resolve("member", "org_matrix_team"))
      .rejects.toBeInstanceOf(CollaborationIdentifierResolutionError);
    expect(warn).toHaveBeenCalledWith("[platform-collaboration] invitation identifier refused: no membership projection registered");
  });

  it("returns only current members of the scope's organization and the same safe failure for everyone else", async () => {
    const calls: { organizationId: string; actorId: string }[] = [];
    const withProjection = resolver({
      isCurrentMember: async (input) => { calls.push(input); return input.organizationId === "org_matrix_team" && input.actorId === member.actorId; },
    });
    await expect(withProjection.resolve("@member", "org_matrix_team")).resolves.toEqual(member);
    await expect(withProjection.resolve("outsider", "org_matrix_team")).rejects.toMatchObject({ code: "unresolved" });
    await expect(withProjection.resolve(member.actorId, "org_other")).rejects.toMatchObject({ code: "unresolved" });
    await expect(withProjection.resolve(member.actorId, "not-an-org")).rejects.toMatchObject({ code: "unresolved" });
    expect(calls).toEqual([
      { organizationId: "org_matrix_team", actorId: member.actorId },
      { organizationId: "org_matrix_team", actorId: outsider.actorId },
      { organizationId: "org_other", actorId: member.actorId },
    ]);
  });
});

describe("S20 / T102: platform person-to-person inventory", () => {
  it("counts directory and index rows, which are all pre-organization records", async () => {
    const fixture = await createPlatformCollaborationTestDatabase();
    try {
      await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
      await expect(inventoryPlatformPersonToPersonRecords(fixture.collaborationDb)).resolves.toEqual({
        directoryScopes: 0, invitedIndexRows: 0, acceptedIndexRows: 0, revokedIndexRows: 0, total: 0,
      });
      const rolloutTable = await fixture.collaborationDb.selectFrom("pg_tables" as never)
        .select("tablename" as never).where("tablename" as never, "=", "collaboration_rollout_policy").execute();
      expect(rolloutTable).toEqual([]);
    } finally {
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });
});
