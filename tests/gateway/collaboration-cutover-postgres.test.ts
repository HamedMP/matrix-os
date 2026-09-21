import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { drainActiveSharedRunsForCutover, GatewayCollaborationCutover } from "../../packages/gateway/src/collaboration/cutover.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { lockDirectScope } from "../../packages/gateway/src/collaboration/repository-shared.js";
import {
  allowAllOrganizationPrecondition, collaborationActors, collaborationIds, createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = "2026-09-21T11:00:00.000Z";
const ORG = "org_cutover_test";
const key = {
  scopeId: collaborationIds.scope,
  ownerId: collaborationActors.owner,
  organizationId: ORG,
  runtimeId: collaborationIds.runtime,
  expectedSourceGeneration: 1,
  targetGeneration: 2,
  idempotencyKey: "cutover-124-test-1",
};

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("S18 home cutover on real Postgres", () => {
  let fixture: CollaborationTestDatabase;
  let cutover: GatewayCollaborationCutover;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: key.scopeId, owner_type: "personal", owner_id: key.ownerId, organization_id: ORG,
      kind: "project", resource_id: "project_cutover", parent_scope_id: null,
      membership_mode: "direct", lifecycle: "shared", revision: 1, auth_epoch: 1,
      authority_runtime_id: key.runtimeId, authority_generation: 1, execution_generation: null,
      execution_eligibility: null, deleted_at: null, created_at: NOW, updated_at: NOW,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values([
      member(collaborationActors.owner, "owner", ORG),
      member(collaborationActors.editor, "editor", ORG),
      member(collaborationActors.viewer, "viewer", ORG),
    ]).execute();
    await fixture.db.insertInto("collaboration_grants").values({
      id: "80000000-0000-4000-8000-000000000001", scope_id: key.scopeId, organization_id: ORG,
      audience_kind: "member", audience_actor_id: "user_existing_grant", preset: "viewer",
      state: "active", policy_version: "legacy-disposition", source_id: "existing",
      legacy_ceiling: "viewer", expires_at: null, revision: 1, created_by: key.ownerId,
      created_at: NOW, updated_at: NOW, revoked_at: null,
    }).execute();
    cutover = new GatewayCollaborationCutover(fixture.db, { now: () => new Date(NOW) });
  });

  afterEach(async () => { if (fixture) await fixture.destroy(); });

  it("migrates v14 and inventories immutable old ceilings and stable IDs", async () => {
    await fixture.db.insertInto("collaboration_members").values({
      ...member("user_pending_cutover", "viewer", ORG), status: "pending",
      invitation_id: "30000000-0000-4000-8000-000000000099", accepted_at: null,
      joined_at: null, expires_at: "2026-09-22T11:00:00.000Z",
    }).execute();
    const inventory = await cutover.inventory(key);
    expect(inventory).toMatchObject({ phase: "inventoried", legacyCount: 2, grantCount: 1, invitationCount: 1, nonOrganizationCount: 0 });
    expect(inventory.ceilingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.idsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.backupRef).toMatch(/^cutover:/);
    expect(await cutover.inventory(key)).toEqual(inventory);
    const backup = await sql<{ inventory: unknown }>`SELECT inventory FROM collaboration_cutover_journal WHERE scope_id = ${key.scopeId}`.execute(fixture.db);
    expect(JSON.stringify(backup.rows[0]?.inventory)).toContain("80000000-0000-4000-8000-000000000001");
    expect(JSON.stringify(backup.rows[0]?.inventory)).toContain("30000000-0000-4000-8000-000000000099");
    expect(JSON.stringify(backup.rows[0]?.inventory)).toContain(collaborationActors.owner);
    const versions = await fixture.db.selectFrom("collaboration_schema_migrations").select("version").execute();
    expect(versions.map((row) => Number(row.version))).toContain(14);
    await cutover.freeze(key);
    await cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 }));
    await expect(cutover.stage(key)).rejects.toThrow(/invitation/i);
  });

  it("fences ordinary authorization before drain and imports exact ceilings once", async () => {
    const before = await cutover.inventory(key);
    const frozen = await cutover.freeze(key);
    expect(frozen.phase).toBe("fenced");
    expect(frozen.fenceEpoch).toBeGreaterThan(1);
    const fencedScope = await fixture.db.selectFrom("collaboration_scopes").select(["lifecycle", "auth_epoch"]).where("id", "=", key.scopeId).executeTakeFirstOrThrow();
    expect(fencedScope.lifecycle).toBe("recovering");
    expect(Number(fencedScope.auth_epoch)).toBe(frozen.fenceEpoch);
    await expect(cutover.assertWritable(key.scopeId)).rejects.toThrow();
    await expect(cutover.assertRuntimeWritable(key.runtimeId)).rejects.toThrow();
    expect(await cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 }))).toMatchObject({ phase: "drained" });
    expect(await cutover.stage(key)).toMatchObject({ phase: "staged", shadowCount: 2 });
    expect(await cutover.stage(key)).toMatchObject({ phase: "staged", shadowCount: 2 });
    expect(await cutover.verify(key)).toMatchObject({ phase: "verified", legacyCount: before.legacyCount, grantCount: before.grantCount });
    expect(await cutover.activate(key)).toMatchObject({ phase: "active", authorityGeneration: 2, ceilingDigest: before.ceilingDigest });
    expect(await cutover.activate(key)).toMatchObject({ phase: "active", authorityGeneration: 2 });
    const grants = await fixture.db.selectFrom("collaboration_grants").select(["id", "audience_actor_id", "legacy_ceiling"]).where("scope_id", "=", key.scopeId).execute();
    expect(grants).toHaveLength(3);
    expect(grants.find((grant) => grant.audience_actor_id === collaborationActors.editor)?.legacy_ceiling).toBe("editor");
    expect(grants.find((grant) => grant.audience_actor_id === collaborationActors.viewer)?.legacy_ceiling).toBe("viewer");
    expect(grants.some((grant) => grant.id === "80000000-0000-4000-8000-000000000001")).toBe(true);
    expect(await cutover.assertWritable(key.scopeId)).toBeUndefined();
    expect(await cutover.assertRuntimeWritable(key.runtimeId)).toBeUndefined();
  });

  it("never reopens an accepted legacy member row inserted after direct activation", async () => {
    const revivedActor = "user_revived_legacy_after_cutover";
    const authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
      now: () => new Date(NOW), organizationPrecondition: allowAllOrganizationPrecondition,
    });
    await cutover.inventory(key);
    await cutover.freeze(key);
    await cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 }));
    await cutover.stage(key);
    await cutover.verify(key);
    await cutover.activate(key);
    await fixture.db.insertInto("collaboration_members").values(member(revivedActor, "editor", ORG)).execute();
    await expect(authority.authorize({ scopeId: key.scopeId, actorId: revivedActor, action: "read" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("holds a failed drain and interrupted activation fenced for safe retry", async () => {
    await cutover.inventory(key);
    await cutover.freeze(key);
    await expect(cutover.drain(key, async () => { throw new Error("host unavailable"); })).rejects.toThrow("host unavailable");
    await expect(cutover.stage(key)).rejects.toThrow();
    expect(await cutover.drain(key, async () => ({ interrupted: 1, remaining: 0 }))).toMatchObject({ phase: "drained", interrupted: 1 });
    await cutover.stage(key);
    await cutover.verify(key);
    await fixture.db.updateTable("collaboration_scopes").set({ authority_generation: 3 }).where("id", "=", key.scopeId).execute();
    await expect(cutover.activate(key)).rejects.toThrow();
    await expect(cutover.assertWritable(key.scopeId)).rejects.toThrow();
  });

  it("rejects a writer that reaches the locked scope row after the fence commits", async () => {
    await cutover.inventory(key);
    await cutover.freeze(key);
    await expect(fixture.db.transaction().execute((trx) => lockDirectScope(trx, key.scopeId)))
      .rejects.toThrow(/cutover|maintenance/i);
  });

  it("never accepts a drain callback that reports zero while a canonical shared run remains active", async () => {
    await seedActiveRun(fixture);
    await cutover.inventory(key);
    await cutover.freeze(key);
    await expect(cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 })))
      .rejects.toThrow(/run|drain/i);
    const cancelSharedRun = async (_owner: unknown, _scopeId: string, _chatId: string, runId: string) => {
      await sql`UPDATE chat_runs SET status = 'aborted', outcome = 'aborted' WHERE id = ${runId}`.execute(fixture.db);
    };
    const drained = await cutover.drain(key, () => drainActiveSharedRunsForCutover({
      db: fixture.db, scopeId: key.scopeId, ownerId: key.ownerId, orchestrator: { cancelSharedRun },
    }));
    expect(drained).toMatchObject({ phase: "drained", interrupted: 1 });
  });

  it("blocks person-to-person rows instead of converting them to organization grants", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ organization_id: null }).where("id", "=", key.scopeId).execute();
    await expect(cutover.inventory(key)).rejects.toThrow(/non.organization|organization/i);
    const grants = await fixture.db.selectFrom("collaboration_grants").select("id").execute();
    expect(grants).toHaveLength(1);
  });

  it("rejects a legacy actor already covered by a live grant so cutover cannot widen their ceiling", async () => {
    await fixture.db.updateTable("collaboration_grants").set({ audience_actor_id: collaborationActors.editor,
      preset: "contributor", legacy_ceiling: null }).where("id", "=", "80000000-0000-4000-8000-000000000001").execute();
    await expect(cutover.inventory(key)).rejects.toThrow(/covered|ceiling|conflict/i);
  });

  it("detects changed grant expiry after staging before direct-generation activation", async () => {
    await cutover.inventory(key);
    await cutover.freeze(key);
    await cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 }));
    await cutover.stage(key);
    await fixture.db.updateTable("collaboration_grants").set({ expires_at: "2026-09-22T11:00:00.000Z" })
      .where("id", "=", "80000000-0000-4000-8000-000000000001").execute();
    await expect(cutover.verify(key)).rejects.toThrow(/ceiling|source/i);
    await expect(cutover.activate(key)).rejects.toThrow();
  });

  it("supports only a compatible direct rollback and can disable an active home without reopening legacy roles", async () => {
    await cutover.inventory(key);
    await cutover.freeze(key);
    await cutover.drain(key, async () => ({ interrupted: 0, remaining: 0 }));
    await cutover.stage(key);
    await cutover.verify(key);
    await cutover.activate(key);
    await expect(cutover.rollbackCompatible(key, { compatibleDirectBuild: false })).rejects.toThrow();
    expect(await cutover.rollbackCompatible(key, { compatibleDirectBuild: true })).toMatchObject({
      phase: "rolled_back", authorityGeneration: 2,
    });
    expect(await cutover.assertWritable(key.scopeId)).toBeUndefined();
    expect(await cutover.disable(key)).toMatchObject({ phase: "blocked", authorityGeneration: 2 });
    expect(await cutover.disable(key)).toMatchObject({ phase: "blocked", authorityGeneration: 2 });
    await expect(cutover.assertWritable(key.scopeId)).rejects.toThrow();
    const scope = await fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_generation", "auth_epoch"]).where("id", "=", key.scopeId).executeTakeFirstOrThrow();
    expect(scope.lifecycle).toBe("recovering");
    expect(Number(scope.authority_generation)).toBe(2);
    expect(Number(scope.auth_epoch)).toBeGreaterThan(2);
    const members = await fixture.db.selectFrom("collaboration_members").select(["actor_id", "status", "dispositioned_at"])
      .where("scope_id", "=", key.scopeId).execute();
    expect(members.filter((member) => member.actor_id !== key.ownerId).every((member) => member.status === "revoked" && member.dispositioned_at !== null)).toBe(true);
  });
});

