import { sql, type Selectable } from "kysely";
import {
  BOARD_WATCHER_MAX_DEPTH, BOARD_WATCHER_RUNS_PER_HOUR_DEFAULT, BOARD_WATCHERS_PER_BOARD_MAX, parseBoardLabelFilter,
  type BoardActor, type BoardEvent, type BoardWatcher, type BoardWatcherAction, type CreateWatcherRequest,
} from "@matrix-os/contracts/message-board";
import type { BoardWatchersTable } from "./database.js";
import { boardFail, MessageBoardServiceError } from "./errors.js";
import { eventMatches, readBoardEvents } from "./events.js";
import { newBoardId, toIso } from "./rows.js";
import type { BoardCaller, MessageBoardService } from "./service.js";

type WatcherRow = Selectable<BoardWatchersTable>;

/** How a watcher wakes something. Each call carries the event cursor as its idempotency key. */
export interface WatcherActionRunner {
  start?(input: { template: string; projectId?: string; name: string; task: string; idempotencyKey: string; origin: { watcher: string; depth: number } }): Promise<void>;
  send?(input: { session: string; text: string; idempotencyKey: string }): Promise<void>;
  routine?(input: { routine: string; input: string; idempotencyKey: string }): Promise<void>;
}

export interface BoardNotification { ownerId: string; dedupeKey: string; title: string; body: string }
export interface BoardNotifier { notify(notification: BoardNotification): void }

const HOUR_MS = 3_600_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_SWEEP_MS = 30_000;
const MAX_QUEUED_EVENTS = 1_000;
const RETRY_BATCH = 20;
/** A run being dispatched is not due again until this passes, so the retry sweep never doubles it. */
const DISPATCH_LEASE_MS = 5 * 60_000;
const FAILED_COPY = "The last run could not start. Check the watcher's action and try again.";
const UNAVAILABLE_COPY = "This kind of action is not available on this computer yet.";
const MAX_TASK_TEXT = 6_000;
/** Events read per board per catch-up pass. */
const CATCH_UP_BATCH = 200;

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** The message text a woken session gets, marked so it can tell a board message from its user. */
export function watcherTaskText(event: { board: string; channel: string; messageId: string }, text: string): string {
  // Terminal launches take at most 8 KiB of task text; a long post is cut with a pointer to the whole message.
  const body = text.length > MAX_TASK_TEXT
    ? `${text.slice(0, MAX_TASK_TEXT)}\n[cut; read the whole post with: matrix board read ${event.messageId}]`
    : text;
  return `<matrix from="board:${event.board}/${event.channel}#${event.messageId}">\n${body}\n</matrix>`;
}

/**
 * Watchers (spec 2700 section 6). Delivery is at least once: a run row keyed
 * by (watcher, event cursor) is written before dispatch, so a duplicate wake
 * starts one run and a restart retries runs that never finished.
 */
export class BoardWatcherService {
  private readonly queue: Array<{ ownerId: string; event: BoardEvent }> = [];
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(
    private readonly board: MessageBoardService,
    private readonly options: { actions?: WatcherActionRunner; notifier?: BoardNotifier; retryBaseMs?: number } = {},
  ) {}

  configure(options: { actions?: WatcherActionRunner; notifier?: BoardNotifier }): void {
    Object.assign(this.options, options);
    // Runs recovered before the gateway supplied its actions were left pending; start them now.
    if (options.actions && !this.stopped) void this.sweep();
  }

  /* ---------------- management (owner only; routes enforce `manage`) ---------------- */

  async list(caller: BoardCaller, boardName: string | undefined): Promise<BoardWatcher[]> {
    const board = await this.board.resolveBoard(caller.ownerId, boardName);
    const rows = await this.board.db.selectFrom("board_watchers").selectAll().where("board_id", "=", board.id).orderBy("name").execute();
    return Promise.all(rows.map((row) => this.describe(row)));
  }

