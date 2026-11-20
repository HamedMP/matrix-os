import { sql, type Kysely } from "kysely";
import {
  BOARD_LEASE_DEFAULT_SECONDS, BoardMessageIdSchema, parseBoardLabelFilter,
  type BoardActor, type BoardClaim, type BoardEvent, type BoardMessage, type BoardTask, type ClaimProofInput, type ClaimTaskRequest,
  type CreateTaskPlanRequest,
} from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "./database.js";
import { boardFail, MessageBoardServiceError } from "./errors.js";
import { hydrateMessages, storedActor } from "./rows.js";
import { MessageBoardService, type BoardCaller, type MessageBoardServiceOptions, type WriteContext } from "./service.js";
import {
  claimTokenMatches, FINISHED_STATES, hashClaimToken, lockTask, mirrorTaskLabel, needsFor, newClaimToken, orderPlan, readinessOf, taskExtension,
  toBoardTask, validateNeeds, writeNeeds, type TaskRow,
} from "./task-store.js";

const SWEEPER: BoardActor = { id: "system:lease-sweeper", kind: "system", name: "lease sweeper" };
const SWEEP_INTERVAL_MS = 15_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60_000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_CLAIM_WAITERS = 128;
const WAKE_EVENTS = new Set(["task.created", "task.ready", "task.released", "task.expired", "task.unblocked", "task.reopened", "task.assigned", "task.needs_changed"]);

export interface CreatedTask { root: BoardMessage; task: BoardTask; claim?: BoardClaim }

interface ClaimWaiter { ownerId: string; wake(): void }

/**
 * Board tasks (spec 2700 section 2): claims with leases, settles guarded by the
 * claim epoch in the UPDATE, dependencies, and the lease sweeper. Every change
 * runs inside the board write transaction with its events.
 */
