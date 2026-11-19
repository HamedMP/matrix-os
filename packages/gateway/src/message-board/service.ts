import { sql, type Kysely } from "kysely";
import {
  BOARD_DEFAULT_NAME, isReservedBoardLabelKey, parseBoardLabelFilter,
  type BoardActor, type BoardChannel, type BoardEvent, type BoardMessage, type BoardSummary, type BoardThread,
  type BoardThreadSummary, type LabelPatchRequest, type MessagesQuery, type PostMessageRequest, type ThreadsQuery,
} from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "./database.js";
import { boardFail, MessageBoardServiceError } from "./errors.js";
import { createWriteRateLimiter, type WriteRateLimiter } from "./rate-limit.js";
import {
  appendEvents, extractMentions, hydrateMessages, lockBoard, newBoardId, parseActor, storedActor, toIso,
  type BoardRow, type BoardTrx, type MessageRow, type PendingBoardEvent,
} from "./rows.js";
import { loadTasks, type TaskExtension } from "./task-hooks.js";

export interface BoardCaller {
  /** The computer owner every row belongs to. */
  ownerId: string;
  actor: BoardActor;
}

export interface MessageBoardLimits {
  boardsPerOwner: number;
  channelsPerBoard: number;
  repliesPerThread: number;
  labelsPerMessage: number;
  writesPerMinute: number;
}

const DEFAULT_LIMITS: MessageBoardLimits = {
  boardsPerOwner: 50, channelsPerBoard: 2_000, repliesPerThread: 200, labelsPerMessage: 20, writesPerMinute: 120,
};

export interface MessageBoardServiceOptions {
  now?: () => Date;
  /** Called after commit with the events a write produced, in cursor order. */
  onEvents?: (ownerId: string, events: BoardEvent[]) => void;
  limits?: Partial<MessageBoardLimits>;
  tasks?: TaskExtension;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * The owner's message board store (spec 2700 sections 1, 3 and 4). Every
 * write is one transaction that serializes on the board row, changes its rows
 * and appends its events; subscribers hear about it only after commit.
 */
export class MessageBoardService {
  readonly db: Kysely<MessageBoardDatabase>;
  readonly limits: MessageBoardLimits;
  private readonly now: () => Date;
  private readonly onEvents?: MessageBoardServiceOptions["onEvents"];
  private readonly rateLimiter: WriteRateLimiter;
  private readonly tasks?: TaskExtension;

  constructor(db: Kysely<MessageBoardDatabase>, options: MessageBoardServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.onEvents = options.onEvents;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.rateLimiter = createWriteRateLimiter({ perMinute: this.limits.writesPerMinute });
    this.tasks = options.tasks;
  }

  clock(): Date {
    return this.now();
  }

  /* ---------------- boards ---------------- */

  async resolveBoard(ownerId: string, name: string | undefined, executor: Kysely<MessageBoardDatabase> | BoardTrx = this.db): Promise<BoardRow> {
    const wanted = name ?? BOARD_DEFAULT_NAME;
    const find = () => executor.selectFrom("board_boards").selectAll()
      .where("owner_id", "=", ownerId).where(sql`lower(name)`, "=", wanted.toLowerCase()).executeTakeFirst();
    const existing = await find();
    if (existing) return existing;
    if (wanted.toLowerCase() !== BOARD_DEFAULT_NAME.toLowerCase()) boardFail("not_found");
    await sql`INSERT INTO board_boards (id, owner_id, name, scope, last_cursor, created_at)
      VALUES (${newBoardId("brd")}, ${ownerId}, ${BOARD_DEFAULT_NAME}, 'personal', 0, ${this.now()})
      ON CONFLICT (owner_id, lower(name)) DO NOTHING`.execute(executor);
    return (await find()) ?? boardFail("unavailable");
  }

  async listBoards(ownerId: string): Promise<BoardSummary[]> {
    await this.resolveBoard(ownerId, undefined);
    const rows = await this.db.selectFrom("board_boards").select(["id", "name", "scope", "created_at"])
      .where("owner_id", "=", ownerId).orderBy("created_at").orderBy("name").execute();
    return rows.map((row) => ({ id: row.id, name: row.name, scope: row.scope }));
  }