  private async describe(row: WatcherRow): Promise<BoardWatcher> {
    const since = new Date(this.board.clock().getTime() - HOUR_MS);
    const stats = await this.board.db.selectFrom("board_watcher_runs").select((eb) => [
      eb.fn.countAll<string>().as("total"),
      sql<string>`count(*) FILTER (WHERE created_at > ${since})`.as("recent"),
      eb.fn.max("created_at").as("last"),
    ]).where("watcher_id", "=", row.id).executeTakeFirstOrThrow();
    const lastFailed = await this.board.db.selectFrom("board_watcher_runs").select("last_error").where("watcher_id", "=", row.id)
      .orderBy("created_at", "desc").limit(1).executeTakeFirst();
    return {
      id: row.id, name: row.name, tail: parseJson(row.tail), action: parseJson<BoardWatcherAction>(row.action), enabled: row.enabled,
      maxRunsPerHour: row.max_runs_per_hour, runsThisHour: Number(stats.recent), totalRuns: Number(stats.total),
      lastRunAt: toIso(stats.last as Date | null), lastError: lastFailed?.last_error ?? null,
    };
  }

  async create(caller: BoardCaller, boardName: string | undefined, input: CreateWatcherRequest): Promise<BoardWatcher> {
    const row = await this.board.write(caller, boardName, async (ctx) => {
      const count = await ctx.trx.selectFrom("board_watchers").select((eb) => eb.fn.countAll<string>().as("count"))
        .where("board_id", "=", ctx.board.id).executeTakeFirstOrThrow();
      if (Number(count.count) >= BOARD_WATCHERS_PER_BOARD_MAX) boardFail("limit_reached");
      const inserted = await ctx.trx.insertInto("board_watchers").values({
        id: newBoardId("wat"), owner_id: caller.ownerId, board_id: ctx.board.id, name: input.name,
        tail: JSON.stringify(input.tail), action: JSON.stringify(input.action), enabled: input.enabled ?? true,
        max_runs_per_hour: input.maxRunsPerHour ?? BOARD_WATCHER_RUNS_PER_HOUR_DEFAULT, created_by: caller.actor.id,
        created_at: ctx.now, updated_at: ctx.now,
      }).onConflict((oc) => oc.columns(["board_id", "name"]).doNothing()).returningAll().executeTakeFirst();
      if (!inserted) boardFail("duplicate_id");
      ctx.emit({ type: "watcher.changed", actor: caller.actor, payload: { watcher: input.name } });
      return inserted;
    });
    return this.describe(row);
  }