export class BoardTaskService {
  readonly board: MessageBoardService;
  private readonly now: () => Date;
  private readonly waiters: ClaimWaiter[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  static attach(db: Kysely<MessageBoardDatabase>, options: MessageBoardServiceOptions = {}): BoardTaskService {
    let tasks: BoardTaskService | null = null;
    const board = new MessageBoardService(db, {
      ...options,
      tasks: taskExtension,
      onEvents: (ownerId, events) => {
        tasks?.wakeWaiters(ownerId, events);
        options.onEvents?.(ownerId, events);
      },
    });
    tasks = new BoardTaskService(board);
    return tasks;
  }

  private constructor(board: MessageBoardService) {
    this.board = board;
    this.now = () => board.clock();
  }

  /* ---------------- create ---------------- */

  async create(caller: BoardCaller, boardName: string | undefined, input: {
    channel: string; text: string; labels?: Record<string, string>; needs?: string[]; forProfile?: string; claim?: boolean;
  }): Promise<CreatedTask> {
    return this.board.write(caller, boardName, async (ctx) => {
      await validateNeeds(ctx, null, input.needs ?? []);
      const root = await this.board.postInTransaction(ctx, { channel: input.channel, text: input.text, labels: input.labels });
      const task = await this.insertTask(ctx, root, input.needs ?? [], input.forProfile ?? null);
      if (!input.claim) return { root, task };
      const claim = await this.claimRow(ctx, await lockTask(ctx, root.id), BOARD_LEASE_DEFAULT_SECONDS);
      return { root, task: claim.task, claim };
    });
  }

  async createFromThread(caller: BoardCaller, boardName: string | undefined, rootId: string, input: { needs?: string[]; forProfile?: string }): Promise<CreatedTask> {
    return this.board.write(caller, boardName, async (ctx) => {
      const root = await ctx.trx.selectFrom("board_messages").selectAll().where("id", "=", rootId).where("board_id", "=", ctx.board.id).forUpdate().executeTakeFirst();
      if (!root || root.root_id) boardFail("not_found");
      if (root.deleted_at) boardFail("message_deleted");
      if (await ctx.trx.selectFrom("board_tasks").select("root_id").where("root_id", "=", rootId).executeTakeFirst()) boardFail("duplicate_id");
      await validateNeeds(ctx, null, input.needs ?? []);
      const [message] = await hydrateMessages(ctx.trx, [root]);
      return { root: message!, task: await this.insertTask(ctx, message!, input.needs ?? [], input.forProfile ?? null) };
    });
  }

  async createPlan(caller: BoardCaller, boardName: string | undefined, plan: CreateTaskPlanRequest): Promise<CreatedTask[]> {
    return this.board.write(caller, boardName, async (ctx) => {
      const externalRefs = [...new Set(plan.tasks.flatMap((item) => item.needs ?? []).filter((ref) => !plan.tasks.some((task) => task.key === ref)))];
      const existing = new Set<string>();
      for (const ref of externalRefs) {
        if (!BoardMessageIdSchema.safeParse(ref).success) boardFail("invalid_needs");
        existing.add(ref);
      }
      await validateNeeds(ctx, null, [...existing]);
      const ordered = orderPlan(plan.tasks, (ref) => existing.has(ref));
      const idByKey = new Map<string, string>();
      const created = new Map<string, CreatedTask>();
      for (const item of ordered) {
        const root = await this.board.postInTransaction(ctx, { channel: plan.channel, text: item.text, labels: item.labels });
        const needs = (item.needs ?? []).map((ref) => idByKey.get(ref) ?? ref);
        await validateNeeds(ctx, null, needs);
        idByKey.set(item.key, root.id);
        created.set(item.key, { root, task: await this.insertTask(ctx, root, needs, item.forProfile ?? null) });
      }
      return plan.tasks.map((item) => created.get(item.key)!);
    });
  }

  private async insertTask(ctx: WriteContext, root: BoardMessage, needs: readonly string[], forProfile: string | null): Promise<BoardTask> {
    const state = await readinessOf(ctx, needs);
    const row = await ctx.trx.insertInto("board_tasks").values({
      root_id: root.id, owner_id: ctx.caller.ownerId, board_id: ctx.board.id, channel: root.channel, state, owner_actor: ctx.caller.actor.id,
      assigned_profile: forProfile, claim_holder: JSON.stringify(null), claim_epoch: 0, claim_token_hash: null, lease_until: null,
      result: null, failure_reason: null, cancel_reason: null, blocked_reason: null, blocked_kind: null, updated_at: ctx.now,
    }).returningAll().executeTakeFirstOrThrow();
    await writeNeeds(ctx, root.id, needs);
    await mirrorTaskLabel(ctx, root.id, state);
    ctx.emit({ type: "task.created", actor: ctx.caller.actor, channel: root.channel, messageId: root.id, threadId: root.id, payload: { state } });
    return toBoardTask(row, [...needs]);
  }

  /* ---------------- claim ---------------- */

  async claim(caller: BoardCaller, boardName: string | undefined, request: ClaimTaskRequest): Promise<BoardClaim> {
    const leaseSeconds = request.leaseSeconds ?? BOARD_LEASE_DEFAULT_SECONDS;
    if ("id" in request) {
      return this.board.write(caller, boardName, async (ctx) => this.claimRow(ctx, await lockTask(ctx, request.id), leaseSeconds));
    }
    // Real time, not the board clock: a wait is about how long this request stays open.
    const deadline = Date.now() + (request.waitSeconds ?? 0) * 1000;
    for (;;) {
      try {
        return await this.board.write(caller, boardName, async (ctx) => {
          const candidate = await this.nextReady(ctx, request);
          return this.claimRow(ctx, candidate ?? boardFail("nothing_ready"), leaseSeconds);
        });
      } catch (error) {
        if (!(error instanceof MessageBoardServiceError) || error.reason !== "nothing_ready") throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw error;
        await this.waitForWork(caller.ownerId, remaining);
      }
    }
  }

  /** Assigned to my profile first, then unassigned tasks my owner created (or `from` created); oldest first. */
  private async nextReady(ctx: WriteContext, request: Extract<ClaimTaskRequest, { ready: string }>): Promise<TaskRow | undefined> {
    const profile = ctx.caller.actor.profile ?? null;
    const scope = request.ready;
    const scopeSql = scope === "*" ? sql<boolean>`true`
      : scope.endsWith("/") ? sql<boolean>`(m.channel = ${scope.slice(0, -1)} OR left(m.channel, ${scope.length}) = ${scope})`
        : sql<boolean>`m.channel = ${scope}`;
    // Task text is instructions: implicitly take only tasks the owner (or this caller) created.
    const creators = [`user:${ctx.caller.ownerId}`, ctx.caller.actor.id, ...(request.from ? [request.from] : [])];
    let query = ctx.trx.selectFrom("board_tasks as t").innerJoin("board_messages as m", "m.id", "t.root_id").selectAll("t")
      .where("t.board_id", "=", ctx.board.id).where("t.state", "=", "ready").where(scopeSql)
      .where((eb) => eb.or([
        profile ? eb("t.assigned_profile", "=", profile) : eb.val(false),
        eb.and([eb("t.assigned_profile", "is", null), eb("t.owner_actor", "in", creators)]),
      ]));
    if (request.label) {
      const filter = parseBoardLabelFilter(request.label);
      query = query.where(({ exists, selectFrom }) => exists(selectFrom("board_labels as l").select("l.key").whereRef("l.message_id", "=", "m.id")
        .where("l.key", "=", filter.key).$if(filter.values !== null, (qb) => qb.where("l.value", "in", filter.values!))));
    }
    return query.orderBy(sql`(t.assigned_profile IS NOT NULL)`, "desc").orderBy("m.seq").limit(1).forUpdate().skipLocked().executeTakeFirst();
  }

  private async claimRow(ctx: WriteContext, row: TaskRow, leaseSeconds: number): Promise<BoardClaim> {
    if (row.state === "claimed") boardFail("task_claimed");
    if (row.state === "waiting") boardFail("task_waiting");
    if (row.state === "blocked") boardFail("task_blocked");
    if (FINISHED_STATES.includes(row.state)) boardFail("task_finished");
    if (row.assigned_profile && row.assigned_profile !== ctx.caller.actor.profile) boardFail("task_assigned");
    const needs = (await needsFor(ctx.trx, [row.root_id])).get(row.root_id) ?? [];
    if (await readinessOf(ctx, needs) !== "ready") boardFail("task_waiting");
    const token = newClaimToken();
    const leaseUntil = new Date(ctx.now.getTime() + leaseSeconds * 1000);
    const updated = await ctx.trx.updateTable("board_tasks").set({
      state: "claimed", claim_holder: JSON.stringify(storedActor(ctx.caller.actor)), claim_epoch: row.claim_epoch + 1,
      claim_token_hash: hashClaimToken(token), lease_until: leaseUntil, updated_at: ctx.now,
    }).where("root_id", "=", row.root_id).where("state", "=", "ready").returningAll().executeTakeFirst();
    if (!updated) boardFail("task_claimed");
    await mirrorTaskLabel(ctx, row.root_id, "claimed");
    this.emitTask(ctx, updated, "task.claimed", { epoch: updated.claim_epoch, leaseUntil: leaseUntil.toISOString() });
    return { task: toBoardTask(updated, needs), taskId: row.root_id, epoch: updated.claim_epoch, token };
  }

  /* ---------------- settle ---------------- */

  /**
   * The caller must hold the current claim. Agents prove it with epoch and
   * token; a person holding the claim is identified by their principal.
   */
  private requireClaim(ctx: WriteContext, row: TaskRow, proof: ClaimProofInput): void {
    const holder = row.claim_holder ? (typeof row.claim_holder === "string" ? JSON.parse(row.claim_holder) : row.claim_holder) as { id: string } : null;
    const holds = row.state === "claimed" && holder?.id === ctx.caller.actor.id;
    if (!holds) boardFail(proof.epoch !== undefined || proof.token !== undefined ? "claim_lost" : "claim_not_held");
    if (proof.epoch === undefined || proof.token === undefined) {
      if (ctx.caller.actor.kind !== "user") boardFail("invalid_input");
    } else if (proof.epoch !== row.claim_epoch || !claimTokenMatches(proof.token, row.claim_token_hash)) {
      boardFail("claim_lost");
    }
    if (row.lease_until && new Date(row.lease_until).getTime() <= ctx.now.getTime()) boardFail("claim_lost");
  }

  /** The UPDATE re-checks the epoch, so a holder whose claim lapsed in between changes nothing. */
  private async settle(ctx: WriteContext, row: TaskRow, set: Partial<Record<keyof TaskRow, unknown>>, type: BoardEvent["type"], payload: Record<string, unknown> = {}): Promise<TaskRow> {
    const updated = await ctx.trx.updateTable("board_tasks").set({ ...set, updated_at: ctx.now } as never)
      .where("root_id", "=", row.root_id).where("claim_epoch", "=", row.claim_epoch).where("state", "=", row.state)
      .returningAll().executeTakeFirst();
    if (!updated) boardFail("claim_lost");
    if (updated.state !== row.state) await mirrorTaskLabel(ctx, row.root_id, updated.state);
    this.emitTask(ctx, updated, type, payload);
    return updated;
  }

  private emitTask(ctx: WriteContext, row: TaskRow, type: BoardEvent["type"], payload: Record<string, unknown> = {}) {
    ctx.emit({ type, actor: ctx.caller.actor, channel: row.channel, messageId: row.root_id, threadId: row.root_id, payload: { state: row.state, ...payload } });
  }

  private async withTask<T>(caller: BoardCaller, boardName: string | undefined, taskId: string, work: (ctx: WriteContext, row: TaskRow) => Promise<T>): Promise<T> {
    return this.board.write(caller, boardName, async (ctx) => work(ctx, await lockTask(ctx, taskId)));
  }

  renew(caller: BoardCaller, boardName: string | undefined, taskId: string, input: ClaimProofInput & { leaseSeconds?: number }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireClaim(ctx, row, input);
      const leaseUntil = new Date(ctx.now.getTime() + (input.leaseSeconds ?? BOARD_LEASE_DEFAULT_SECONDS) * 1000);
      const renewed = await this.settle(ctx, row, { lease_until: leaseUntil }, "task.renewed", { leaseUntil: leaseUntil.toISOString() });
      return toBoardTask(renewed, (await needsFor(ctx.trx, [taskId])).get(taskId) ?? []);
    });
  }

  release(caller: BoardCaller, boardName: string | undefined, taskId: string, input: ClaimProofInput) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireClaim(ctx, row, input);
      await this.settle(ctx, row, { state: "ready", claim_holder: JSON.stringify(null), claim_token_hash: null, lease_until: null }, "task.released");
    });
  }

  complete(caller: BoardCaller, boardName: string | undefined, taskId: string, input: ClaimProofInput & { result?: string }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireClaim(ctx, row, input);
      await this.settle(ctx, row, { state: "completed", claim_token_hash: null, lease_until: null, result: input.result || null }, "task.completed");
      await this.readyDependents(ctx, taskId);
    });
  }

  fail(caller: BoardCaller, boardName: string | undefined, taskId: string, input: ClaimProofInput & { reason: string }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireClaim(ctx, row, input);
      await this.settle(ctx, row, { state: "failed", claim_token_hash: null, lease_until: null, failure_reason: input.reason }, "task.failed");
    });
  }

  block(caller: BoardCaller, boardName: string | undefined, taskId: string, input: ClaimProofInput & { reason: string; kind?: string }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      if (row.state === "claimed") this.requireClaim(ctx, row, input);
      else if (row.state === "ready" || row.state === "waiting") this.requireOwnerOrCreator(ctx, row);
      else boardFail(FINISHED_STATES.includes(row.state) ? "task_finished" : "task_blocked");
      await this.settle(ctx, row, {
        state: "blocked", claim_holder: JSON.stringify(null), claim_token_hash: null, lease_until: null,
        blocked_reason: input.reason, blocked_kind: input.kind ?? null,
      }, "task.blocked", { kind: input.kind ?? null });
    });
  }

  unblock(caller: BoardCaller, boardName: string | undefined, taskId: string) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireOwnerOrCreator(ctx, row);
      if (row.state !== "blocked") boardFail("invalid_input");
      const needs = (await needsFor(ctx.trx, [taskId])).get(taskId) ?? [];
      await this.settle(ctx, row, { state: await readinessOf(ctx, needs), blocked_reason: null, blocked_kind: null }, "task.unblocked");
    });
  }

  reopen(caller: BoardCaller, boardName: string | undefined, taskId: string) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireOwnerOrCreator(ctx, row);
      if (!FINISHED_STATES.includes(row.state)) boardFail("invalid_input");
      const needs = (await needsFor(ctx.trx, [taskId])).get(taskId) ?? [];
      await this.settle(ctx, row, {
        state: await readinessOf(ctx, needs), claim_holder: JSON.stringify(null), claim_token_hash: null, lease_until: null,
        result: null, failure_reason: null, cancel_reason: null,
      }, "task.reopened");
      if (row.state === "completed") await this.unreadyDependents(ctx, taskId);
    });
  }

  assign(caller: BoardCaller, boardName: string | undefined, taskId: string, input: { profile: string | null }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireOwnerOrCreator(ctx, row);
      this.requireUnclaimed(row);
      await this.settle(ctx, row, { assigned_profile: input.profile }, "task.assigned", { profile: input.profile });
    });
  }

  setNeeds(caller: BoardCaller, boardName: string | undefined, taskId: string, input: { needs: string[] }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireOwnerOrCreator(ctx, row);
      this.requireUnclaimed(row);
      await validateNeeds(ctx, taskId, input.needs);
      await writeNeeds(ctx, taskId, input.needs);
      const state = row.state === "blocked" ? "blocked" : await readinessOf(ctx, input.needs);
      await this.settle(ctx, row, { state }, "task.needs_changed", { needs: input.needs });
    });
  }

  cancel(caller: BoardCaller, boardName: string | undefined, taskId: string, input: { reason: string }) {
    return this.withTask(caller, boardName, taskId, async (ctx, row) => {
      this.requireOwnerOrCreator(ctx, row);
      if (FINISHED_STATES.includes(row.state)) boardFail("task_finished");
      await this.settle(ctx, row, {
        state: "canceled", claim_token_hash: null, lease_until: null, cancel_reason: input.reason,
      }, "task.canceled");
    });
  }

  private requireOwnerOrCreator(ctx: WriteContext, row: TaskRow): void {
    if (ctx.caller.actor.id !== `user:${ctx.caller.ownerId}` && ctx.caller.actor.id !== row.owner_actor) boardFail("task_not_owned");
  }

  private requireUnclaimed(row: TaskRow): void {
    if (row.state === "claimed") boardFail("task_claimed");
    if (FINISHED_STATES.includes(row.state)) boardFail("task_finished");
  }

  /** Completing a prerequisite readies dependents whose prerequisites are all complete. */
  private async readyDependents(ctx: WriteContext, completedId: string): Promise<void> {
    const dependents = await ctx.trx.selectFrom("board_task_needs as n").innerJoin("board_tasks as t", "t.root_id", "n.task_id")
      .selectAll("t").where("n.needs_task_id", "=", completedId).where("t.state", "=", "waiting").forUpdate().execute();
    for (const dependent of dependents) {
      const needs = (await needsFor(ctx.trx, [dependent.root_id])).get(dependent.root_id) ?? [];
      if (await readinessOf(ctx, needs) !== "ready") continue;
      const updated = await ctx.trx.updateTable("board_tasks").set({ state: "ready", updated_at: ctx.now })
        .where("root_id", "=", dependent.root_id).where("state", "=", "waiting").returningAll().executeTakeFirst();
      if (!updated) continue;
      await mirrorTaskLabel(ctx, dependent.root_id, "ready");
      this.emitTask(ctx, updated, "task.ready");
    }
  }

  /** A prerequisite that is no longer completed sends unclaimed ready dependents back to waiting. */
  private async unreadyDependents(ctx: WriteContext, reopenedId: string): Promise<void> {
    const dependents = await ctx.trx.selectFrom("board_task_needs as n").innerJoin("board_tasks as t", "t.root_id", "n.task_id")
      .selectAll("t").where("n.needs_task_id", "=", reopenedId).where("t.state", "=", "ready").forUpdate().execute();
    for (const dependent of dependents) {
      const updated = await ctx.trx.updateTable("board_tasks").set({ state: "waiting", updated_at: ctx.now })
        .where("root_id", "=", dependent.root_id).where("state", "=", "ready").returningAll().executeTakeFirst();
      if (!updated) continue;
      await mirrorTaskLabel(ctx, dependent.root_id, "waiting");
      this.emitTask(ctx, updated, "task.needs_changed", { reason: "prerequisite_reopened" });
    }
  }

  /* ---------------- background ---------------- */

  /** Returns lapsed claims to ready with a `task.expired` event; returns how many expired. */
  async sweepExpiredLeases(): Promise<number> {
    const now = this.now();
    const boards = await this.board.db.selectFrom("board_tasks").select(["board_id", "owner_id"]).distinct()
      .where("state", "=", "claimed").where("lease_until", "<=", now).execute();
    let expired = 0;
    for (const { board_id: boardId, owner_id: ownerId } of boards) {
      expired += await this.board.write({ ownerId, actor: SWEEPER }, { id: boardId }, async (ctx) => {
        const rows = await ctx.trx.updateTable("board_tasks")
          .set({ state: "ready", claim_holder: JSON.stringify(null), claim_token_hash: null, lease_until: null, updated_at: ctx.now })
          .where("board_id", "=", boardId).where("state", "=", "claimed").where("lease_until", "<=", ctx.now).returningAll().execute();
        for (const row of rows) {
          await mirrorTaskLabel(ctx, row.root_id, "ready");
          this.emitTask(ctx, row, "task.expired");
        }
        return rows.length;
      }, { internal: true });
    }
    return expired;
  }

  /** Drops events older than the retained window; messages and task state stay. */
  async pruneEvents(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - EVENT_RETENTION_MS);
    const deleted = await this.board.db.deleteFrom("board_events").where("created_at", "<", cutoff).returning("cursor").execute();
    return deleted.length;
  }

  start(): void {
    this.stop();
    this.sweepTimer = setInterval(() => {
      this.sweepExpiredLeases().catch((error: unknown) => console.error("[message-board] lease sweep failed:", error instanceof Error ? error.name : "UnknownError"));
    }, SWEEP_INTERVAL_MS);
    this.pruneTimer = setInterval(() => {
      this.pruneEvents().catch((error: unknown) => console.error("[message-board] event prune failed:", error instanceof Error ? error.name : "UnknownError"));
    }, PRUNE_INTERVAL_MS);
    this.sweepTimer.unref?.();
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.sweepTimer = null;
    this.pruneTimer = null;
    for (const waiter of this.waiters.splice(0)) waiter.wake();
  }

  private waitForWork(ownerId: string, timeoutMs: number): Promise<void> {
    if (this.waiters.length >= MAX_CLAIM_WAITERS) boardFail("unavailable");
    return new Promise((resolve) => {
      const waiter: ClaimWaiter = {
        ownerId,
        wake: () => {
          clearTimeout(timer);
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          resolve();
        },
      };
      const timer = setTimeout(waiter.wake, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private wakeWaiters(ownerId: string, events: readonly BoardEvent[]): void {
    if (!events.some((event) => WAKE_EVENTS.has(event.type))) return;
    for (const waiter of this.waiters.filter((item) => item.ownerId === ownerId)) waiter.wake();
  }
}
