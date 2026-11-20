import type { Selectable } from "kysely";
import {
  BOARD_SCHEDULES_PER_BOARD_MAX, boardDurationMs, type BoardSchedule, type CreateScheduleRequest,
} from "@matrix-os/contracts/message-board";
import type { BoardSchedulesTable } from "./database.js";
import { boardFail, MessageBoardServiceError } from "./errors.js";
import { newBoardId, parseActor, storedActor, toIso } from "./rows.js";
import type { BoardCaller, MessageBoardService } from "./service.js";

type ScheduleRow = Selectable<BoardSchedulesTable>;

const TICK_MS = 15_000;
const DUE_BATCH = 50;

function toSchedule(row: ScheduleRow): BoardSchedule {
  return {
    id: row.id,
    target: row.thread_id ? { kind: "thread", threadId: row.thread_id, channel: row.channel } : { kind: "channel", channel: row.channel },
    text: row.text,
    by: parseActor(row.author_actor),
    nextRunAt: toIso(row.next_run_at)!,
    ...(row.every ? { every: row.every } : {}),
    ...(row.remaining !== null ? { remaining: row.remaining } : {}),
    ...(row.until_at ? { until: toIso(row.until_at)! } : {}),
    runCount: row.run_count,
  };
}

/**
 * Schedules (spec 2700 section 7): posts made later, as their author, through
 * the normal write path, so watchers and waits see them like any other post.
 * Each due post and its schedule update commit in one transaction.
 */
export class BoardScheduleService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<number> | null = null;

  constructor(private readonly board: MessageBoardService) {}

  async list(caller: BoardCaller, boardName: string | undefined): Promise<BoardSchedule[]> {
    const board = await this.board.resolveBoard(caller.ownerId, boardName);
    const rows = await this.board.db.selectFrom("board_schedules").selectAll().where("board_id", "=", board.id)
      .orderBy("next_run_at").limit(BOARD_SCHEDULES_PER_BOARD_MAX).execute();
    return rows.map(toSchedule);
  }

  async create(caller: BoardCaller, boardName: string | undefined, input: CreateScheduleRequest): Promise<BoardSchedule> {
    return this.board.write(caller, boardName, async (ctx) => {
      const count = await ctx.trx.selectFrom("board_schedules").select((eb) => eb.fn.countAll<string>().as("count"))
        .where("board_id", "=", ctx.board.id).executeTakeFirstOrThrow();
      if (Number(count.count) >= BOARD_SCHEDULES_PER_BOARD_MAX) boardFail("limit_reached");
      let channel = input.channel ?? "";
      if (input.thread) {
        const root = await ctx.trx.selectFrom("board_messages").select(["id", "root_id", "channel", "deleted_at"])
          .where("id", "=", input.thread).where("board_id", "=", ctx.board.id).executeTakeFirst();
        if (!root || root.root_id) boardFail("not_found");
        if (root.deleted_at) boardFail("message_deleted");
        channel = root.channel;
      }
      await this.board.requireAccess(ctx.trx, caller, ctx.board.id, channel, "post");
      const nowMs = ctx.now.getTime();
      const first = input.at ? Date.parse(input.at) : nowMs + (input.in ? boardDurationMs(input.in) : 0);
      if (first < nowMs - 1_000) boardFail("invalid_input");
      if (input.until && Date.parse(input.until) <= first) boardFail("invalid_input");
      const row = await ctx.trx.insertInto("board_schedules").values({
        id: newBoardId("sch"), owner_id: caller.ownerId, board_id: ctx.board.id, author: caller.actor.id,
        author_actor: JSON.stringify(storedActor(caller.actor)), channel, thread_id: input.thread ?? null, text: input.text,
        next_run_at: new Date(first), every: input.every ?? null, remaining: input.times ?? null,
        until_at: input.until ? new Date(input.until) : null, run_count: 0, created_at: ctx.now,
      }).returningAll().executeTakeFirstOrThrow();
      ctx.emit({ type: "schedule.changed", actor: caller.actor, channel, payload: { schedule: row.id } });
      return toSchedule(row);
    });
  }

  /** The creator or the board owner can cancel. */
  async cancel(caller: BoardCaller, boardName: string | undefined, id: string): Promise<void> {
    await this.board.write(caller, boardName, async (ctx) => {
      const row = await ctx.trx.selectFrom("board_schedules").select(["author", "channel"]).where("id", "=", id)
        .where("board_id", "=", ctx.board.id).forUpdate().executeTakeFirst();
      if (!row) boardFail("not_found");
      if (row.author !== caller.actor.id && caller.actor.id !== `user:${caller.ownerId}`) boardFail("forbidden");
      await ctx.trx.deleteFrom("board_schedules").where("id", "=", id).execute();
      ctx.emit({ type: "schedule.changed", actor: caller.actor, channel: row.channel, payload: { schedule: id, removed: true } });
    });
  }

  /** Posts every due schedule once; returns how many posted. */
  async runDue(): Promise<number> {
    const now = this.board.clock();
    const due = await this.board.db.selectFrom("board_schedules").select(["id", "board_id", "owner_id"])
      .where("next_run_at", "<=", now).orderBy("next_run_at").limit(DUE_BATCH).execute();
    let posted = 0;
    for (const item of due) {
      try {
        if (await this.postOne(item.id, item.board_id, item.owner_id)) posted += 1;
      } catch (error: unknown) {
        // A schedule that can no longer post (deleted thread, revoked access) is dropped, not retried forever.
        const reason = error instanceof MessageBoardServiceError ? error.reason : "unavailable";
        console.warn("[message-board] scheduled post failed:", reason);
        if (reason !== "unavailable" && reason !== "rate_limited") {
          await this.board.db.deleteFrom("board_schedules").where("id", "=", item.id).execute();
        }
      }
    }
    return posted;
  }

  private async postOne(id: string, boardId: string, ownerId: string): Promise<boolean> {
    const preview = await this.board.db.selectFrom("board_schedules").select("author_actor").where("id", "=", id).executeTakeFirst();
    if (!preview) return false;
    const caller: BoardCaller = { ownerId, actor: parseActor(preview.author_actor) };
    return this.board.write(caller, { id: boardId }, async (ctx) => {
      const row = await ctx.trx.selectFrom("board_schedules").selectAll().where("id", "=", id).forUpdate().skipLocked().executeTakeFirst();
      if (!row || new Date(row.next_run_at).getTime() > ctx.now.getTime()) return false;
      await this.board.postInTransaction(ctx, { channel: row.channel, text: row.text, ...(row.thread_id ? { re: row.thread_id } : {}) });
      const remaining = row.remaining === null ? null : row.remaining - 1;
      const next = row.every ? new Date(Math.max(new Date(row.next_run_at).getTime() + boardDurationMs(row.every), ctx.now.getTime())) : null;
      const finished = !next || remaining === 0 || (row.until_at !== null && next.getTime() > new Date(row.until_at).getTime());
      if (finished) {
        await ctx.trx.deleteFrom("board_schedules").where("id", "=", id).execute();
      } else {
        await ctx.trx.updateTable("board_schedules").set({ next_run_at: next!, remaining, run_count: row.run_count + 1 }).where("id", "=", id).execute();
      }
      return true;
    }, { internal: true });
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = this.runDue().catch((error: unknown) => {
        console.error("[message-board] schedule tick failed:", error instanceof Error ? error.name : "UnknownError");
        return 0;
      }).finally(() => { this.ticking = null; });
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
