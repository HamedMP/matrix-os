/** Real approval/claim contention, with separate pooled connections and NOWAIT lock witnesses. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { NOW } from "./bot-state-support.js";
import { OWNER, BOT, PG_AT, PG_NEXT, PG_CHAT, backendPid, barrier, bounded, expectBlocked, createPgRoutineFixture, pgProposal, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";

const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));

export function registerRoutineEditLockPostgresTests() {
  describe.skipIf(!pgEnabled)("routine edit lock order on native PostgreSQL", () => {
    let f: PgRoutineFixture;
    beforeEach(async () => { f = await createPgRoutineFixture(); });
    afterEach(async () => { await f?.destroy(); });

    function interactions(transact: BotStateTransactions = f.transact) {
      return createBotInteractionService({ transact, now: () => new Date(NOW), handlers: {
        chooseAccount: async () => { throw new Error("No external account interaction in lock regression"); },
        decideApproval: f.approvals.decide,
      } });
    }

    it.each([false, true])("serializes owner edit and claim (different Routine, same Chat: %s)", async different => {
      let scheduled = f.routine;
      if (different) {
        const pending = await f.approvals.propose(f.binding, { ...pgProposal, name: "Second approved schedule" });
        await interactions().resolve(OWNER, PG_CHAT, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
        scheduled = (await f.repo.list(OWNER, BOT)).find(r => r.routineId !== f.routine.routineId)!;
        expect(scheduled).toBeDefined();
      }
      const edit = await f.approvals.requestEdit(OWNER, f.routine.routineId, { baseRevision: f.routine.revision,
        name: "Reviewed edit", prompt: pgProposal.prompt, schedule: pgProposal.schedule });
      const entered = barrier<number>();
      const transact: BotStateTransactions = (ownerId, work) => f.transact(ownerId, async tx => {
        entered.resolve(await backendPid(tx.db)); return work(tx);
      });
      let approval: ReturnType<typeof settle> | undefined;
      const claim = await settle(f.db.transaction().execute(async holder => {
        const holderPid = await backendPid(holder);
        await holder.selectFrom("bot_routines").select("routine_id").where("owner_id", "=", OWNER)
          .where("routine_id", "=", scheduled.routineId).forUpdate().executeTakeFirstOrThrow();
        // Pause the second-Routine claim after its binding fence but before Chat.
        if (different) await holder.selectFrom("bot_chat_bindings").select("chat_id")
          .where("owner_id", "=", OWNER).where("bot_id", "=", BOT).where("chat_id", "=", PG_CHAT)
          .where("removed_at", "is", null).forUpdate().executeTakeFirstOrThrow();
        approval = settle(interactions(transact).resolve(OWNER, PG_CHAT, edit.interaction.interactionId,
          { kind: "approval", decision: "approve", baseRevision: edit.interaction.revision }));
        await expectBlocked(f.db, await bounded(entered.promise), holderPid);
        // A waiting approval must not hold the Chat that the earlier claim needs.
        await sql`SELECT id FROM chats WHERE id=${PG_CHAT} FOR UPDATE NOWAIT`.execute(holder);
        return createBotRoutinesRepository(holder).claim({ ownerId: OWNER, routineId: scheduled.routineId,
          scheduledFor: PG_AT, nextFireAt: PG_NEXT, now: PG_AT });
      }));
      const decision = await approval;
      const code = !claim.ok && claim.error && typeof claim.error === "object" && "code" in claim.error ? String(claim.error.code) : "none";
      expect(claim.ok, `claim lock witness code=${code}`).toBe(true);
      if (claim.ok) expect(claim.value).toBeDefined();
      if (different) {
        expect(decision).toMatchObject({ ok: true });
        expect(await f.repo.get(OWNER, f.routine.routineId)).toMatchObject({ proposal: { name: "Reviewed edit" } });
      } else {
        // The legitimate winning claim changes the revision; never consume a stale approval.
        expect(decision).toMatchObject({ ok: false, error: { code: "revision_conflict" } });
        expect(await createBotInteractionsRepository(f.db).get({ ownerId: OWNER, interactionId: edit.interaction.interactionId }))
          .toMatchObject({ status: "pending", revision: edit.interaction.revision });
      }
    });
  });
}