  async patch(caller: BoardCaller, boardName: string | undefined, id: string, patch: Partial<Pick<CreateWatcherRequest, "tail" | "action" | "enabled" | "maxRunsPerHour">>): Promise<BoardWatcher> {
    const row = await this.board.write(caller, boardName, async (ctx) => {
      const updated = await ctx.trx.updateTable("board_watchers").set({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.maxRunsPerHour !== undefined ? { max_runs_per_hour: patch.maxRunsPerHour } : {}),
        ...(patch.tail ? { tail: JSON.stringify(patch.tail) } : {}),
        ...(patch.action ? { action: JSON.stringify(patch.action) } : {}),
        updated_at: ctx.now,
      }).where("id", "=", id).where("board_id", "=", ctx.board.id).returningAll().executeTakeFirst();
      if (!updated) boardFail("not_found");
      ctx.emit({ type: "watcher.changed", actor: caller.actor, payload: { watcher: updated.name } });
      return updated;
    });
    return this.describe(row);
  }

  async remove(caller: BoardCaller, boardName: string | undefined, id: string): Promise<void> {
    await this.board.write(caller, boardName, async (ctx) => {
      const deleted = await ctx.trx.deleteFrom("board_watchers").where("id", "=", id).where("board_id", "=", ctx.board.id).returning("name").execute();
      if (deleted.length === 0) boardFail("not_found");
      ctx.emit({ type: "watcher.changed", actor: caller.actor, payload: { watcher: deleted[0]!.name, removed: true } });
    });
  }

  /* ---------------- dispatch ---------------- */

  /** Called after commit with each write's events; work happens off the request path. */
  onEvents(ownerId: string, events: readonly BoardEvent[]): void {
    if (this.stopped) return;
    for (const event of events) {
      if (event.type !== "message.posted") continue;
      if (this.queue.length >= MAX_QUEUED_EVENTS) {
        console.warn("[message-board] watcher queue full; event left for the next retry sweep");
        break;
      }
      this.queue.push({ ownerId, event });
    }
    this.draining ??= this.drain().finally(() => { this.draining = null; });
  }

  /** Resolves when queued events have been matched and dispatched; for tests and shutdown. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const next = this.queue.shift()!;
      try {
        await this.handleEvent(next.ownerId, next.event);
      } catch (error: unknown) {
        console.error("[message-board] watcher match failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  }

  private async handleEvent(ownerId: string, event: BoardEvent): Promise<void> {
    const board = await this.board.resolveBoard(ownerId, event.board);
    await this.matchEvent(ownerId, board, event);
    await this.recordProgress(ownerId, board.id, event.cursor);
  }

  /** Remembers the newest cursor matched, so a restart or a full queue replays from there. */
  private async recordProgress(ownerId: string, boardId: string, cursor: string): Promise<void> {
    await this.board.db.insertInto("board_watcher_progress")
      .values({ owner_id: ownerId, board_id: boardId, cursor, updated_at: this.board.clock() })
      .onConflict((oc) => oc.column("board_id").doUpdateSet({ cursor: sql`GREATEST(board_watcher_progress.cursor, excluded.cursor)`, updated_at: this.board.clock() }))
      .execute();
  }

  /**
   * Replays committed events the in-memory queue never matched (overflow,
   * restart). A board without progress starts from its current end.
   */
  async catchUp(): Promise<number> {
    const db = this.board.db;
    const boards = await db.selectFrom("board_watchers as w").innerJoin("board_boards as b", "b.id", "w.board_id")
      .leftJoin("board_watcher_progress as p", "p.board_id", "b.id")
      .select(["b.id", "b.name", "b.owner_id", "b.last_cursor", "p.cursor as progress"]).distinct().where("w.enabled", "=", true).execute();
    let replayed = 0;
    for (const row of boards) {
      if (row.progress == null) {
        await this.recordProgress(row.owner_id, row.id, String(row.last_cursor));
        continue;
      }
      const board = await this.board.resolveBoard(row.owner_id, row.name);
      const page = await readBoardEvents(db, board, { after: String(row.progress), limit: CATCH_UP_BATCH });
      for (const event of page.events) {
        if (event.type === "message.posted") await this.matchEvent(row.owner_id, board, event);
        replayed += 1;
      }
      if (page.cursor !== String(row.progress)) await this.recordProgress(row.owner_id, row.id, page.cursor);
    }
    return replayed;
  }

  private async matchEvent(ownerId: string, board: { id: string; name: string }, event: BoardEvent): Promise<void> {
    if (event.type !== "message.posted" || !event.messageId || !event.channel) return;
    const db = this.board.db;
    const watchers = await db.selectFrom("board_watchers").selectAll().where("board_id", "=", board.id).where("enabled", "=", true).execute();
    if (watchers.length === 0) return;
    const message = await db.selectFrom("board_messages").select(["id", "root_id", "text", "author"]).where("id", "=", event.messageId).executeTakeFirst();
    if (!message) return;
    const labelRows = await db.selectFrom("board_labels").select(["message_id", "key", "value"])
      .where("message_id", "in", [message.id, ...(message.root_id ? [message.root_id] : [])]).execute();
    const own = Object.fromEntries(labelRows.filter((row) => row.message_id === message.id).map((row) => [row.key, row.value]));
    const root = Object.fromEntries(labelRows.filter((row) => row.message_id !== message.id).map((row) => [row.key, row.value]));
    const depth = Number(own["matrix.depth"] ?? 0);
    if (depth >= BOARD_WATCHER_MAX_DEPTH) return;
    for (const watcher of watchers) {
      if (event.actor.id === `watcher:${watcher.name}` || own["matrix.watcher"] === watcher.name) continue;
      const tail = parseJson<{ channel: string; label?: string; by?: string }>(watcher.tail);
      if (!eventMatches(event, { channel: tail.channel })) continue;
      if (tail.by && message.author !== tail.by) continue;
      if (tail.label) {
        const filter = parseBoardLabelFilter(tail.label);
        const matches = [own, root].some((set) => Object.hasOwn(set, filter.key) && (filter.values === null || filter.values.includes(set[filter.key]!)));
        if (!matches) continue;
      }
      await this.admit(ownerId, board.name, watcher, event, message.root_id ?? message.id, depth);
    }
  }

  /** Writes the run row (once per cursor), pausing the watcher at its hourly cap. */
  private async admit(ownerId: string, boardName: string, watcher: WatcherRow, event: BoardEvent, threadId: string, depth: number): Promise<void> {
    const db = this.board.db;
    const now = this.board.clock();
    const recent = await db.selectFrom("board_watcher_runs").select((eb) => eb.fn.countAll<string>().as("count"))
      .where("watcher_id", "=", watcher.id).where("created_at", ">", new Date(now.getTime() - HOUR_MS)).executeTakeFirstOrThrow();
    if (Number(recent.count) >= watcher.max_runs_per_hour) {
      await this.pause(ownerId, boardName, watcher, event.channel!, threadId, now);
      return;
    }
    const inserted = await db.insertInto("board_watcher_runs").values({
      owner_id: ownerId, watcher_id: watcher.id, event_cursor: event.cursor, message_id: event.messageId!,
      outcome: null, attempts: 0, next_attempt_at: new Date(now.getTime() + DISPATCH_LEASE_MS), last_error: null, created_at: now, finished_at: null,
    }).onConflict((oc) => oc.columns(["watcher_id", "event_cursor"]).doNothing()).returning("event_cursor").execute();
    if (inserted.length === 0) return;
    await this.dispatch(watcher, { board: boardName, cursor: event.cursor, messageId: event.messageId!, channel: event.channel!, depth });
  }

  /** Pausing and its one notice commit together: a crash leaves neither, so the next event retries both. */
  private async pause(ownerId: string, boardName: string, watcher: WatcherRow, channel: string, threadId: string, now: Date): Promise<void> {
    const actor: BoardActor = { id: `watcher:${watcher.name}`, kind: "watcher", name: watcher.name };
    let paused = false;
    try {
      paused = await this.board.write({ ownerId, actor }, boardName, async (ctx) => {
        const updated = await ctx.trx.updateTable("board_watchers").set({ enabled: false, updated_at: now })
          .where("id", "=", watcher.id).where("enabled", "=", true).returning("id").execute();
        if (updated.length === 0) return false;
        await this.board.postInTransaction(ctx, {
          channel, re: threadId,
          text: `Watcher ${watcher.name} paused itself after ${watcher.max_runs_per_hour} runs this hour. Resume it in Watchers when you are ready.`,
        });
        ctx.emit({ type: "watcher.changed", actor, payload: { watcher: watcher.name, paused: true } });
        return true;
      }, { internal: true });
    } catch (error: unknown) {
      if (!(error instanceof MessageBoardServiceError)) throw error;
      // The thread cannot take the notice (deleted, full): pause without it rather than keep waking.
      console.warn("[message-board] watcher pause notice not posted:", error.reason);
      paused = (await this.board.db.updateTable("board_watchers").set({ enabled: false, updated_at: now })
        .where("id", "=", watcher.id).where("enabled", "=", true).returning("id").execute()).length > 0;
    }
    if (!paused) return;
    this.options.notifier?.notify({
      ownerId, dedupeKey: `board:watcher:${watcher.name}:paused:${now.toISOString().slice(0, 13)}`,
      title: "Watcher paused", body: `${watcher.name} reached ${watcher.max_runs_per_hour} runs this hour.`,
    });
  }

  private async dispatch(watcher: WatcherRow, run: { board: string; cursor: string; messageId: string; channel: string; depth: number }): Promise<void> {
    const db = this.board.db;
    const action = parseJson<BoardWatcherAction>(watcher.action);
    const message = await db.selectFrom("board_messages").select(["text", "deleted_at"]).where("id", "=", run.messageId).executeTakeFirst();
    const text = watcherTaskText(run, message && !message.deleted_at ? message.text : "");
    const idempotencyKey = `${watcher.id}:${run.cursor}`;
    const actions = this.options.actions;
    if (!actions) {
      // The gateway has not supplied its actions yet (startup): keep the run pending for the next sweep.
      await db.updateTable("board_watcher_runs").set({ next_attempt_at: new Date(this.board.clock().getTime() + RETRY_SWEEP_MS) })
        .where("watcher_id", "=", watcher.id).where("event_cursor", "=", run.cursor as never).execute();
      return;
    }
    let failure: string | null = null;
    try {
      if (action.kind === "start" && actions.start) {
        await actions.start({ template: action.template, projectId: action.project, name: `board-${watcher.name}`.slice(0, 64), task: text, idempotencyKey, origin: { watcher: watcher.name, depth: run.depth + 1 } });
      } else if (action.kind === "send" && actions.send) {
        await actions.send({ session: action.session, text, idempotencyKey });
      } else if (action.kind === "routine" && actions.routine) {
        await actions.routine({ routine: action.routine, input: text, idempotencyKey });
      } else {
        failure = UNAVAILABLE_COPY;
      }
    } catch (error: unknown) {
      console.warn("[message-board] watcher action failed:", error instanceof Error ? error.name : "UnknownError");
      failure = FAILED_COPY;
    }
    const now = this.board.clock();
    if (!failure) {
      await db.updateTable("board_watcher_runs").set({ outcome: "ok", attempts: sql`attempts + 1`, finished_at: now, last_error: null })
        .where("watcher_id", "=", watcher.id).where("event_cursor", "=", run.cursor as never).execute();
      return;
    }
    const current = await db.selectFrom("board_watcher_runs").select("attempts").where("watcher_id", "=", watcher.id)
      .where("event_cursor", "=", run.cursor as never).executeTakeFirst();
    const attempts = (current?.attempts ?? 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS || failure === UNAVAILABLE_COPY;
    await db.updateTable("board_watcher_runs").set({
      attempts, last_error: failure,
      ...(giveUp ? { outcome: "failed", finished_at: now } : { next_attempt_at: new Date(now.getTime() + (this.options.retryBaseMs ?? RETRY_BASE_MS) * 2 ** (attempts - 1)) }),
    }).where("watcher_id", "=", watcher.id).where("event_cursor", "=", run.cursor as never).execute();
  }

  /** Retries runs without an outcome whose backoff has passed, including runs a restart interrupted. */
  async retryPending(): Promise<number> {
    const db = this.board.db;
    const due = await db.selectFrom("board_watcher_runs as r").innerJoin("board_watchers as w", "w.id", "r.watcher_id")
      .innerJoin("board_boards as b", "b.id", "w.board_id").innerJoin("board_messages as m", "m.id", "r.message_id")
      .select(["r.event_cursor", "r.message_id", "w.id as watcher_id", "b.name as board_name", "m.channel"])
      .where("r.outcome", "is", null).where("r.next_attempt_at", "<=", this.board.clock()).orderBy("r.next_attempt_at").limit(RETRY_BATCH).execute();
    let dispatched = 0;
    for (const run of due) {
      const now = this.board.clock();
      const claimed = await db.updateTable("board_watcher_runs").set({ next_attempt_at: new Date(now.getTime() + DISPATCH_LEASE_MS) })
        .where("watcher_id", "=", run.watcher_id).where("event_cursor", "=", run.event_cursor as never)
        .where("outcome", "is", null).where("next_attempt_at", "<=", now).returning("event_cursor").execute();
      if (claimed.length === 0) continue;
      const watcher = await db.selectFrom("board_watchers").selectAll().where("id", "=", run.watcher_id).executeTakeFirst();
      if (!watcher) continue;
      dispatched += 1;
      const depth = Number((await db.selectFrom("board_labels").select("value").where("message_id", "=", run.message_id)
        .where("key", "=", "matrix.depth").executeTakeFirst())?.value ?? 0);
      await this.dispatch(watcher, { board: run.board_name, cursor: String(run.event_cursor), messageId: run.message_id, channel: run.channel, depth });
    }
    return dispatched;
  }

  /** One maintenance pass: replay unmatched events, then retry due runs. */
  async sweep(): Promise<void> {
    try {
      await this.catchUp();
      if (this.options.actions) await this.retryPending();
    } catch (error: unknown) {
      console.error("[message-board] watcher sweep failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  start(): void {
    this.stop();
    this.stopped = false;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), RETRY_SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
