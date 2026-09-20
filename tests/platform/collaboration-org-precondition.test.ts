/**
 * S20 / T098 (platform side): collaboration composition always constructs and
 * fails closed with a logged generic denial when signing or origin
 * configuration is missing. No release flag exists.
 */
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import type { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import { createFailClosedPlatformCollaboration } from "../../packages/platform/src/collaboration/fail-closed.js";
import { describePlatformCollaborationConfiguration } from "../../packages/platform/src/collaboration/wiring.js";
import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import {
  createPlatformCollaborationTestDatabase,
  destroyPlatformCollaborationTestDatabase,
} from "./collaboration-test-support.js";

const signing = {
  MATRIX_COLLABORATION_ACTIVE_KEY_ID: "key-1",
  MATRIX_COLLABORATION_PROOF_KEYS: JSON.stringify({ "key-1": "a".repeat(32) }),
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
    expect(composition.sockets).toBeUndefined();
  });
});

describe("S20 / T100: the rollout cohort table is gone", () => {
  it("drops collaboration_rollout_policy atomically and keeps a nullable, unused policy revision on tickets", async () => {
    const fixture = await createPlatformCollaborationTestDatabase();
    try {
      await bootstrapPlatformCollaborationDatabase(fixture.collaborationDb);
      const tables = await fixture.collaborationDb.selectFrom("pg_tables" as never)
        .select("tablename" as never).where("tablename" as never, "=", "collaboration_rollout_policy").execute();
      expect(tables).toEqual([]);
      const columns = await fixture.collaborationDb.selectFrom("information_schema.columns" as never)
        .select(["column_name", "is_nullable"] as never)
        .where("table_name" as never, "=", "collaboration_connection_tickets")
        .where("column_name" as never, "=", "policy_revision").execute();
      // Kept nullable and unused so a pre-S20 build remains a rollback target; S18 drops it.
      expect(columns).toEqual([{ column_name: "policy_revision", is_nullable: "YES" }]);
      const source = await readFile("packages/platform/src/collaboration/database.ts", "utf8");
      expect(source).toContain("runPlatformMigration(db, (trx) => applyCollaborationSchema(trx))");
      expect(source).not.toContain(".execute(db)");
    } finally {
      await destroyPlatformCollaborationTestDatabase(fixture);
    }
  });
});
