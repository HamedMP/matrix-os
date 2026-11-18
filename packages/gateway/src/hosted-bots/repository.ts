import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { HostedBotsError, type HostedBot, type HostedBotMessage, type HostedBotRun, type HostedBotThread, type ModelResult, type RunInput, type RunMode, type RunStatus } from "./contracts.js";
import { ensureHostedBotsSchema, type HostedBotsDatabase } from "./database.js";

const BOT_LIMIT = 30;
const THREAD_LIMIT = 100;
const THREAD_RUN_LIMIT = 250;
const VISIBLE_RUN_LIMIT = 100;
const MODEL_CONTEXT_RUN_LIMIT = 16;
const LEASE_MS = 75_000;

type RunRow = HostedBotsDatabase["hosted_bot_runs"];

function toBot(row: HostedBotsDatabase["hosted_bots"]): HostedBot {
  return { id: row.id, name: row.name, description: "", revision: row.revision, instructions: row.instructions };
}

function toThread(row: Pick<HostedBotsDatabase["hosted_bot_threads"], "id" | "title" | "updated_at">): HostedBotThread {
  return { id: row.id, title: row.title, updatedAt: row.updated_at.toISOString() };
}

function toRun(row: Pick<RunRow, "id" | "status" | "mode" | "created_at" | "completed_at">): HostedBotRun {
  return { id: row.id, status: row.status, mode: row.mode, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null };
}

function toMessages(rows: Pick<RunRow, "id" | "input" | "output" | "created_at" | "completed_at">[]): HostedBotMessage[] {
  return rows.flatMap((row) => {
    const user: HostedBotMessage = { id: row.id, role: "user", text: row.input, createdAt: row.created_at.toISOString() };
    return row.output === null || row.completed_at === null ? [user] : [user, {
      id: row.id + "-reply", role: "assistant", text: row.output, createdAt: row.completed_at.toISOString(),
    }];
  });
}

export type HostedBotClaim = {
  id: string; ownerId: string; botId: string; threadId: string; revision: number;
  mode: RunMode; instructions: string; text: string; messages: HostedBotMessage[]; leaseUntil: Date;
};

