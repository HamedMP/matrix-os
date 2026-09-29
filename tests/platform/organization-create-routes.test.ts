import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPlatformOrganizationDatabase, type OrganizationPlatformDatabase } from "../../packages/platform/src/organizations/database.js";
import { OrganizationAdminRepository } from "../../packages/platform/src/organizations/admin-repository.js";
import { createOrganizationAdminRoutes } from "../../packages/platform/src/organizations/admin-routes.js";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";
import type { ClerkOrganizationAdmin } from "../../packages/platform/src/organizations/clerk-admin-client.js";
import type { OrganizationMembershipProjection } from "../../packages/platform/src/organizations/projection.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

const actorId = "user_creator000000000000000";
const organizationId = "org_created0000000000000000";
const requestId = "a77b8e1c-6112-4250-93d8-650d6fca8174";
const body = { name: "A team", clientRequestId: requestId };
const post = (app: ReturnType<typeof createOrganizationAdminRoutes>, value: unknown) => app.request("/api/organizations", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});

describe("organization create routes", () => {
  let fixture: TestPlatformDb;
  let repository: OrganizationAdminRepository;
  let clock: Date;
  let actor: string | null;
  let reconcileWorks: boolean;
  let clerk: ClerkOrganizationAdmin;
  let projection: OrganizationMembershipProjection;
  let app: ReturnType<typeof createOrganizationAdminRoutes>;

  beforeEach(async () => {
    fixture = await createTestPlatformDb();
    const db = fixture.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>;
    await bootstrapPlatformOrganizationDatabase(db);
    clock = new Date("2026-09-20T12:00:00.000Z");
    repository = new OrganizationAdminRepository(db, { now: () => clock });
    actor = actorId;
    reconcileWorks = true;
    clerk = {
      createOrganization: vi.fn(async () => ({ organizationId })),
      findCreatedOrganization: vi.fn(async () => ({ kind: "absent" as const })),
    };
    projection = {
      reconcile: vi.fn(async () => ({ verified: reconcileWorks, endedMemberships: [] })),
      isCurrentMember: vi.fn(async () => reconcileWorks),
      assert: vi.fn(), touch: vi.fn(), describe: vi.fn(), shutdown: vi.fn(),
    } as unknown as OrganizationMembershipProjection;
    app = createOrganizationAdminRoutes({ repository, clerk, projection, resolveActor: async () => actor, now: () => clock });
  });

  afterEach(async () => { await destroyTestPlatformDb(fixture.db); });

  it("requires auth, bounds the body, and rejects unknown or malformed fields", async () => {
    actor = null;
    expect((await post(app, body)).status).toBe(401);
    actor = actorId;
    expect((await post(app, { ...body, extra: true })).status).toBe(422);
    expect((await post(app, { ...body, name: "\u0000bad" })).status).toBe(422);
    expect((await post(app, { ...body, clientRequestId: "bad" })).status).toBe(422);
    expect((await post(app, { ...body, name: "x".repeat(100_000) })).status).toBe(413);
    expect(clerk.createOrganization).not.toHaveBeenCalled();
  });

  it("creates once for an idempotency key and lists setting-up rows only while membership is current", async () => {
    reconcileWorks = false;
    const first = await post(app, body);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ state: "setting_up", organizationId, name: "A team" });
    const second = await post(app, body);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ state: "setting_up", organizationId });
    expect(clerk.createOrganization).toHaveBeenCalledTimes(1);

    const readRoutes = createPlatformOrganizationRoutes({
      repository: { listOrganizationsForActor: async () => [] } as never,
      adminRepository: repository,
      projection,
      controlAuthority: {} as never,
      resolveActor: async () => actor,
      authenticateRuntime: async () => null,
    });
    expect(await (await readRoutes.request("/api/organizations")).json()).toEqual({ organizations: [] });
    reconcileWorks = true;
    expect(await (await readRoutes.request("/api/organizations")).json()).toEqual({
      organizations: [{ organizationId, name: "A team", state: "setting_up" }],
    });
    reconcileWorks = false;
    expect(await (await readRoutes.request("/api/organizations")).json()).toEqual({ organizations: [] });
    expect((await post(app, { ...body, name: "A different team" })).status).toBe(409);
  });

  it("does not charge an account for requests while Clerk creation is unconfigured", async () => {
    const unavailable = createOrganizationAdminRoutes({ repository, projection, resolveActor: async () => actor });
    for (let index = 0; index < 3; index++) {
      const response = await post(unavailable, { ...body, clientRequestId: `a77b8e1c-6112-4250-93d8-650d6fca817${index}` });
      expect(response.status).toBe(503);
    }
    expect(await repository.getRequest(actorId, "a77b8e1c-6112-4250-93d8-650d6fca8170")).toBeNull();
    expect((await post(app, body)).status).toBe(201);
    expect((await post(unavailable, body)).status).toBe(201);
    expect((await post(unavailable, { ...body, name: "Different team" })).status).toBe(409);
  });

  it("atomically caps new creates at three per account per day and returns Retry-After", async () => {
    for (let index = 0; index < 3; index++) {
      expect((await post(app, { name: `Team ${index}`, clientRequestId: `a77b8e1c-6112-4250-93d8-650d6fca817${index}` })).status).toBe(201);
    }
    const limited = await post(app, { name: "Team four", clientRequestId: "a77b8e1c-6112-4250-93d8-650d6fca8179" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(clerk.createOrganization).toHaveBeenCalledTimes(3);
  });

  it("returns a generic 503 when Clerk fails and leaves a pending request for recovery", async () => {
    clerk.createOrganization = vi.fn(async () => { throw new Error("Clerk upstream private detail"); });
    const response = await post(app, body);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private detail");
    expect((await repository.getRequest(actorId, requestId))?.state).toBe("pending");
  });

  it("reports unresolved rows only to the platform operator", async () => {
    const { request } = await repository.beginCreate(actorId, requestId, "A team");
    await repository.markNeedsReview(request);
    const operatorRoutes = createOrganizationAdminRoutes({
      repository, clerk, projection, resolveActor: async () => actor, platformSecret: "operator-secret", now: () => clock,
    });
    expect((await operatorRoutes.request("/api/operator/organizations/readiness")).status).toBe(401);
    expect((await operatorRoutes.request("/api/operator/organizations/readiness", {
      headers: { authorization: "Bearer wrong" },
    })).status).toBe(401);
    const response = await operatorRoutes.request("/api/operator/organizations/readiness", {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ needsReviewCount: 1, failedCount: 0 });
  });
});
