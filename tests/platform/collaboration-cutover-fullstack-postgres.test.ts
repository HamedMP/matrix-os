import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { drainActiveSharedRunsForCutover, GatewayCollaborationCutover } from "../../packages/gateway/src/collaboration/cutover.js";
import { createCollaborationCutoverRoutes } from "../../packages/gateway/src/collaboration/cutover-route.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { PlatformCollaborationCutover } from "../../packages/platform/src/collaboration/cutover.js";
import { createPlatformCutoverHomeResolver } from "../../packages/platform/src/collaboration/cutover-home-transport.js";
import { ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "../gateway/collaboration-test-support.js";
import { createRealPlatformCollaborationTestDatabase, type RealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

const NOW = new Date("2026-09-21T14:05:00.000Z");
const OWNER = "user_cutover_owner";
const EDITOR = "user_cutover_editor";
const ORG = "org_cutover_integration";
const RUNTIME = "vps:10000000-0000-4000-8000-000000000099";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("S18 signed platform and owner-home cutover on real PostgreSQL", () => {
  let platform: RealPlatformCollaborationTestDatabase;
  let owner: CollaborationTestDatabase;
  let scopeId: string;
  let bearer: string;
  let seed: string;
  let phases: string[];
  let cancelSharedRun: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    platform = await createRealPlatformCollaborationTestDatabase();
    owner = await createRealCollaborationTestDatabase();
    await bootstrapPlatformCollaborationDatabase(platform.collaborationDb);
    await bootstrapChatDatabase(owner.db);
    await bootstrapCollaborationDatabase(owner.db);
    scopeId = randomUUID();
    bearer = randomBytes(32).toString("hex");
    seed = randomBytes(32).toString("base64url");
    phases = [];
    cancelSharedRun = vi.fn(async () => {});
    await platform.collaborationDb.insertInto("collaboration_directory").values({
      scope_id: scopeId, runtime_id: RUNTIME, owner_id: OWNER, kind: "project",
      organization_id: ORG, audience: "members", organization_grant_id: null,
      authority_generation: 1, metadata_revision: 1, last_event_id: randomUUID(), updated_at: NOW,
    }).execute();
    await platform.collaborationDb.insertInto("collaboration_user_index").values({
      actor_id: EDITOR, scope_id: scopeId, status: "accepted", invitation_id: null,
      locator_generation: 1, last_event_id: randomUUID(), updated_at: NOW,
    }).execute();
    await owner.db.insertInto("collaboration_scopes").values({
      id: scopeId, owner_type: "personal", owner_id: OWNER, organization_id: ORG,
      kind: "project", resource_id: "project_cutover_integration", parent_scope_id: null,
      membership_mode: "direct", lifecycle: "shared", revision: 1, auth_epoch: 1,
      authority_runtime_id: RUNTIME, authority_generation: 1, execution_generation: null,
      execution_eligibility: null, deleted_at: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }).execute();
    await owner.db.insertInto("collaboration_members").values([
      { scope_id: scopeId, actor_id: OWNER, role: "owner", status: "accepted", organization_id: ORG,
        invitation_id: null, invited_by: OWNER, accepted_at: NOW.toISOString(), expires_at: null,
        revision: 1, joined_at: NOW.toISOString(), updated_at: NOW.toISOString(), dispositioned_at: null },
      { scope_id: scopeId, actor_id: EDITOR, role: "editor", status: "accepted", organization_id: ORG,
        invitation_id: null, invited_by: OWNER, accepted_at: NOW.toISOString(), expires_at: null,
        revision: 1, joined_at: NOW.toISOString(), updated_at: NOW.toISOString(), dispositioned_at: null },
    ]).execute();
  });

  afterEach(async () => {
    await owner?.destroy();
    await platform?.destroy();
  });

  function realGatewayRoute(controlFresh = true): Hono {
    const publicKey = ed25519PublicKeyRaw(ed25519PrivateKeyFromSeed(seed));
    const cutover = new GatewayCollaborationCutover(owner.db, { now: () => NOW });
    const app = new Hono();
    app.use("*", authMiddleware(bearer));
    app.use("/internal/collaboration/cutover/*", async (c, next) => {
      phases.push(c.req.param("phase") ?? c.req.path.split("/").at(-1)!);
      await next();
    });
    app.route("/", createCollaborationCutoverRoutes({
      ownerId: OWNER, runtimeId: RUNTIME,
      platformKeys: () => [{ keyId: "test", algorithm: "ed25519", publicKey }],
      controlFresh: () => controlFresh,
      cutover,
      drainRuns: (key) => drainActiveSharedRunsForCutover({
        db: owner.db, scopeId: key.scopeId, ownerId: key.ownerId,
        orchestrator: { cancelSharedRun },
      }),
      now: () => NOW,
    }));
    return app;
  }

  function platformCoordinator(app: Hono, presentedBearer = bearer): PlatformCollaborationCutover {
    const resolveHome = createPlatformCutoverHomeResolver({
      keyring: { activeKeyId: "test", keys: { test: seed } },
      resolveRuntime: async () => ({ status: "ready" as const, origin: "https://owner.example", bearerToken: presentedBearer }),
      fetchImpl: async (input, init) => app.request(new Request(input, init)),
      now: () => NOW,
    });
    return new PlatformCollaborationCutover({ db: platform.collaborationDb, resolveHome });
  }

  it("crosses the authenticated home route and activates both databases only after exact phase verification", async () => {
    const result = await platformCoordinator(realGatewayRoute()).run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result).toMatchObject({ phase: "active", counts: { scopes: 1, grants: 1, invitations: 0 } });
    expect(phases).toEqual(["inventory", "freeze", "drain", "stage", "verify", "activate"]);
    expect(cancelSharedRun).not.toHaveBeenCalled();
    const directory = await platform.collaborationDb.selectFrom("collaboration_directory")
      .select(["authority_generation", "metadata_revision"]).where("scope_id", "=", scopeId).executeTakeFirstOrThrow();
    const home = await owner.db.selectFrom("collaboration_scopes")
      .select(["authority_generation", "lifecycle"]).where("id", "=", scopeId).executeTakeFirstOrThrow();
    expect(Number(directory.authority_generation)).toBe(2);
    expect(Number(directory.metadata_revision)).toBe(2);
    expect(Number(home.authority_generation)).toBe(2);
    expect(home.lifecycle).toBe("shared");
    const migrated = await owner.db.selectFrom("collaboration_grants")
      .select(["audience_actor_id", "preset", "legacy_ceiling"]).where("scope_id", "=", scopeId).execute();
    expect(migrated).toEqual([expect.objectContaining({ audience_actor_id: EDITOR, preset: "contributor", legacy_ceiling: "editor" })]);
  });

  it("keeps both generations unchanged when bearer auth or fresh control fails", async () => {
    const wrongBearer = randomBytes(32).toString("hex");
    expect(await platformCoordinator(realGatewayRoute(), wrongBearer).run(scopeId, { backupRef: "restricted-backup-1" }))
      .toMatchObject({ phase: "blocked", blockReason: "home_unavailable" });
    expect(await owner.db.selectFrom("collaboration_cutover_journal").select("scope_id").execute()).toEqual([]);
    const blocked = await platformCoordinator(realGatewayRoute(false)).resume(scopeId);
    expect(blocked).toMatchObject({ phase: "blocked", blockReason: "home_unavailable" });
    expect(Number((await platform.collaborationDb.selectFrom("collaboration_directory")
      .select("authority_generation").where("scope_id", "=", scopeId).executeTakeFirstOrThrow()).authority_generation)).toBe(1);
    expect(Number((await owner.db.selectFrom("collaboration_scopes")
      .select("authority_generation").where("id", "=", scopeId).executeTakeFirstOrThrow()).authority_generation)).toBe(1);
  });
});