  async createBoard(ownerId: string, name: string): Promise<BoardSummary> {
    await this.resolveBoard(ownerId, undefined);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`board-create:${ownerId}`}))`.execute(trx);
      const count = await trx.selectFrom("board_boards").select((eb) => eb.fn.countAll<string>().as("count"))
        .where("owner_id", "=", ownerId).executeTakeFirstOrThrow();
      if (Number(count.count) >= this.limits.boardsPerOwner) boardFail("limit_reached");
      const id = newBoardId("brd");
      const inserted = await sql<{ id: string }>`INSERT INTO board_boards (id, owner_id, name, scope, last_cursor, created_at)
        VALUES (${id}, ${ownerId}, ${name}, 'personal', 0, ${this.now()})
        ON CONFLICT (owner_id, lower(name)) DO NOTHING RETURNING id`.execute(trx);
      if (inserted.rows.length === 0) boardFail("duplicate_id");
      return { id, name, scope: "personal" as const };
    });
  }

  /* ---------------- reads ---------------- */

  async listChannels(caller: BoardCaller, boardName?: string): Promise<BoardChannel[]> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    const channels = await this.db.selectFrom("board_channels").select("path")
      .where("board_id", "=", board.id).orderBy("path").limit(this.limits.channelsPerBoard).execute();
    const stats = await this.db.selectFrom("board_messages as m")
      .leftJoin("board_reads as r", (join) => join.onRef("r.root_id", "=", "m.id").on("r.actor", "=", caller.actor.id))
      .select((eb) => [
        "m.channel",
        eb.fn.countAll<string>().as("threads"),
        eb.fn.max("m.last_activity_at").as("last_activity_at"),
        sql<string>`count(*) FILTER (WHERE m.last_actor <> ${caller.actor.id} AND (r.read_at IS NULL OR m.last_activity_at > r.read_at))`.as("unread"),
      ])
      .where("m.board_id", "=", board.id).where("m.root_id", "is", null).groupBy("m.channel").execute();
    const byChannel = new Map(stats.map((row) => [row.channel, row]));
    return channels.map(({ path }) => {
      const stat = byChannel.get(path);
      return {
        path,
        unread: Number(stat?.unread ?? 0),
        threadCount: Number(stat?.threads ?? 0),
        lastActivityAt: toIso(stat?.last_activity_at as Date | null | undefined),
      };
    });
  }

  async listActors(caller: BoardCaller, boardName?: string): Promise<BoardActor[]> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    const rows = await this.db.selectFrom("board_messages").select(["author", "author_actor"]).distinctOn("author")
      .where("board_id", "=", board.id).orderBy("author").limit(500).execute();
    return rows.map((row) => parseActor(row.author_actor));
  }

  async listThreads(caller: BoardCaller, boardName: string | undefined, query: Omit<ThreadsQuery, "board">): Promise<BoardThreadSummary[]> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    let builder = this.db.selectFrom("board_messages as m").selectAll("m")
      .where("m.board_id", "=", board.id).where("m.root_id", "is", null);
    builder = builder.where(scopeCondition(query.channel ?? "*"));
    if (query.by) builder = builder.where("m.author", "=", query.by);
    if (query.label) {
      const filter = parseBoardLabelFilter(query.label);
      builder = builder.where(({ exists, selectFrom }) => exists(
        selectFrom("board_labels as l").select("l.key").whereRef("l.message_id", "=", "m.id").where("l.key", "=", filter.key)
          .$if(filter.values !== null, (qb) => qb.where("l.value", "in", filter.values!)),
      ));
    }
    if (query.text) {
      const pattern = `%${escapeLike(query.text)}%`;
      builder = builder.where((eb) => eb.or([
        eb.and([eb("m.deleted_at", "is", null), eb("m.text", "ilike", pattern)]),
        eb.exists(eb.selectFrom("board_messages as r").select("r.id").whereRef("r.root_id", "=", "m.id")
          .where("r.deleted_at", "is", null).where("r.text", "ilike", pattern)),
      ]));
    }
    if (query.taskState) builder = this.tasks ? this.tasks.filterByState(builder, query.taskState) : builder.where(sql<boolean>`false`);
    const roots = await builder.orderBy("m.last_activity_at", "desc").orderBy("m.seq", "desc").limit(query.limit ?? 50).execute();
    return this.summarize(caller, roots);
  }

  private async summarize(caller: BoardCaller, roots: MessageRow[]): Promise<BoardThreadSummary[]> {
    if (roots.length === 0) return [];
    const ids = roots.map((root) => root.id);
    const [latest, reads] = await Promise.all([
      this.db.selectFrom("board_messages").selectAll().distinctOn("root_id")
        .where("root_id", "in", ids).orderBy("root_id").orderBy("seq", "desc").execute(),
      this.db.selectFrom("board_reads").select(["root_id", "read_at"]).where("actor", "=", caller.actor.id).where("root_id", "in", ids).execute(),
    ]);
    const tx = this.db as unknown as BoardTrx;
    const [hydratedRoots, hydratedLatest, tasks] = await Promise.all([
      hydrateMessages(tx, roots), hydrateMessages(tx, latest), loadTasks(this.tasks, tx, ids),
    ]);
    const latestByRoot = new Map(hydratedLatest.map((message) => [message.re!, message]));
    const readByRoot = new Map(reads.map((read) => [read.root_id, read.read_at]));
    return roots.map((root, index) => {
      const lastActivityAt = root.last_activity_at;
      const readAt = readByRoot.get(root.id);
      return {
        root: hydratedRoots[index]!,
        replyCount: root.reply_count,
        latestReply: latestByRoot.get(root.id) ?? null,
        lastActivityAt: toIso(lastActivityAt)!,
        task: tasks.get(root.id) ?? null,
        unread: root.last_actor !== caller.actor.id && (!readAt || new Date(lastActivityAt) > new Date(readAt)),
      };
    });
  }

  async getThread(caller: BoardCaller, boardName: string | undefined, rootId: string): Promise<BoardThread> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    const root = await this.db.selectFrom("board_messages").selectAll().where("id", "=", rootId).where("board_id", "=", board.id).executeTakeFirst();
    if (!root) boardFail("not_found");
    if (root.root_id) return this.getThread(caller, boardName, root.root_id);
    const replies = await this.db.selectFrom("board_messages").selectAll().where("root_id", "=", root.id)
      .orderBy("seq").limit(this.limits.repliesPerThread + 1).execute();
    const tx = this.db as unknown as BoardTrx;
    const [[hydratedRoot], hydratedReplies, tasks] = await Promise.all([
      hydrateMessages(tx, [root]), hydrateMessages(tx, replies), loadTasks(this.tasks, tx, [root.id]),
    ]);
    const task = tasks.get(root.id) ?? null;
    return {
      root: hydratedRoot!, replies: hydratedReplies, task,
      needs: task && this.tasks ? await this.tasks.describeNeeds(tx, task.needs) : [],
    };
  }

  async listMessages(caller: BoardCaller, boardName: string | undefined, query: Omit<MessagesQuery, "board">): Promise<BoardMessage[]> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    let builder = this.db.selectFrom("board_messages as m").selectAll("m").where("m.board_id", "=", board.id);
    if (query.channel) builder = builder.where(scopeCondition(query.channel));
    if (query.re) builder = builder.where("m.root_id", "=", query.re);
    if (query.by) builder = builder.where("m.author", "=", query.by);
    if (query.mentions) builder = builder.where(sql<boolean>`m.mentions @> ${JSON.stringify([query.mentions])}::jsonb`);
    if (query.text) builder = builder.where("m.deleted_at", "is", null).where("m.text", "ilike", `%${escapeLike(query.text)}%`);
    if (query.label) {
      const filter = parseBoardLabelFilter(query.label);
      builder = builder.where(({ exists, selectFrom }) => exists(
        selectFrom("board_labels as l").select("l.key")
          .where((eb) => eb.or([eb("l.message_id", "=", eb.ref("m.id")), eb("l.message_id", "=", eb.ref("m.root_id"))]))
          .where("l.key", "=", filter.key)
          .$if(filter.values !== null, (qb) => qb.where("l.value", "in", filter.values!)),
      ));
    }
    if (query.after) {
      const anchor = await this.db.selectFrom("board_messages").select("seq").where("id", "=", query.after)
        .where("board_id", "=", board.id).executeTakeFirst();
      if (!anchor) boardFail("not_found");
      builder = builder.where("m.seq", ">", anchor.seq as never);
    }
    const rows = await builder.orderBy("m.seq").limit(query.limit ?? 50).execute();
    return hydrateMessages(this.db as unknown as BoardTrx, rows);
  }

  async markRead(caller: BoardCaller, boardName: string | undefined, rootId: string): Promise<void> {
    const board = await this.resolveBoard(caller.ownerId, boardName);
    const root = await this.db.selectFrom("board_messages").select(["id", "root_id"]).where("id", "=", rootId)
      .where("board_id", "=", board.id).executeTakeFirst();
    if (!root || root.root_id) boardFail("not_found");
    await this.db.insertInto("board_reads")
      .values({ owner_id: caller.ownerId, board_id: board.id, actor: caller.actor.id, root_id: rootId, read_at: this.now() })
      .onConflict((oc) => oc.columns(["board_id", "actor", "root_id"]).doUpdateSet({ read_at: this.now() }))
      .execute();
  }

  /* ---------------- writes ---------------- */

  /** One write transaction on a board; events reach subscribers after commit. */
  async write<T>(caller: BoardCaller, boardName: string | undefined, work: (ctx: WriteContext) => Promise<T>): Promise<T> {
    if (!this.rateLimiter.take(caller.actor.id, this.now().getTime())) boardFail("rate_limited");
    const target = await this.resolveBoard(caller.ownerId, boardName);
    const pending: PendingBoardEvent[] = [];
    const { result, events } = await this.db.transaction().execute(async (trx) => {
      const board = await lockBoard(trx, target.id);
      const now = this.now();
      const value = await work({ trx, board, now, caller, emit: (event) => pending.push(event) });
      return { result: value, events: await appendEvents(trx, board, pending, now) };
    });
    this.publish(caller.ownerId, events);
    return result;
  }

  publish(ownerId: string, events: BoardEvent[]): void {
    if (events.length === 0 || !this.onEvents) return;
    try {
      this.onEvents(ownerId, events);
    } catch (error: unknown) {
      console.error("[message-board] event fan-out failed:", error instanceof Error ? error.message : "UnknownError");
    }
  }

  async createChannel(caller: BoardCaller, boardName: string | undefined, path: string): Promise<void> {
    await this.write(caller, boardName, async (ctx) => {
      if (!(await ensureChannel(ctx, path, this.limits.channelsPerBoard))) boardFail("channel_exists");
    });
  }

  async post(caller: BoardCaller, boardName: string | undefined, input: PostMessageRequest): Promise<BoardMessage> {
    if (Object.keys(input.labels ?? {}).some(isReservedBoardLabelKey)) boardFail("reserved_label");
    return this.write(caller, boardName, async (ctx) => {
      const { trx, board, now } = ctx;
      if (input.idempotencyKey) {
        const existing = await trx.selectFrom("board_messages").selectAll().where("board_id", "=", board.id)
          .where("author", "=", caller.actor.id).where("idempotency_key", "=", input.idempotencyKey).executeTakeFirst();
        if (existing) return (await hydrateMessages(trx, [existing]))[0]!;
      }
      let rootId: string | null = null;
      let replyTo: string | null = input.replyTo ?? null;
      if (replyTo && !input.re) boardFail("invalid_input");
      if (input.re) {
        const target = await trx.selectFrom("board_messages").selectAll().where("id", "=", input.re)
          .where("board_id", "=", board.id).executeTakeFirst();
        if (!target) boardFail("not_found");
        rootId = target.root_id ?? target.id;
        if (target.root_id && !replyTo) replyTo = target.id;
        const root = target.root_id
          ? await trx.selectFrom("board_messages").selectAll().where("id", "=", rootId).forUpdate().executeTakeFirstOrThrow()
          : target;
        if (root.channel !== input.channel) boardFail("invalid_input");
        if (root.deleted_at) boardFail("message_deleted");
        if (root.reply_count >= this.limits.repliesPerThread) boardFail("thread_full");
        if (input.replyTo && input.replyTo !== target.id) {
          const replied = await trx.selectFrom("board_messages").select(["id", "root_id"]).where("id", "=", input.replyTo)
            .where("board_id", "=", board.id).executeTakeFirst();
          // The replied-to message must be in this thread: the root itself or one of its replies.
          if (!replied || (replied.id !== rootId && replied.root_id !== rootId)) boardFail("invalid_input");
        }
      }
      await ensureChannel(ctx, input.channel, this.limits.channelsPerBoard);
      const id = newBoardId("msg");
      const row = await trx.insertInto("board_messages").values({
        id, owner_id: caller.ownerId, board_id: board.id, channel: input.channel, root_id: rootId, reply_to: replyTo,
        author: caller.actor.id, author_actor: JSON.stringify(storedActor(caller.actor)), text: input.text,
        mentions: JSON.stringify(extractMentions(input.text)), revision: 1, idempotency_key: input.idempotencyKey ?? null,
        reply_count: 0, last_activity_at: now, last_actor: caller.actor.id, created_at: now,
      }).returningAll().executeTakeFirstOrThrow();
      if (input.labels && Object.keys(input.labels).length > 0) {
        await trx.insertInto("board_labels")
          .values(Object.entries(input.labels).map(([key, value]) => ({ owner_id: caller.ownerId, message_id: id, key, value }))).execute();
      }
      if (rootId) {
        await trx.updateTable("board_messages")
          .set((eb) => ({ reply_count: eb("reply_count", "+", 1), last_activity_at: now, last_actor: caller.actor.id }))
          .where("id", "=", rootId).execute();
      }
      ctx.emit({ type: "message.posted", actor: caller.actor, channel: input.channel, messageId: id, threadId: rootId ?? id });
      return (await hydrateMessages(trx, [row]))[0]!;
    });
  }

  async edit(caller: BoardCaller, boardName: string | undefined, messageId: string, input: { text: string; ifRevision?: number }): Promise<BoardMessage> {
    return this.write(caller, boardName, async (ctx) => {
      const target = await lockOwnMessage(ctx, messageId);
      const expected = input.ifRevision ?? target.revision;
      const updated = await ctx.trx.updateTable("board_messages")
        .set({ text: input.text, mentions: JSON.stringify(extractMentions(input.text)), revision: expected + 1, edited_at: ctx.now })
        .where("id", "=", messageId).where("revision", "=", expected).where("deleted_at", "is", null)
        .returningAll().executeTakeFirst();
      if (!updated) boardFail("revision_conflict");
      ctx.emit({ type: "message.edited", actor: caller.actor, channel: updated.channel, messageId, threadId: updated.root_id ?? messageId });
      return (await hydrateMessages(ctx.trx, [updated]))[0]!;
    });
  }

  async remove(caller: BoardCaller, boardName: string | undefined, messageId: string, input: { ifRevision?: number }): Promise<void> {
    await this.write(caller, boardName, async (ctx) => {
      const target = await lockOwnMessage(ctx, messageId);
      const expected = input.ifRevision ?? target.revision;
      const updated = await ctx.trx.updateTable("board_messages")
        .set({ deleted_at: ctx.now, revision: expected + 1 })
        .where("id", "=", messageId).where("revision", "=", expected).where("deleted_at", "is", null)
        .returning(["channel", "root_id"]).executeTakeFirst();
      if (!updated) boardFail("revision_conflict");
      ctx.emit({ type: "message.deleted", actor: caller.actor, channel: updated.channel, messageId, threadId: updated.root_id ?? messageId });
    });
  }

  async react(caller: BoardCaller, boardName: string | undefined, messageId: string, input: { emoji: string; on: boolean }): Promise<void> {
    await this.write(caller, boardName, async (ctx) => {
      const target = await findMessage(ctx, messageId);
      if (target.deleted_at) boardFail("message_deleted");
      const changed = input.on
        ? await ctx.trx.insertInto("board_reactions")
          .values({ owner_id: caller.ownerId, message_id: messageId, actor: caller.actor.id, emoji: input.emoji, created_at: ctx.now })
          .onConflict((oc) => oc.columns(["message_id", "actor", "emoji"]).doNothing()).returning("emoji").execute()
        : await ctx.trx.deleteFrom("board_reactions").where("message_id", "=", messageId).where("actor", "=", caller.actor.id)
          .where("emoji", "=", input.emoji).returning("emoji").execute();
      if (changed.length === 0) return;
      ctx.emit({
        type: input.on ? "reaction.added" : "reaction.removed", actor: caller.actor, channel: target.channel,
        messageId, threadId: target.root_id ?? messageId, payload: { emoji: input.emoji },
      });
    });
  }

  async label(caller: BoardCaller, boardName: string | undefined, messageId: string, patch: LabelPatchRequest): Promise<void> {
    const touched = [...Object.keys(patch.set ?? {}), ...(patch.unset ?? []), ...Object.keys(patch.if ?? {}), ...(patch.ifUnset ?? [])];
    if (touched.some(isReservedBoardLabelKey)) boardFail("reserved_label");
    await this.write(caller, boardName, async (ctx) => {
      const target = await findMessage(ctx, messageId, true);
      if (target.deleted_at) boardFail("message_deleted");
      await applyLabelPatch(ctx, target, patch, this.limits.labelsPerMessage);
      ctx.emit({
        type: "labels.changed", actor: caller.actor, channel: target.channel, messageId, threadId: target.root_id ?? messageId,
        payload: { set: patch.set ?? {}, unset: patch.unset ?? [] },
      });
    });
  }
}

export interface WriteContext {
  trx: BoardTrx;
  board: BoardRow;
  now: Date;
  caller: BoardCaller;
  emit(event: PendingBoardEvent): void;
}

/** `dev` is exact, `security/` is that channel and everything under it, `*` is everything. */
function scopeCondition(scope: string) {
  if (scope === "*") return sql<boolean>`true`;
  if (!scope.endsWith("/")) return sql<boolean>`m.channel = ${scope}`;
  return sql<boolean>`(m.channel = ${scope.slice(0, -1)} OR left(m.channel, ${scope.length}) = ${scope})`;
}

/** Creates the channel once; true when this call created it. */
export async function ensureChannel(ctx: WriteContext, path: string, maxChannels: number): Promise<boolean> {
  const existing = await ctx.trx.selectFrom("board_channels").select("path").where("board_id", "=", ctx.board.id).where("path", "=", path).executeTakeFirst();
  if (existing) return false;
  const count = await ctx.trx.selectFrom("board_channels").select((eb) => eb.fn.countAll<string>().as("count"))
    .where("board_id", "=", ctx.board.id).executeTakeFirstOrThrow();
  if (Number(count.count) >= maxChannels) boardFail("limit_reached");
  await ctx.trx.insertInto("board_channels")
    .values({ owner_id: ctx.caller.ownerId, board_id: ctx.board.id, path, created_by: ctx.caller.actor.id, created_at: ctx.now })
    .onConflict((oc) => oc.columns(["board_id", "path"]).doNothing()).execute();
  ctx.emit({ type: "channel.created", actor: ctx.caller.actor, channel: path });
  return true;
}

export async function findMessage(ctx: WriteContext, messageId: string, lock = false): Promise<MessageRow> {
  const query = ctx.trx.selectFrom("board_messages").selectAll().where("id", "=", messageId).where("board_id", "=", ctx.board.id);
  const row = await (lock ? query.forUpdate() : query).executeTakeFirst();
  return row ?? boardFail("not_found");
}

async function lockOwnMessage(ctx: WriteContext, messageId: string): Promise<MessageRow> {
  const target = await findMessage(ctx, messageId, true);
  if (target.author !== ctx.caller.actor.id) boardFail("forbidden");
  if (target.deleted_at) boardFail("message_deleted");
  return target;
}

async function applyLabelPatch(ctx: WriteContext, target: MessageRow, patch: LabelPatchRequest, maxLabels: number): Promise<void> {
  const current = Object.fromEntries((await ctx.trx.selectFrom("board_labels").select(["key", "value"])
    .where("message_id", "=", target.id).execute()).map((row) => [row.key, row.value]));
  for (const [key, value] of Object.entries(patch.if ?? {})) {
    if (current[key] !== value) boardFail("label_conflict");
  }
  for (const key of patch.ifUnset ?? []) {
    if (Object.hasOwn(current, key)) boardFail("label_conflict");
  }
  const next = { ...current, ...patch.set };
  for (const key of patch.unset ?? []) delete next[key];
  if (Object.keys(next).length > maxLabels) boardFail("limit_reached");
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    await ctx.trx.insertInto("board_labels").values({ owner_id: ctx.caller.ownerId, message_id: target.id, key, value })
      .onConflict((oc) => oc.columns(["message_id", "key"]).doUpdateSet({ value })).execute();
  }
  if (patch.unset?.length) {
    await ctx.trx.deleteFrom("board_labels").where("message_id", "=", target.id).where("key", "in", patch.unset).execute();
  }
}

export { MessageBoardServiceError };