export async function createHostedBotsRepository(db: Kysely<HostedBotsDatabase>) {
  await ensureHostedBotsSchema(db);

  function selectBot(ownerId: string, botId: string, executor = db) {
    return executor.selectFrom("hosted_bots").selectAll().where("owner_id", "=", ownerId).where("id", "=", botId);
  }

  function selectThread(ownerId: string, botId: string, threadId: string, executor = db) {
    return executor.selectFrom("hosted_bot_threads").selectAll()
      .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("id", "=", threadId);
  }

  function selectRuns(ownerId: string, botId: string, executor = db) {
    return executor.selectFrom("hosted_bot_runs").selectAll().where("owner_id", "=", ownerId).where("bot_id", "=", botId);
  }

  return {
    async listBots(ownerId: string) {
      const rows = await db.selectFrom("hosted_bots").select(["id", "name"]).where("owner_id", "=", ownerId).orderBy("name").limit(BOT_LIMIT).execute();
      return rows.map((row) => ({ ...row, description: "" }));
    },

    async createBot(ownerId: string, name: string) {
      return db.transaction().execute(async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${"hosted-bots:" + ownerId}))`.execute(tx);
        const existing = await tx.selectFrom("hosted_bots").select("id").where("owner_id", "=", ownerId).limit(BOT_LIMIT).execute();
        if (existing.length >= BOT_LIMIT) throw new HostedBotsError("limit");
        const bot = await tx.insertInto("hosted_bots").values({
          owner_id: ownerId, id: randomUUID(), name, instructions: "", revision: 0,
        }).returningAll().executeTakeFirstOrThrow();
        return toBot(bot);
      });
    },

    async readBot(ownerId: string, botId: string) {
      const bot = await selectBot(ownerId, botId).executeTakeFirst();
      if (!bot) throw new HostedBotsError("not_found");
      const threads = await db.selectFrom("hosted_bot_threads").select(["id", "title", "updated_at"])
        .where("owner_id", "=", ownerId).where("bot_id", "=", botId).orderBy("updated_at", "desc").limit(THREAD_LIMIT).execute();
      return { bot: toBot(bot), threads: threads.map(toThread) };
    },

    async createThread(ownerId: string, botId: string, title: string) {
      return db.transaction().execute(async (tx) => {
        if (!await selectBot(ownerId, botId, tx).forUpdate().executeTakeFirst()) throw new HostedBotsError("not_found");
        const existing = await tx.selectFrom("hosted_bot_threads").select("id")
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).limit(THREAD_LIMIT).execute();
        if (existing.length >= THREAD_LIMIT) throw new HostedBotsError("limit");
        const thread = await tx.insertInto("hosted_bot_threads").values({
          owner_id: ownerId, bot_id: botId, id: randomUUID(), title, updated_at: new Date(),
        }).returningAll().executeTakeFirstOrThrow();
        return toThread(thread);
      });
    },

    async readThread(ownerId: string, botId: string, threadId: string) {
      return db.transaction().setIsolationLevel("repeatable read").execute(async (tx) => {
        const thread = await selectThread(ownerId, botId, threadId, tx).executeTakeFirst();
        if (!thread) throw new HostedBotsError("not_found");
        const rows = await selectRuns(ownerId, botId, tx).where("thread_id", "=", threadId)
          .orderBy("created_at", "desc").orderBy("id", "desc").limit(VISIBLE_RUN_LIMIT).execute();
        rows.reverse();
        const changes = await tx.selectFrom("hosted_bot_changes").select(["id", "reason", "revision", "undone_at"])
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("thread_id", "=", threadId)
          .orderBy("revision", "desc").limit(VISIBLE_RUN_LIMIT).execute();
        return {
          thread: toThread(thread), runs: rows.map(toRun), messages: toMessages(rows),
          profileChanges: changes.map((row) => ({ id: row.id, reason: row.reason, revision: row.revision, undoneAt: row.undone_at?.toISOString() ?? null })),
        };
      });
    },

    async enqueue(ownerId: string, botId: string, threadId: string, input: RunInput) {
      return db.transaction().execute(async (tx) => {
        if (!await selectBot(ownerId, botId, tx).forUpdate().executeTakeFirst()
          || !await selectThread(ownerId, botId, threadId, tx).executeTakeFirst()) throw new HostedBotsError("not_found");
        const prior = await selectRuns(ownerId, botId, tx).where("thread_id", "=", threadId)
          .where("request_id", "=", input.requestId).executeTakeFirst();
        if (prior) {
          if (prior.input !== input.text || prior.mode !== input.mode) throw new HostedBotsError("conflict");
          return toRun(prior);
        }
        const active = await selectRuns(ownerId, botId, tx).where("status", "in", ["queued", "running"]).executeTakeFirst();
        if (active) throw new HostedBotsError("conflict");
        const existing = await tx.selectFrom("hosted_bot_runs").select("id")
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("thread_id", "=", threadId).limit(THREAD_RUN_LIMIT).execute();
        if (existing.length >= THREAD_RUN_LIMIT) throw new HostedBotsError("limit");
        const now = new Date();
        const row = await tx.insertInto("hosted_bot_runs").values({
          owner_id: ownerId, bot_id: botId, thread_id: threadId, id: randomUUID(), request_id: input.requestId, mode: input.mode,
          input: input.text, output: null, status: "queued", created_at: now, completed_at: null, lease_until: null,
        }).returningAll().executeTakeFirstOrThrow();
        await tx.updateTable("hosted_bot_threads").set({ updated_at: now })
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("id", "=", threadId).executeTakeFirst();
        return toRun(row);
      });
    },

    async claim(ownerId: string): Promise<HostedBotClaim | undefined> {
      return db.transaction().execute(async (tx) => {
        const now = new Date();
        // An expired external request is failed, never replayed implicitly.
        await tx.updateTable("hosted_bot_runs").set({ status: "failed", completed_at: now, lease_until: null })
          .where("owner_id", "=", ownerId).where("status", "=", "running").where("lease_until", "<=", now).execute();
        const run = await tx.selectFrom("hosted_bot_runs").selectAll().where("owner_id", "=", ownerId).where("status", "=", "queued")
          .orderBy("created_at").limit(1).forUpdate().skipLocked().executeTakeFirst();
        if (!run) return undefined;
        const leaseUntil = new Date(now.getTime() + LEASE_MS);
        await tx.updateTable("hosted_bot_runs").set({ status: "running", lease_until: leaseUntil })
          .where("id", "=", run.id).executeTakeFirst();
        const bot = await selectBot(run.owner_id, run.bot_id, tx).executeTakeFirstOrThrow();
        const past = await selectRuns(run.owner_id, run.bot_id, tx).where("thread_id", "=", run.thread_id)
          .where("status", "=", "completed").orderBy("created_at", "desc").limit(MODEL_CONTEXT_RUN_LIMIT).execute();
        return {
          id: run.id, ownerId: run.owner_id, botId: run.bot_id, threadId: run.thread_id, mode: run.mode,
          revision: bot.revision, instructions: bot.instructions, text: run.input, leaseUntil,
          messages: toMessages([...past.reverse(), run]),
        };
      });
    },

    async finish(run: HostedBotClaim, result?: ModelResult) {
      await db.transaction().execute(async (tx) => {
        const bot = await selectBot(run.ownerId, run.botId, tx).forUpdate().executeTakeFirstOrThrow();
        const now = new Date();
        const staleProfile = result?.profile && (run.mode !== "setup" || bot.revision !== run.revision);
        const status: RunStatus = result && !staleProfile ? "completed" : "failed";
        const transitioned = await tx.updateTable("hosted_bot_runs").set({
          status, output: status === "completed" ? result?.text ?? null : null, completed_at: now, lease_until: null,
        }).where("id", "=", run.id).where("owner_id", "=", run.ownerId).where("status", "=", "running")
          .where("lease_until", "=", run.leaseUntil).where("lease_until", ">", now).returning("id").executeTakeFirst();
        if (!transitioned) return;
        if (status === "completed" && result?.profile && result.profile.instructions !== bot.instructions) {
          const revision = bot.revision + 1;
          await tx.updateTable("hosted_bots").set({ instructions: result.profile.instructions, revision })
            .where("owner_id", "=", run.ownerId).where("id", "=", run.botId).where("revision", "=", bot.revision).executeTakeFirst();
          await tx.insertInto("hosted_bot_changes").values({
            owner_id: run.ownerId, bot_id: run.botId, thread_id: run.threadId, id: randomUUID(),
            prior: bot.instructions, reason: result.profile.reason, revision, undone_at: null,
          }).executeTakeFirst();
        }
        await tx.updateTable("hosted_bot_threads").set({ updated_at: now }).where("owner_id", "=", run.ownerId)
          .where("bot_id", "=", run.botId).where("id", "=", run.threadId).executeTakeFirst();
      });
    },

    async undo(ownerId: string, botId: string, changeId: string) {
      return db.transaction().execute(async (tx) => {
        const bot = await selectBot(ownerId, botId, tx).forUpdate().executeTakeFirst();
        const change = await tx.selectFrom("hosted_bot_changes").selectAll()
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("id", "=", changeId).executeTakeFirst();
        if (!bot || !change) throw new HostedBotsError("not_found");
        if (change.undone_at || change.revision !== bot.revision
          || await selectRuns(ownerId, botId, tx).where("status", "in", ["queued", "running"]).executeTakeFirst()) {
          throw new HostedBotsError("conflict");
        }
        const updated = await tx.updateTable("hosted_bots").set({ instructions: change.prior, revision: bot.revision + 1 })
          .where("owner_id", "=", ownerId).where("id", "=", botId).where("revision", "=", bot.revision)
          .returningAll().executeTakeFirstOrThrow();
        await tx.updateTable("hosted_bot_changes").set({ undone_at: new Date() })
          .where("owner_id", "=", ownerId).where("bot_id", "=", botId).where("id", "=", changeId).executeTakeFirst();
        return toBot(updated);
      });
    },
  };
}

export type HostedBotsRepository = Awaited<ReturnType<typeof createHostedBotsRepository>>;
