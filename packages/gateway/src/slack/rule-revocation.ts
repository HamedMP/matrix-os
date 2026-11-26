import { sql, type Kysely, type Transaction } from "kysely";
import { SlackThreadContextEnvelopeSchema } from "@matrix-os/contracts/slack-bridge";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { ChatDatabase } from "../chat/database.js";
import { cancelNonPrivateRoutineQueue } from "../chat/private-routine-authority.js";
import { currentRulePolicy, parseRulePolicy } from "./rule-jobs.js";
/** Best-effort worker stop follows committed revocation; durable guards never depend on its ACK. */
export async function retireRevokedSlackJobs(db: Kysely<OwnerBotDatabase>, ownerId: string, chatId: string, stop: (runId: string) => Promise<void>) {
    const runs = await db.transaction().execute(async (tx) => {
        let chat = await tx.selectFrom("chats").select("revision").where("id", "=", chatId).where("owner_type", "=", "personal").where("owner_id", "=", ownerId).forUpdate().executeTakeFirst();
        if (!chat)
            return [];
        const jobs = await sql<{
            id: string;
            request_id: string;
            policy: unknown;
            envelope: unknown;
            accepted_kind: string | null;
            accepted_id: string | null;
        }> `SELECT id,request_id,policy,envelope,accepted_kind,accepted_id FROM slack_mention_summary_jobs WHERE owner_id=${ownerId} AND chat_id=${chatId} AND state IN('pending','processing','accepted') AND to_jsonb(slack_mention_summary_jobs)->>'routed' IS NULL LIMIT 100 FOR UPDATE`.execute(tx);
        const result: string[] = [];
        for (const job of jobs.rows) {
            const envelope = SlackThreadContextEnvelopeSchema.parse(typeof job.envelope === "string" ? JSON.parse(job.envelope) : job.envelope);
            if (await currentRulePolicy(tx, envelope, parseRulePolicy(job.policy)))
                continue;
            await sql `UPDATE slack_mention_summary_jobs SET state='failed',lease=NULL,lease_until=NULL WHERE id=${job.id}`.execute(tx);
            const queued = await tx.selectFrom("chat_queued_turns").select(["id", "position", "claimed_run_id", "status"]).where("chat_id", "=", chatId).where("client_request_id", "=", job.request_id).executeTakeFirst();
            if (queued?.status === "queued") {
                const revision = await cancelNonPrivateRoutineQueue(tx as unknown as Transaction<ChatDatabase>, { chatId, queuedTurnId: queued.id, position: Number(queued.position), baseRevision: Number(chat.revision), at: new Date().toISOString() });
                chat = { revision };
                await tx.insertInto("chat_outbox").values({ owner_type: "personal", owner_id: ownerId, chat_id: chatId, revision, event_type: "queue.cancelled", payload: { queuedTurnId: queued.id }, created_at: new Date() }).execute();
            }
            const run = await tx.selectFrom("chat_runs").select("id").where("chat_id", "=", chatId).where("client_request_id", "=", job.request_id).where("status", "in", ["accepted", "running", "waiting_for_input", "waiting_for_approval"]).executeTakeFirst();
            if (run)
                result.push(run.id);
            else if (queued?.claimed_run_id)
                result.push(queued.claimed_run_id);
        }
        return result;
    });
    for (const runId of runs)
        await stop(runId);
}
