import { insertUserMachine } from "../../packages/platform/src/db.js";
import { CustomerHandleSchema } from "../../packages/platform/src/customer-vps-schema.js";
import { sql } from "kysely";
import { admitCollaborationRuntimeWrite } from "../../packages/platform/src/collaboration/runtime-write-admission.js";
import { Agent } from "undici";
import { bootstrapPlatformCollaboration } from "../../packages/platform/src/collaboration/bootstrap.js";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlatformCollaborationRepository } from "../../packages/platform/src/collaboration/repository.js";
import { CollaborationRuntimeEndpointRegistry } from "../../packages/platform/src/collaboration/runtime-endpoints.js";
import { createProjectedPreviewPair } from "./preview-pair-projected-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("preview pair access retirement (two real Postgres databases)", () => {
  let f: Awaited<ReturnType<typeof createProjectedPreviewPair>>;
  beforeEach(async () => { f = await createProjectedPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  const now = () => new Date(PAIR_NOW);
  async function seed() {
    const repo = new PlatformCollaborationRepository(f.collaborationDb, { now });
    const endpoints = new CollaborationRuntimeEndpointRegistry(f.collaborationDb, { now });
    const runtimeId = `vps:${f.owner.machine_id}`, logical = runtimeId.replace(":", "-");
    const project = randomUUID(), chat = randomUUID(), foreign = randomUUID(), organizationId = "org_pair_fixture";
    const event = { runtimeId, ownerId: f.owner.actor_id, authorityGeneration: 1, metadataRevision: 1, organizationId };
    for (const scopeId of [project, foreign]) await repo.applyDirectoryEvent({ ...event, eventId: randomUUID(), scopeId,
      runtimeId: scopeId === foreign ? "unrelated-runtime" : runtimeId, kind: "project", recipients: [{ actorId: "user_reader", status: "accepted" }] });
    await repo.applyDirectoryEvent({ ...event, eventId: randomUUID(), scopeId: chat, kind: "chat", parentScopeId: project, recipients: [] });
    for (const scopeId of [project, chat, foreign]) await repo.createConnectionTicket({ token: randomUUID(), actorId: "user_reader", scopeId, purpose: "events", expiresAt: new Date(PAIR_NOW + 20_000).toISOString() });
    await endpoints.register({ authenticated: { runtimeId, ownerId: f.owner.actor_id, relayHandle: f.owner.handle },
      registration: { protocolVersion: 2, runtimeId: logical, ownerId: f.owner.actor_id, relayHandle: f.owner.handle,
        authorityGeneration: 1, publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }] },
      controlTicket: { token: "pair-control-ticket", expiresAt: new Date(PAIR_NOW + 20_000) } });
    await endpoints.register({ authenticated: { runtimeId: "unrelated-runtime", ownerId: "user_foreign", relayHandle: "foreign" },
      registration: { protocolVersion: 2, runtimeId: "unrelated-runtime", ownerId: "user_foreign", relayHandle: "foreign", authorityGeneration: 1,
        publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }] },
      controlTicket: { token: "foreign-control-ticket", expiresAt: new Date(PAIR_NOW + 20_000) } });
    // Real non-cascading FK must be retired before directory deletion.
    await f.collaborationDb.insertInto("collaboration_cutover_journal").values({ scope_id: chat, cutover_id: randomUUID(), owner_id: f.owner.actor_id,
      runtime_id: runtimeId, organization_id: organizationId, source_generation: 1, target_generation: 2, source_metadata_revision: 1,
      phase: "pending", resume_phase: null, block_reason: null, backup_ref: "fixture", backup_inventory_ref: null,
      counts: null, ids_digest: null, ceiling_digest: null, fence_epoch: null, fence_digest: null, interrupted_runs: null, rollback_mode: null }).execute();
    await f.collaborationDb.insertInto("collaboration_cutover_dispositions").values({ scope_id: randomUUID(), action: "terminated", owner_id: f.owner.actor_id,
      runtime_id: runtimeId, notice_ref: "fixture", backup_ref: "fixture", home_receipt: "fixture", index_rows: 0 }).execute();
    return { repo, endpoints, runtimeId, logical, project, chat, foreign };
  }
  it("removes the exact runtime's project, inherited Chats, discovery and tickets while preserving another runtime", async () => {
    const s = await seed();
    expect(await s.repo.listForActor("user_reader")).toHaveLength(2);
    await f.retire();
    expect((await s.repo.listForActor("user_reader")).map(entry => entry.scopeId)).toEqual([s.foreign]);
    expect(await s.repo.getDirectoryRoute(s.chat)).toBeNull();
    expect(await s.endpoints.resolve(s.logical)).toBeNull();
    expect(await s.endpoints.resolve("unrelated-runtime")).not.toBeNull();
    expect((await f.collaborationDb.selectFrom("collaboration_connection_tickets").select("scope_id").execute()).map(row => row.scope_id)).toEqual([s.foreign]);
    expect((await f.collaborationDb.selectFrom("collaboration_control_upgrade_tickets").select("runtime_id").execute()).map(row => row.runtime_id)).toEqual(["unrelated-runtime"]);
    expect(await f.collaborationDb.selectFrom("collaboration_cutover_journal").selectAll().execute()).toEqual([]);
    expect(await f.collaborationDb.selectFrom("collaboration_cutover_dispositions").selectAll().execute()).toEqual([]);
    await f.retire();
    expect(await s.repo.listForActor("user_reader")).toHaveLength(1);
  });
  it("production composition rejects late directory, endpoint and ticket writes after retirement", async () => {
    const s = await seed(), dispatcher = new Agent();
    const runtime = await bootstrapPlatformCollaboration({ db: f.target.db, platformSecret: "fixture-preview-secret",
      platformJwtSecret: "fixture-preview-jwt", customerVpsProxyDispatcher: dispatcher, startTimers: false,
      env: { MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com", MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "fixture",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ fixture: Buffer.alloc(32, 1).toString("base64url") }) } });
    try {
      if (!("repository" in runtime) || !runtime.direct) throw new Error("Real collaboration composition is required");
      const repository = runtime.repository, endpoints = runtime.direct.endpoints;
      const writeAll = () => Promise.allSettled([
        repository.applyDirectoryEvent({ eventId: randomUUID(), scopeId: randomUUID(), runtimeId: s.runtimeId,
          ownerId: f.owner.actor_id, kind: "project", authorityGeneration: 1, metadataRevision: 1,
          organizationId: "org_pair_fixture", recipients: [{ actorId: "user_reader", status: "accepted" }] }),
        endpoints.register({ authenticated: { runtimeId: s.runtimeId, ownerId: f.owner.actor_id, relayHandle: f.owner.handle },
          registration: { protocolVersion: 2, runtimeId: s.logical, ownerId: f.owner.actor_id, relayHandle: f.owner.handle,
            authorityGeneration: 1, publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }] } }),
        endpoints.issueControlTicket(s.logical, "late-control", new Date(Date.now() + 20_000)),
        repository.createConnectionTicket({ token: "late-connection", actorId: "user_reader", scopeId: s.project,
          purpose: "events", expiresAt: new Date(Date.now() + 20_000).toISOString() }),
      ]);
      expect((await writeAll()).map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
      await f.retire();
      expect((await writeAll()).map(result => result.status)).toEqual(["rejected", "rejected", "rejected", "rejected"]);
      expect(await s.repo.listForActor("user_reader")).toHaveLength(1);
      expect(await s.endpoints.resolve(s.logical)).toBeNull();
    } finally { try { await runtime.shutdown(); } finally { await dispatcher.close(); } }
  });
  it("serializes an already admitted directory writer before retirement on the machine row", async () => {
    const s = await seed();
    let entered!: () => void, release!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const writer = new PlatformCollaborationRepository(f.collaborationDb, { now,
      admitRuntimeWrite: async (trx, identity) => { await admitCollaborationRuntimeWrite(trx, identity); entered(); await resume; } });
    const scopeId = randomUUID();
    const pending = writer.applyDirectoryEvent({ eventId: randomUUID(), scopeId, runtimeId: s.runtimeId,
      ownerId: f.owner.actor_id, kind: "project", authorityGeneration: 1, metadataRevision: 1,
      organizationId: "org_pair_fixture", recipients: [{ actorId: "user_reader", status: "accepted" }] });
    const completion = pending.catch(error => { throw error; });
    try {
      await admitted;
      // Real conflicting UPDATE, not a timing assertion or a fake query executor.
      await expect(f.target.db.transaction(async trx => {
        await sql`SET LOCAL lock_timeout = '100ms'`.execute(trx.executor);
        await f.retire();
      })).rejects.toMatchObject({ code: "55P03" });
    } finally { release(); await completion; }
    expect(await s.repo.getDirectoryRoute(scopeId)).not.toBeNull();
    await f.retire();
    expect(await s.repo.getDirectoryRoute(scopeId)).toBeNull();
    expect(await s.repo.listForActor("user_reader")).toHaveLength(1);
  });
  it("production composition preserves valid cp-prefixed customer handles", async () => {
    const dispatcher = new Agent();
    const runtime = await bootstrapPlatformCollaboration({ db: f.target.db, platformSecret: "fixture-preview-secret",
      platformJwtSecret: "fixture-preview-jwt", customerVpsProxyDispatcher: dispatcher, startTimers: false,
      env: { MATRIX_COLLABORATION_ALLOWED_ORIGINS: "https://app.matrix-os.com", MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: "fixture",
        MATRIX_COLLABORATION_TICKET_KEYS: JSON.stringify({ fixture: Buffer.alloc(32, 1).toString("base64url") }) } });
    try {
      if (!("repository" in runtime) || !runtime.direct) throw new Error("Real collaboration composition is required");
      for (const handle of ["cp-alice", "cp-design-team"]) {
        CustomerHandleSchema.parse(handle);
        const machineId = randomUUID(), runtimeId = `vps:${machineId}`, logical = runtimeId.replace(":", "-");
        const actorId = "user_customer_" + handle, scopeId = randomUUID();
        await insertUserMachine(f.target.db, { machineId, clerkUserId: actorId, handle, runtimeSlot: "primary",
          provisioningClass: "customer", status: "running", provisionedAt: now().toISOString() });
        await runtime.repository.applyDirectoryEvent({ eventId: randomUUID(), scopeId, runtimeId, ownerId: actorId,
          kind: "project", authorityGeneration: 1, metadataRevision: 1, organizationId: "org_fixture_customer",
          recipients: [{ actorId: "user_reader", status: "accepted" }] });
        await runtime.direct.endpoints.register({ authenticated: { runtimeId, ownerId: actorId, relayHandle: handle },
          registration: { protocolVersion: 2, runtimeId: logical, ownerId: actorId, relayHandle: handle,
            authorityGeneration: 1, publicKeys: [{ keyId: "home", algorithm: "ed25519", publicKey: "B".repeat(43) }] } });
        await runtime.direct.endpoints.issueControlTicket(logical, "control-" + handle, new Date(Date.now() + 20_000));
        await runtime.repository.createConnectionTicket({ token: "connection-" + handle, actorId: "user_reader", scopeId,
          purpose: "events", expiresAt: new Date(Date.now() + 20_000).toISOString() });
        expect(await runtime.repository.getDirectoryRoute(scopeId)).toMatchObject({ runtimeId, ownerId: actorId });
      }
    } finally { try { await runtime.shutdown(); } finally { await dispatcher.close(); } }
  });
  it("rolls back retirement instead of cascading into a mismatched runtime's child", async () => {
    const s = await seed();
    // Corruption fixture: normal ingestion correctly disallows this cross-runtime parent.
    await f.collaborationDb.updateTable("collaboration_directory").set({ runtime_id: "unrelated-runtime" }).where("scope_id", "=", s.chat).execute();
    await expect(f.retire()).rejects.toThrow();
    expect(await s.repo.listForActor("user_reader")).toHaveLength(2);
    expect((await f.target.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", f.owner.machine_id).executeTakeFirstOrThrow()).status).toBe("running");
  });
});
