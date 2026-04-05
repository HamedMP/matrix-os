import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import {
  createPlatformDb,
  type PlatformDb,
} from "../../packages/gateway/src/platform-db.js";

describe("PlatformDb", () => {
  let db: PlatformDb;
  let instance: InstanceType<typeof KyselyPGlite>;

  beforeEach(async () => {
    instance = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: instance.dialect });
    await db.migrate();
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("migrate()", () => {
    it("creates all 5 tables", async () => {
      const result = await db.raw(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('users', 'connected_services', 'user_apps', 'event_subscriptions', 'billing')
         ORDER BY table_name`,
      );
      expect(result.rows.map((r) => r.table_name)).toEqual([
        "billing",
        "connected_services",
        "event_subscriptions",
        "user_apps",
        "users",
      ]);
    });

    it("creates indexes on foreign key columns", async () => {
      const result = await db.raw(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname IN ('idx_connected_services_user', 'idx_user_apps_user', 'idx_event_subs_user')
         ORDER BY indexname`,
      );
      expect(result.rows.map((r) => r.indexname)).toEqual([
        "idx_connected_services_user",
        "idx_event_subs_user",
        "idx_user_apps_user",
      ]);
    });

    it("is idempotent (can run twice)", async () => {
      await db.migrate();
      const result = await db.raw(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'users'`,
      );
      expect(result.rows).toHaveLength(1);
    });
  });

  describe("users", () => {
    it("creates and retrieves a user by clerk_id", async () => {
      const user = await db.createUser({
        clerkId: "clerk_123",
        handle: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        containerId: "container_abc",
      });

      expect(user.id).toBeDefined();
      expect(user.clerk_id).toBe("clerk_123");
      expect(user.handle).toBe("alice");
      expect(user.plan).toBe("free");
      expect(user.status).toBe("active");

      const found = await db.getUserByClerkId("clerk_123");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
      expect(found!.email).toBe("alice@example.com");
    });

    it("retrieves a user by id", async () => {
      const user = await db.createUser({
        clerkId: "clerk_456",
        handle: "bob",
        displayName: "Bob",
        email: "bob@example.com",
        containerId: "container_def",
      });

      const found = await db.getUserById(user.id);
      expect(found).not.toBeNull();
      expect(found!.handle).toBe("bob");
    });

    it("returns null for non-existent clerk_id", async () => {
      const found = await db.getUserByClerkId("nonexistent");
      expect(found).toBeNull();
    });

    it("returns null for non-existent id", async () => {
      const found = await db.getUserById("00000000-0000-0000-0000-000000000000");
      expect(found).toBeNull();
    });

    it("enforces unique clerk_id", async () => {
      await db.createUser({
        clerkId: "clerk_dup",
        handle: "user1",
        displayName: "User 1",
        email: "u1@example.com",
        containerId: "c1",
      });
      await expect(
        db.createUser({
          clerkId: "clerk_dup",
          handle: "user2",
          displayName: "User 2",
          email: "u2@example.com",
          containerId: "c2",
        }),
      ).rejects.toThrow();
    });

    it("enforces unique handle", async () => {
      await db.createUser({
        clerkId: "clerk_a",
        handle: "samehandle",
        displayName: "A",
        email: "a@example.com",
        containerId: "ca",
      });
      await expect(
        db.createUser({
          clerkId: "clerk_b",
          handle: "samehandle",
          displayName: "B",
          email: "b@example.com",
          containerId: "cb",
        }),
      ).rejects.toThrow();
    });
  });

  describe("connected_services", () => {
    let userId: string;

    beforeEach(async () => {
      const user = await db.createUser({
        clerkId: "clerk_svc",
        handle: "svcuser",
        displayName: "Service User",
        email: "svc@example.com",
        containerId: "container_svc",
      });
      userId = user.id;
    });

    it("connects a service and lists it", async () => {
      const svc = await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_123",
        accountLabel: "Work Gmail",
        accountEmail: "work@gmail.com",
        scopes: ["read", "send"],
      });

      expect(svc.id).toBeDefined();
      expect(svc.service).toBe("gmail");
      expect(svc.status).toBe("active");

      const list = await db.listConnectedServices(userId);
      expect(list).toHaveLength(1);
      expect(list[0].service).toBe("gmail");
      expect(list[0].account_label).toBe("Work Gmail");
      expect(list[0].account_email).toBe("work@gmail.com");
      expect(list[0].scopes).toEqual(["read", "send"]);
    });

    it("retrieves a single connected service by id", async () => {
      const svc = await db.connectService({
        userId,
        service: "github",
        pipedreamAccountId: "pd_acc_gh",
        accountLabel: "Personal GitHub",
        scopes: ["repo"],
      });

      const found = await db.getConnectedService(svc.id);
      expect(found).not.toBeNull();
      expect(found!.service).toBe("github");
      expect(found!.pipedream_account_id).toBe("pd_acc_gh");
    });

    it("disconnects a service (soft delete via status)", async () => {
      const svc = await db.connectService({
        userId,
        service: "slack",
        pipedreamAccountId: "pd_acc_sl",
        accountLabel: "Team Slack",
        scopes: ["chat:write"],
      });

      await db.disconnectService(svc.id);

      const found = await db.getConnectedService(svc.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe("revoked");

      // Should not appear in active list
      const list = await db.listConnectedServices(userId);
      expect(list).toHaveLength(0);
    });

    it("updates service status", async () => {
      const svc = await db.connectService({
        userId,
        service: "discord",
        pipedreamAccountId: "pd_acc_dc",
        accountLabel: "My Discord",
        scopes: [],
      });

      await db.updateServiceStatus(svc.id, "expired");

      const found = await db.getConnectedService(svc.id);
      expect(found!.status).toBe("expired");
    });

    it("touches service last_used_at", async () => {
      const svc = await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_touch",
        accountLabel: "Touch Test",
        scopes: [],
      });

      expect(svc.last_used_at).toBeNull();

      await db.touchServiceUsage(svc.id);

      const found = await db.getConnectedService(svc.id);
      expect(found!.last_used_at).not.toBeNull();
    });

    it("supports multiple services per user", async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_1",
        accountLabel: "Gmail 1",
        scopes: [],
      });
      await db.connectService({
        userId,
        service: "github",
        pipedreamAccountId: "pd_2",
        accountLabel: "GitHub",
        scopes: [],
      });

      const list = await db.listConnectedServices(userId);
      expect(list).toHaveLength(2);
    });

    it("cascades delete when user is removed", async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_cascade",
        accountLabel: "Cascade Test",
        scopes: [],
      });

      await db.raw("DELETE FROM users WHERE id = $1", [userId]);

      const list = await db.raw(
        "SELECT * FROM connected_services WHERE user_id = $1",
        [userId],
      );
      expect(list.rows).toHaveLength(0);
    });
  });

  describe("raw()", () => {
    it("executes arbitrary SQL", async () => {
      const result = await db.raw("SELECT 1 + 1 AS sum");
      expect(result.rows[0].sum).toBe(2);
    });

    it("supports parameterized queries", async () => {
      const result = await db.raw("SELECT $1::text AS name", ["Matrix"]);
      expect(result.rows[0].name).toBe("Matrix");
    });
  });
});
