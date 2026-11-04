/** Actual Project publication vs canonical admission, on separate PostgreSQL connections. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import { setTimeout as delay } from "node:timers/promises";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createProjectInheritanceResolver } from "../../../packages/gateway/src/collaboration/project-inheritance.js";
import { reconcileProjectMembershipAtPublication } from "../../../packages/gateway/src/collaboration/project-membership-transition.js";
import type { OwnerCollaborationDatabase } from "../../../packages/gateway/src/collaboration/database.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { OWNER, PG_AT, PG_CHAT, backendPid, barrier, bounded, expectBlocked, createPgRoutineFixture, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";

const scopeId = "10000000-0000-4000-8000-000000000b93";
const runtimeId = "vps:routine_scope_test";
const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

async function waiterBlockedBy(db: Kysely<OwnerBotDatabase>, pid: number) {
  for (let pass = 0; pass < 100; pass++) {
    const row = (await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`.execute(db)).rows[0];
    if (row) { await expectBlocked(db, row.pid, pid); return row.pid; }
    await delay(10);
  }
  throw new Error("Expected production operation never waited on the Chat lock");
}

export function registerInheritedRoutinePostgresTests() {
  describe.skipIf(!pgEnabled)("private routine inherited-scope publication fences on native PostgreSQL", () => {
    let f: PgRoutineFixture;
    beforeEach(async () => {
      f = await createPgRoutineFixture();
      const db = f.db as unknown as Kysely<OwnerCollaborationDatabase>;
      await db.insertInto("collaboration_scopes").values({
        id: scopeId, owner_type: "personal", owner_id: OWNER, organization_id: "org_scope_test",
        kind: "project", resource_id: "project_scope_test", parent_scope_id: null, membership_mode: "direct",
        lifecycle: "preparing", revision: 1, auth_epoch: 1, authority_runtime_id: runtimeId, authority_generation: 1,
        created_at: PG_AT, updated_at: PG_AT, deleted_at: null,
      }).execute();
      await createProjectInheritanceResolver({ db }).bindOwnedResource({ projectScopeId: scopeId, ownerId: OWNER,
        kind: "chat", resourceId: PG_CHAT, authorityRuntimeId: runtimeId, authorityGeneration: 1, revision: 1, readiness: "ready" });
    });
    afterEach(async () => { vi.restoreAllMocks(); await f?.destroy(); });

    async function publish(tx: Transaction<OwnerBotDatabase>) {
      const db = tx as unknown as Transaction<OwnerCollaborationDatabase>;
      await db.selectFrom("collaboration_scopes").select("id").where("id", "=", scopeId).forUpdate().executeTakeFirstOrThrow();
      await reconcileProjectMembershipAtPublication(db, { projectScopeId: scopeId, ownerType: "personal", ownerId: OWNER,
        requestedBy: OWNER, destinationAuthorityRuntimeId: runtimeId, destinationAuthorityGeneration: 1, now: new Date(PG_AT),
        createEventId: () => "60000000-0000-4000-8000-000000000b93" });
      await db.updateTable("collaboration_scopes").set({ lifecycle: "shared" }).where("id", "=", scopeId).execute();
    }

    it("publication wins the Chat lock: blocked admission writes no private input", async () => {
      const fire = await f.claim(), entered = barrier<number>(), release = barrier<void>();
      const holder = settle(f.db.transaction().execute(async tx => {
        await publish(tx); entered.resolve(await backendPid(tx)); await bounded(release.promise);
      }));
      let contender: ReturnType<typeof settle> | undefined;
      try {
        const pid = await bounded(entered.promise);
        contender = settle(f.running(fire.fireId));
        await waiterBlockedBy(f.db, pid);
      } finally { release.resolve(); await holder; }
      expect(await holder).toMatchObject({ ok: true });
      expect(await contender).toMatchObject({ ok: false });
      expect(await f.db.selectFrom("chat_messages").select("id").where("chat_id", "=", PG_CHAT).execute()).toEqual([]);
      expect(await f.approvals.authorize(f.routine)).toBe(false);
    });

    it("admission wins the Chat lock: publication rolls back instead of sharing active private work", async () => {
      const fire = await f.claim(), entered = barrier<number>(), release = barrier<void>();
      vi.spyOn(f.chats, "admitTurn").mockImplementation((owner, input) => f.db.transaction().execute(async tx => {
        const repository = new ChatRepository(tx as never, true);
        const result = await repository.admitTurn(owner, input);
        entered.resolve(await backendPid(tx)); await bounded(release.promise); return result;
      }));
      const holder = settle(f.running(fire.fireId));
      let contender: ReturnType<typeof settle> | undefined;
      try {
        const pid = await bounded(entered.promise);
        contender = settle(f.db.transaction().execute(publish));
        await waiterBlockedBy(f.db, pid);
      } finally { release.resolve(); await holder; }
      expect(await holder).toMatchObject({ ok: true });
      expect(await contender).toMatchObject({ ok: false });
      const scope = await (f.db as unknown as Kysely<OwnerCollaborationDatabase>).selectFrom("collaboration_scopes").select("lifecycle")
        .where("kind", "=", "chat").where("resource_id", "=", PG_CHAT).executeTakeFirstOrThrow();
      expect(scope.lifecycle).toBe("preparing");
      expect(await f.approvals.authorize(f.routine)).toBe(true);
    });
  });
}