function member(actorId: string, role: "owner" | "editor" | "viewer", organizationId: string) {
  return {
    scope_id: key.scopeId, actor_id: actorId, role, status: "accepted" as const,
    organization_id: organizationId, invitation_id: null, invited_by: key.ownerId,
    accepted_at: NOW, expires_at: null, revision: 1, joined_at: NOW,
    updated_at: NOW, dispositioned_at: null,
  };
}

async function seedActiveRun(fixture: CollaborationTestDatabase): Promise<void> {
  await sql`INSERT INTO chats(id,owner_type,owner_id,create_request_id,title,lifecycle,attention)
    VALUES (${collaborationIds.chat},'personal',${key.ownerId},'req_cutover','Cutover','active','none')`.execute(fixture.db);
  await sql`INSERT INTO chat_messages(id,chat_id,seq,role,state,parts,byte_count,created_at)
    VALUES ('msg_cutover',${collaborationIds.chat},1,'user','committed','[]'::jsonb,2,${NOW})`.execute(fixture.db);
  await sql`INSERT INTO chat_turns(id,chat_id,client_request_id,base_message_seq,input_message_id,status,created_at,updated_at)
    VALUES ('turn_cutover',${collaborationIds.chat},'req_turn_cutover',0,'msg_cutover','running',${NOW},${NOW})`.execute(fixture.db);
  await sql`INSERT INTO chat_runs(id,chat_id,turn_id,client_request_id,attempt,driver_kind,instance_id,selection,
    interaction_mode,permission_mode,status,history_boundary_seq,capability_snapshot,created_at,updated_at)
    VALUES ('run_cutover',${collaborationIds.chat},'turn_cutover','req_run_cutover',1,'claude-code','instance_cutover','{}'::jsonb,
      'default','supervised','running',0,'{}'::jsonb,${NOW},${NOW})`.execute(fixture.db);
  await sql`INSERT INTO chat_queued_turns(id,chat_id,client_request_id,requesting_actor_id,collaboration_scope_id,
    position,status,parts,driver_kind,instance_id,selection,interaction_mode,permission_mode,capability_snapshot,
    claimed_turn_id,claimed_run_id,created_at,updated_at)
    VALUES ('queue_cutover',${collaborationIds.chat},'req_queue_cutover',${collaborationActors.editor},${key.scopeId},
      1,'claimed','[]'::jsonb,'claude-code','instance_cutover','{}'::jsonb,'default','supervised','{}'::jsonb,
      'turn_cutover','run_cutover',${NOW},${NOW})`.execute(fixture.db);
}
