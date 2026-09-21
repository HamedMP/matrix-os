import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { Kysely, PostgresDialect, sql, type KyselyPlugin } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapPlatformCollaborationDatabase,
  type CollaborationPlatformDatabase,
} from "../../packages/platform/src/collaboration/database.js";
import { inventoryPlatformPersonToPersonRecords } from "../../packages/platform/src/collaboration/person-to-person-inventory.js";
import { PlatformCollaborationCutover, cutoverTicketAdmission } from "../../packages/platform/src/collaboration/cutover.js";
import { createGatewayCutoverHomeAdapter } from "../../packages/platform/src/collaboration/cutover-home-adapter.js";
import { createPlatformCutoverHomeResolver } from "../../packages/platform/src/collaboration/cutover-home-transport.js";
import { canonicalJson, ed25519PrivateKeyFromSeed, ed25519PublicKeyRaw, verifyEd25519 } from "../../packages/platform/src/collaboration/ticket-crypto.js";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { CollaborationTicketIssuer } from "../../packages/platform/src/collaboration/ticket-issuer.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const runtimeId = "vps:11111111-1111-4111-8111-111111111111";
const logicalRuntimeId = "vps-11111111-1111-4111-8111-111111111111";

describe.skipIf(!connectionString)("collaboration cutover on real PostgreSQL (T088)", () => {
  let adminDb: Kysely<Record<string, never>>;
  let db: Kysely<CollaborationPlatformDatabase>;
  let schema: string;

  beforeEach(async () => {
    schema = `collab_cutover_${randomUUID().replaceAll("-", "")}`;
    adminDb = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
    db = new Kysely<CollaborationPlatformDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString, max: 4, options: `-c search_path=${schema},public` }),
      }),
    });
    await bootstrapPlatformCollaborationDatabase(db);
  });

  afterEach(async () => {
    await db.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
    await adminDb.destroy();
  });

  it("inventories only legacy person-to-person rows, excluding active organization shares", async () => {
    const legacyScope = randomUUID();
    const organizationScope = randomUUID();
    for (const [scopeId, organizationId] of [[legacyScope, null], [organizationScope, "org_current"]] as const) {
      await db.insertInto("collaboration_directory").values({
        scope_id: scopeId, runtime_id: "vps:owner-runtime", owner_id: "owner-a", kind: "chat",
        organization_id: organizationId, audience: organizationId ? "organization" : null,
        authority_generation: 1, metadata_revision: 1, last_event_id: randomUUID(), updated_at: new Date(),
      }).execute();
    }
    await db.insertInto("collaboration_user_index").values([
      { actor_id: "legacy-actor", scope_id: legacyScope, status: "invited", invitation_id: randomUUID(), locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
      { actor_id: "legacy-ended", scope_id: legacyScope, status: "revoked", invitation_id: null, locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
      { actor_id: "org-actor", scope_id: organizationScope, status: "accepted", invitation_id: null, locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
      { actor_id: "org-ended", scope_id: organizationScope, status: "revoked", invitation_id: null, locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date() },
    ]).execute();

    expect(await inventoryPlatformPersonToPersonRecords(db)).toEqual({
      directoryScopes: 1,
      invitedIndexRows: 1,
      acceptedIndexRows: 0,
      revokedIndexRows: 1,
      total: 3,
    });
  });

  async function orgScope(): Promise<string> {
    const scopeId = randomUUID();
    await db.insertInto("collaboration_directory").values({
      scope_id: scopeId, runtime_id: runtimeId, owner_id: "owner-a", kind: "project",
      organization_id: "org_current", audience: "organization", organization_grant_id: randomUUID(),
      authority_generation: 1, metadata_revision: 1, last_event_id: randomUUID(), updated_at: new Date(),
    }).execute();
    await db.insertInto("collaboration_user_index").values({
      actor_id: "member-a", scope_id: scopeId, status: "accepted", invitation_id: null,
      locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date(),
    }).execute();
    return scopeId;
  }

  const counts = { scopes: 1, grants: 2, invitations: 1 };
  const idsDigest = "a".repeat(64);
  const ceilingDigest = "b".repeat(64);
  const fenceDigest = "c".repeat(64);

  function home(scopeId: string) {
    return {
      inventory: vi.fn(async () => ({
        scopeId, organizationId: "org_current", authorityGeneration: 1,
        counts, idsDigest, ceilingDigest, backupInventoryRef: "owner-inventory-1", nonOrganizationRecords: 0,
      })),
      freeze: vi.fn(async () => ({ fenceEpoch: 1, fenceDigest })),
      drain: vi.fn(async () => ({ remainingRuns: 0, interruptedRuns: 1 })),
      stage: vi.fn(async () => ({ counts, idsDigest, ceilingDigest })),
      verify: vi.fn(async () => ({ counts, idsDigest, ceilingDigest, nonOrganizationRecords: 0 })),
      activate: vi.fn(async () => ({ authorityGeneration: 2 })),
      rollbackCompatible: vi.fn(async () => ({ authorityGeneration: 2 })),
      disable: vi.fn(async () => ({ fenced: true as const })),
    };
  }

  function cutover(ownerHome: ReturnType<typeof home>, status: "ready" | "offline" | "ambiguous" = "ready") {
    return new PlatformCollaborationCutover({
      db,
      resolveHome: vi.fn(async () => status === "ready" ? { status, home: ownerHome } : { status }),
      verifyCompatibleDirectBuild: vi.fn(async () => true),
    });
  }

  it("imports once, preserves exact counts and ceilings, and atomically activates directory generation", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    const coordinator = cutover(ownerHome);

    const first = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    const again = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    expect(first.phase).toBe("active");
    expect(again).toEqual(first);
    expect(ownerHome.stage).toHaveBeenCalledOnce();
    expect(ownerHome.activate).toHaveBeenCalledOnce();
    const directory = await db.selectFrom("collaboration_directory").selectAll().where("scope_id", "=", scopeId).executeTakeFirstOrThrow();
    expect(Number(directory.authority_generation)).toBe(2);
    expect(Number(directory.metadata_revision)).toBe(2);
    const member = await db.selectFrom("collaboration_user_index").selectAll().where("scope_id", "=", scopeId).executeTakeFirstOrThrow();
    expect(Number(member.locator_generation)).toBe(2);
    expect(first).toMatchObject({ scopeId, counts, idsDigest, ceilingDigest, backupRef: "restricted-backup-1" });
  });

  it.each(["ambiguous", "offline"] as const)("blocks %s owner resolution without a home import", async (status) => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    const result = await cutover(ownerHome, status).run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result.phase).toBe("blocked");
    expect(result.blockReason).toBe(status);
    expect(ownerHome.inventory).not.toHaveBeenCalled();
    expect(Number((await db.selectFrom("collaboration_directory").select("authority_generation").where("scope_id", "=", scopeId).executeTakeFirstOrThrow()).authority_generation)).toBe(1);
  });

  it("fails closed when shadow import widens an old action ceiling", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    ownerHome.stage.mockResolvedValueOnce({ counts, idsDigest, ceilingDigest: "d".repeat(64) });
    const result = await cutover(ownerHome).run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result.phase).toBe("blocked");
    expect(result.blockReason).toBe("shadow_mismatch");
    expect(ownerHome.activate).not.toHaveBeenCalled();
  });

  it("holds platform directory events behind a failed or uncertain home freeze", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    ownerHome.freeze.mockRejectedValueOnce(new Error("home unavailable"));
    const coordinator = cutover(ownerHome);
    const result = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result.phase).toBe("blocked");
    expect(result.resumePhase).toBe("inventoried");
    const repository = new PlatformCollaborationRepository(db);
    await expect(repository.applyDirectoryEvent({
      eventId: randomUUID(), scopeId, runtimeId, ownerId: "owner-a", kind: "project",
      organizationId: "org_current", audience: "organization", authorityGeneration: 1, metadataRevision: 2,
      recipients: [],
    })).rejects.toMatchObject({ code: "conflict" });
    expect(ownerHome.stage).not.toHaveBeenCalled();
  });

  it("blocks after a lost directory CAS acknowledgement while keeping the home activation idempotent", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    ownerHome.activate.mockImplementationOnce(async () => {
      await db.updateTable("collaboration_directory").set({ authority_generation: 3 }).where("scope_id", "=", scopeId).execute();
      return { authorityGeneration: 2 };
    });
    const coordinator = cutover(ownerHome);
    const result = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result.phase).toBe("blocked");
    expect(result.blockReason).toBe("directory_generation_conflict");
    expect(result.resumePhase).toBe("verified");
    expect(Number((await db.selectFrom("collaboration_directory").select("authority_generation").where("scope_id", "=", scopeId).executeTakeFirstOrThrow()).authority_generation)).toBe(3);
    expect((await coordinator.resume(scopeId)).phase).toBe("blocked");
  });

  it("allows only a compatible direct rollback or a disabled collaboration fence", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    const coordinator = cutover(ownerHome);
    await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    await expect(coordinator.rollback(scopeId, "legacy")).rejects.toThrow();
    await expect(coordinator.rollback(scopeId, "compatible_direct")).rejects.toThrow();
    const compatible = await coordinator.rollback(scopeId, "compatible_direct", { compatibleDirectBuild: true });
    expect(compatible.phase).toBe("active");
    expect(compatible.rollbackMode).toBe("compatible_direct");
    expect(ownerHome.rollbackCompatible).toHaveBeenCalledOnce();
    const disabled = await coordinator.rollback(scopeId, "disable");
    expect(disabled.phase).toBe("blocked");
    expect(disabled.blockReason).toBe("disabled_for_recovery");
    expect(ownerHome.disable).toHaveBeenCalledOnce();
  });

  it("reconciles an active compatible rollback after the owner home returns without repeating activation", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    let ready = true;
    const verifyCompatibleDirectBuild = vi.fn(async () => true);
    const coordinator = new PlatformCollaborationCutover({
      db,
      resolveHome: async () => ready ? { status: "ready" as const, home: ownerHome } : { status: "offline" as const },
      verifyCompatibleDirectBuild,
    });
    expect((await coordinator.run(scopeId, { backupRef: "restricted-backup-1" })).phase).toBe("active");
    ready = false;
    expect(await coordinator.rollback(scopeId, "compatible_direct", { compatibleDirectBuild: true }))
      .toMatchObject({ phase: "blocked", blockReason: "offline", resumePhase: "active" });
    expect(await cutoverTicketAdmission(db, scopeId)).toBe(false);
    ready = true;
    expect(await coordinator.resume(scopeId)).toMatchObject({ phase: "active", rollbackMode: "compatible_direct" });
    expect(await cutoverTicketAdmission(db, scopeId)).toBe(true);
    expect(ownerHome.activate).toHaveBeenCalledOnce();
    expect(ownerHome.rollbackCompatible).toHaveBeenCalledOnce();
    expect(verifyCompatibleDirectBuild).toHaveBeenCalledTimes(2);
    const directory = await db.selectFrom("collaboration_directory").select(["authority_generation", "metadata_revision"])
      .where("scope_id", "=", scopeId).executeTakeFirstOrThrow();
    expect([Number(directory.authority_generation), Number(directory.metadata_revision)]).toEqual([2, 2]);
  });

  it("rejects a caller assertion of compatibility without a fresh installed-build verifier", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    const coordinator = new PlatformCollaborationCutover({
      db, resolveHome: async () => ({ status: "ready", home: ownerHome }),
    });
    await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    await expect(coordinator.rollback(scopeId, "compatible_direct", { compatibleDirectBuild: true }))
      .rejects.toThrow(/compatible direct build/i);
    expect(ownerHome.rollbackCompatible).not.toHaveBeenCalled();
  });

  it("adapts flat home inventory and canonical scoped drain without widening counts", async () => {
    const scopeId = await orgScope();
    const calls: Array<{ phase: string; source: number; target: number }> = [];
    const flat = (phase: string) => ({
      scopeId, organizationId: "org_current", phase,
      authorityGeneration: ["active", "rolled_back", "blocked"].includes(phase) ? 2 : 1,
      legacyCount: 1, grantCount: 1, invitationCount: 0, nonOrganizationCount: 0,
      idsDigest, ceilingDigest, backupInventoryRef: "owner-inventory-1", backupRef: "owner-inventory-1",
      fenceEpoch: phase === "inventoried" ? null : 3,
      fenceDigest: phase === "inventoried" ? null : fenceDigest,
      ...(phase === "drained" ? { interrupted: 1 } : {}),
    });
    const operation = (phase: string) => vi.fn(async (key: { expectedSourceGeneration: number; targetGeneration: number }) => {
      calls.push({ phase, source: key.expectedSourceGeneration, target: key.targetGeneration });
      return flat(phase);
    });
    const client = {
      inventory: operation("inventoried"), freeze: operation("fenced"),
      drain: vi.fn(async (key: { expectedSourceGeneration: number; targetGeneration: number }, callback: () => Promise<{ interrupted: number; remaining: number }>) => {
        calls.push({ phase: "drained", source: key.expectedSourceGeneration, target: key.targetGeneration });
        expect(await callback()).toEqual({ interrupted: 1, remaining: 0 });
        return flat("drained");
      }),
      stage: operation("staged"), verify: operation("verified"), activate: operation("active"),
      rollbackCompatible: vi.fn(async (key: { expectedSourceGeneration: number; targetGeneration: number }, proof: { compatibleDirectBuild: boolean }) => {
        expect(proof).toEqual({ compatibleDirectBuild: true });
        calls.push({ phase: "rolled_back", source: key.expectedSourceGeneration, target: key.targetGeneration });
        return flat("rolled_back");
      }),
      disable: operation("blocked"),
    };
    const drainRuns = vi.fn(async () => ({ interrupted: 1, remaining: 0 }));
    const adapter = createGatewayCutoverHomeAdapter({ client, drainRuns });
    const coordinator = cutover(adapter);
    const result = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result).toMatchObject({ phase: "active", counts: { scopes: 1, grants: 2, invitations: 0 } });
    expect(drainRuns).toHaveBeenCalledWith(expect.objectContaining({ scopeId, ownerId: "owner-a" }));
    await coordinator.rollback(scopeId, "compatible_direct", { compatibleDirectBuild: true });
    await coordinator.rollback(scopeId, "disable");
    expect(calls.map((call) => call.phase)).toEqual([
      "inventoried", "fenced", "drained", "staged", "verified", "active", "rolled_back", "blocked",
    ]);
    expect(calls.every((call) => call.source === 1 && call.target === 2)).toBe(true);
  });

  it("blocks a flat home response that changes the bound organization", async () => {
    const scopeId = await orgScope();
    const client = {
      inventory: vi.fn(async () => ({
        scopeId, organizationId: "different-org", phase: "inventoried", authorityGeneration: 1,
        legacyCount: 0, grantCount: 1, invitationCount: 0, nonOrganizationCount: 0,
        idsDigest, ceilingDigest, backupInventoryRef: "owner-inventory-1", backupRef: "owner-inventory-1",
        fenceEpoch: null, fenceDigest: null,
      })),
      freeze: vi.fn(), drain: vi.fn(), stage: vi.fn(), verify: vi.fn(), activate: vi.fn(),
      rollbackCompatible: vi.fn(), disable: vi.fn(),
    };
    const result = await cutover(createGatewayCutoverHomeAdapter({
      client, drainRuns: async () => ({ interrupted: 0, remaining: 0 }),
    })).run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result).toMatchObject({ phase: "blocked", blockReason: "home_unavailable" });
    expect(client.freeze).not.toHaveBeenCalled();
  });

  it("sends authenticated signed commands through the owner-home route for every cutover phase", async () => {
    const scopeId = await orgScope();
    const seed = randomBytes(32).toString("base64url");
    const publicKey = ed25519PublicKeyRaw(ed25519PrivateKeyFromSeed(seed));
    const bearerToken = randomBytes(32).toString("hex");
    const called: string[] = [];
    const app = new Hono();
    app.post("/internal/collaboration/cutover/:scopeId/:phase", async (c) => {
      const envelope = await c.req.json() as {
        command: Record<string, unknown> & { phase: string; path: string; runtimeId: string; ownerId: string; scopeId: string };
        keyId: string; signature: string;
      };
      const command = envelope.command;
      if (c.req.header("authorization") !== `Bearer ${bearerToken}` || envelope.keyId !== "test"
        || command.scopeId !== scopeId || command.ownerId !== "owner-a" || command.runtimeId !== runtimeId
        || command.phase !== c.req.param("phase") || command.path !== c.req.path
        || typeof command.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(command.nonce)
        || !verifyEd25519(publicKey, `matrix-collaboration-cutover-v1\n${canonicalJson(command)}`, envelope.signature)) {
        return c.json({ error: "Unavailable", code: "unavailable" }, 503);
      }
      called.push(command.phase);
      const phase = command.phase;
      return c.json({
        scopeId, organizationId: "org_current", phase: phase === "inventory" ? "inventoried"
          : phase === "freeze" ? "fenced" : phase === "drain" ? "drained"
            : phase === "stage" ? "staged" : phase === "verify" ? "verified" : "active",
        authorityGeneration: phase === "activate" ? 2 : 1,
        legacyCount: 1, grantCount: 1, invitationCount: 0, nonOrganizationCount: 0,
        idsDigest, ceilingDigest, backupInventoryRef: "owner-inventory-1", backupRef: "owner-inventory-1",
        fenceEpoch: phase === "inventory" ? null : 3, fenceDigest: phase === "inventory" ? null : fenceDigest,
        ...(phase === "drain" ? { interrupted: 1 } : {}),
      });
    });
    const resolver = createPlatformCutoverHomeResolver({
      keyring: { activeKeyId: "test", keys: { test: seed } },
      resolveRuntime: async () => ({ status: "ready" as const, origin: "https://owner.example", bearerToken }),
      fetchImpl: async (input, init) => app.request(new Request(input, init)),
    });
    const result = await new PlatformCollaborationCutover({ db, resolveHome: resolver })
      .run(scopeId, { backupRef: "restricted-backup-1" });
    expect(result.phase).toBe("active");
    expect(called).toEqual(["inventory", "freeze", "drain", "stage", "verify", "activate"]);
  });

  it("keeps the transport journal blocked when the home is offline or returns a different scope", async () => {
    const offlineScope = await orgScope();
    const noFetch = vi.fn(async () => { throw new Error("Unexpected request"); });
    const offline = createPlatformCutoverHomeResolver({
      keyring: { activeKeyId: "test", keys: { test: randomBytes(32).toString("base64url") } },
      resolveRuntime: async () => ({ status: "offline" as const }), fetchImpl: noFetch,
    });
    expect(await new PlatformCollaborationCutover({ db, resolveHome: offline })
      .run(offlineScope, { backupRef: "restricted-backup-1" })).toMatchObject({ phase: "blocked", blockReason: "offline" });
    expect(noFetch).not.toHaveBeenCalled();

    const mismatchScope = await orgScope();
    const mismatch = createPlatformCutoverHomeResolver({
      keyring: { activeKeyId: "test", keys: { test: randomBytes(32).toString("base64url") } },
      resolveRuntime: async () => ({ status: "ready" as const, origin: "https://owner.example", bearerToken: randomBytes(32).toString("hex") }),
      fetchImpl: async () => Response.json({
        scopeId: randomUUID(), organizationId: "org_current", phase: "inventoried", authorityGeneration: 1,
        legacyCount: 0, grantCount: 0, invitationCount: 0, nonOrganizationCount: 0,
        idsDigest, ceilingDigest, backupInventoryRef: "owner-inventory-1", backupRef: "owner-inventory-1",
        fenceEpoch: null, fenceDigest: null,
      }),
    });
    expect(await new PlatformCollaborationCutover({ db, resolveHome: mismatch })
      .run(mismatchScope, { backupRef: "restricted-backup-1" })).toMatchObject({ phase: "blocked", blockReason: "home_unavailable" });
  });

  it("rejects a new direct ticket after disabled rollback", async () => {
    const scopeId = await orgScope();
    const coordinator = cutover(home(scopeId));
    await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    await coordinator.rollback(scopeId, "disable");
    const repository = new PlatformCollaborationRepository(db);
    const issuer = new CollaborationTicketIssuer({
      keyring: { activeKeyId: "test", keys: { test: randomBytes(32).toString("base64url") } },
      repository,
      endpoints: { resolveEnrolled: vi.fn(async () => ({
        runtimeId: logicalRuntimeId, ownerId: "owner-a", authorityGeneration: 2,
        lastControlAt: new Date().toISOString(),
      })) } as never,
      resolveOrganization: async () => "org_current",
      projection: { isCurrentMember: async () => true },
      relayOrigin: "https://relay.example",
      cutoverAdmission: (id) => cutoverTicketAdmission(db, id),
    });
    await expect(issuer.issue({
      actorId: "member-a",
      request: {
        clientRequestId: randomUUID(), scopeId, purpose: "direct_session",
        proofPublicKey: randomBytes(32).toString("base64url"),
      },
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("never imports a person-to-person row until a noticed disposition is recorded", async () => {
    const scopeId = await orgScope();
    const legacyScopeId = randomUUID();
    await db.insertInto("collaboration_directory").values({
      scope_id: legacyScopeId, runtime_id: "vps:legacy", owner_id: "owner-a", kind: "chat",
      organization_id: null, audience: null, organization_grant_id: null,
      authority_generation: 1, metadata_revision: 1, last_event_id: randomUUID(), updated_at: new Date(),
    }).execute();
    await db.insertInto("collaboration_user_index").values({
      actor_id: "legacy-actor", scope_id: legacyScopeId, status: "revoked", invitation_id: null,
      locator_generation: 1, last_event_id: randomUUID(), updated_at: new Date(),
    }).execute();
    const ownerHome = home(scopeId);
    const coordinator = cutover(ownerHome);
    const blocked = await coordinator.run(scopeId, { backupRef: "restricted-backup-1" });
    expect(blocked.phase).toBe("blocked");
    expect(blocked.blockReason).toBe("legacy_disposition_required");
    expect(ownerHome.inventory).not.toHaveBeenCalled();
    await expect(coordinator.terminateLegacy({ scopeId: legacyScopeId, noticeRef: "", backupRef: "restricted-backup-1", homeReceipt: "home-ended-1" })).rejects.toThrow();
    await coordinator.terminateLegacy({ scopeId: legacyScopeId, noticeRef: "notice-1", backupRef: "restricted-backup-1", homeReceipt: "home-ended-1" });
    expect((await inventoryPlatformPersonToPersonRecords(db)).total).toBe(0);
    const disposition = await db.selectFrom("collaboration_cutover_dispositions").selectAll().where("scope_id", "=", legacyScopeId).executeTakeFirstOrThrow();
    expect(disposition).toMatchObject({ action: "terminated", notice_ref: "notice-1", home_receipt: "home-ended-1" });
    expect((await coordinator.resume(scopeId)).phase).toBe("active");
  });

  /**
   * resume() reads the blocked journal, then writes. A recovery disable that commits inside that
   * window must not be reopened by the stale resume write.
   */
  function racingCoordinator(ownerHome: ReturnType<typeof home>, onJournalRead: () => Promise<void>): PlatformCollaborationCutover {
    let armed = true;
    const plugin: KyselyPlugin = {
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        if (armed && args.result.rows.some((row) => typeof row === "object" && row !== null && "resume_phase" in row)) {
          armed = false;
          await onJournalRead();
        }
        return args.result;
      },
    };
    return new PlatformCollaborationCutover({
      db: db.withPlugin(plugin),
      resolveHome: vi.fn(async () => ({ status: "ready" as const, home: ownerHome })),
      verifyCompatibleDirectBuild: vi.fn(async () => true),
    });
  }

  it("keeps recovery disabled when it commits while a resume read is in flight", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    ownerHome.freeze.mockRejectedValueOnce(new Error("home unavailable"));
    const coordinator = cutover(ownerHome);
    expect(await coordinator.run(scopeId, { backupRef: "restricted-backup-1" }))
      .toMatchObject({ phase: "blocked", blockReason: "home_unavailable", resumePhase: "inventoried" });

    const racing = racingCoordinator(ownerHome, async () => { await coordinator.rollback(scopeId, "disable"); });
    expect(await racing.resume(scopeId)).toMatchObject({ phase: "blocked", blockReason: "disabled_for_recovery" });
    expect(await db.selectFrom("collaboration_cutover_journal").select(["phase", "block_reason"])
      .where("scope_id", "=", scopeId).executeTakeFirstOrThrow())
      .toMatchObject({ phase: "blocked", block_reason: "disabled_for_recovery" });
    expect(await cutoverTicketAdmission(db, scopeId)).toBe(false);
    expect(ownerHome.activate).not.toHaveBeenCalled();
  });

  it("disables recovery even when a resume commits while the disable read is in flight", async () => {
    const scopeId = await orgScope();
    const ownerHome = home(scopeId);
    ownerHome.freeze.mockRejectedValueOnce(new Error("home unavailable"));
    const coordinator = cutover(ownerHome);
    expect(await coordinator.run(scopeId, { backupRef: "restricted-backup-1" }))
      .toMatchObject({ phase: "blocked", blockReason: "home_unavailable", resumePhase: "inventoried" });

    // The resume reaches the active generation, so the disable read observes a stale blocked phase.
    const racing = racingCoordinator(ownerHome, async () => {
      expect(await coordinator.resume(scopeId)).toMatchObject({ phase: "active" });
    });
    expect(await racing.rollback(scopeId, "disable")).toMatchObject({ phase: "blocked", blockReason: "disabled_for_recovery" });
    expect(await db.selectFrom("collaboration_cutover_journal").select(["phase", "block_reason", "resume_phase"])
      .where("scope_id", "=", scopeId).executeTakeFirstOrThrow())
      .toMatchObject({ phase: "blocked", block_reason: "disabled_for_recovery", resume_phase: null });
    expect(await cutoverTicketAdmission(db, scopeId)).toBe(false);
  });
});
